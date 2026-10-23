const fs = require('fs');
const path = require('path');
const logger = require('../../utils/logger');

class PreferenceStore {
    constructor(storagePath) {
        this.storagePath = storagePath || path.join(__dirname, '../../../data/preferences.json');
        this.preferences = [];
        this.load();
    }

    load() {
        try {
            if (fs.existsSync(this.storagePath)) {
                const data = JSON.parse(fs.readFileSync(this.storagePath, 'utf8'));
                this.preferences = Array.isArray(data) ? data : [];
            } else {
                this.preferences = [];
                this.save();
            }
        } catch (e) {
            logger.warn(`Could not load preferences from ${this.storagePath}: ${e.message}`);
            this.preferences = [];
        }
    }

    save() {
        try {
            const dir = path.dirname(this.storagePath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(this.storagePath, JSON.stringify(this.preferences, null, 2), 'utf8');
        } catch (e) {
            logger.error(`Failed to save preferences: ${e.message}`);
        }
    }

    /**
     * Adds a persistent preference rule.
     */
    addPreference(rule, category = 'workflow', source = 'manual') {
        if (!rule || typeof rule !== 'string') return null;
        const cleanRule = rule.trim();
        if (cleanRule.length < 5) return null;

        // Dedup
        const existing = this.preferences.find(p => p.rule.toLowerCase() === cleanRule.toLowerCase());
        if (existing) return existing;

        const item = {
            id: `pref_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
            rule: cleanRule,
            category: category.toLowerCase(),
            source,
            createdAt: Date.now()
        };

        this.preferences.push(item);
        this.save();
        logger.info(`Learned new preference [${item.id}]: "${cleanRule}"`);
        return item;
    }

    listPreferences() {
        return [...this.preferences].sort((a, b) => b.createdAt - a.createdAt);
    }

    deletePreference(idOrIndex) {
        const query = String(idOrIndex).trim().toLowerCase();
        let idx = this.preferences.findIndex(p => p.id.toLowerCase() === query);

        if (idx === -1 && /^\d+$/.test(query)) {
            const num = parseInt(query, 10) - 1;
            if (num >= 0 && num < this.preferences.length) {
                idx = num;
            }
        }

        if (idx !== -1) {
            const removed = this.preferences.splice(idx, 1)[0];
            this.save();
            logger.info(`Deleted preference [${removed.id}]`);
            return { success: true, removed };
        }

        return { success: false, message: `No preference found matching "${idOrIndex}".` };
    }

    /**
     * Scans user message for feedback or rule commands like:
     * "always use TypeScript", "don't use classes", "i prefer X over Y", "from now on, ..."
     */
    detectFeedbackRule(text) {
        if (!text || typeof text !== 'string') return null;
        const clean = text.trim();

        // Pattern 1: "from now on, <rule>" or "starting now, <rule>"
        const p1 = clean.match(/^(?:from now on|starting now|moving forward),?\s+(.+)$/i);
        if (p1 && p1[1].length > 5) return { rule: p1[1].trim(), category: 'workflow' };

        // Pattern 2: "always <rule>" or "never <rule>"
        const p2 = clean.match(/^(?:always|never)\s+(.+)$/i);
        if (p2 && p2[1].length > 6 && !clean.endsWith('?')) {
            return { rule: clean, category: 'coding_style' };
        }

        // Pattern 3: "i prefer <rule>" or "gusto ko <rule>"
        const p3 = clean.match(/^(?:i prefer|mas gusto ko|gusto ko)\s+(.+)$/i);
        if (p3 && p3[1].length > 5) return { rule: `Prefer: ${p3[1].trim()}`, category: 'preference' };

        // Pattern 4: "don't <rule>, do <alt>"
        const p4 = clean.match(/^(?:don't|huwag|wag)\s+(.+?)(?:,\s*(?:use|do|gawin)\s+(.+))?$/i);
        if (p4 && p4[1].length > 5) {
            const rule = p4[2] ? `Avoid ${p4[1].trim()}; use ${p4[2].trim()}` : `Avoid ${p4[1].trim()}`;
            return { rule, category: 'correction' };
        }

        return null;
    }

    /**
     * Generates markdown system prompt context with learned rules.
     */
    toPromptContext() {
        if (this.preferences.length === 0) return '';

        const lines = this.preferences.map((p, i) => `${i + 1}. ${p.rule}`);
        return (
            `[LANCE'S LEARNED PREFERENCES & HABITS]\n` +
            `You have learned the following rules and preferences from Lance over time. ALWAYS adhere to these:\n` +
            lines.join('\n')
        );
    }

    getPromptContext() {
        return this.toPromptContext();
    }
}

module.exports = PreferenceStore;

