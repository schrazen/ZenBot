const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec, execFile } = require('child_process');
const logger = require('../utils/logger');

class WorkspaceService {
    constructor({ rootDir, vaultDirs } = {}) {
        this.rootDir = path.resolve(rootDir || path.join(__dirname, '../..'));

        const defaultVaults = [
            path.join(os.homedir(), 'Documents'),
            path.join(os.homedir(), 'Downloads'),
            path.join(os.homedir(), 'Desktop')
        ];
        const rawVaults = Array.isArray(vaultDirs) ? vaultDirs : defaultVaults;
        this.vaultDirs = rawVaults
            .map(d => path.resolve(d))
            .filter(d => {
                try { return fs.existsSync(d) && fs.statSync(d).isDirectory(); } catch (e) { return false; }
            });

        logger.info(`WorkspaceService initialized. Write sandbox: ${this.rootDir} | Read vaults (${this.vaultDirs.length}): ${this.vaultDirs.map(v => path.basename(v)).join(', ') || 'None'}`);
    }

    /**
     * Checks if a file path points to sensitive credentials, private keys, or browser secrets.
     */
    isSensitiveFile(fullPath) {
        const base = path.basename(fullPath).toLowerCase();
        const norm = fullPath.replace(/\\/g, '/').toLowerCase();

        if (base === 'security.env' || base === 'zen.env') return true;
        if (/^\.env(?:\.|$)/i.test(base) || /\.env$/i.test(base)) return true;
        if (/\.(pem|key|pfx|p12|kdbx)$/i.test(base)) return true;
        if (/^(id_rsa|id_ed25519|known_hosts|authorized_keys)$/i.test(base)) return true;
        if (norm.includes('/.ssh/') || norm.includes('/.aws/') || norm.includes('/.gnupg/')) return true;
        if (/^(cookies|login data|web data|local state)$/i.test(base) && (norm.includes('/appdata/') || norm.includes('chrome') || norm.includes('edge'))) {
            return true;
        }
        return false;
    }

    /**
     * Checks whether resolvedPath is inside parentDir.
     */
    _isInside(parentDir, resolvedPath) {
        const relative = path.relative(parentDir, resolvedPath);
        return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
    }

    /**
     * Resolves a read-only path inside EITHER the ZenBot project workspace OR a whitelisted personal vault
     * (e.g. "Documents/notes.txt", "Downloads/lecture.pdf", or full path inside vault).
     * Blocks sensitive secret/credential files.
     */
    resolveReadPath(targetPath = '.') {
        const raw = (targetPath || '.').trim();
        let candidate = null;

        // Check if targetPath uses a friendly vault prefix like "Downloads/..." or "Documents/..."
        const normSlash = raw.replace(/\\/g, '/');
        const firstSeg = normSlash.split('/')[0].toLowerCase();
        const matchingVault = this.vaultDirs.find(v => path.basename(v).toLowerCase() === firstSeg);

        if (matchingVault && !path.isAbsolute(raw)) {
            const rest = normSlash.slice(firstSeg.length).replace(/^\/+/, '');
            candidate = path.resolve(matchingVault, rest || '.');
        } else if (path.isAbsolute(raw)) {
            candidate = path.resolve(raw);
        } else {
            candidate = path.resolve(this.rootDir, path.normalize(raw));
        }

        const inWorkspace = this._isInside(this.rootDir, candidate);
        const inVault = this.vaultDirs.some(v => this._isInside(v, candidate));

        if (!inWorkspace && !inVault) {
            throw new Error(`Security Violation: Path "${targetPath}" is outside the authorized project workspace and personal vaults.`);
        }

        if (this.isSensitiveFile(candidate)) {
            throw new Error(`Security Violation: Access to sensitive credential/secret file "${path.basename(candidate)}" is blocked.`);
        }

        return candidate;
    }

