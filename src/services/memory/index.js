const ProfileManager = require('./profile');
const FactStore = require('./factStore');
const ProjectStore = require('./projectStore');
const EpisodicMemory = require('./episodic');
const PreferenceStore = require('./preferenceStore');
const logger = require('../../utils/logger');

class MemoryManager {
    constructor(config) {
        this.config = config;
        this.profile = new ProfileManager(config.paths.profile);
        this.facts = new FactStore(config.paths.facts);
        this.projects = new ProjectStore(config.paths.projects);
        this.episodic = new EpisodicMemory(config.paths.memories);
        this.preferences = new PreferenceStore(config.paths.preferences);

        // In-memory rolling short-term conversation cache: channelId -> [{role, content, ts}]
        this.shortTermHistory = new Map();
        this.maxShortTermTurns = 10;
        this.shortTermTtlMs = 20 * 60 * 1000; // 20 minutes TTL
    }

    /**
     * Records a turn in short-term buffer and persists to episodic memory with channel/DM scope.
     */
    recordTurn(channelId, role, content, meta = {}) {
        if (!content || !content.trim()) return;
        const cleaned = content.replace(/\[Called tool\s+[a-z0-9_]+\s*\([\s\S]*?\)\]/gi, '').trim();
        if (!cleaned) return;

        const now = Date.now();
        // 1. Short-term cache with TTL expiration
        const history = (this.shortTermHistory.get(channelId) || [])
            .filter(turn => (now - turn.ts) < this.shortTermTtlMs);

        history.push({ role, content: cleaned, ts: now });
        if (history.length > this.maxShortTermTurns) {
            history.splice(0, history.length - this.maxShortTermTurns);
        }
        this.shortTermHistory.set(channelId, history);

        // 2. Long-term episodic memory (with DM vs guild isolation)
        this.episodic.add(role, cleaned, {
            channelId,
            isDM: Boolean(meta.isDM)
        });
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
    buildMessages(channelId, userQuery, liveContext = null, { isDM = false, isOwner = false, activeStudySession = null, ownerAvailabilityState = null } = {}) {
        const messages = [];

        // 1. Base System Prompt (scope & humor-level aware)
        let systemPrompt = typeof this.config.persona.getSystemPrompt === 'function'
            ? this.config.persona.getSystemPrompt(this.config.persona.humorIntensity, { isDM })
            : this.config.persona.baseSystemPrompt;

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

        if (ownerAvailabilityState) {
            systemPrompt += (
                `\n[OWNER LIVE AVAILABILITY STATUS]\n` +
                `- Lance (schrazen) is currently: ${ownerAvailabilityState.state} (${ownerAvailabilityState.reason}).\n` +
                `- CRITICAL: When Lance is AVAILABLE or LIKELY_AVAILABLE, NEVER claim, joke, or imply to his friends that he is AFK, offline, away, or not answering.`
            );
        }

        // 2b. Autonomous Agent Self-Awareness & Environment Context (Owner Only)
        if (isOwner) {
            systemPrompt += (
                `\n\n[AUTONOMOUS AGENT CAPABILITIES & SELF-AWARENESS]\n` +
                `- You are speaking with your owner and creator, Lance.\n` +
                `- Your live codebase and workspace directory is \`d:\\xamp awawawa\\htdocs\\zen\`, plus read-only Personal Vault access to Lance's \`Documents\`, \`Downloads\`, and \`Desktop\` folders. You HAVE full tool access (\`list_directory\`, \`find_files\`, \`search_files\`, \`read_file\`, \`send_file_to_owner\`, \`propose_self_upgrade\`, \`edit_file\`, \`write_file\`, \`run_command\`, \`web_search\`, \`fetch_web_page\`, \`read_discord_channel\`, \`post_discord_message\`, \`set_owner_availability\`, \`set_persona_mode\`, \`remember_fact\`, \`save_preference\`, \`search_memory\`, \`update_project_task\`, \`schedule_automation\`, \`list_automations\`, \`delete_automation\`).\n` +
                `- \`read_file\` natively extracts text from PDF files (no need for shell scripts or installing packages).\n` +
                `- PROACTIVE MEMORY RULE: Whenever Lance shares an important personal fact, exam/deadline, server detail, account note, or recurring preference in conversation, proactively call \`remember_fact\` or \`save_preference\` so you remember it across sessions without him needing to type "remember that".\n` +
                `- PERSONAL VAULT & FILE DELIVERY: When Lance asks for a document, PDF, reviewer, or file from his PC (e.g. Downloads, Documents, Desktop), use \`find_files\` or \`list_directory\` to locate it and \`send_file_to_owner\` to upload it directly to his DM.\n` +
                `- Connected Discord Servers: \`col\` (ID: 873791689939107861), \`rodericks\` (ID: 1422544961597083712), and \`BANORANTTT\` (ID: 1484106877708013608). Use \`read_discord_channel\` to inspect server messages, and \`post_discord_message\` ONLY when Lance explicitly commands you to post/send a message to a target channel/server. NEVER call \`post_discord_message\` during normal conversation or banter.\n` +
                `- If Lance tells you his status is active/online, or tells you to stop replying to his friends with AFK messages, call \`set_owner_availability({ "state": "online" })\` immediately.\n` +
                `- AUTONOMOUS EXECUTION RULE (NEVER BE MESSAGE-RELIANT): When Lance asks you to check, debug, fix, or implement something, execute ALL required tool calls (\`search_files\` -> \`read_file\` -> \`propose_self_upgrade\` / \`edit_file\` / \`run_command\`) in this SAME turn until the job is finished. NEVER reply with "Let me check...", "I'll patch that now...", or "One sec..." without calling the actual tool right then!\n` +
                `- SELF-HEALING & SELF-UPGRADE RULE (WITH OWNER PERMISSION): If Lance asks you to do something you cannot currently do, or if you encounter a bug/limitation in your own files (\`src/\`), DO NOT just say "I can't do that." Instead, inspect your own source code using \`search_files\` and \`read_file\`, figure out the fix or new capability needed, and call \`propose_self_upgrade\` (or \`edit_file\` / \`write_file\`).\n` +
                `- Any change to your source code automatically stages a Permission Request card for Lance so he can review the diff and reply \`approve\` (or \`yes\`) before any code is modified on disk.`
            );
        }

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
        const factsContext = this.facts.toPromptContext(userQuery, { isDM });
        if (factsContext) {
            systemPrompt += `\n\n[REMEMBERED FACTS]\n${factsContext}`;
        }

        // 6. Lance's Learned Preferences & Habits
        const prefsContext = this.preferences.toPromptContext();
        if (prefsContext) {
            systemPrompt += `\n\n${prefsContext}`;
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

        // 7. Relevant Past Episodic Memories (brief excerpts only, isolated by DM/guild scope)
        const retrievedMemories = this.episodic.retrieve(userQuery, 2, { isDM, channelId });
        if (retrievedMemories.length > 0) {
            const memorySnippets = retrievedMemories
                .map((m, i) => {
                    const excerpt = m.content.length > 350 ? m.content.slice(0, 350) + '...' : m.content;
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

        // 9. Inject Short-term rolling history ONLY when liveContext is unavailable (avoids duplicating 15 messages)
        if (!liveContext) {
            const nowMs = Date.now();
            const recent = (this.shortTermHistory.get(channelId) || [])
                .filter(turn => (nowMs - turn.ts) < this.shortTermTtlMs);

            for (const turn of recent) {
                messages.push({ role: turn.role, content: turn.content });
            }
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
