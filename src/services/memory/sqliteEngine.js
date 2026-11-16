const fs = require('fs');
const os = require('os');
const path = require('path');
const logger = require('../../utils/logger');

let DatabaseSync = null;
try {
    ({ DatabaseSync } = require('node:sqlite'));
} catch (e) {
    DatabaseSync = null;
}

const engineCache = new Map();

class SqliteMemoryEngine {
    constructor(baseDir) {
        this.baseDir = path.resolve(baseDir || path.join(__dirname, '../../../data'));
        this.useInMemory = this._isTempPath(this.baseDir);
        this.dbPath = this.useInMemory ? ':memory:' : path.join(this.baseDir, 'zenbot_memory.sqlite');
        this.db = null;
        this.ready = false;

        this._init();
    }

    _isTempPath(targetDir) {
        const normTarget = path.resolve(targetDir).toLowerCase();
        const normTmp = path.resolve(os.tmpdir()).toLowerCase();
        return normTarget === normTmp || normTarget.startsWith(normTmp + path.sep);
    }

    _init() {
        if (!DatabaseSync) return;
        try {
            if (!this.useInMemory && !fs.existsSync(this.baseDir)) {
                fs.mkdirSync(this.baseDir, { recursive: true });
            }
            this.db = new DatabaseSync(this.dbPath);
            if (!this.useInMemory) {
                this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 3000;');
            }
            this.db.exec(`
                CREATE TABLE IF NOT EXISTS episodic_memories (
                    id TEXT PRIMARY KEY,
                    role TEXT NOT NULL,
                    content TEXT NOT NULL,
                    channel_id TEXT,
                    is_dm INTEGER NOT NULL DEFAULT 0,
                    scope TEXT NOT NULL DEFAULT 'unknown',
                    ts INTEGER NOT NULL,
                    date TEXT
                );
                CREATE INDEX IF NOT EXISTS idx_episodic_ts ON episodic_memories(ts);
                CREATE INDEX IF NOT EXISTS idx_episodic_scope ON episodic_memories(scope, channel_id);
                CREATE VIRTUAL TABLE IF NOT EXISTS episodic_fts USING fts5(
                    id UNINDEXED,
                    content
                );

                CREATE TABLE IF NOT EXISTS facts (
                    id TEXT PRIMARY KEY,
                    category TEXT NOT NULL,
                    fact TEXT NOT NULL,
                    created_at TEXT,
                    updated_at TEXT
                );
                CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5(
                    id UNINDEXED,
                    category,
                    fact
                );
            `);
            this.ready = true;
        } catch (err) {
            logger.warn(`SqliteMemoryEngine unavailable, falling back to JSON search: ${err.message}`);
            this.db = null;
            this.ready = false;
        }
    }

    isReady() {
        return Boolean(this.ready && this.db);
    }

    _buildFtsQuery(rawQuery) {
        const tokens = String(rawQuery || '')
            .toLowerCase()
            .split(/[^a-z0-9_]+/)
            .map(t => t.trim())
            .filter(t => t.length >= 2);
        if (tokens.length === 0) return null;
        const unique = Array.from(new Set(tokens)).slice(0, 10);
        // Quote every token so FTS5 never interprets words like "and"/"or"/"not" as syntax operators
        return unique.map(t => `"${t}"`).join(' OR ');
    }

    syncEpisodicFromJson(entries = []) {
        if (!this.isReady() || !Array.isArray(entries) || entries.length === 0) return;
        try {
            const existsStmt = this.db.prepare('SELECT 1 FROM episodic_memories WHERE id = ?');
            const insertMain = this.db.prepare(
                'INSERT OR IGNORE INTO episodic_memories (id, role, content, channel_id, is_dm, scope, ts, date) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
            );
            const insertFts = this.db.prepare('INSERT INTO episodic_fts (id, content) VALUES (?, ?)');

            for (const entry of entries) {
                if (!entry?.id || !entry?.content) continue;
                if (existsStmt.get(entry.id)) continue;
                const isDmInt = entry.isDM ? 1 : 0;
                const scope = entry.scope || (entry.isDM ? 'dm' : (entry.channelId ? 'guild' : 'unknown'));
                insertMain.run(
                    entry.id,
                    entry.role || 'user',
                    entry.content,
                    entry.channelId || null,
                    isDmInt,
                    scope,
                    Number(entry.ts) || Date.now(),
                    entry.date || new Date().toISOString()
                );
                insertFts.run(entry.id, entry.content);
            }
        } catch (err) {
            logger.warn(`SqliteMemoryEngine syncEpisodicFromJson error: ${err.message}`);
        }
    }

    insertEpisodic(entry) {
        if (!this.isReady() || !entry?.id || !entry?.content) return;
        try {
            const existing = this.db.prepare('SELECT 1 FROM episodic_memories WHERE id = ?').get(entry.id);
            if (existing) return;

            const isDmInt = entry.isDM ? 1 : 0;
            const scope = entry.scope || (entry.isDM ? 'dm' : (entry.channelId ? 'guild' : 'unknown'));
            this.db.prepare(
                'INSERT INTO episodic_memories (id, role, content, channel_id, is_dm, scope, ts, date) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
            ).run(
                entry.id,
                entry.role || 'user',
                entry.content,
                entry.channelId || null,
                isDmInt,
                scope,
                Number(entry.ts) || Date.now(),
                entry.date || new Date().toISOString()
            );
            this.db.prepare('INSERT INTO episodic_fts (id, content) VALUES (?, ?)').run(entry.id, entry.content);
        } catch (err) {
            logger.warn(`SqliteMemoryEngine insertEpisodic error: ${err.message}`);
        }
    }

