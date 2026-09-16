const ProfileManager = require('./profile');
const FactStore = require('./factStore');
const ProjectStore = require('./projectStore');
const EpisodicMemory = require('./episodic');
const logger = require('../../utils/logger');

class MemoryManager {
    constructor(config) {
        this.config = config;
        this.profile = new ProfileManager(config.paths.profile);
        this.facts = new FactStore(config.paths.facts);
        this.projects = new ProjectStore(config.paths.projects);
        this.episodic = new EpisodicMemory(config.paths.memories);

        // In-memory rolling short-term conversation cache: channelId -> [{role, content, ts}]
        this.shortTermHistory = new Map();
        this.maxShortTermTurns = 10;
    }

    /**
     * Records a turn in short-term buffer and persists to episodic memory.
     */
    recordTurn(channelId, role, content) {
        if (!content || !content.trim()) return;

        // 1. Short-term cache
        const history = this.shortTermHistory.get(channelId) || [];
        history.push({ role, content: content.trim(), ts: Date.now() });
        if (history.length > this.maxShortTermTurns) {
            history.splice(0, history.length - this.maxShortTermTurns);
        }
        this.shortTermHistory.set(channelId, history);

        // 2. Long-term episodic memory
        this.episodic.add(role, content);
    }

    /**
     * Clears short-term buffer for a specific channel.
     */
    clearShortTerm(channelId) {
        this.shortTermHistory.delete(channelId);
        logger.info(`Cleared short-term conversation history for channel: ${channelId}`);
    }

    /**
     * Builds full context messages array for LLM completion.
     */
    buildMessages(channelId, userQuery) {
        const messages = [];

        // 1. Base System Prompt
        let systemPrompt = this.config.persona.baseSystemPrompt;

        // 2. Inject Current Time & Date Context
        const now = new Date();
        const timeStr = now.toLocaleString('en-US', {
            weekday: 'long',
            month: 'short',
            day: 'numeric',
            year: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
            hour12: true
        });
        systemPrompt += `\n\n[TEMPORAL CONTEXT]\nCurrent Time: ${timeStr}`;

        // 3. Inject User Profile (Tier 1)
        const profileContext = this.profile.toPromptContext();
        if (profileContext) {
            systemPrompt += `\n\n[USER PROFILE]\n${profileContext}`;
        }

        // 4. Inject Projects Knowledge (Specialized Domain Tier)
        const projectContext = this.projects.toPromptContext(userQuery);
        if (projectContext) {
            systemPrompt += `\n\n[PROJECTS KNOWLEDGE]\n${projectContext}`;
        }

        // 5. Inject Relevant Learned Facts (Tier 2)
        const factsContext = this.facts.toPromptContext(userQuery);
        if (factsContext) {
            systemPrompt += `\n\n[REMEMBERED FACTS]\n${factsContext}`;
        }

        messages.push({ role: 'system', content: systemPrompt });

        // 6. Inject Relevant Past Episodic Memories (Tier 3)
        const retrievedMemories = this.episodic.retrieve(userQuery, 3);
        if (retrievedMemories.length > 0) {
            const memorySnippets = retrievedMemories
                .map((m, i) => `[Past interaction ${i + 1} (${new Date(m.ts).toLocaleDateString()})] ${m.role.toUpperCase()}: ${m.content}`)
                .join('\n');
            messages.push({
                role: 'system',
                content: `Relevant past conversation context retrieved from memory:\n${memorySnippets}`
            });
        }

        // 7. Inject Short-term rolling history
        const recent = this.shortTermHistory.get(channelId) || [];
        for (const turn of recent) {
            messages.push({ role: turn.role, content: turn.content });
        }

        // 8. Current turn
        messages.push({ role: 'user', content: userQuery });

        return messages;
    }

    getStats() {
        return {
            factsCount: this.facts.facts.length,
            projectsCount: this.projects.projects.length,
            memoriesCount: this.episodic.memories.length,
            profileUpdated: this.profile.profile.updatedAt
        };
    }
}

module.exports = MemoryManager;
