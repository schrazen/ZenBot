const { splitMessage } = require('../utils/chunker');
const logger = require('../utils/logger');

class MessageHandler {
    constructor({ config, llmManager, memoryManager, commandHandler, client }) {
        this.config = config;
        this.llmManager = llmManager;
        this.memoryManager = memoryManager;
        this.commandHandler = commandHandler;
        this.client = client;
        this.processedMessageIds = new Set();
        this.showTokens = false;
    }

    /**
     * Determines whether the bot should respond to the message.
     * Supports:
     * 1. Direct Messages (DMs) from authorized users.
     * 2. Configured test channel messages.
     * 3. Bot mentions across any server channel.
     */
    shouldHandle(message) {
        if (message.author.bot) return false;

        // Dedup recent message events
        if (this.processedMessageIds.has(message.id)) return false;

        const isAllowedUser = this.config.discord.allowedUserIds.length === 0 ||
            this.config.discord.allowedUserIds.includes(message.author.id);

        if (!isAllowedUser) return false;

        // 1. Check if Direct Message (DM)
        const isDM = !message.guild || (typeof message.channel.isDMBased === 'function' && message.channel.isDMBased());
        if (isDM) {
            return true;
        }

        // 2. Check if explicitly mentioned in a server
        const isMentioned = message.mentions.has(this.client.user.id);
        if (isMentioned) {
            return true;
        }

        // 3. Check if inside the locked/configured channel
        const isConfiguredChannel = Boolean(this.config.discord.channelId && message.channel.id === this.config.discord.channelId);
        if (isConfiguredChannel) {
            return true;
        }

        return false;
    }

    /**
     * Extracts clean query text (removes bot mention tags).
     */
    cleanContent(message) {
        let text = message.content || '';
        const botMentionRegex = new RegExp(`<@!?${this.client.user.id}>`, 'g');
        text = text.replace(botMentionRegex, '').trim();
        return text;
    }

    /**
     * Checks if user requested an inline memory store.
     */
    checkInlineMemory(text) {
        const match = text.match(/^(?:please\s+)?remember(?:\s+that|\s+to)?\s+(.+)$/i);
        if (match && match[1]) {
            const fact = match[1].trim();
            if (fact.length > 4) {
                this.memoryManager.facts.addFact(fact);
                return fact;
            }
        }
        return null;
    }

    async handle(message) {
        if (!this.shouldHandle(message)) return;

        // Mark processed with TTL
        this.processedMessageIds.add(message.id);
        setTimeout(() => this.processedMessageIds.delete(message.id), 2 * 60 * 1000);

        // Check if command
        if (this.commandHandler.isCommand(message)) {
            return await this.commandHandler.handle(message);
        }

        const userQuery = this.cleanContent(message);
        if (!userQuery) return;

        const rememberedInline = this.checkInlineMemory(userQuery);

        logger.info(`Message [${message.guild ? message.guild.name : 'DM'}] from ${message.author.tag}: "${userQuery.slice(0, 80)}"`);

        // Send typing indicator
        try {
            await message.channel.sendTyping();
        } catch (e) {
            // Typing indicator fail is non-fatal
        }

        try {
            // Build multi-tier context with projects and temporal awareness
            const messages = this.memoryManager.buildMessages(message.channel.id, userQuery);

            // Execute LLM inference
            const response = await this.llmManager.chat(messages);

            let replyText = response.content;
            if (rememberedInline) {
                replyText = `*(Noted: "${rememberedInline}")*\n\n` + replyText;
            }

            // Append failover notification if any
            if (response.note) {
                replyText += `\n\n_${response.note}_`;
            }

            // Only append token indicator if explicitly enabled by user (default: false)
            if (this.showTokens) {
                let statsTag = `\n\n\`[${response.provider} • ${response.model} • ${response.latencyMs}ms`;
                if (response.usage?.total_tokens) {
                    statsTag += ` | ${response.usage.total_tokens} tokens`;
                }
                if (response.rateLimits?.remainingTokens) {
                    statsTag += ` | ${response.rateLimits.remainingTokens} TPM left`;
                }
                statsTag += `]\``;
                replyText += statsTag;
            }

            // Split into Discord-compliant chunks
            const chunks = splitMessage(replyText, 1950);

            for (const chunk of chunks) {
                await message.reply(chunk);
            }

            // Persist turns to memory
            this.memoryManager.recordTurn(message.channel.id, 'user', userQuery);
            this.memoryManager.recordTurn(message.channel.id, 'assistant', response.content);

            logger.success(`Replied via ${response.provider} (${response.model}) in ${response.latencyMs}ms`);
        } catch (error) {
            logger.error(`Failed to generate response: ${error.message}`);
            await message.reply(`Error: ${error.message}`);
        }
    }
}

module.exports = MessageHandler;
