const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { splitMessage } = require('../utils/chunker');
const logger = require('../utils/logger');

class MessageHandler {
    constructor({ config, llmManager, memoryManager, commandHandler, channelHistory, client, ownerAvailability, studyService, workspaceService, selfUpgradeService, reminderService, webSearchService, goalService, automationService }) {
        this.config = config;
        this.llmManager = llmManager;
        this.memoryManager = memoryManager;
        this.commandHandler = commandHandler;
        this.channelHistory = channelHistory;
        this.client = client;
        this.ownerAvailability = ownerAvailability;
        this.studyService = studyService;
        this.workspaceService = workspaceService;
        this.selfUpgradeService = selfUpgradeService;
        this.reminderService = reminderService;
        this.webSearchService = webSearchService;
        this.goalService = goalService;
        this.automationService = automationService;
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

        // 1. Active study review session in this channel (anyone in channel can participate)
        if (this.studyService && this.studyService.hasActiveSession(message.channel.id)) {
            return true;
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
     * Downloads supported image, voice/audio, and PDF attachments (up to 12 MB, max 3 files)
     * as base64 inlineData payloads for multimodal Gemini inference.
     */
    async extractMultimodalAttachments(message) {
        if (!message?.attachments || message.attachments.size === 0) return [];

        const extToMime = {
            '.png': 'image/png',
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.webp': 'image/webp',
            '.gif': 'image/gif',
            '.ogg': 'audio/ogg',
            '.mp3': 'audio/mpeg',
            '.wav': 'audio/wav',
            '.m4a': 'audio/mp4',
            '.pdf': 'application/pdf'
        };
        const supportedMimes = new Set([
            'image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif',
            'audio/ogg', 'audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/mp4', 'audio/x-m4a',
            'application/pdf'
        ]);
        const maxBytes = 12 * 1024 * 1024;
        const results = [];

        for (const att of message.attachments.values()) {
            if (results.length >= 3) break;
            if (!att?.url || (att.size && att.size > maxBytes)) continue;

            const rawType = (att.contentType || '').split(';')[0].trim().toLowerCase();
            const lowerName = (att.name || '').toLowerCase();
            const matchedExt = Object.keys(extToMime).find(ext => lowerName.endsWith(ext));
            const mimeType = supportedMimes.has(rawType)
                ? (rawType === 'image/jpg' ? 'image/jpeg' : rawType)
                : (matchedExt ? extToMime[matchedExt] : null);

            if (!mimeType) continue;

            try {
                const res = await fetch(att.url);
                if (!res.ok) continue;
                const arrayBuf = await res.arrayBuffer();
                if (arrayBuf.byteLength > maxBytes) continue;
                results.push({
                    name: att.name || 'attachment',
                    mimeType,
                    data: Buffer.from(arrayBuf).toString('base64'),
                    size: arrayBuf.byteLength
                });
            } catch (err) {
                logger.warn(`Could not fetch multimodal attachment "${att.name}": ${err.message}`);
            }
        }

        return results;
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
            const isCmd = this.commandHandler ? this.commandHandler.isCommand(message) : message.content.trim().startsWith('!');
            this.ownerAvailability.recordActivity({
                type: 'message',
                channelId: message.channel.id,
                guildId: message.guild?.id,
                isCommand: isCmd
            });
        }

        // 2. Check if this is someone looking for or pinging Lance while he is away/asleep
        // (Scans across all server channels, even if they didn't prompt ZenBot)
        if (this.ownerAvailability && message.guild && !isOwner) {
            const availabilityResult = await this.ownerAvailability.checkAndRespond(message);
            // If the message was directed at or asking about Lance:
            if (availabilityResult.isContact) {
                const isBotMentioned = message.mentions.has(this.client.user.id);
                // If bot already sent an availability auto-reply, stop here:
                if (availabilityResult.responded) {
                    return;
                }

                // If user did NOT explicitly mention ZenBot, stay silent (let Lance answer for himself):
                if (!isBotMentioned) {
                    return;
                }

                // If user DID mention @ZenBot (e.g. "@zen-bot where is lance" or "@zen-bot san si lance"):
                // Respond with live reality rather than letting Groq LLM hallucinate about Ti-To monitors!
                if (availabilityResult.state === 'AVAILABLE' || availabilityResult.state === 'LIKELY_AVAILABLE') {
                    const onlineReply = this.ownerAvailability.generateOnlineResponse(availabilityResult.diffMinutes, message.content);
                    return await message.reply(onlineReply);
                }
            }
        }

        // 3. If message should NOT be handled as a direct ZenBot interaction, stop here
        if (!this.shouldHandle(message)) {
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

        // 2b. Owner Self-Upgrade Approval / Rejection Gate
        if (isOwner && this.selfUpgradeService && this.selfUpgradeService.hasPendingProposals()) {
            const cleanApprove = userQuery.trim();
            const approveMatch = cleanApprove.match(/^(?:approve|approved|yes|yep|yeah|sure|go\s+ahead|sige|apply|do\s+it|proceed)(?:\s+(all|latest|upg_[a-z0-9_]+))?[.!]*$/i);
            const rejectMatch = cleanApprove.match(/^(?:reject|rejected|no|nope|cancel|deny|wag|discard)(?:\s+(all|latest|upg_[a-z0-9_]+))?[.!]*$/i);

            if (approveMatch) {
                return await this.commandHandler.cmdApproveUpgrade(message, approveMatch[1] || 'all');
            }
            if (rejectMatch) {
                return await this.commandHandler.cmdRejectUpgrade(message, rejectMatch[1] || 'all');
            }
        }

        // 2c. Owner Dismissal / Availability Correction Gate
        // Prevents unsolicited tool calls or argument back-and-forth when Lance tells the bot to be quiet or states he is active.
        if (isOwner && this.ownerAvailability) {
            const cleanQ = userQuery.trim();
            const isDismissal = /^(?:stfu(?:\s+bro)?|shut\s+up(?:\s+bro)?|quiet|hush|tumahimik\s+ka|wag\s+ka\s+sumabat|i\s+didn'?t\s+ask\s+(?:u|you)\s+for\s+that)[.!]*$/i.test(cleanQ);
            if (isDismissal) {
                this.ownerAvailability.suppressChannel(message.channel.id, 60 * 60 * 1000);
                try {
                    await message.react('🤐');
                } catch (e) {}
                logger.info(`Owner dismissed bot in channel ${message.channel.id}; suppressed auto-replies for 60m.`);
                return;
            }

            const isActiveStatusOverride = /\b(?:stop\s+replying\s+to\s+my\s+friends|my\s+status\s+is\s+(?:active|online)|no\s+need\s+to\s+tell\s+them\s+i'?m\s+(?:off|away|afk)|i'?m\s+(?:active|online)\s+now)\b/i.test(cleanQ);
            if (isActiveStatusOverride) {
                this.ownerAvailability.suppressChannel('global', 60 * 60 * 1000);
                this.ownerAvailability.setManualState('on', 'Active (confirmed by Lance)');
                logger.info(`Owner explicitly confirmed ACTIVE status; set state to AVAILABLE and suppressed AFK replies.`);
            }
        }

        // 3. Active Acads / Study Review Session in this channel
        if (this.studyService && this.studyService.hasActiveSession(message.channel.id)) {
            const session = this.studyService.getSession(message.channel.id);
            if (session) {
                const lower = userQuery.trim().toLowerCase();

                // Stop / Quit / Cancel
                if (['stop', 'quit', 'exit', 'cancel', 'end'].includes(lower)) {
                    const canStop = session.userId === message.author.id || isOwner || Boolean(message.guild);
                    if (canStop) {
                        const score = this.studyService.endSession(message.channel.id);
                        if (score && score.total > 0) {
                            let endMsg = `🛑 **Study Session Ended.**\nScore so far: **${score.correct}/${score.total}** (${score.percentage}%)\n`;
                            const pKeys = Object.keys(score.participants || {});
                            if (pKeys.length > 1) {
                                endMsg += `\n**Contributors:**\n` + pKeys
                                    .map(k => `• ${score.participants[k].name}: ${score.participants[k].correct} correct`)
                                    .join('\n') + `\n`;
                            }
                            endMsg += `Great job! Reply \`quiz me\` anytime to try again.`;
                            return await message.reply(endMsg);
                        }
                        return await message.reply('🛑 **Study Session Ended.**');
                    }
                }

                // Skip / Pass / IDK / Reveal
                if (['skip', 'pass', 'idk', 'dunno', 'reveal'].includes(lower)) {
                    try {
                        await message.channel.sendTyping();
                    } catch (e) {}

                    const skipResult = this.studyService.skipCard(message.channel.id, speakerName);
                    if (skipResult.finished) {
                        let finalReply = `${skipResult.feedback}\n\n🎉 **Deck Complete!**\nFinal Score: **${skipResult.score.correct}/${skipResult.score.total}** (${skipResult.score.percentage}%)\n`;
                        const pKeys = Object.keys(skipResult.participants || {});
                        if (pKeys.length > 1) {
                            finalReply += `\n**Contributors:**\n` + pKeys
                                .map(k => `• ${skipResult.participants[k].name}: ${skipResult.participants[k].correct} correct`)
                                .join('\n') + `\n`;
                        }
                        finalReply += `Type \`quiz me\` to review again!`;
                        return await message.reply(finalReply);
                    }
                    return await message.reply(`${skipResult.feedback}\n\n**${skipResult.nextDescription}**`);
                }

                try {
                    await message.channel.sendTyping();
                } catch (e) {}

                // Evaluate answer - accepts answers from ANY user in the channel
                const result = await this.studyService.evaluateAnswer(message.channel.id, userQuery, speakerName, message.author.id);
                if (result && result.ignored) {
                    // Casual chatter between members: do NOT burn the card!
                    // If bot wasn't mentioned, let the conversation flow silently
                    if (!message.mentions.has(this.client.user.id) && !userQuery.toLowerCase().includes('zenbot')) {
                        return;
                    }
                    // If ZenBot was mentioned, fall through to AI with active study context
                } else if (result) {
                    if (result.finished) {
                        let finalReply = `${result.isCorrect ? `**Correct, ${speakerName}! 🎉**` : `Incorrect, ${speakerName}. The answer is: **${result.targetAnswer}**`}\n\n🎉 **Deck Complete!**\nFinal Score: **${result.score.correct}/${result.score.total}** (${result.score.percentage}%)\n`;
                        const pKeys = Object.keys(result.participants || {});
                        if (pKeys.length > 1) {
                            finalReply += `\n**Contributors:**\n` + pKeys
                                .map(k => `• ${result.participants[k].name}: ${result.participants[k].correct} correct`)
                                .join('\n') + `\n`;
                        }
                        finalReply += `Type \`quiz me\` or \`!quiz\` whenever you want to review again!`;
                        return await message.reply(finalReply);
                    }

                    if (result.isCorrect) {
                        const replyText = `**Correct, ${speakerName}! 🎉**\n\n**${result.nextDescription}**`;
                        return await message.reply(replyText);
                    } else {
                        const replyText = `Incorrect, ${speakerName}. The answer is: **${result.targetAnswer}**\n\n**${result.nextDescription}**`;
                        return await message.reply(replyText);
                    }
                }
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

        // Check for attached text/markdown file or multimodal attachments (images, voice notes, PDFs)
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
        const multimodalAttachments = isOwner ? await this.extractMultimodalAttachments(message) : [];

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
                    return await message.reply(`Saved **${res.addedCount}** terms to deck **${res.deckName}**! Ready to begin? (Reply **"Quiz me"** when you're ready)`);
                } else if (res.success) {
                    return await message.reply(`No distinct terms and definitions could be extracted from those notes. Make sure to provide concepts with descriptions or definitions!`);
                } else {
                    return await message.reply(`Failed to process notes: ${res.error || 'Unknown error'}`);
                }
            }
        }

        // 7. Inspect referenced reply message FIRST (if user is replying to someone or bot)
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

        // 8. If no text was provided (e.g. user just pinged @ZenBot or sent a voice/image attachment):
        let effectiveQuery = userQuery;
        if (!effectiveQuery && !attachmentText && multimodalAttachments.length > 0) {
            const hasAudio = multimodalAttachments.some(a => a.mimeType.startsWith('audio/'));
            const hasPdf = multimodalAttachments.some(a => a.mimeType === 'application/pdf');
            effectiveQuery = hasAudio
                ? 'Transcribe this voice message accurately, then respond directly and execute any request inside it.'
                : (hasPdf
                    ? 'Inspect and summarize this attached PDF document clearly for Lance.'
                    : 'Analyze the attached image(s)/screenshot(s) thoroughly and help Lance with whatever is shown.');
        } else if (!effectiveQuery && !attachmentText) {
            if (referencedContext) {
                // User clicked reply and tagged bot without extra text
                effectiveQuery = `[React to and address this referenced message]`;
            } else if (message.mentions.has(this.client.user.id)) {
                // Check if there was recent conversation in the channel
                if (this.channelHistory && message.channel.isTextBased()) {
                    try {
                        const { transcript } = await this.channelHistory.fetchRecentTranscript(message.channel, 5);
                        if (transcript && transcript.split('\n').length > 1) {
                            effectiveQuery = `[React naturally to what was just discussed above in the channel]`;
                        }
                    } catch (e) {}
                }

                if (!effectiveQuery) {
                    return await message.reply(`Yo ${speakerName}! What's up?`);
                }
            } else {
                return;
            }
        }

        if (attachmentText) {
            effectiveQuery = `${effectiveQuery ? effectiveQuery + '\n\n' : ''}[Attached File Content]:\n${attachmentText.slice(0, 6000)}`;
        }

        // Only allow owner to inject persistent inline memories & learn feedback rules
        const rememberedInline = isOwner ? this.checkInlineMemory(effectiveQuery) : null;
        const learnedPref = (isOwner && this.memoryManager.preferences)
            ? this.memoryManager.preferences.detectFeedbackRule(effectiveQuery)
            : null;
        if (learnedPref) {
            this.memoryManager.preferences.addPreference(learnedPref.rule, learnedPref.category, 'feedback');
            if (learnedPref.humorLevel !== undefined && this.config?.persona) {
                this.config.persona.humorIntensity = learnedPref.humorLevel;
                logger.info(`Updated live humorIntensity to ${learnedPref.humorLevel} from owner feedback.`);
            }
        }

        // Combine referenced message context and user query
        let fullUserText = effectiveQuery;
        if (referencedContext) {
            fullUserText = `${referencedContext}\n\n${effectiveQuery}`;
        }

        // Add speaker prefix when friends or server members talk so the LLM has context
        const promptQuery = (!isOwner && message.guild)
            ? `[From ${speakerName}]: ${fullUserText}`
            : fullUserText;

        logger.info(`Message [${message.guild ? message.guild.name : 'DM'}] from ${message.author.tag} (${speakerName}): "${effectiveQuery.slice(0, 80)}"`);

        // Send typing indicator
        try {
            await message.channel.sendTyping();
        } catch (e) {
            // Typing indicator fail is non-fatal
        }

        try {
            // Retrieve live channel / server conversation history if asked or in server channel/DM
            let liveTranscriptContext = null;
            if (this.channelHistory && this.channelHistory.isHistoryInquiry(effectiveQuery)) {
                const targetChannel = this.channelHistory.resolveTargetChannel(effectiveQuery, message.channel);
                if (targetChannel) {
                    const { transcript, messageCount, channelName, guildName } =
                        await this.channelHistory.fetchRecentTranscript(targetChannel, 40);
                    if (transcript && messageCount > 0) {
                        liveTranscriptContext = `[LIVE DISCORD CHAT TRANSCRIPT (#${channelName} in ${guildName} - ${messageCount} recent messages)]:\n${transcript}\n\nUse this real chat history to answer the user accurately, concisely, and factually.`;
                    }
                }
            } else if (this.channelHistory && message.channel?.isTextBased?.()) {
                // Ambient conversational context from current channel (last 15 messages) - works for BOTH guild and DMs!
                try {
                    const { transcript } = await this.channelHistory.fetchRecentTranscript(message.channel, 15);
                    if (transcript) {
                        const loc = message.guild ? `#${message.channel.name}` : 'Direct Messages';
                        liveTranscriptContext = `[RECENT CHANNEL MESSAGES (${loc})]:\n${transcript}`;
                    }
                } catch (e) {}
            }

            // Build multi-tier context with projects, temporal awareness, live chat transcript, and active study session
            const isDM = !message.guild || (typeof message.channel.isDMBased === 'function' && message.channel.isDMBased());
            const activeSession = this.studyService?.getSession(message.channel.id) || null;
            const ownerAvailabilityState = this.ownerAvailability ? this.ownerAvailability.getAvailabilityState() : null;
            const messages = this.memoryManager.buildMessages(message.channel.id, promptQuery, liveTranscriptContext, {
                isDM,
                isOwner,
                activeStudySession: activeSession,
                ownerAvailabilityState
            });

            if (multimodalAttachments.length > 0 && messages.length > 0) {
                const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
                if (lastUserMsg) {
                    lastUserMsg.attachments = multimodalAttachments;
                }
            }

            // Execute LLM inference (with Agent tools for owner Lance, standard chat for server members)
            let response;
            const autonomyEnabled = this.config.autonomy?.enabled !== false;

            // In DMs, always enable full agent tools for Lance.
            // In public server channels, only enable agent tools when Lance is asking for a task/action
            // (prevents casual group-chat banter or laughter from accidentally invoking workspace/posting tools).
            const hasTaskIntentInGuild = isDM || /\b(?:file|code|src|read|write|edit|patch|fix|upgrade|search|find|check|post|send|message|channel|server|banorant|col|rodericks|remind|alarm|schedule|automate|watch|status|available|away|sleep|online|offline|run|cmd|git|web|http|url|remember|fact|preference|project|vault|download|document|desktop|pdf|attach|upload)\b/i.test(effectiveQuery);
            const useAgentLoop = isOwner && autonomyEnabled && hasTaskIntentInGuild && (this.workspaceService || this.reminderService);

            // Live progress tracker message for multi-step agent operations
            let progressMsg = null;
            let lastProgressUpdateMs = 0;
            const progressLines = [];

            const formatToolSummary = (toolName, rawArgs) => {
                let parsed = {};
                if (typeof rawArgs === 'string') {
                    try { parsed = JSON.parse(rawArgs); } catch (e) {}
                } else if (rawArgs && typeof rawArgs === 'object') {
                    parsed = rawArgs;
                }
                const detail = parsed.filePath || parsed.query || parsed.target || parsed.url || parsed.command || parsed.state || parsed.task || parsed.fact || parsed.rule || parsed.project || parsed.categories || '';
                return detail ? `\`${toolName}\` (${String(detail).slice(0, 50)})` : `\`${toolName}\``;
            };

            const updateLiveProgress = async (info) => {
                try {
                    if (info.phase === 'tool_start') {
                        progressLines.push(`🔄 **Step ${info.step}:** Running ${formatToolSummary(info.toolName, info.toolArgs)}...`);
                    } else if (info.phase === 'tool_done') {
                        const err = info.toolResult?.error;
                        const lastIdx = progressLines.length - 1;
                        const label = `${err ? '⚠️' : '✅'} **Step ${info.step}:** ${formatToolSummary(info.toolName, info.toolArgs)}${err ? ` — *${String(err).slice(0, 60)}*` : ''}`;
                        if (lastIdx >= 0 && progressLines[lastIdx].startsWith('🔄')) {
                            progressLines[lastIdx] = label;
                        } else {
                            progressLines.push(label);
                        }
                    } else if (info.phase === 'continuing') {
                        progressLines.push(`⚡ **Continuing:** Proceeding to next action...`);
                    }

                    const content = `⚙️ **ZenBot Agent Working...**\n${progressLines.slice(-6).join('\n')}`;
                    const nowMs = Date.now();

                    if (!progressMsg) {
                        progressMsg = await message.channel.send(content);
                        lastProgressUpdateMs = nowMs;
                    } else if (info.phase === 'tool_done' || (nowMs - lastProgressUpdateMs) >= 1200) {
                        await progressMsg.edit(content);
                        lastProgressUpdateMs = nowMs;
                    }
                } catch (e) {}
            };

            if (useAgentLoop) {
                const { getToolsForQuery, executeTool } = require('../services/llm/toolDefinitions');
                const { groqTools, geminiTools } = getToolsForQuery(effectiveQuery);

                response = await this.llmManager.chatWithAgent(messages, {
                    tools: groqTools,
                    geminiTools,
                    onProgress: updateLiveProgress,
                    executeTool: (name, args) => executeTool(name, args, {
                        config: this.config,
                        workspaceService: this.workspaceService,
                        selfUpgradeService: this.selfUpgradeService,
                        channelHistory: this.channelHistory,
                        reminderService: this.reminderService,
                        webSearchService: this.webSearchService,
                        automationService: this.automationService,
                        ownerAvailability: this.ownerAvailability,
                        memoryManager: this.memoryManager,
                        client: this.client,
                        userId: message.author.id,
                        channelId: message.channel.id,
                        isDM
                    }),
                    maxSteps: 10
                });
            } else {
                response = await this.llmManager.chat(messages);
            }

            // Clean up live progress indicator message before posting final response
            if (progressMsg) {
                try {
                    await progressMsg.delete();
                } catch (e) {}
                progressMsg = null;
            }

            let replyText = (response.content || '').trim();
            if (this.showTokens && response.executedTools && response.executedTools.length > 0) {
                const toolNames = response.executedTools.map(t => `\`${t.name}\``).join(', ');
                replyText = `*(🛠️ Executed: ${toolNames})*\n\n` + replyText;
            }

            if (learnedPref) {
                replyText = `*(💡 Learned preference: "${learnedPref.rule}")*\n\n` + replyText;
            }

            if (rememberedInline) {
                replyText = `*(Noted: "${rememberedInline}")*\n\n` + replyText;
            }

            // Only append failover/token indicators if debug token display (`!tokens`) is enabled
            if (this.showTokens) {
                if (response.note) {
                    replyText += `\n\n_${response.note}_`;
                }
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

            if (!replyText) {
                replyText = 'Done.';
            }

            // Build quick-send buttons if find_files found files and send_file_to_owner wasn't already invoked
            const replyComponents = [];
            if (isOwner && Array.isArray(response.executedTools)) {
                const alreadySentFile = response.executedTools.some(t => t.name === 'send_file_to_owner' && t.result?.success);
                const findCall = [...response.executedTools].reverse().find(t => t.name === 'find_files' && Array.isArray(t.result?.matches) && t.result.matches.length > 0);
                if (!alreadySentFile && findCall) {
                    const row = new ActionRowBuilder();
                    const seenIds = new Set();
                    for (const match of findCall.result.matches) {
                        if (row.components.length >= 4) break;
                        const matchPath = String(match.path || '');
                        if (!matchPath || matchPath.length > 85) continue;
                        const customId = `zen_send_file:${matchPath}`;
                        if (seenIds.has(customId)) continue;
                        seenIds.add(customId);
                        row.addComponents(
                            new ButtonBuilder()
                                .setCustomId(customId)
                                .setLabel(`📎 Send ${match.name || 'file'}`.slice(0, 75))
                                .setStyle(ButtonStyle.Secondary)
                        );
                    }
                    if (row.components.length > 0) {
                        replyComponents.push(row);
                    }
                }
            }

            // Split into Discord-compliant chunks
            const chunks = splitMessage(replyText, 1950);

            for (let i = 0; i < chunks.length; i++) {
                const isLastChunk = i === chunks.length - 1;
                if (isLastChunk && replyComponents.length > 0) {
                    await message.reply({ content: chunks[i], components: replyComponents });
                } else {
                    await message.reply(chunks[i]);
                }
            }

            // Smart Auto-Continuation: If the model cut off mid-sentence or hit max_tokens,
            // automatically continue in a follow-up message (and execute any pending tools).
            let fullAccumulatedReply = response.content || '';
            let currentResponse = response;
            let continuationCount = 0;
            const maxContinuations = 2;

            while (
                continuationCount < maxContinuations &&
                this.llmManager.isResponseIncomplete(currentResponse.content, currentResponse.finishReason)
            ) {
                continuationCount++;
                logger.info(`[Auto-Continue #${continuationCount}] Detected incomplete response (finishReason=${currentResponse.finishReason}). Generating continuation...`);

                try {
                    await message.channel.sendTyping();
                } catch (e) {}

                const continuationMessages = [
                    ...messages,
                    { role: 'assistant', content: fullAccumulatedReply },
                    {
                        role: 'user',
                        content: '[SYSTEM AUTO-CONTINUE]: Your previous message was cut off before you finished. Continue seamlessly right from where you stopped without repeating what you already said. If you were about to run a tool (like `schedule_automation`, `run_command`, `write_file`, etc.), execute it now and finish your explanation.'
                    }
                ];

                let nextResponse;
                if (useAgentLoop) {
                    const { getToolsForQuery, executeTool } = require('../services/llm/toolDefinitions');
                    const { groqTools, geminiTools } = getToolsForQuery(effectiveQuery);
                    nextResponse = await this.llmManager.chatWithAgent(continuationMessages, {
                        tools: groqTools,
                        geminiTools,
                        onProgress: updateLiveProgress,
                        executeTool: (name, args) => executeTool(name, args, {
                            config: this.config,
                            workspaceService: this.workspaceService,
                            selfUpgradeService: this.selfUpgradeService,
                            channelHistory: this.channelHistory,
                            reminderService: this.reminderService,
                            webSearchService: this.webSearchService,
                            automationService: this.automationService,
                            ownerAvailability: this.ownerAvailability,
                            memoryManager: this.memoryManager,
                            client: this.client,
                            userId: message.author.id,
                            channelId: message.channel.id,
                            isDM
                        }),
                        maxSteps: 8
                    });
                    if (progressMsg) {
                        try { await progressMsg.delete(); } catch (e) {}
                        progressMsg = null;
                    }
                } else {
                    nextResponse = await this.llmManager.chat(continuationMessages);
                }

                if (!nextResponse || (!nextResponse.content?.trim() && (!nextResponse.executedTools || nextResponse.executedTools.length === 0))) {
                    break;
                }

                let contText = nextResponse.content || '';
                if (this.showTokens && nextResponse.executedTools && nextResponse.executedTools.length > 0) {
                    const toolNames = nextResponse.executedTools.map(t => `\`${t.name}\``).join(', ');
                    contText = `*(🛠️ Executed: ${toolNames})*\n\n` + contText;
                }

                if (contText.trim()) {
                    const contChunks = splitMessage(contText, 1950);
                    for (const c of contChunks) {
                        await message.channel.send(c);
                    }
                    fullAccumulatedReply += '\n' + (nextResponse.content || '');
                }

                currentResponse = nextResponse;
            }

            // If any tool calls during this turn staged a self-upgrade proposal awaiting Lance's approval,
            // display the Permission Request Embed automatically!
            if (isOwner && this.selfUpgradeService) {
                const allExecuted = [
                    ...(response.executedTools || []),
                    ...(currentResponse !== response ? (currentResponse.executedTools || []) : [])
                ];
                const stagedIds = allExecuted
                    .filter(t => t.result && t.result.status === 'pending_owner_approval')
                    .map(t => t.result.proposalId);

                if (stagedIds.length > 0) {
                    const pendingList = this.selfUpgradeService.getPendingProposals().filter(p => stagedIds.includes(p.id));
                    if (pendingList.length > 0) {
                        const proposalEmbed = this.selfUpgradeService.buildProposalEmbed(pendingList);
                        const proposalComponents = this.selfUpgradeService.buildProposalComponents(pendingList);
                        await message.channel.send({ embeds: [proposalEmbed], components: proposalComponents });
                    }
                }
            }

            // Persist turns to memory with DM vs Guild scope isolation
            const historyUserTurn = isOwner ? userQuery : `${speakerName}: ${userQuery}`;
            this.memoryManager.recordTurn(message.channel.id, 'user', historyUserTurn, { isDM });
            this.memoryManager.recordTurn(message.channel.id, 'assistant', fullAccumulatedReply, { isDM });

            logger.success(`Replied via ${response.provider} (${response.model}) in ${response.latencyMs}ms${continuationCount > 0 ? ` (+${continuationCount} auto-continuation)` : ''}`);
        } catch (error) {
            logger.error(`Failed to generate response: ${error.message}`);
            await message.reply(`Error: ${error.message}`);
        }
    }
}

module.exports = MessageHandler;