    /**
     * Formats a resolved path cleanly relative to workspace or vault name.
     */
    _displayPath(fullPath) {
        if (this._isInside(this.rootDir, fullPath)) {
            return (path.relative(this.rootDir, fullPath) || '.').replace(/\\/g, '/');
        }
        for (const v of this.vaultDirs) {
            if (this._isInside(v, fullPath)) {
                const rel = path.relative(v, fullPath);
                return (rel ? path.join(path.basename(v), rel) : path.basename(v)).replace(/\\/g, '/');
            }
        }
        return String(fullPath).replace(/\\/g, '/');
    }

    /**
     * Resolves and validates that the requested target path is safely inside rootDir (STRICT write/exec sandbox).
     * Throws an error if path traversal is attempted.
     */
    resolvePath(targetPath = '.') {
        const normalized = path.normalize(targetPath);
        const resolved = path.resolve(this.rootDir, normalized);

        // Security check: Must start with rootDir
        const relative = path.relative(this.rootDir, resolved);
        if (relative.startsWith('..') || path.isAbsolute(relative)) {
            throw new Error(`Security Violation: Path "${targetPath}" is outside the authorized project workspace.`);
        }

        return resolved;
    }

    /**
     * Reads file content with optional line slicing (supports workspace + personal vaults + PDFs).
     */
    async readFile(filePath, maxLines = 150, offset = 0) {
        const fullPath = this.resolveReadPath(filePath);

        if (!fs.existsSync(fullPath)) {
            throw new Error(`File not found: ${filePath}`);
        }

        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
            throw new Error(`Cannot read "${filePath}": it is a directory. Use listDirectory instead.`);
        }

        const ext = path.extname(fullPath).toLowerCase();

        // Guard against reading raw binary archives, media, installers, or databases as UTF-8 text
        const binaryExts = new Set([
            '.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.webm',
            '.mp3', '.wav', '.flac', '.aac', '.ogg', '.m4a',
            '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.svgz',
            '.exe', '.dll', '.msi', '.sys', '.so', '.dylib',
            '.zip', '.rar', '.7z', '.tar', '.gz', '.bz2', '.xz', '.iso', '.bin',
            '.sqlite', '.db', '.mdb'
        ]);
        if (binaryExts.has(ext)) {
            throw new Error(`Cannot read binary file "${path.basename(fullPath)}" (${ext}) as text. Use find_files to inspect metadata or send_file_to_owner to upload it to Discord.`);
        }

        let raw = '';
        let fileType = 'text';

        if (ext === '.pdf') {
            if (stat.size > 15 * 1024 * 1024) {
                throw new Error(`PDF file "${filePath}" is too large (> 15 MB) to extract directly.`);
            }
            fileType = 'pdf';
            raw = await this._extractPdfText(fullPath);
        } else {
            if (stat.size > 2 * 1024 * 1024) {
                throw new Error(`File "${filePath}" is too large (> 2 MB) to view directly.`);
            }
            raw = fs.readFileSync(fullPath, 'utf8');
        }

        const allLines = raw.split(/\r?\n/);
        const totalLines = allLines.length;

        const start = Math.max(0, parseInt(offset, 10) || 0);
        const end = Math.min(totalLines, start + (parseInt(maxLines, 10) || 150));
        const sliced = allLines.slice(start, end);

        const numbered = sliced
            .map((line, idx) => `${start + idx + 1}: ${line}`)
            .join('\n');

