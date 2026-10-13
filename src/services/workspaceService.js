const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const logger = require('../utils/logger');

class WorkspaceService {
    constructor({ rootDir } = {}) {
        this.rootDir = path.resolve(rootDir || path.join(__dirname, '../..'));
        logger.info(`WorkspaceService initialized. Sandboxed to: ${this.rootDir}`);
    }

    /**
     * Resolves and validates that the requested target path is safely inside rootDir.
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
     * Reads file content with optional line slicing.
     */
    async readFile(filePath, maxLines = 150, offset = 0) {
        const fullPath = this.resolvePath(filePath);

        if (!fs.existsSync(fullPath)) {
            throw new Error(`File not found: ${filePath}`);
        }

        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
            throw new Error(`Cannot read "${filePath}": it is a directory. Use listDirectory instead.`);
        }

        if (stat.size > 2 * 1024 * 1024) {
            throw new Error(`File "${filePath}" is too large (> 2 MB) to view directly.`);
        }

        const raw = fs.readFileSync(fullPath, 'utf8');
        const allLines = raw.split(/\r?\n/);
        const totalLines = allLines.length;

        const start = Math.max(0, parseInt(offset, 10) || 0);
        const end = Math.min(totalLines, start + (parseInt(maxLines, 10) || 150));
        const sliced = allLines.slice(start, end);

        const numbered = sliced
            .map((line, idx) => `${start + idx + 1}: ${line}`)
            .join('\n');

        return {
            path: path.relative(this.rootDir, fullPath) || path.basename(fullPath),
            totalLines,
            startLine: start + 1,
            endLine: end,
            truncated: end < totalLines,
            content: numbered
        };
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
     * Lists files and folders in a directory.
     */
    async listDirectory(dirPath = '.', depth = 1) {
        const fullPath = this.resolvePath(dirPath);

        if (!fs.existsSync(fullPath)) {
            throw new Error(`Directory not found: ${dirPath}`);
        }

        const stat = fs.statSync(fullPath);
        if (!stat.isDirectory()) {
            throw new Error(`"${dirPath}" is a file, not a directory.`);
        }

        const ignoreList = new Set(['node_modules', '.git', '.gemini', 'package-lock.json']);

        const results = [];
        const scan = (currentDir, currentDepth) => {
            if (currentDepth > depth) return;
            const entries = fs.readdirSync(currentDir, { withFileTypes: true });

            for (const entry of entries) {
                if (ignoreList.has(entry.name)) continue;

                const entryPath = path.join(currentDir, entry.name);
                const relPath = path.relative(fullPath, entryPath);

                if (entry.isDirectory()) {
                    results.push({ name: entry.name, path: relPath, type: 'dir' });
                    if (currentDepth < depth) {
                        scan(entryPath, currentDepth + 1);
                    }
                } else {
                    let size = 0;
                    try {
                        size = fs.statSync(entryPath).size;
                    } catch (e) {}
                    results.push({ name: entry.name, path: relPath, type: 'file', size });
                }
            }
        };

        scan(fullPath, 1);

        return {
            directory: path.relative(this.rootDir, fullPath) || '.',
            entries: results
        };
    }

    /**
     * Recursively searches for text across project files.
     */
    async searchFiles(query, dirPath = '.', maxResults = 25) {
        if (!query || !query.trim()) {
            throw new Error('Search query cannot be empty.');
        }

        const fullPath = this.resolvePath(dirPath);
        const ignoreList = new Set(['node_modules', '.git', '.gemini', 'package-lock.json']);
        const needle = query.toLowerCase();
        const matches = [];

        const scan = (currentDir) => {
            if (matches.length >= maxResults) return;
            const entries = fs.readdirSync(currentDir, { withFileTypes: true });

            for (const entry of entries) {
                if (matches.length >= maxResults) return;
                if (ignoreList.has(entry.name)) continue;

                const entryPath = path.join(currentDir, entry.name);
                if (entry.isDirectory()) {
                    scan(entryPath);
                } else if (entry.isFile()) {
                    // Only search text-like files
                    const ext = path.extname(entry.name).toLowerCase();
                    if (['.exe', '.dll', '.png', '.jpg', '.jpeg', '.gif', '.zip', '.tar', '.gz'].includes(ext)) {
                        continue;
                    }

                    try {
                        const content = fs.readFileSync(entryPath, 'utf8');
                        const lines = content.split(/\r?\n/);
                        for (let i = 0; i < lines.length; i++) {
                            if (matches.length >= maxResults) break;
                            if (lines[i].toLowerCase().includes(needle)) {
                                matches.push({
                                    file: path.relative(this.rootDir, entryPath),
                                    line: i + 1,
                                    text: lines[i].trim().slice(0, 150)
                                });
                            }
                        }
                    } catch (e) {}
                }
            }
        };

        scan(fullPath);

        return {
            query,
            totalMatches: matches.length,
            matches
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
