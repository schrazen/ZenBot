const fs = require('fs');
const path = require('path');
const logger = require('../../utils/logger');

class FactStore {
    constructor(filePath) {
        this.filePath = filePath;
        this.facts = this._load();
    }

    _load() {
        try {
            if (fs.existsSync(this.filePath)) {
                const data = fs.readFileSync(this.filePath, 'utf8');
                return JSON.parse(data);
            }
        } catch (e) {
            logger.warn(`Could not read facts from ${this.filePath}, starting fresh.`, e.message);
        }
        this._save([]);
        return [];
    }

    _save(data) {
        try {
            const dir = path.dirname(this.filePath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2), 'utf8');
        } catch (e) {
            logger.error(`Failed to save facts: ${e.message}`);
        }
    }

    inferCategory(text) {
        const lower = text.toLowerCase();
        if (/prefer|like|dislike|hate|favorite|favourite|style/.test(lower)) return 'Preference';
        if (/sleep|wake|routine|gym|workout|diet|habit|morning|night/.test(lower)) return 'Routine/Health';
        if (/project|code|work|github|portfolio|bug|build|deploy|stack/.test(lower)) return 'Work/Tech';
        if (/goal|plan|target|aim|dream|future/.test(lower)) return 'Goal';
        return 'General';
    }

    addFact(factText, category = null) {
        const cleanText = factText.trim();
        if (!cleanText) throw new Error('Fact content cannot be empty.');

        const entry = {
            id: `fact_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
            category: category || this.inferCategory(cleanText),
            fact: cleanText,
            createdAt: new Date().toISOString()
        };

        this.facts.push(entry);
        this._save(this.facts);
        logger.info(`Saved fact [${entry.category}]: ${entry.fact}`);
        return entry;
    }

    removeFact(queryOrId) {
        const lower = queryOrId.toLowerCase().trim();
        const initialLen = this.facts.length;

        // Try exact ID match first
        let index = this.facts.findIndex(f => f.id === lower);
        if (index === -1) {
            // Find by substring match
            index = this.facts.findIndex(f => f.fact.toLowerCase().includes(lower));
        }

        if (index !== -1) {
            const removed = this.facts.splice(index, 1)[0];
            this._save(this.facts);
            return removed;
        }

        return null;
    }

    listFacts(limit = 20) {
        return this.facts.slice(-limit);
    }

    search(query, topK = 5) {
        if (!query || !this.facts.length) return [];
        const words = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);

        if (!words.length) return this.facts.slice(-topK);

        const scored = this.facts.map(f => {
            const text = (f.category + ' ' + f.fact).toLowerCase();
            let score = 0;
            for (const word of words) {
                if (text.includes(word)) score += 2;
            }
            return { fact: f, score };
        }).filter(x => x.score > 0);

        scored.sort((a, b) => b.score - a.score);
        return scored.slice(0, topK).map(x => x.fact);
    }

    toPromptContext(relevantQuery = '') {
        let matching = [];
        if (relevantQuery) {
            matching = this.search(relevantQuery, 6);
        }

        // If no matching facts by search, include the most recent 4 facts
        if (matching.length === 0) {
            matching = this.facts.slice(-4);
        }

        if (matching.length === 0) return null;

        const bullets = matching.map(f => `- [${f.category}] ${f.fact}`).join('\n');
        return `Personal Facts & Learned Knowledge:\n${bullets}`;
    }
}

module.exports = FactStore;
