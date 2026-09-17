const logger = require('../utils/logger');

class ChannelHistoryService {
    constructor(client) {
        this.client = client;
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

        // 1. Explicit channel mention: <#123456789...>
        const mentionMatch = text.match(/<#(\d+)>/);
        if (mentionMatch) {
            const ch = this.client.channels.cache.get(mentionMatch[1]);
            if (ch && ch.isTextBased()) return ch;
        }

        // 2. Check if a connected server name is mentioned in the query
        for (const [, guild] of this.client.guilds.cache) {
            const guildLower = guild.name.toLowerCase();
            // e.g. "banorant" matches "BANORANTTT"
            if (text.includes(guildLower) || (guildLower.length >= 4 && text.includes(guildLower.slice(0, 5)))) {
                // Find a channel in this guild mentioned in the query
                for (const [, ch] of guild.channels.cache) {
                    if (ch.isTextBased() && !ch.isVoiceBased() && text.includes(ch.name.toLowerCase())) {
                        return ch;
                    }
                }
                // Fallback to #general or first readable text channel in this guild
                const general = guild.channels.cache.find(c => c.isTextBased() && !c.isVoiceBased() && c.name.toLowerCase().includes('general'));
                if (general) return general;

                const firstText = guild.channels.cache.find(c => c.isTextBased() && !c.isVoiceBased());
                if (firstText) return firstText;
            }
        }

        // 3. Check if any channel name matches across any guild
        for (const [, guild] of this.client.guilds.cache) {
            for (const [, ch] of guild.channels.cache) {
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
     * @param {TextChannel} channel 
     * @param {number} limit Maximum messages to fetch (max 100)
     * @returns {Promise<{transcript: string, messageCount: number, channelName: string, guildName: string}>}
     */
    async fetchRecentTranscript(channel, limit = 35) {
        if (!channel || typeof channel.messages?.fetch !== 'function') {
            return { transcript: '', messageCount: 0, channelName: '', guildName: '' };
        }

        const safeLimit = Math.min(Math.max(limit, 5), 100);
        const channelName = channel.name || 'channel';
        const guildName = channel.guild?.name || 'Server';

        try {
            const fetched = await channel.messages.fetch({ limit: safeLimit });
            // Sort oldest to newest
            const sorted = Array.from(fetched.values()).reverse();

            const lines = sorted.map(m => {
                const author = m.member?.displayName || m.author.username;
                const time = m.createdAt.toLocaleTimeString('en-US', {
                    hour: '2-digit',
                    minute: '2-digit',
                    hour12: true
                });

                let content = m.cleanContent || m.content || '';
                if (m.attachments.size > 0) {
                    content += ` [${m.attachments.size} attachment(s)]`;
                }

                return `[${time}] ${author}: ${content.trim()}`;
            }).filter(l => !l.endsWith(': '));

            return {
                transcript: lines.join('\n'),
                messageCount: lines.length,
                channelName,
                guildName
            };
        } catch (err) {
            logger.warn(`Failed to fetch messages from #${channelName}: ${err.message}`);
            return { transcript: '', messageCount: 0, channelName, guildName, error: err.message };
        }
    }
}

module.exports = ChannelHistoryService;
