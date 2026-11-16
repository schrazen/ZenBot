const fs = require('fs');
const path = require('path');
const { writeJsonAtomicSync } = require('../../utils/atomicWrite');
const { getSqliteMemoryEngine } = require('./sqliteEngine');
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
        this.sqlite = getSqliteMemoryEngine(this.filePath);
        this.sqlite.syncEpisodicFromJson(this.memories);
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
            writeJsonAtomicSync(this.filePath, data);
        } catch (e) {
            logger.error(`Failed to save memories: ${e.message}`);
        }
    }

    /**
     * Store a new conversation turn into long-term episodic memory with scope metadata.
     */
    add(role, content, meta = {}) {
        if (!content || !content.trim()) return null;

        const cleanContent = content.trim();
        const storedContent = (role === 'assistant' && cleanContent.length > 800)
            ? cleanContent.slice(0, 800) + '...'
            : cleanContent;

        const isDM = Boolean(meta.isDM);
        const channelId = meta.channelId || null;
        const scope = isDM ? 'dm' : (channelId ? 'guild' : 'unknown');

        const entry = {
            id: `mem_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
            role,
            content: storedContent,
            channelId,
            isDM,
            scope,
            ts: Date.now(),
            date: new Date().toISOString()
        };

        this.memories.push(entry);

        // Keep JSON working set compact while SQLite retains full searchable history
        if (this.memories.length > this.maxEntries) {
            this.memories = this.memories.slice(-this.maxEntries);
        }

        this.sqlite?.insertEpisodic(entry);
        this._save(this.memories);
        return entry;
    }

    /**
     * Hybrid SQLite FTS5 (BM25) + Reciprocal Rank Fusion retrieval with DM/Guild scope isolation:
     * - In public guild channels (`isDM === false`), strictly exclude private DM memories.
     * - In private DMs (`isDM === true`), exclude noisy public server banter unless `includeGuild` is set.
     */
    retrieve(query, topK = 2, options = {}) {
        if (!query || (!this.memories.length && !(this.sqlite?.getEpisodicCount?.() > 0))) return [];

        const cleanQuery = query.toLowerCase();
        const terms = cleanQuery.split(/[^a-z0-9]+/).filter(t => t.length > 2 && !STOP_WORDS.has(t));
        if (!terms.length && cleanQuery.length < 8) return [];

        const now = Date.now();
        const oneDayMs = 24 * 60 * 60 * 1000;
        const filterIsDM = options.isDM;
        const includeGuild = Boolean(options.includeGuild);

        const eligible = this.memories.filter(entry => {
            if (filterIsDM === false) {
                if (entry.isDM === true || entry.scope === 'dm') return false;
                if (options.channelId && entry.channelId && entry.channelId !== options.channelId && !includeGuild) {
                    return false;
                }
            } else if (filterIsDM === true && !includeGuild) {
                if (entry.scope === 'guild') return false;
                if (/^\[From\s+[^\]]+\]:/i.test(entry.content || '')) return false;
            }
            return true;
        });

        const scored = eligible.map(entry => {
            const text = (entry.content || '').toLowerCase();
            let score = 0;

            if (cleanQuery.length > 10 && text.includes(cleanQuery)) {
                score += 15;
            }

            for (const term of terms) {
                const count = (text.match(new RegExp('\\b' + term, 'gi')) || []).length;
                if (count > 0) {
                    score += count * 4;
                }
            }

            if (filterIsDM === true && entry.scope === 'dm') {
                score += 3;
            } else if (options.channelId && entry.channelId === options.channelId) {
                score += 2;
            }

            const ageDays = (now - entry.ts) / oneDayMs;
            if (ageDays < 7) {
                score += Math.max(0, 2 - ageDays * 0.2);
            }

            return { entry, score };
        }).filter(item => item.score >= 6);

        scored.sort((a, b) => b.score - a.score);

        // Query SQLite FTS5 BM25 archive and combine via Reciprocal Rank Fusion (RRF)
        const bm25Results = this.sqlite?.isReady()
            ? this.sqlite.searchEpisodicBM25(query, {
                isDM: filterIsDM,
                channelId: options.channelId,
                includeGuild,
                topK: Math.max(4, topK * 2)
            })
            : [];

        if (bm25Results.length === 0) {
            return scored.slice(0, topK).map(s => s.entry);
        }

        const k = 60;
        const rrfScores = new Map();
        const byId = new Map();

        scored.slice(0, topK * 2).forEach((item, idx) => {
            const e = item.entry;
            byId.set(e.id, e);
            rrfScores.set(e.id, (rrfScores.get(e.id) || 0) + (1 / (k + idx + 1)));
        });

        bm25Results.forEach((e, idx) => {
            if (!byId.has(e.id)) byId.set(e.id, e);
            rrfScores.set(e.id, (rrfScores.get(e.id) || 0) + (1 / (k + idx + 1)));
        });

        return Array.from(rrfScores.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, topK)
            .map(([id]) => byId.get(id))
            .filter(Boolean);
    }

    clear() {
        this.memories = [];
        this.sqlite?.clearEpisodic();
        this._save([]);
        logger.info('Episodic memories cleared.');
    }

    getStats() {
        const sqliteCount = this.sqlite?.isReady() ? this.sqlite.getEpisodicCount() : this.memories.length;
        return {
            totalMemories: Math.max(this.memories.length, sqliteCount),
            oldest: this.memories[0]?.date || null,
            newest: this.memories[this.memories.length - 1]?.date || null
        };
    }
}

module.exports = EpisodicMemory;