    searchEpisodicBM25(query, { isDM = undefined, channelId = null, includeGuild = false, topK = 5 } = {}) {
        if (!this.isReady()) return [];
        const matchExpr = this._buildFtsQuery(query);
        if (!matchExpr) return [];

        try {
            const conditions = ['episodic_fts MATCH ?'];
            const params = [matchExpr];

            if (isDM === false) {
                conditions.push("m.is_dm = 0 AND m.scope != 'dm'");
                if (channelId && !includeGuild) {
                    conditions.push('(m.channel_id IS NULL OR m.channel_id = ?)');
                    params.push(channelId);
                }
            } else if (isDM === true && !includeGuild) {
                conditions.push("m.scope != 'guild'");
                conditions.push("m.content NOT LIKE '[From %'");
            }

            const sql = `
                SELECT m.id, m.role, m.content, m.channel_id AS channelId, m.is_dm AS isDmInt, m.scope, m.ts, m.date,
                       bm25(episodic_fts) AS rank
                FROM episodic_fts
                JOIN episodic_memories m ON m.id = episodic_fts.id
                WHERE ${conditions.join(' AND ')}
                ORDER BY rank ASC, m.ts DESC
                LIMIT ?
            `;
            params.push(Math.max(1, topK * 2));

            const rows = this.db.prepare(sql).all(...params);
            return rows.map(r => ({
                id: r.id,
                role: r.role,
                content: r.content,
                channelId: r.channelId,
                isDM: Boolean(r.isDmInt),
                scope: r.scope,
                ts: r.ts,
                date: r.date,
                bm25Score: typeof r.rank === 'number' ? -r.rank : 1
            }));
        } catch (err) {
            logger.warn(`SqliteMemoryEngine searchEpisodicBM25 error: ${err.message}`);
            return [];
        }
    }

    clearEpisodic() {
        if (!this.isReady()) return;
        try {
            this.db.exec('DELETE FROM episodic_fts; DELETE FROM episodic_memories;');
        } catch (err) {
            logger.warn(`SqliteMemoryEngine clearEpisodic error: ${err.message}`);
        }
    }

    getEpisodicCount() {
        if (!this.isReady()) return 0;
        try {
            const row = this.db.prepare('SELECT COUNT(*) AS cnt FROM episodic_memories').get();
            return row?.cnt || 0;
        } catch (e) {
            return 0;
        }
    }

    syncFactsFromJson(facts = []) {
        if (!this.isReady() || !Array.isArray(facts) || facts.length === 0) return;
        try {
            for (const f of facts) {
                if (f?.id && f?.fact) {
                    this.upsertFact(f);
                }
            }
        } catch (err) {
            logger.warn(`SqliteMemoryEngine syncFactsFromJson error: ${err.message}`);
        }
    }

    upsertFact(entry) {
        if (!this.isReady() || !entry?.id || !entry?.fact) return;
        try {
            this.db.prepare(
                'INSERT INTO facts (id, category, fact, created_at, updated_at) VALUES (?, ?, ?, ?, ?) ' +
                'ON CONFLICT(id) DO UPDATE SET category = excluded.category, fact = excluded.fact, updated_at = excluded.updated_at'
            ).run(
                entry.id,
                entry.category || 'General',
                entry.fact,
                entry.createdAt || new Date().toISOString(),
                entry.updatedAt || null
            );
            this.db.prepare('DELETE FROM facts_fts WHERE id = ?').run(entry.id);
            this.db.prepare('INSERT INTO facts_fts (id, category, fact) VALUES (?, ?, ?)').run(
                entry.id,
                entry.category || 'General',
                entry.fact
            );
        } catch (err) {
            logger.warn(`SqliteMemoryEngine upsertFact error: ${err.message}`);
        }
    }

    deleteFact(id) {
        if (!this.isReady() || !id) return;
        try {
            this.db.prepare('DELETE FROM facts WHERE id = ?').run(id);
            this.db.prepare('DELETE FROM facts_fts WHERE id = ?').run(id);
        } catch (err) {
            logger.warn(`SqliteMemoryEngine deleteFact error: ${err.message}`);
        }
    }

    searchFactsBM25(query, topK = 5) {
        if (!this.isReady()) return [];
        const matchExpr = this._buildFtsQuery(query);
        if (!matchExpr) return [];

        try {
            const rows = this.db.prepare(`
                SELECT f.id, f.category, f.fact, f.created_at AS createdAt, f.updated_at AS updatedAt,
                       bm25(facts_fts) AS rank
                FROM facts_fts
                JOIN facts f ON f.id = facts_fts.id
                WHERE facts_fts MATCH ?
                ORDER BY rank ASC
                LIMIT ?
            `).all(matchExpr, Math.max(1, topK));

            return rows.map(r => ({
                id: r.id,
                category: r.category,
                fact: r.fact,
                createdAt: r.createdAt,
                ...(r.updatedAt ? { updatedAt: r.updatedAt } : {})
            }));
        } catch (err) {
            logger.warn(`SqliteMemoryEngine searchFactsBM25 error: ${err.message}`);
            return [];
        }
    }
}

function getSqliteMemoryEngine(storageFilePath) {
    const baseDir = path.resolve(storageFilePath ? path.dirname(storageFilePath) : path.join(__dirname, '../../../data'));
    if (!engineCache.has(baseDir)) {
        engineCache.set(baseDir, new SqliteMemoryEngine(baseDir));
    }
    return engineCache.get(baseDir);
}

module.exports = {
    SqliteMemoryEngine,
    getSqliteMemoryEngine
};
