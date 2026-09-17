const fs = require('fs');
const path = require('path');
const logger = require('../../utils/logger');

const STOP_WORDS = new Set([
    'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'any', 'can',
    'her', 'was', 'one', 'our', 'out', 'day', 'get', 'has', 'him', 'his',
    'how', 'man', 'new', 'now', 'old', 'see', 'two', 'way', 'who', 'boy',
    'did', 'its', 'let', 'put', 'say', 'she', 'too', 'use', 'what', 'with',
    'your', 'this', 'that', 'from', 'they', 'them', 'have', 'more', 'some',
    'will', 'just', 'like', 'know', 'about', 'would', 'there', 'their',
    'been', 'then', 'into', 'come', 'make', 'when', 'which', 'could',
    'also', 'than', 'other', 'over', 'such', 'even', 'most', 'play', 'team'
]);

class EpisodicMemory {
    constructor(filePath, maxEntries = 500) {
        this.filePath = filePath;
        this.maxEntries = maxEntries;
        this.memories = this._load();
    }

    _load() {
        try {
            if (fs.existsSync(this.filePath)) {
                const data = fs.readFileSync(this.filePath, 'utf8');
                return JSON.parse(data);
            }
        } catch (e) {
            logger.warn(`Could not read memories from ${this.filePath}, starting fresh.`, e.message);
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
            logger.error(`Failed to save memories: ${e.message}`);
        }
    }

    /**
     * Store a new conversation turn into long-term episodic memory.
     */
    add(role, content) {
        if (!content || !content.trim()) return null;

        const cleanContent = content.trim();
        const storedContent = (role === 'assistant' && cleanContent.length > 250)
            ? cleanContent.slice(0, 250) + '...'
            : cleanContent;

        const entry = {
            id: `mem_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
            role,
            content: storedContent,
            ts: Date.now(),
            date: new Date().toISOString()
        };

        this.memories.push(entry);

        // Keep size within bounds
        if (this.memories.length > this.maxEntries) {
            this.memories = this.memories.slice(-this.maxEntries);
        }

        this._save(this.memories);
        return entry;
    }

    /**
     * Hybrid relevance retrieval: keyword frequency + phrase match + recency decay.
     */
    retrieve(query, topK = 2) {
        if (!query || !this.memories.length) return [];

        const cleanQuery = query.toLowerCase();
        const terms = cleanQuery.split(/[^a-z0-9]+/).filter(t => t.length > 2 && !STOP_WORDS.has(t));
        if (!terms.length && cleanQuery.length < 8) return [];

        const now = Date.now();
        const oneDayMs = 24 * 60 * 60 * 1000;

        const scored = this.memories.map(entry => {
            const text = (entry.content || '').toLowerCase();
            let score = 0;

            // 1. Exact phrase match bonus (meaningful phrases)
            if (cleanQuery.length > 10 && text.includes(cleanQuery)) {
                score += 15;
            }

            // 2. Term frequency matching on non-stop words
            for (const term of terms) {
                const count = (text.match(new RegExp('\\b' + term, 'gi')) || []).length;
                if (count > 0) {
                    score += count * 4;
                }
            }

            // 3. Recency boost (events from last 24h get a minor boost)
            const ageDays = (now - entry.ts) / oneDayMs;
            if (ageDays < 7) {
                score += Math.max(0, 2 - ageDays * 0.2);
            }

            return { entry, score };
        }).filter(item => item.score >= 6);

        // Sort descending by relevance score
        scored.sort((a, b) => b.score - a.score);

        return scored.slice(0, topK).map(s => s.entry);
    }

    clear() {
        this.memories = [];
        this._save([]);
        logger.info('Episodic memories cleared.');
    }

    getStats() {
        return {
            totalMemories: this.memories.length,
            oldest: this.memories[0]?.date || null,
            newest: this.memories[this.memories.length - 1]?.date || null
        };
    }
}

module.exports = EpisodicMemory;
