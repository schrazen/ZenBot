const logger = require('../utils/logger');

class ChannelHistoryService {
    constructor(client, config = null) {
        this.client = client;
        this.config = config;
    }

    /**
     * Determines if a user query is asking about chat history, past conversation,
     * or a summary of what happened in a channel/server.
     */
    isHistoryInquiry(text) {
        if (!text) return false;
        const pattern = /(?:summariz|catch\s*up|recap|what\s+happened|what\s+did\s+\w+\s+say|what\s+were\s+(?:we|they)\s+talking|convo|chat\s+history|who\s+said|past\s+messages|last\s+\d+\s+messages|happening\s+in)/i;
        return pattern.test(text);
    }

    /**
     * Resolves target text channel across all connected Discord servers.
     * Can match channel mentions (<#id>), server names (e.g. "banorant"),
     * channel names (e.g. "general", "acads"), or fallback to currentChannel.
     */
    resolveTargetChannel(query = '', currentChannel = null) {
        if (!this.client) return currentChannel;

        const text = query.toLowerCase();

        const getChannels = (g) => {
            if (!g || !g.channels?.cache) return [];
            return typeof g.channels.cache.values === 'function'
                ? Array.from(g.channels.cache.values())
                : [];
        };

        // 1. Explicit channel mention: <#123456789...> or raw 17-20 digit ID
        const mentionMatch = text.match(/<#(\d+)>/) || text.match(/\b(\d{17,20})\b/);
        if (mentionMatch) {
            const rawId = mentionMatch[1];
            const ch = this.client.channels.cache.get(rawId);
            if (ch && ch.isTextBased()) return ch;

            // Check if the ID is a Guild (Server) ID
            const guild = this.client.guilds.cache.get(rawId);
            if (guild) {
                const chList = getChannels(guild);
                const general = chList.find(c => c.isTextBased() && !c.isVoiceBased() && c.name.toLowerCase().includes('general'));
                if (general) return general;
                const firstText = chList.find(c => c.isTextBased() && !c.isVoiceBased());
                if (firstText) return firstText;
            }
        }

        // 2. Check if a connected server name is mentioned in the query
        for (const [, guild] of this.client.guilds.cache) {
            const guildLower = guild.name.toLowerCase();
            // e.g. "banorant" matches "BANORANTTT", "col" matches "col"
            const isMatch = text.includes(guildLower) ||
                guildLower.includes(text) ||
                (guildLower.length >= 4 && text.includes(guildLower.slice(0, Math.min(5, guildLower.length)))) ||
                (text.length >= 4 && guildLower.includes(text.slice(0, Math.min(5, text.length))));

            if (isMatch) {
                const chList = getChannels(guild);
                // Find a channel in this guild mentioned in the query
                for (const ch of chList) {
                    if (ch.isTextBased() && !ch.isVoiceBased() && (text.includes(ch.name.toLowerCase()) || text.includes('#' + ch.name.toLowerCase()))) {
                        return ch;
                    }
                }
                // Fallback to #general or first readable text channel in this guild
                const general = chList.find(c => c.isTextBased() && !c.isVoiceBased() && c.name.toLowerCase().includes('general'));
                if (general) return general;

                const firstText = chList.find(c => c.isTextBased() && !c.isVoiceBased());
                if (firstText) return firstText;
            }
        }

        // 3. Check if any channel name matches across any guild
        for (const [, guild] of this.client.guilds.cache) {
            const chList = getChannels(guild);
            for (const ch of chList) {
                if (ch.isTextBased() && !ch.isVoiceBased()) {
                    const chName = ch.name.toLowerCase();
                    if (text.includes(chName) || text.includes('#' + chName)) {
                        return ch;
                    }
                }
            }
        }

        // 4. Default to current channel if it's a guild text channel
        if (currentChannel && currentChannel.isTextBased() && !currentChannel.isDMBased()) {
            return currentChannel;
        }

        return null;
    }

    /**
     * Fetches recent messages from a channel and formats them into a clean transcript.
     * Supports optional `afterMessageId` cursor to return only new messages since the last check.
     * @param {TextChannel} channel 
     * @param {number} limit Maximum messages to fetch (max 100)
     * @param {string|null} afterMessageId Optional Discord snowflake cursor
     * @returns {Promise<{transcript: string, messageCount: number, channelName: string, guildName: string, latestMessageId: string|null, latestTimestamp: number|null, newMessageCount: number, newTranscript: string}>}
     */
    async fetchRecentTranscript(channel, limit = 35, afterMessageId = null, ownerIds = []) {
        if (!channel || typeof channel.messages?.fetch !== 'function') {
            return {
                transcript: '',
                messageCount: 0,
                channelName: '',
                guildName: '',
                latestMessageId: null,
                latestTimestamp: null,
                newMessageCount: 0,
                nonOwnerNewMessageCount: 0,
                ownerPostedInNewBatch: false,
                newTranscript: ''
            };
        }

        const ownerIdSet = new Set(
            (Array.isArray(ownerIds) && ownerIds.length > 0
                ? ownerIds
                : (this.config?.discord?.allowedUserIds || [])
            ).map(String)
        );

        const safeLimit = Math.min(Math.max(limit, 5), 100);
        const channelName = channel.name || (typeof channel.isDMBased === 'function' && channel.isDMBased() ? 'Direct Message' : 'channel');
        const guildName = channel.guild?.name || 'Direct Messages';

        const isNewerId = (idA, idB) => {
            if (!idA || !idB) return false;
            const a = String(idA);
            const b = String(idB);
            if (/^\d+$/.test(a) && /^\d+$/.test(b)) {
                return BigInt(a) > BigInt(b);
            }
            return a !== b;
        };

        const formatMessageLine = (m) => {
            const author = m.member?.displayName || m.author?.username || 'Unknown';
            const created = m.createdAt ? new Date(m.createdAt) : new Date(m.createdTimestamp || Date.now());
            const time = created.toLocaleTimeString('en-US', {
                hour: '2-digit',
                minute: '2-digit',
                hour12: true
            });

            let content = m.cleanContent || m.content || '';
            if (m.attachments && m.attachments.size > 0) {
                content += ` [${m.attachments.size} attachment(s)]`;
            }

            const trimmed = content.trim();
            if (!trimmed) return null;
            return `[${time}] ${author}: ${trimmed}`;
        };

        try {
            const fetched = await channel.messages.fetch({ limit: safeLimit });
            // Sort oldest to newest
            const sorted = Array.from(fetched.values()).reverse();

            const latestMsg = sorted[sorted.length - 1] || null;
            const latestMessageId = latestMsg ? String(latestMsg.id) : null;
            const latestTimestamp = latestMsg ? (latestMsg.createdTimestamp || Date.now()) : null;

            const lines = sorted.map(formatMessageLine).filter(Boolean);

            let newMessages = sorted;
            if (afterMessageId) {
                const cursorIdx = sorted.findIndex(m => String(m.id) === String(afterMessageId));
                if (cursorIdx !== -1) {
                    newMessages = sorted.slice(cursorIdx + 1);
                } else {
                    newMessages = sorted.filter(m => isNewerId(m.id, afterMessageId));
                }
            }

            // Exclude bot messages when tracking new user activity after cursor
            const newNonBotMessages = afterMessageId
                ? newMessages.filter(m => !m.author?.bot)
                : newMessages;
            const nonOwnerNewMessages = ownerIdSet.size > 0
                ? newNonBotMessages.filter(m => !ownerIdSet.has(String(m.author?.id || '')))
                : newNonBotMessages;
            const ownerPostedInNewBatch = ownerIdSet.size > 0 && newNonBotMessages.some(m => ownerIdSet.has(String(m.author?.id || '')));
            const newLines = newNonBotMessages.map(formatMessageLine).filter(Boolean);

            return {
                transcript: lines.join('\n'),
                messageCount: lines.length,
                channelName,
                guildName,
                latestMessageId,
                latestTimestamp,
                newMessageCount: afterMessageId ? newLines.length : lines.length,
                nonOwnerNewMessageCount: afterMessageId ? nonOwnerNewMessages.length : lines.length,
                ownerPostedInNewBatch,
                newTranscript: afterMessageId ? newLines.join('\n') : lines.join('\n')
            };
        } catch (err) {
            logger.warn(`Failed to fetch messages from #${channelName}: ${err.message}`);
            return {
                transcript: '',
                messageCount: 0,
                channelName,
                guildName,
                latestMessageId: null,
                latestTimestamp: null,
                newMessageCount: 0,
                nonOwnerNewMessageCount: 0,
                ownerPostedInNewBatch: false,
                newTranscript: '',
                error: err.message
            };
        }
    }
}

module.exports = ChannelHistoryService;

