const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { EmbedBuilder } = require('discord.js');
const logger = require('../utils/logger');

class SelfUpgradeService {
    constructor({ config, workspaceService, client, storagePath }) {
        this.config = config;
        this.workspaceService = workspaceService;
        this.client = client;

        this.storagePath = storagePath || path.join(this.workspaceService.rootDir, 'data', 'pending_upgrades.json');
        this.backupDir = path.join(this.workspaceService.rootDir, 'data', 'backups');
        this.proposals = [];

        this.load();
    }

    load() {
        try {
            if (fs.existsSync(this.storagePath)) {
                const raw = JSON.parse(fs.readFileSync(this.storagePath, 'utf8'));
                this.proposals = Array.isArray(raw) ? raw : [];
            } else {
                this.proposals = [];
                this.save();
            }
        } catch (err) {
            logger.warn(`SelfUpgradeService: Could not load pending upgrades: ${err.message}`);
            this.proposals = [];
        }
    }

    save() {
        try {
            const dir = path.dirname(this.storagePath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(this.storagePath, JSON.stringify(this.proposals, null, 2), 'utf8');
        } catch (err) {
            logger.error(`SelfUpgradeService: Failed to save proposals: ${err.message}`);
        }
    }

    /**
     * Checks whether a file path is part of ZenBot's protected source/runtime code
     * and therefore requires Lance's explicit approval before modification.
     */
    requiresPermission(filePath) {
        const normalized = path.normalize(filePath).replace(/\\/g, '/').replace(/^\.\//, '');
        // Allow scratch/notes/data files to be written directly if not core code,
        // but protect all source code, scripts, config, and package manifests.
        if (
            normalized.startsWith('src/') ||
            normalized.startsWith('scripts/') ||
            normalized === 'index.js' ||
            normalized === 'package.json' ||
            normalized.endsWith('.js') ||
            normalized.endsWith('.env')
        ) {
            return true;
        }
        return false;
    }

    /**
     * Generates a compact unified-style diff preview for Discord display.
     */
    buildDiffPreview({ operation, filePath, targetContent, replacementContent, content }) {
        if (operation === 'edit' && targetContent !== undefined && replacementContent !== undefined) {
            const oldLines = targetContent.split(/\r?\n/).slice(0, 12).map(l => `- ${l}`).join('\n');
            const newLines = replacementContent.split(/\r?\n/).slice(0, 15).map(l => `+ ${l}`).join('\n');
            return `${oldLines}\n${newLines}`.slice(0, 900);
        }
        const previewLines = (content || '').split(/\r?\n/).slice(0, 18).map(l => `+ ${l}`).join('\n');
        return previewLines.slice(0, 900);
    }

    /**
     * Validates and stages a self-upgrade proposal awaiting Lance's approval.
     */
    stageProposal({ filePath, operation = 'edit', targetContent = null, replacementContent = null, content = null, reason = '', userId = null, channelId = null }) {
        const fullPath = this.workspaceService.resolvePath(filePath);
        const relPath = path.relative(this.workspaceService.rootDir, fullPath).replace(/\\/g, '/');

        // Pre-validate 'edit' operations so the agent doesn't propose an invalid patch
        if (operation === 'edit') {
            if (!fs.existsSync(fullPath)) {
                throw new Error(`Cannot stage edit for "${relPath}": file does not exist. Use read_file/list_directory to check the path, or use write_file to create a new file.`);
            }
            const original = fs.readFileSync(fullPath, 'utf8');
            if (!targetContent || !original.includes(targetContent)) {
                throw new Error(`Cannot stage edit for "${relPath}": targetContent was not found in the file. Read the exact lines with read_file first so targetContent matches character-for-character.`);
            }
            const occurrences = original.split(targetContent).length - 1;
            if (occurrences > 1) {
                throw new Error(`Cannot stage edit for "${relPath}": targetContent appears ${occurrences} times. Include more surrounding lines so it is unique.`);
            }
        }

        const id = `upg_${Date.now().toString(36).slice(-4)}_${Math.floor(10 + Math.random() * 89)}`;
        const diffPreview = this.buildDiffPreview({ operation, filePath: relPath, targetContent, replacementContent, content });

        const proposal = {
            id,
            filePath: relPath,
            operation,
            reason: reason || `Modify ${relPath} (${operation})`,
            targetContent,
            replacementContent,
            content,
            diffPreview,
            status: 'pending',
            userId,
            channelId,
            createdAt: Date.now()
        };

        this.proposals.push(proposal);
        this.save();

        logger.info(`SelfUpgradeService: Staged proposal [${id}] for ${relPath} (awaiting owner approval).`);
        return proposal;
    }

    getPendingProposals() {
        return this.proposals.filter(p => p.status === 'pending');
    }

    hasPendingProposals() {
        return this.getPendingProposals().length > 0;
    }

    /**
     * Builds a Discord Embed asking Lance for permission to apply the staged proposal(s).
     */
    buildProposalEmbed(proposalsInput) {
        const list = Array.isArray(proposalsInput) ? proposalsInput : [proposalsInput];
        const first = list[0];

        const embed = new EmbedBuilder()
            .setTitle(`🛠️ Permission Request: Self-Upgrade Proposal (${list.map(p => `\`${p.id}\``).join(', ')})`)
            .setColor(0xf4a261)
            .setDescription(
                `I diagnosed a limitation or code change needed and staged **${list.length}** file modification(s) for your review.\n` +
                `**Nothing has been changed on disk yet.**`
            );

        for (const prop of list.slice(0, 3)) {
            embed.addFields(
                {
                    name: `📄 File: \`${prop.filePath}\` (${prop.operation.toUpperCase()} • ID: \`${prop.id}\`)`,
                    value: `**Reason:** ${prop.reason || 'Enhance capability / fix bug'}\n\`\`\`diff\n${prop.diffPreview || '+ (content update)'}\n\`\`\``,
                    inline: false
                }
            );
        }

        embed.addFields({
            name: '✅ How to Respond',
            value: 'Reply **`approve`** (or **`yes`** / **`!approve`**) to apply and verify syntax, or **`reject`** (or **`no`** / **`!reject`**) to cancel.',
            inline: false
        });

        embed.setFooter({ text: 'ZenBot Self-Evolution Gate • Owner Approval Required' })
            .setTimestamp();

        return embed;
    }

    /**
     * Runs `node --check` on a JS file to guarantee syntax validity.
     */
    verifySyntax(fullPath) {
        if (!fullPath.endsWith('.js')) return Promise.resolve({ valid: true });

        return new Promise((resolve) => {
            exec(`node --check "${fullPath}"`, { cwd: this.workspaceService.rootDir, timeout: 10000 }, (error, stdout, stderr) => {
                if (error) {
                    resolve({
                        valid: false,
                        error: (stderr || error.message || 'Syntax check failed').trim()
                    });
                } else {
                    resolve({ valid: true });
                }
            });
        });
    }

    /**
     * Approves and applies a specific proposal ID or all currently pending proposals.
     */
    async approve(idOrAll = null) {
        const pending = this.getPendingProposals();
        if (pending.length === 0) {
            return { success: false, message: 'There are no pending self-upgrade proposals to approve.' };
        }

        let targets = [];
        if (!idOrAll || idOrAll === 'all' || idOrAll === 'latest') {
            targets = pending;
        } else {
            const match = pending.find(p => p.id.toLowerCase() === idOrAll.toLowerCase());
            if (!match) {
                return { success: false, message: `No pending proposal found with ID \`${idOrAll}\`.` };
            }
            targets = [match];
        }

        if (!fs.existsSync(this.backupDir)) {
            fs.mkdirSync(this.backupDir, { recursive: true });
        }

        const applied = [];
        const failed = [];

        for (const prop of targets) {
            const fullPath = this.workspaceService.resolvePath(prop.filePath);
            let backupPath = null;
            const existedBefore = fs.existsSync(fullPath);

            try {
                // 1. Create backup if file exists
                if (existedBefore) {
                    const safeName = prop.filePath.replace(/[\\/]/g, '__');
                    backupPath = path.join(this.backupDir, `${Date.now()}_${safeName}.bak`);
                    fs.copyFileSync(fullPath, backupPath);
                }

                // 2. Apply modification
                if (prop.operation === 'edit') {
                    await this.workspaceService.editFile(prop.filePath, prop.targetContent, prop.replacementContent);
                } else {
                    await this.workspaceService.writeFile(prop.filePath, prop.content);
                }

                // 3. Verify syntax with `node --check`
                const check = await this.verifySyntax(fullPath);
                if (!check.valid) {
                    // Rollback immediately!
                    if (existedBefore && backupPath && fs.existsSync(backupPath)) {
                        fs.copyFileSync(backupPath, fullPath);
                    } else if (!existedBefore && fs.existsSync(fullPath)) {
                        fs.unlinkSync(fullPath);
                    }
                    prop.status = 'failed';
                    prop.error = check.error;
                    failed.push({ id: prop.id, filePath: prop.filePath, error: `Syntax error (auto-rolled back): ${check.error}` });
                    continue;
                }

                // 4. Hot-clear Node require cache for the updated file
                try {
                    const resolvedReq = require.resolve(fullPath);
                    if (require.cache[resolvedReq]) {
                        delete require.cache[resolvedReq];
                    }
                } catch (e) {}

                prop.status = 'approved';
                prop.appliedAt = Date.now();
                prop.backupPath = backupPath ? path.relative(this.workspaceService.rootDir, backupPath) : null;
                applied.push(prop);
                logger.success(`SelfUpgradeService: Applied and verified proposal [${prop.id}] on ${prop.filePath}`);
            } catch (err) {
                if (existedBefore && backupPath && fs.existsSync(backupPath)) {
                    try { fs.copyFileSync(backupPath, fullPath); } catch (e) {}
                }
                prop.status = 'failed';
                prop.error = err.message;
                failed.push({ id: prop.id, filePath: prop.filePath, error: err.message });
            }
        }

        this.save();

        // If changes were applied successfully, schedule an automatic background restart
        // so the running Node.js process picks up the new code without manual intervention.
        if (applied.length > 0) {
            setTimeout(() => {
                try {
                    const ctlScript = path.join(this.workspaceService.rootDir, 'scripts', 'ctl.js');
                    if (fs.existsSync(ctlScript)) {
                        const child = exec(`node "${ctlScript}" restart bg`, {
                            cwd: this.workspaceService.rootDir,
                            windowsHide: true
                        });
                        logger.info(`SelfUpgradeService: Scheduled background bot restart to activate upgraded code.`);
                    }
                } catch (restartErr) {
                    logger.warn(`SelfUpgradeService: Auto-restart attempt warning: ${restartErr.message}`);
                }
            }, 2500);
        }

        return {
            success: applied.length > 0,
            applied,
            failed
        };
    }

    /**
     * Rejects/cancels a specific proposal ID or all currently pending proposals.
     */
    reject(idOrAll = null) {
        const pending = this.getPendingProposals();
        if (pending.length === 0) {
            return { success: false, message: 'There are no pending self-upgrade proposals to reject.' };
        }

        let targets = [];
        if (!idOrAll || idOrAll === 'all' || idOrAll === 'latest') {
            targets = pending;
        } else {
            const match = pending.find(p => p.id.toLowerCase() === idOrAll.toLowerCase());
            if (!match) {
                return { success: false, message: `No pending proposal found with ID \`${idOrAll}\`.` };
            }
            targets = [match];
        }

        for (const prop of targets) {
            prop.status = 'rejected';
            prop.rejectedAt = Date.now();
        }

        this.save();
        return {
            success: true,
            rejected: targets
        };
    }
}

module.exports = SelfUpgradeService;

