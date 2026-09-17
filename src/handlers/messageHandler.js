const { splitMessage } = require('../utils/chunker');
const logger = require('../utils/logger');

class MessageHandler {
    constructor({ config, llmManager, memoryManager, commandHandler, channelHistory, client, ownerAvailability, studyService }) {
        this.config = config;
        this.llmManager = llmManager;
        this.memoryManager = memoryManager;
        this.commandHandler = commandHandler;
        this.channelHistory = channelHistory;
        this.client = client;
        this.ownerAvailability = ownerAvailability;
        this.studyService = studyService;
        this.processedMessageIds = new Set();
        this.showTokens = false;
    }

    /**
     * Checks if the message author is an authorized owner/admin.
     */
    isOwner(message) {
        return this.config.discord.allowedUserIds.length === 0 ||
            this.config.discord.allowedUserIds.includes(message.author.id);
    }

    /**
     * Determines whether the bot should respond to the message.
     * Supports:
     * 1. Active study review session in this channel.
     * 2. Direct Messages (DMs) from authorized users.
     * 3. Mentions (@ZenBot) across any server channel (allows friends/server members).
     * 4. Any messages inside configured channel(s).
     */
    shouldHandle(message) {
        if (message.author.bot) return false;

        // Dedup recent message events
        if (this.processedMessageIds.has(message.id)) return false;

        // 1. Active study review session in this channel
        if (this.studyService && this.studyService.hasActiveSession(message.channel.id)) {
            const session = this.studyService.getSession(message.channel.id);
            if (session && (session.userId === message.author.id || this.isOwner(message))) {
                return true;
            }
        }

        // 2. Direct Messages (DMs) - STRICTLY OWNER ONLY
        const isDM = !message.guild || (typeof message.channel.isDMBased === 'function' && message.channel.isDMBased());
        if (isDM) {
            return this.isOwner(message);
        }

        // 3. Server channels: explicitly mentioned (@ZenBot)
        const isMentioned = message.mentions.has(this.client.user.id);
        if (isMentioned) {
            return true;
        }

        // 4. Server channels: inside configured channel(s)
        const channelIds = this.config.discord.channelIds?.length
            ? this.config.discord.channelIds
            : (this.config.discord.channelId ? [this.config.discord.channelId] : []);

        if (channelIds.includes(message.channel.id)) {
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
        if (message.author.bot) return;

        const isOwner = this.isOwner(message);

        // 1. Record owner activity whenever Lance sends any message in any channel
        if (isOwner && this.ownerAvailability) {
            this.ownerAvailability.recordActivity({
                type: 'message',
                channelId: message.channel.id,
                guildId: message.guild?.id
            });
        }

        // 2. If message should NOT be handled as a direct ZenBot interaction,
        // run the smart owner availability / inactivity scanner for server messages!
        if (!this.shouldHandle(message)) {
            if (this.ownerAvailability && message.guild && !isOwner) {
                await this.ownerAvailability.checkAndRespond(message);
            }
            return;
        }

        // Mark processed with TTL
        this.processedMessageIds.add(message.id);
        setTimeout(() => this.processedMessageIds.delete(message.id), 2 * 60 * 1000);

        // Check if command
        if (this.commandHandler.isCommand(message)) {
            return await this.commandHandler.handle(message);
        }

        const userQuery = this.cleanContent(message);
        const speakerName = message.member?.displayName || message.author.username;

        // 3. Active Acads / Study Review Session in this channel
        if (this.studyService && this.studyService.hasActiveSession(message.channel.id)) {
            const session = this.studyService.getSession(message.channel.id);
            if (session && (session.userId === message.author.id || isOwner)) {
                const lower = userQuery.trim().toLowerCase();
                if (['stop', 'quit', 'exit', 'cancel', 'end'].includes(lower)) {
                    const score = this.studyService.endSession(message.channel.id);
                    if (score && score.total > 0) {
                        return await message.reply(`🛑 **Study Session Ended.**\nScore so far: **${score.correct}/${score.total}** (${score.percentage}%)\nGreat job! Reply \`quiz me\` anytime to try again.`);
                    }
                    return await message.reply('🛑 **Study Session Ended.**');
                }

                try {
                    await message.channel.sendTyping();
                } catch (e) {}

                const result = await this.studyService.evaluateAnswer(message.channel.id, userQuery);
                if (result.finished) {
                    const finalReply = `${result.feedback}\n\n🎉 **Deck Complete!**\nFinal Score: **${result.score.correct}/${result.score.total}** (${result.score.percentage}%)\nType \`quiz me\` or \`!quiz\` whenever you want to review again!`;
                    return await message.reply(finalReply);
                }

                // MODE 3: GRADING:
                // 1. If correct: Reply "Correct!" and immediately output the next random [Description].
                // 2. If incorrect: Reply "Incorrect. The answer is: [Word Answer]" and immediately output the next random [Description].
                const replyText = `${result.feedback}\n\n**${result.nextDescription}**`;
                return await message.reply(replyText);
            }
        }

        // 4. Natural Deck Switch Trigger ("use deck <name>", "switch deck <name>")
        const deckSwitchRegex = /^(?:use|set|switch|change)\s+deck\s+([a-z0-9_-]+)$/i;
        const deckSwitchMatch = userQuery.match(deckSwitchRegex);
        if (deckSwitchMatch && this.studyService) {
            const res = this.studyService.setActiveDeck(message.channel.id, deckSwitchMatch[1]);
            return await message.reply(res.message);
        }

        // 5. Natural Study Triggers (Mode 2: Review)
        const reviewTriggerRegex = /^(?:quiz me|review|start quiz|test me|quiz|review notes)(?:\s+(?:on|for|deck)?\s*([a-z0-9_-]+))?$/i;
        const reviewMatch = userQuery.match(reviewTriggerRegex);
        if (reviewMatch && this.studyService) {
            const deckName = reviewMatch[1] ? reviewMatch[1].trim() : this.studyService.getActiveDeck(message.channel.id);
            const review = this.studyService.startReview(message.channel.id, message.author.id, deckName);
            if (!review.success) {
                return await message.reply(review.message);
            }
            return await message.reply(`📚 **Review Started** [Deck: *${review.deckName}* | ${review.totalCards} cards]\nType your answer directly in chat, or type **"stop"** to quit anytime.\n\n**${review.description}**`);
        }

        // Check for attached text/markdown file
        let attachmentText = null;
        if (message.attachments?.size > 0) {
            const textAtt = message.attachments.find(att =>
                att.name?.endsWith('.txt') || att.name?.endsWith('.md')
            );
            if (textAtt && textAtt.size < 500000) {
                try {
                    const res = await fetch(textAtt.url);
                    attachmentText = await res.text();
                } catch (err) {
                    logger.warn(`Could not fetch attachment text: ${err.message}`);
                }
            }
        }

        // 6. Natural Notes Ingestion Trigger (Mode 1: Ingestion)
        const notesTriggerRegex = /^(?:notes|study|acads|flashcards|save notes|add notes):\s*([\s\S]*)$/i;
        const notesMatch = userQuery.match(notesTriggerRegex);
        if ((notesMatch || (attachmentText && userQuery.toLowerCase().includes('notes'))) && this.studyService) {
            const rawNotes = (notesMatch ? notesMatch[1] : (userQuery + '\n' + (attachmentText || ''))).trim();
            const combinedContent = attachmentText ? `${rawNotes}\n\n${attachmentText}` : rawNotes;
            if (combinedContent.length > 5) {
                try {
                    await message.channel.sendTyping();
                } catch (e) {}

                const activeDeck = this.studyService.getActiveDeck(message.channel.id);
                const res = await this.studyService.ingestNotes(combinedContent, activeDeck, message.channel.id);
                if (res.success && res.addedCount > 0) {
                    // MODE 1: Reply ONLY with brief confirmation of count and ask if ready. Do not list terms.
                    return await message.reply(`Saved **${res.addedCount}** terms to deck **${res.deckName}**! Ready to begin? (Reply **"Quiz me"** when you're ready)`);
                } else if (res.success) {
                    return await message.reply(`No distinct terms and definitions could be extracted from those notes. Make sure to provide concepts with descriptions or definitions!`);
                } else {
                    return await message.reply(`Failed to process notes: ${res.error || 'Unknown error'}`);
                }
            }
        }

        // Friendly response if mentioned without any query text
        if (!userQuery && !attachmentText) {
            if (message.mentions.has(this.client.user.id)) {
                return await message.reply(`Hey ${speakerName}! What's on your mind? Mention me with a question or use \`!help\` to see what I can do.`);
            }
            return;
        }

        // 3. Inspect referenced reply message (if user is replying to someone else)
        let referencedContext = null;
        if (message.reference && message.reference.messageId) {
            try {
                const refMsg = await message.channel.messages.fetch(message.reference.messageId);
                if (refMsg) {
                    const refAuthor = refMsg.member?.displayName || refMsg.author.username;
                    referencedContext = `[Replying to ${refAuthor}'s message]: "${refMsg.cleanContent || refMsg.content}"`;
                }
            } catch (e) {
                logger.warn(`Could not fetch referenced message for context: ${e.message}`);
            }
        }

        // Only allow owner to inject persistent inline memories
        const rememberedInline = isOwner ? this.checkInlineMemory(userQuery) : null;

        // Combine referenced message context and user query
        let fullUserText = userQuery;
        if (referencedContext) {
            fullUserText = `${referencedContext}\n\n${userQuery}`;
        }

        // Add speaker prefix when friends or server members talk so the LLM has context
        const promptQuery = (!isOwner && message.guild)
            ? `[From ${speakerName}]: ${fullUserText}`
            : fullUserText;

        logger.info(`Message [${message.guild ? message.guild.name : 'DM'}] from ${message.author.tag} (${speakerName}): "${userQuery.slice(0, 80)}"`);

        // Send typing indicator
        try {
            await message.channel.sendTyping();
        } catch (e) {
            // Typing indicator fail is non-fatal
        }

        try {
            // Retrieve live channel / server conversation history if asked or in server channel
            let liveTranscriptContext = null;
            if (this.channelHistory && this.channelHistory.isHistoryInquiry(userQuery)) {
                const targetChannel = this.channelHistory.resolveTargetChannel(userQuery, message.channel);
                if (targetChannel) {
                    const { transcript, messageCount, channelName, guildName } =
                        await this.channelHistory.fetchRecentTranscript(targetChannel, 40);
                    if (transcript && messageCount > 0) {
                        liveTranscriptContext = `[LIVE DISCORD CHAT TRANSCRIPT (#${channelName} in ${guildName} - ${messageCount} recent messages)]:\n${transcript}\n\nUse this real chat history to answer the user accurately, concisely, and factually.`;
                    }
                }
            } else if (this.channelHistory && message.guild && message.channel.isTextBased()) {
                // Ambient conversational context from current channel (last 8 messages)
                try {
                    const { transcript } = await this.channelHistory.fetchRecentTranscript(message.channel, 8);
                    if (transcript) {
                        liveTranscriptContext = `[RECENT CHANNEL MESSAGES (#${message.channel.name})]:\n${transcript}`;
                    }
                } catch (e) {}
            }

            // Build multi-tier context with projects, temporal awareness, and live chat transcript
            const isDM = !message.guild || (typeof message.channel.isDMBased === 'function' && message.channel.isDMBased());
            const messages = this.memoryManager.buildMessages(message.channel.id, promptQuery, liveTranscriptContext, { isDM, isOwner });

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
            const historyUserTurn = isOwner ? userQuery : `${speakerName}: ${userQuery}`;
            this.memoryManager.recordTurn(message.channel.id, 'user', historyUserTurn);
            this.memoryManager.recordTurn(message.channel.id, 'assistant', response.content);

            logger.success(`Replied via ${response.provider} (${response.model}) in ${response.latencyMs}ms`);
        } catch (error) {
            logger.error(`Failed to generate response: ${error.message}`);
            await message.reply(`Error: ${error.message}`);
        }
    }
}

module.exports = MessageHandler;
