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
        this.shortTermTtlMs = 20 * 60 * 1000; // 20 minutes TTL
    }

    /**
     * Records a turn in short-term buffer and persists to episodic memory.
     */
    recordTurn(channelId, role, content) {
        if (!content || !content.trim()) return;

        const now = Date.now();
        // 1. Short-term cache with TTL expiration
        const history = (this.shortTermHistory.get(channelId) || [])
            .filter(turn => (now - turn.ts) < this.shortTermTtlMs);

        history.push({ role, content: content.trim(), ts: now });
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
    buildMessages(channelId, userQuery, liveContext = null, { isDM = false, isOwner = false, activeStudySession = null } = {}) {
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

        // 3. User Profile: Only inject in private DMs or if explicitly asked about Lance's profile/career
        const wantsProfile = isDM || /\b(profile|bio|who is lance|lance'?s background|skills|career)\b/i.test(userQuery);
        if (wantsProfile) {
            const profileContext = this.profile.toPromptContext();
            if (profileContext) {
                systemPrompt += `\n\n[USER PROFILE]\n${profileContext}`;
            }
        }

        // 4. Projects Knowledge: Only inject if query is relevant to projects/portfolio
        const projectContext = this.projects.toPromptContext(userQuery);
        if (projectContext) {
            systemPrompt += `\n\n[PROJECTS KNOWLEDGE]\n${projectContext}`;
        }

        // 5. Relevant Learned Facts
        const factsContext = this.facts.toPromptContext(userQuery);
        if (factsContext) {
            systemPrompt += `\n\n[REMEMBERED FACTS]\n${factsContext}`;
        }

        // 6. Active Study Session Context (if a review quiz is running in this channel)
        if (activeStudySession && activeStudySession.currentCard) {
            systemPrompt += (
                `\n\n[ACTIVE STUDY SESSION IN THIS CHANNEL]\n` +
                `A flashcard review session is currently running in this channel!\n` +
                `- Active Deck: "${activeStudySession.deckName}"\n` +
                `- Current Question: "${activeStudySession.currentCard.description}"\n` +
                `- Target Answer: "${activeStudySession.currentCard.answer}"\n` +
                `- Score So Far: ${activeStudySession.score?.correct || 0} correct, ${activeStudySession.score?.incorrect || 0} incorrect\n` +
                `Be aware that users in this channel might be discussing, clarifying, or commenting on this quiz.`
            );
        }

        // 7. Relevant Past Episodic Memories (brief excerpts only)
        const retrievedMemories = this.episodic.retrieve(userQuery, 2);
        if (retrievedMemories.length > 0) {
            const memorySnippets = retrievedMemories
                .map((m, i) => {
                    const excerpt = m.content.length > 180 ? m.content.slice(0, 180) + '...' : m.content;
                    return `- [${new Date(m.ts).toLocaleDateString()}] ${m.role.toUpperCase()}: ${excerpt}`;
                })
                .join('\n');
            systemPrompt += `\n\n[RELEVANT PAST CONVERSATION EXCERPTS]\n${memorySnippets}`;
        }

        messages.push({ role: 'system', content: systemPrompt });

        // 8. Inject Live Channel / Server Transcript Context if provided
        if (liveContext) {
            messages.push({
                role: 'system',
                content: liveContext
            });

            // If userQuery is short/vague/reactionary, add a directive to resolve intent against recent chat
            const cleanQ = (userQuery || '').replace(/^\[From [^\]]+\]:\s*/i, '').trim();
            const isElliptical = cleanQ.split(/\s+/).length <= 8 ||
                /^(?:why|what|ano|bakit|wait|huh|totoo|explain|look|tingnan|lmao|haha|gago|o\s*shit|namatay)\b/i.test(cleanQ);
            if (isElliptical) {
                messages.push({
                    role: 'system',
                    content: (
                        `[CONTEXT DIRECTIVE]: The user's query is a short or contextual follow-up ("${cleanQ}"). ` +
                        `They are reacting to what was just said above in [RECENT CHANNEL MESSAGES] or [REPLY CONTEXT]. ` +
                        `DO NOT say "Hello! What can I help you with today?" or offer generic helpdesk greetings. ` +
                        `Respond directly and naturally to the topic they are reacting to.`
                    )
                });
            }
        }

        // 9. Inject Short-term rolling history (filtered by 20-min TTL)
        const nowMs = Date.now();
        const recent = (this.shortTermHistory.get(channelId) || [])
            .filter(turn => (nowMs - turn.ts) < this.shortTermTtlMs);

        for (const turn of recent) {
            messages.push({ role: turn.role, content: turn.content });
        }

        // 10. Current turn
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