        return {
            path: this._displayPath(fullPath),
            fileType,
            totalLines,
            startLine: start + 1,
            endLine: end,
            truncated: end < totalLines,
            content: numbered
        };
    }

    /**
     * Extracts plain text from a PDF file using pdf-parse with python pypdf fallback.
     */
    async _extractPdfText(fullPath) {
        let extractedText = '';

        try {
            const pdfParseModule = require('pdf-parse');
            const dataBuffer = fs.readFileSync(fullPath);
            if (typeof pdfParseModule === 'function') {
                const parsed = await pdfParseModule(dataBuffer);
                extractedText = parsed?.text || '';
            } else if (pdfParseModule && typeof pdfParseModule.PDFParse === 'function') {
                const parser = new pdfParseModule.PDFParse({ data: dataBuffer });
                const parsed = await parser.getText();
                extractedText = parsed?.text || (typeof parsed === 'string' ? parsed : '');
                if (typeof parser.destroy === 'function') {
                    await parser.destroy().catch(() => {});
                }
            }
        } catch (pdfErr) {
            logger.warn(`pdf-parse extraction failed for "${path.basename(fullPath)}": ${pdfErr.message}`);
        }

        if (extractedText && extractedText.trim()) {
            return extractedText.trim();
        }

        // Fallback: Python pypdf
        const pyText = await new Promise((resolve) => {
            const pyCode = 'import pypdf, sys; reader = pypdf.PdfReader(sys.argv[1]); print("\\n".join([(p.extract_text() or "") for p in reader.pages]))';
            execFile('python', ['-c', pyCode, fullPath], { timeout: 15000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
                if (err || !stdout) return resolve('');
                resolve(stdout.trim());
            });
        });

        if (pyText && pyText.trim()) {
            return pyText.trim();
        }

        throw new Error(`Could not extract readable text from PDF "${path.basename(fullPath)}" (it may be scanned/image-only or encrypted).`);
    }

    _formatBytes(bytes) {
        if (!bytes || bytes < 1024) return `${bytes || 0} B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
        if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
        return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
    }

    /**
     * Creates or overwrites a file with content.
     */
    async writeFile(filePath, content) {
        const fullPath = this.resolvePath(filePath);
        const dir = path.dirname(fullPath);

        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        fs.writeFileSync(fullPath, content, 'utf8');
        const lines = content.split(/\r?\n/).length;

        logger.info(`Workspace: wrote file ${filePath} (${content.length} chars, ${lines} lines)`);
        return {
            success: true,
            path: path.relative(this.rootDir, fullPath),
            bytesWritten: Buffer.byteLength(content, 'utf8'),
            linesCount: lines
        };
    }

    /**
     * Performs targeted replacement in a file.
     */
    async editFile(filePath, targetContent, replacementContent) {
        const fullPath = this.resolvePath(filePath);

        if (!fs.existsSync(fullPath)) {
            throw new Error(`File not found: ${filePath}`);
        }

        const original = fs.readFileSync(fullPath, 'utf8');

        if (!original.includes(targetContent)) {
            throw new Error(`Target content not found in ${filePath}. Ensure exact match including whitespace.`);
        }

        // Count occurrences
        const occurrences = original.split(targetContent).length - 1;
        if (occurrences > 1) {
            throw new Error(`Target content appears ${occurrences} times in ${filePath}. Provide more surrounding context to make it unique.`);
        }

        const updated = original.replace(targetContent, replacementContent);
        fs.writeFileSync(fullPath, updated, 'utf8');

        logger.info(`Workspace: edited file ${filePath}`);
        return {
            success: true,
            path: path.relative(this.rootDir, fullPath),
            replacedOccurrences: 1
        };
    }

    /**
     * Lists files and folders in a directory (supports workspace + personal vaults).
     */
    async listDirectory(dirPath = '.', depth = 1) {
        const fullPath = this.resolveReadPath(dirPath);

        if (!fs.existsSync(fullPath)) {
            throw new Error(`Directory not found: ${dirPath}`);
        }

        const stat = fs.statSync(fullPath);
        if (!stat.isDirectory()) {
            throw new Error(`"${dirPath}" is a file, not a directory.`);
        }

        // Cap depth to 1 for personal vault roots to keep token size compact
        const isVaultRoot = this.vaultDirs.some(v => path.resolve(v) === path.resolve(fullPath));
        const safeDepth = isVaultRoot ? 1 : Math.min(Math.max(parseInt(depth, 10) || 1, 1), 2);
        const ignoreList = new Set(['node_modules', '.git', '.gemini', 'package-lock.json', 'AppData']);

        const results = [];
        const scan = (currentDir, currentDepth) => {
            if (currentDepth > safeDepth) return;
            let entries = [];
            try {
                entries = fs.readdirSync(currentDir, { withFileTypes: true });
            } catch (e) {
                return;
            }

            for (const entry of entries) {
                if (ignoreList.has(entry.name)) continue;

                const entryPath = path.join(currentDir, entry.name);
                if (this.isSensitiveFile(entryPath)) continue;
                const displayEntryPath = this._displayPath(entryPath);

                let mtimeMs = 0;
                let size = 0;
                try {
                    const st = fs.statSync(entryPath);
                    mtimeMs = st.mtimeMs || 0;
                    size = st.size || 0;
                } catch (e) {}

                if (entry.isDirectory()) {
                    results.push({ name: entry.name, path: displayEntryPath, type: 'dir', mtimeMs });
                    if (currentDepth < safeDepth) {
                        scan(entryPath, currentDepth + 1);
                    }
                } else {
                    results.push({
                        name: entry.name,
                        path: displayEntryPath,
                        type: 'file',
                        size,
                        sizeFormatted: this._formatBytes(size),
                        sendableToDiscord: size > 0 && size <= 25 * 1024 * 1024,
                        mtimeMs
                    });
                }
            }
        };

        scan(fullPath, 1);

        // Directories first, then most recently modified files first
        results.sort((a, b) => {
            if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
            return (b.mtimeMs || 0) - (a.mtimeMs || 0);
        });

        const capped = results.slice(0, 60).map(({ mtimeMs, ...rest }) => rest);

        return {
            directory: this._displayPath(fullPath),
            availableVaults: this.vaultDirs.map(v => path.basename(v)),
            totalEntries: results.length,
            truncated: results.length > 60,
            entries: capped
        };
    }

    /**
     * Recursively searches for text across project or vault text files.
     */
    async searchFiles(query, dirPath = '.', maxResults = 25) {
        if (!query || !query.trim()) {
            throw new Error('Search query cannot be empty.');
        }

        const fullPath = this.resolveReadPath(dirPath);
        const ignoreList = new Set(['node_modules', '.git', '.gemini', 'package-lock.json', 'AppData']);
        const needle = query.toLowerCase();
        const matches = [];

        const scan = (currentDir, currentDepth = 0) => {
            if (matches.length >= maxResults || currentDepth > 5) return;
            let entries = [];
            try {
                entries = fs.readdirSync(currentDir, { withFileTypes: true });
            } catch (e) {
                return;
            }

            for (const entry of entries) {
                if (matches.length >= maxResults) return;
                if (ignoreList.has(entry.name)) continue;

                const entryPath = path.join(currentDir, entry.name);
                if (this.isSensitiveFile(entryPath)) continue;

                if (entry.isDirectory()) {
                    scan(entryPath, currentDepth + 1);
                } else if (entry.isFile()) {
                    // Only search text-like files
                    const ext = path.extname(entry.name).toLowerCase();
                    if (['.exe', '.dll', '.png', '.jpg', '.jpeg', '.gif', '.zip', '.tar', '.gz', '.pdf', '.docx', '.xlsx', '.pptx'].includes(ext)) {
                        continue;
                    }

                    try {
                        const stat = fs.statSync(entryPath);
                        if (stat.size > 1024 * 1024) continue;
                        const content = fs.readFileSync(entryPath, 'utf8');
                        const lines = content.split(/\r?\n/);
                        for (let i = 0; i < lines.length; i++) {
                            if (matches.length >= maxResults) break;
                            if (lines[i].toLowerCase().includes(needle)) {
                                matches.push({
                                    file: this._displayPath(entryPath),
                                    line: i + 1,
                                    text: lines[i].trim().slice(0, 150)
                                });
                            }
                        }
                    } catch (e) {}
                }
            }
        };

        scan(fullPath, 0);

        return {
            query,
            totalMatches: matches.length,
            matches
        };
    }

    /**
     * Searches for files by filename/extension/category across the project workspace and personal vaults
     * (Documents, Downloads, Desktop). Supports wildcards ("", "*", "all", "random") and media categories
     * ("image", "video", "audio", "document", "archive").
     */
    async findFilesByName(query, location = 'all', maxResults = 25, options = {}) {
        const rawQuery = String(query ?? '').trim().toLowerCase();
        const isRandom = /\brandom\b/.test(rawQuery) || Boolean(options.random);
        const sendableOnly = Boolean(options.sendableOnly);

        const CATEGORY_EXTS = {
            image: ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.svg'],
            images: ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.svg'],
            photo: ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'],
            photos: ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'],
            picture: ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'],
            pictures: ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'],
            screenshot: ['.png', '.jpg', '.jpeg', '.webp'],
            screenshots: ['.png', '.jpg', '.jpeg', '.webp'],
            video: ['.mp4', '.mkv', '.mov', '.webm', '.avi'],
            videos: ['.mp4', '.mkv', '.mov', '.webm', '.avi'],
            clip: ['.mp4', '.mkv', '.mov', '.webm'],
            movie: ['.mp4', '.mkv', '.mov', '.avi'],
            audio: ['.mp3', '.wav', '.ogg', '.m4a', '.flac'],
            music: ['.mp3', '.wav', '.ogg', '.m4a', '.flac'],
            sound: ['.mp3', '.wav', '.ogg', '.m4a'],
            song: ['.mp3', '.wav', '.ogg', '.m4a', '.flac'],
            document: ['.pdf', '.docx', '.doc', '.txt', '.md', '.pptx', '.xlsx', '.csv'],
            documents: ['.pdf', '.docx', '.doc', '.txt', '.md', '.pptx', '.xlsx', '.csv'],
            doc: ['.pdf', '.docx', '.doc', '.txt', '.md'],
            docs: ['.pdf', '.docx', '.doc', '.txt', '.md'],
            archive: ['.zip', '.rar', '.7z', '.tar', '.gz'],
            zip: ['.zip', '.rar', '.7z']
        };

        // Strip filler/location words when interpreting query intent
        const cleanedQuery = rawQuery
            .replace(/\b(?:random|one|a|an|any|some|file|files|from|in|my)\b/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();

        const isWildcard = !cleanedQuery || ['*', '*.*', 'all', 'any', 'everything'].includes(cleanedQuery);
        let categoryExts = null;
        if (cleanedQuery && CATEGORY_EXTS[cleanedQuery]) {
            categoryExts = CATEGORY_EXTS[cleanedQuery];
        } else {
            const matchedCatWord = cleanedQuery.split(/\s+/).find(w => CATEGORY_EXTS[w]);
            if (matchedCatWord && cleanedQuery === matchedCatWord) {
                categoryExts = CATEGORY_EXTS[matchedCatWord];
            }
        }

        // Convert "*.png" -> ".png"
        const normalizedTerms = (isWildcard || categoryExts)
            ? []
            : cleanedQuery
                .replace(/^\*+(\.[a-z0-9]+)$/i, '$1')
                .replace(/\*/g, ' ')
                .split(/\s+/)
                .filter(t => t && t !== '*');

        const ignoreList = new Set(['node_modules', '.git', '.gemini', 'package-lock.json', 'AppData']);
        const searchRoots = [];
        const locLower = (location || 'all').toLowerCase().trim();

        if (locLower === 'all' || locLower === 'vault' || locLower === 'vaults') {
            searchRoots.push(...this.vaultDirs);
            if (locLower === 'all') searchRoots.push(this.rootDir);
        } else if (locLower === 'workspace' || locLower === '.') {
            searchRoots.push(this.rootDir);
        } else {
            searchRoots.push(this.resolveReadPath(location));
        }

        const scanPoolLimit = isRandom ? Math.max(maxResults * 6, 150) : maxResults;
        const matches = [];
        const seenPaths = new Set();

        const scan = (currentDir, depth = 0) => {
            if (matches.length >= scanPoolLimit || depth > 4) return;
            let entries = [];
            try {
                entries = fs.readdirSync(currentDir, { withFileTypes: true });
            } catch (e) {
                return;
            }

            for (const entry of entries) {
                if (matches.length >= scanPoolLimit) return;
                if (ignoreList.has(entry.name)) continue;

                const entryPath = path.join(currentDir, entry.name);
                if (seenPaths.has(entryPath) || this.isSensitiveFile(entryPath)) continue;
                seenPaths.add(entryPath);

                if (entry.isDirectory()) {
                    scan(entryPath, depth + 1);
                } else if (entry.isFile()) {
                    const lowerName = entry.name.toLowerCase();
                    const ext = path.extname(lowerName);
                    let matched = false;

                    if (isWildcard) {
                        matched = true;
                    } else if (categoryExts) {
                        matched = categoryExts.includes(ext);
                    } else {
                        matched = normalizedTerms.every(t => lowerName.includes(t));
                    }

                    if (matched) {
                        let size = 0;
                        let modifiedAt = null;
                        try {
                            const st = fs.statSync(entryPath);
                            size = st.size;
                            modifiedAt = st.mtime?.toISOString() || null;
                        } catch (e) {}
                        const sendable = size > 0 && size <= 25 * 1024 * 1024;
                        if (sendableOnly && !sendable) continue;
                        matches.push({
                            name: entry.name,
                            path: this._displayPath(entryPath),
                            sizeBytes: size,
                            sizeMB: Number((size / (1024 * 1024)).toFixed(2)),
                            sizeFormatted: this._formatBytes(size),
                            sendableToDiscord: sendable,
                            modifiedAt
                        });
                    }
                }
            }
        };

        for (const root of searchRoots) {
            if (matches.length >= scanPoolLimit) break;
            scan(root, 0);
        }

        if (isRandom) {
            // Shuffle matches cleanly (Fisher-Yates), prioritizing files <= 25 MB that Discord can actually upload
            for (let i = matches.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [matches[i], matches[j]] = [matches[j], matches[i]];
            }
            matches.sort((a, b) => Number(b.sendableToDiscord) - Number(a.sendableToDiscord));
        } else {
            // Most recently modified first
            matches.sort((a, b) => (b.modifiedAt || '').localeCompare(a.modifiedAt || ''));
        }

        const finalMatches = matches.slice(0, maxResults);

        return {
            query,
            location,
            searchedRoots: searchRoots.map(r => this._displayPath(r)),
            totalMatches: finalMatches.length,
            matches: finalMatches
        };
    }

    /**
     * Executes a terminal command in the workspace directory.
     */
    async runCommand(command, cwdRel = '.') {
        const fullCwd = this.resolvePath(cwdRel);

        // Security blacklist of catastrophic disk commands
        const dangerousPatterns = [
            /\bformat\s+[a-z]:/i,
            /\brmdir\s+\/s\s+\/q\s+[c-z]:\\/i,
            /\bdel\s+\/s\s+\/q\s+[c-z]:\\/i,
            /\bshutdown\b/i
        ];

        for (const pattern of dangerousPatterns) {
            if (pattern.test(command)) {
                throw new Error(`Dangerous command execution blocked by workspace policy: "${command}"`);
            }
        }

        logger.info(`Workspace: running command "${command}" in ${cwdRel}`);

        return new Promise((resolve) => {
            exec(command, {
                cwd: fullCwd,
                timeout: 25000,
                maxBuffer: 1024 * 1024 * 2
            }, (error, stdout, stderr) => {
                resolve({
                    command,
                    exitCode: error ? (error.code || 1) : 0,
                    stdout: (stdout || '').trim(),
                    stderr: (stderr || '').trim(),
                    error: error ? error.message : null
                });
            });
        });
    }
}

module.exports = WorkspaceService;

