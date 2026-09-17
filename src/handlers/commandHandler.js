const fs = require('fs');
const path = require('path');
const { EmbedBuilder } = require('discord.js');
const { splitMessage } = require('../utils/chunker');
const logger = require('../utils/logger');

class CommandHandler {
    constructor({ config, llmManager, memoryManager, channelHistory, ownerAvailability, studyService }) {
        this.config = config;
        this.llmManager = llmManager;
        this.memoryManager = memoryManager;
        this.channelHistory = channelHistory;
        this.ownerAvailability = ownerAvailability;
        this.studyService = studyService;
    }

    /**
     * Checks whether a message is a command.
     */
    isCommand(message) {
        return message.content.trim().startsWith('!');
    }

    /**
     * Checks if the message author is an authorized owner/admin.
     */
    isOwner(message) {
        const userId = message?.author?.id || message?.user?.id || message?.id;
        return this.config.discord.allowedUserIds.length === 0 ||
            (userId && this.config.discord.allowedUserIds.includes(userId));
    }

    /**
     * Dispatches command to specific handlers.
     */
    async handle(message) {
        const raw = message.content.trim().slice(1);
        const [cmdName, ...args] = raw.split(/\s+/);
        const cmd = cmdName.toLowerCase();
        const argText = args.join(' ').trim();

        logger.info(`Command !${cmd} from ${message.author.tag}`);

        switch (cmd) {
            case 'help':
                return await this.cmdHelp(message);
            case 'status':
                return await this.cmdStatus(message);
            case 'limits':
            case 'usage':
                return await this.cmdLimits(message);
            case 'projects':
                return await this.cmdProjects(message);
            case 'project':
                return await this.cmdProject(message, args);
            case 'standup':
            case 'plan':
                return await this.cmdStandup(message);
            case 'ping':
                return await this.cmdPing(message);
            case 'remember':
                if (!this.isOwner(message)) return await message.reply('Only Lance (bot owner) can add persistent facts.');
                return await this.cmdRemember(message, argText);
            case 'facts':
            case 'memories':
                return await this.cmdListFacts(message, argText);
            case 'forget':
                if (!this.isOwner(message)) return await message.reply('Only Lance (bot owner) can remove facts.');
                return await this.cmdForget(message, argText);
            case 'profile':
                return await this.cmdProfile(message);
            case 'addgoal':
                if (!this.isOwner(message)) return await message.reply('Only Lance (bot owner) can update profile goals.');
                return await this.cmdAddGoal(message, argText);
            case 'provider':
                if (!this.isOwner(message)) return await message.reply('Only Lance (bot owner) can switch active AI providers.');
                return await this.cmdProvider(message, argText);
            case 'model':
                if (!this.isOwner(message)) return await message.reply('Only Lance (bot owner) can change LLM models.');
                return await this.cmdModel(message, argText);
            case 'tokens':
                if (!this.isOwner(message)) return await message.reply('Only Lance (bot owner) can toggle token indicators.');
                return await this.cmdTokens(message, argText);
            case 'humor':
            case 'intensity':
            case 'vibe':
                return await this.cmdHumor(message, argText);
            case 'roast':
            case 'cook':
            case 'petty':
                return await this.cmdRoast(message, args);
            case 'roll':
            case 'r':
            case 'dice':
            case 'dnd':
            case 'check':
                return await this.cmdRoll(message, args);
            case 'choose':
            case 'pick':
            case 'decide':
            case 'fate':
                return await this.cmdChoose(message, args);
            case 'coin':
            case 'flip':
                return await this.cmdCoin(message);
            case 'summarize':
            case 'catchup':
            case 'recap':
            case 'tldr':
                return await this.cmdSummarize(message, args);
            case 'clear':
                return await this.cmdClear(message);
            case 'availability':
                if (!this.isOwner(message)) return await message.reply('Only Lance (bot owner) can manage availability status.');
                return await this.cmdAvailability(message, argText);
            case 'study':
            case 'quiz':
            case 'review':
                return await this.cmdStudy(message, args, cmd);
            default:
                return await message.reply(`Unknown command \`!${cmd}\`. Use \`!help\` to see the full list.`);
        }
    }

    async cmdHelp(message) {
        const embed = new EmbedBuilder()
            .setTitle('ZenBot Commands')
            .setDescription('Personal AI companion for Lance with persistent memory, project tracking, and multi-provider cloud inference.')
            .setColor(0x2b2d42)
            .addFields(
                {
                    name: 'Interactive Acads & Flashcard Study (CRUD)',
                    value: (
                        '`!study use <deck>` — Switch active study deck\n' +
                        '`!study create <deck>` / `!study delete <deck>` — Create or delete a deck\n' +
                        '`!study decks` — List all decks & show active deck\n' +
                        '`!study view [deck]` — Inspect flashcards in a deck\n' +
                        '`!study rename <old> <new>` — Rename a deck\n' +
                        '`!study notes <text>` — Ingest raw notes into active deck silently\n' +
                        '`!study quiz [deck]` or `!quiz` — Start interactive review session\n' +
                        '`!study stop` or `!quiz stop` — Stop current review session\n' +
                        '`!study clear [deck]` — Clear all cards in a deck\n' +
                        '`!study remove <term>` — Delete a single card from active deck'
                    )
                },
                {
                    name: 'Project Tracking',
                    value: (
                        '`!projects` — Overview of active projects & tech stacks\n' +
                        '`!project <name>` — Detailed architecture & tasks for a project\n' +
                        '`!standup` — Daily planning check-in based on goals & projects'
                    )
                },
                {
                    name: 'Fun & Utilities',
                    value: (
                        '`!roll [d20|2d6+3|action]` — Roll dice with D&D outcome commentary (e.g. `!roll d20 sneak into kitchen`)\n' +
                        '`!choose <opt1, opt2...>` — Let fate pick between options\n' +
                        '`!coin` — Flip a coin (Heads or Tails)'
                    )
                },
                {
                    name: 'Discord History & Context',
                    value: (
                        '`!summarize [channel|server|count]` — Summarize chat from this or another channel (e.g. `!summarize banorant`, `!summarize 50`)\n' +
                        '`!catchup` / `!recap` — Catch up on recent discussions\n' +
                        '`!clear` — Reset short-term conversation context for this channel'
                    )
                },
                {
                    name: 'Memory & Profile',
                    value: (
                        '`!facts [search]` — List or search remembered knowledge\n' +
                        '`!profile` — Review Lance\'s compiled profile & goals'
                    )
                },
                {
                    name: 'AI Engine & Limits',
                    value: (
                        '`!status` — Provider status, active model, and memory counts\n' +
                        '`!limits` — Real-time tokens, remaining requests, and rate limits\n' +
                        '`!humor` — View current humor intensity setting (0-5)\n' +
                        '`!ping` — Test bot latency'
                    )
                },
                {
                    name: 'Owner Controls (Lance Only)',
                    value: (
                        '`!availability [status|on|off|away|sleep|auto] [duration]` — Owner availability & auto-reply detection\n' +
                        '`!roast <@user|name> [topic]` — Ruthlessly cook a target on Discord (or reply with `!roast`)\n' +
                        '`!humor <0-5>` — Set humor intensity (0=serious, 2=natural, 4=shitpost, 5=degeneracy)\n' +
                        '`!provider <groq|gemini>` — Switch active AI provider\n' +
                        '`!model <name>` — Switch active LLM model\n' +
                        '`!remember <fact>` / `!forget <id>` — Store or delete permanent memories\n' +
                        '`!addgoal <goal>` — Add a new career/dev goal'
                    )
                },
                {
                    name: 'Usage',
                    value: 'Chat directly in this channel, mention `@ZenBot` in any server, or send a DM anytime (owner only).'
                }
            )
            .setFooter({ text: 'ZenBot' })
            .setTimestamp();

        return await message.reply({ embeds: [embed] });
    }

    async cmdStatus(message) {
        const status = this.llmManager.getStatus();
        const memStats = this.memoryManager.getStats();
        const activeProvider = status.activeProvider;
        const providerInfo = status.providers[activeProvider];
        const humorLvl = this.config.persona.humorIntensity ?? 2;
        const humorLabel = this.config.persona.humorLevels?.[humorLvl]?.label || 'Naturally Humorous';

        const embed = new EmbedBuilder()
            .setTitle('System Status')
            .setColor(0x3a0ca3)
            .addFields(
                {
                    name: 'Active Provider',
                    value: `**${activeProvider.toUpperCase()}** (\`${providerInfo.currentModel}\`)`,
                    inline: true
                },
                {
                    name: 'Providers Configured',
                    value: Object.entries(status.providers)
                        .map(([name, p]) => `[${p.configured ? 'READY' : 'OFF'}] ${name}`)
                        .join('\n'),
                    inline: true
                },
                {
                    name: 'Context, Persona & Knowledge',
                    value: (
                        `• Humor Intensity: **Level ${humorLvl}** (${humorLabel})\n` +
                        `• Tracked Projects: **${memStats.projectsCount}**\n` +
                        `• Remembered Facts: **${memStats.factsCount}**\n` +
                        `• Stored Interactions: **${memStats.memoriesCount}**\n` +
                        `• Profile Updated: ${new Date(memStats.profileUpdated).toLocaleDateString()}`
                    ),
                    inline: false
                }
            )
            .setFooter({ text: 'Use !limits to check real-time token quotas' })
            .setTimestamp();

        return await message.reply({ embeds: [embed] });
    }

    async cmdLimits(message) {
        const provider = this.llmManager.getCurrentProvider();
        const lastUsage = provider.lastUsage || {};
        const rateLimits = provider.lastRateLimits || {};

        const fields = [
            {
                name: 'Current Provider',
                value: `**${provider.name.toUpperCase()}** (${provider.model})`,
                inline: false
            }
        ];

        if (rateLimits.limitRequests || rateLimits.remainingRequests) {
            fields.push({
                name: 'Requests Quota',
                value: (
                    `Remaining: **${rateLimits.remainingRequests || 'N/A'}** / ${rateLimits.limitRequests || 'N/A'}\n` +
                    `Reset Window: ${rateLimits.resetRequests || rateLimits.resetTokens || 'N/A'}`
                ),
                inline: true
            });
        }

        if (rateLimits.limitTokens || rateLimits.remainingTokens) {
            fields.push({
                name: 'Tokens Per Minute (TPM)',
                value: (
                    `Remaining: **${rateLimits.remainingTokens || 'N/A'}** / ${rateLimits.limitTokens || 'N/A'}\n` +
                    `Reset: ${rateLimits.resetTokens || 'N/A'}`
                ),
                inline: true
            });
        }

        if (lastUsage.prompt_tokens || lastUsage.promptTokenCount) {
            const promptTokens = lastUsage.prompt_tokens || lastUsage.promptTokenCount || 0;
            const completionTokens = lastUsage.completion_tokens || lastUsage.candidatesTokenCount || 0;
            const totalTokens = lastUsage.total_tokens || lastUsage.totalTokenCount || (promptTokens + completionTokens);

            fields.push({
                name: 'Last Turn Token Breakdown',
                value: `Prompt: **${promptTokens}** | Completion: **${completionTokens}** | Total: **${totalTokens}**`,
                inline: false
            });
        } else {
            fields.push({
                name: 'Last Turn Usage',
                value: 'No completed turns recorded yet in this session.',
                inline: false
            });
        }

        const embed = new EmbedBuilder()
            .setTitle('Rate Limits & Token Usage')
            .setColor(0x4361ee)
            .addFields(fields)
            .setFooter({ text: 'Monitored via live API response headers' })
            .setTimestamp();

        return await message.reply({ embeds: [embed] });
    }

    async cmdProjects(message) {
        const projects = this.memoryManager.projects.list();
        if (!projects.length) {
            return await message.reply('No projects currently registered.');
        }

        const list = projects.map(p => {
            const stack = p.stack?.slice(0, 3).join(', ') || 'N/A';
            const openTasks = p.tasks?.length ? `(${p.tasks.length} open tasks)` : '';
            return `**${p.name}** [${p.status}]\n_${p.category}_ • Stack: \`${stack}\` ${openTasks}\nID: \`${p.id}\``;
        }).join('\n\n');

        const embed = new EmbedBuilder()
            .setTitle('Lance\'s Tracked Projects')
            .setColor(0x1d3557)
            .setDescription(list)
            .setFooter({ text: 'Use !project <id> to view architecture & roadmap' });

        return await message.reply({ embeds: [embed] });
    }

    async cmdProject(message, args) {
        if (!args.length) {
            return await message.reply('Specify a project ID or name. Example: `!project balik-belongings` or `!project portfolio`');
        }

        // Subcommand: !project task <id> <task>
        if (args[0].toLowerCase() === 'task') {
            if (!this.isOwner(message)) {
                return await message.reply('Only Lance can add tasks to tracked projects.');
            }
            const projId = args[1];
            const taskText = args.slice(2).join(' ').trim();
            if (!projId || !taskText) {
                return await message.reply('Usage: `!project task <project-id> <task text>`');
            }

            const updated = this.memoryManager.projects.addTask(projId, taskText);
            if (!updated) {
                return await message.reply(`Project "${projId}" not found. Check \`!projects\` for valid IDs.`);
            }

            return await message.reply(`Added task to **${updated.name}**: "${taskText}"`);
        }

        const query = args.join(' ').trim();
        const p = this.memoryManager.projects.find(query);

        if (!p) {
            return await message.reply(`Could not find project matching "${query}". Use \`!projects\` to see available IDs.`);
        }

        const embed = new EmbedBuilder()
            .setTitle(`${p.name} [${p.status}]`)
            .setColor(0x457b9d)
            .setDescription(p.description)
            .addFields(
                { name: 'Category', value: p.category, inline: true },
                { name: 'Tech Stack', value: p.stack?.join(', ') || 'N/A', inline: true },
                {
                    name: 'Key Highlights',
                    value: p.highlights?.length ? p.highlights.map(h => `• ${h}`).join('\n') : 'None recorded',
                    inline: false
                },
                {
                    name: 'Active Tasks / Roadmap',
                    value: p.tasks?.length ? p.tasks.map(t => `• [ ] ${t}`).join('\n') : 'No open tasks recorded',
                    inline: false
                }
            )
            .setFooter({ text: `ID: ${p.id} • Use !project task ${p.id} <text> to add tasks` });

        return await message.reply({ embeds: [embed] });
    }

    async cmdStandup(message) {
        const profile = this.memoryManager.profile.getProfile();
        const projects = this.memoryManager.projects.list();

        const activeProjects = projects.filter(p => p.status === 'Active');
        const tasksSummary = activeProjects
            .filter(p => p.tasks?.length)
            .map(p => `**${p.name}**:\n${p.tasks.slice(0, 2).map(t => `  - ${t}`).join('\n')}`)
            .join('\n');

        const goals = profile.goals?.slice(0, 3).map(g => `• ${g}`).join('\n') || 'None set';

        const embed = new EmbedBuilder()
            .setTitle('Daily Check-in & Focus Plan')
            .setColor(0x0077b6)
            .setDescription(`Good focus starts with clear priorities. Here is your current active roadmap, Lance:`)
            .addFields(
                { name: 'Core Goals', value: goals, inline: false },
                { name: 'Pending Tasks on Active Projects', value: tasksSummary || 'All caught up!', inline: false },
                {
                    name: 'Next Steps',
                    value: 'What is your single main target today? Tell me what you want to focus on and we will lock it in.'
                }
            )
            .setFooter({ text: 'ZenBot Standup' })
            .setTimestamp();

        return await message.reply({ embeds: [embed] });
    }

    async cmdPing(message) {
        const ping = Date.now() - message.createdTimestamp;
        return await message.reply(`Pong: **${ping}ms**.`);
    }

    async cmdRemember(message, factText) {
        if (!factText) {
            return await message.reply('Please provide something to remember. Example: `!remember I prefer TypeScript for frontend`');
        }

        const entry = this.memoryManager.facts.addFact(factText);
        return await message.reply(`Noted [${entry.category}]: "${entry.fact}"`);
    }

    async cmdListFacts(message, searchQuery) {
        const facts = searchQuery
            ? this.memoryManager.facts.search(searchQuery, 10)
            : this.memoryManager.facts.listFacts(10);

        if (!facts.length) {
            return await message.reply(searchQuery ? `No facts found matching "${searchQuery}".` : 'No remembered facts yet. Use `!remember <fact>` to record one.');
        }

        const list = facts
            .map((f, i) => `${i + 1}. [${f.category}] ${f.fact} (ID: \`${f.id}\`)`)
            .join('\n');

        const embed = new EmbedBuilder()
            .setTitle(searchQuery ? `Search Results for "${searchQuery}"` : 'Stored Personal Facts')
            .setColor(0x3d5a80)
            .setDescription(list)
            .setFooter({ text: 'Use !forget <id> to remove a fact' });

        return await message.reply({ embeds: [embed] });
    }

    async cmdForget(message, query) {
        if (!query) {
            return await message.reply('Specify the fact text or ID to forget. Example: `!forget TypeScript`');
        }

        const removed = this.memoryManager.facts.removeFact(query);
        if (removed) {
            return await message.reply(`Removed fact: "${removed.fact}"`);
        } else {
            return await message.reply(`Could not find a fact matching "${query}". Use \`!facts\` to view IDs.`);
        }
    }

    async cmdProfile(message) {
        const p = this.memoryManager.profile.getProfile();
        const embed = new EmbedBuilder()
            .setTitle(`Profile: ${p.userName}`)
            .setColor(0x293241)
            .setDescription(p.bio || 'Personal context for ZenBot')
            .addFields(
                { name: 'Active Goals', value: p.goals?.length ? p.goals.map(g => `• ${g}`).join('\n') : 'None set' },
                { name: 'Interests & Stack', value: p.interests?.length ? p.interests.join(', ') : 'None set' },
                { name: 'Preferences', value: `Tone: ${p.preferences?.tone || 'Default'}\nCode: ${p.preferences?.codeStyle || 'Clean'}` }
            )
            .setFooter({ text: 'Last Updated: ' + new Date(p.updatedAt).toLocaleDateString() });

        return await message.reply({ embeds: [embed] });
    }

    async cmdAddGoal(message, goalText) {
        if (!goalText) {
            return await message.reply('Please provide a goal. Example: `!addgoal Ship ZenBot to GitHub portfolio`');
        }

        this.memoryManager.profile.addGoal(goalText);
        return await message.reply(`Added goal: "${goalText}"`);
    }

    async cmdProvider(message, providerName) {
        if (!providerName) {
            const current = this.llmManager.currentProviderName;
            return await message.reply(`Current provider is **${current}**. Switch using \`!provider groq\` or \`!provider gemini\`.`);
        }

        try {
            const switched = this.llmManager.setProvider(providerName);
            const provider = this.llmManager.getCurrentProvider();
            return await message.reply(`Active provider switched to **${switched.toUpperCase()}** (Model: \`${provider.model}\`).`);
        } catch (err) {
            return await message.reply(`Failed to switch: ${err.message}`);
        }
    }

    async cmdModel(message, modelName) {
        if (!modelName) {
            const provider = this.llmManager.getCurrentProvider();
            return await message.reply(`Current model for **${this.llmManager.currentProviderName}** is \`${provider.model}\`.`);
        }

        try {
            const newModel = this.llmManager.setModel(modelName);
            return await message.reply(`Model updated to \`${newModel}\` for **${this.llmManager.currentProviderName}**.`);
        } catch (err) {
            return await message.reply(`Error updating model: ${err.message}`);
        }
    }

    async cmdTokens(message, argText) {
        if (!this.messageHandler) return;
        const arg = argText.toLowerCase().trim();
        if (arg === 'on') {
            this.messageHandler.showTokens = true;
            return await message.reply('In-chat token indicator enabled.');
        } else if (arg === 'off') {
            this.messageHandler.showTokens = false;
            return await message.reply('In-chat token indicator disabled.');
        }
        this.messageHandler.showTokens = !this.messageHandler.showTokens;
        return await message.reply(`In-chat token indicator is now **${this.messageHandler.showTokens ? 'ON' : 'OFF'}**.`);
    }

    async cmdRoast(message, args) {
        if (!this.isOwner(message)) {
            const speaker = message.member?.displayName || message.author.username;
            return await message.reply(`Nice try, ${speaker}. Only Lance has the clearance to order hits. Sit back down.`);
        }

        let targetUser = null;
        let targetContent = '';

        // 1. Check if replying to a specific message
        if (message.reference && message.reference.messageId) {
            try {
                const refMsg = await message.channel.messages.fetch(message.reference.messageId);
                if (refMsg) {
                    targetUser = refMsg.author;
                    targetContent = refMsg.content;
                }
            } catch (e) {
                logger.warn(`Could not fetch referenced message for roast: ${e.message}`);
            }
        }

        // 2. Check mentions in command message
        const botId = this.messageHandler?.client?.user?.id || message.client?.user?.id;
        const mentioned = message.mentions?.users ? message.mentions.users.filter(u => u.id !== botId).first() : null;
        if (mentioned) {
            targetUser = mentioned;
        }

        // 3. Prevent self-roasting or shooting the boss
        if (targetUser && targetUser.id === botId) {
            return await message.reply('I am not roasting myself, Lance. I carry this entire server.');
        }
        if (targetUser && targetUser.id === message.author.id && !args.length) {
            return await message.reply('I work for you, Lance. Pick a real victim.');
        }

        let targetName = '';
        let reason = '';

        if (targetUser) {
            const member = message.guild?.members.cache.get(targetUser.id);
            targetName = member?.displayName || targetUser.username;
            reason = args.filter(a => !a.startsWith('<@')).join(' ').trim();
        } else if (args.length > 0) {
            targetName = args[0];
            reason = args.slice(1).join(' ').trim();
        }

        // 4. If target is "him" or empty, resolve to the last person who spoke in the channel
        if ((!targetUser && (!targetName || targetName.toLowerCase() === 'him')) && message.channel.isTextBased()) {
            try {
                const recent = await message.channel.messages.fetch({ limit: 6 });
                const lastOtherMsg = recent.find(m => m.id !== message.id && m.author.id !== message.author.id && !m.author.bot);
                if (lastOtherMsg) {
                    targetUser = lastOtherMsg.author;
                    targetName = lastOtherMsg.member?.displayName || lastOtherMsg.author.username;
                    targetContent = lastOtherMsg.content;
                }
            } catch (e) {}
        }

        if (!targetName) {
            return await message.reply('Give me a victim: reply to their message with `!roast`, tag them (`!roast @user`), or use `!roast him`.');
        }

        try {
            await message.channel.sendTyping();
        } catch (e) {}

        const roastSystemPrompt = (
            `You are ZenBot, Lance's fiercely loyal, hyper-intelligent, and aggressively petty AI companion. ` +
            `Lance has specifically authorized you to ruthlessly roast, cook, and verbally dismantle a target in this Discord chat.\n\n` +
            `ROAST RULES:\n` +
            `- Tone: Deadpan, razor-sharp, viciously petty, sarcastic, and hilarious Discord developer/gamer banter.\n` +
            `- Do NOT use generic cheesy dad jokes or bland insults. Make it feel personal, hyper-specific, and cutting.\n` +
            `- Call them out mercilessly on their skill issues, logic flaws, excuses, or whatever context/quote Lance provided.\n` +
            `- Length: 1 to 2 short, punchy paragraphs (maximum 4 sentences total). Every single word must hit like a freight train.\n` +
            `- Zero generic AI filler ("Oh, you want a roast?", "Let's talk about...", "Here goes nothing"). Jump straight for the jugular.\n` +
            `- Zero emoji spam. At most 1 subtle reaction emoji or none at all.\n` +
            `- Address the target directly as "${targetName}".`
        );

        let promptContent = `Target: ${targetName}.\n`;
        if (targetContent) {
            promptContent += `What they just said in chat: "${targetContent}"\n`;
        }
        if (reason) {
            promptContent += `Context / ammunition from Lance: "${reason}"\n`;
        }

        // Special inside lore for Ed (edvtl)
        const isEd = targetName.toLowerCase().includes('ed') ||
            targetUser?.username?.toLowerCase().includes('ed') ||
            targetUser?.displayName?.toLowerCase().includes('ed') ||
            reason.toLowerCase().includes('ed');

        if (isEd) {
            promptContent += `\nSPECIAL INSIDE LORE AGAINST ED:\n` +
                `- He is Bisaya (the whole server's favorite joke; bot status is 'Bisaya si Ed').\n` +
                `- He is a certified simp who immediately ditches, ghosts, and abandons his friends/homies the second his girlfriend breathes.\n` +
                `- He has zero loyalty to the squad, drops the boys mid-game or mid-call for his girl.\n` +
                `- Roast him brutally and specifically for abandoning his friends for his girl and being Bisaya.\n`;
        }

        promptContent += `Cook them with maximum pettiness.`;

        try {
            const response = await this.llmManager.chat([
                { role: 'system', content: roastSystemPrompt },
                { role: 'user', content: promptContent }
            ]);

            return await message.reply(response.content);
        } catch (error) {
            logger.error(`Roast generation failed: ${error.message}`);
            return await message.reply(`Failed to cook ${targetName}: ${error.message}`);
        }
    }

    async cmdSummarize(message, args) {
        const query = args.join(' ').trim();
        const limitMatch = query.match(/\b(\d{1,3})\b/);
        const limit = limitMatch ? parseInt(limitMatch[1], 10) : 35;

        // Strip numbers from query to isolate channel/guild names
        const searchPhrase = query.replace(/\b\d{1,3}\b/g, '').trim();

        // Resolve target channel (current channel or across connected servers)
        const targetChannel = this.channelHistory
            ? this.channelHistory.resolveTargetChannel(searchPhrase, message.channel)
            : message.channel;

        if (!targetChannel) {
            return await message.reply('Could not identify which channel to summarize. Usage: `!summarize [channel or server name] [count]`. Example: `!summarize banorant` or `!summarize 40`.');
        }

        try {
            await message.channel.sendTyping();
        } catch (e) {}

        const { transcript, messageCount, channelName, guildName, error } =
            await this.channelHistory.fetchRecentTranscript(targetChannel, limit);

        if (error) {
            return await message.reply(`Could not read messages from #${channelName}: ${error}`);
        }

        if (!transcript || messageCount === 0) {
            return await message.reply(`No recent messages found in #${channelName} (${guildName}).`);
        }

        const summaryPrompt = (
            `You are ZenBot. Summarize the following recent Discord chat transcript from #${channelName} in ${guildName}.\n\n` +
            `TRANSCRIPT (${messageCount} messages):\n` +
            `${transcript}\n\n` +
            `SUMMARY INSTRUCTIONS:\n` +
            `- Be compact, sharp, and Discord-friendly (peer dev/gamer tone).\n` +
            `- NEVER USE MARKDOWN TABLES. Always use clean bold headers and indented bullet points.\n` +
            `- Structure:\n` +
            `  • **Core Topics**: What was being talked about\n` +
            `  • **Key Highlights & Inputs**: Notable points from specific members\n` +
            `  • **Current Vibe / Next Steps**: Any plans, decisions, or ongoing banter\n` +
            `- Zero emoji spam. Maximum 1 subtle reaction emoji or none.\n` +
            `- Avoid generic opening fluff ("Sure, here is..."). Jump straight into the recap.`
        );

        try {
            const response = await this.llmManager.chat([
                { role: 'system', content: summaryPrompt },
                { role: 'user', content: `Summarize the recent discussion in #${channelName}.` }
            ]);

            const header = `**Chat Recap: #${channelName} (${guildName}) [Last ${messageCount} messages]**\n\n`;
            const chunks = splitMessage(header + response.content, 1950);
            for (const chunk of chunks) {
                await message.reply(chunk);
            }
        } catch (err) {
            logger.error(`Failed to summarize channel #${channelName}: ${err.message}`);
            return await message.reply(`Error generating summary for #${channelName}: ${err.message}`);
        }
    }

    async cmdRoll(message, args) {
        const raw = args.join(' ').trim();
        const diceRegex = /^(\d{1,2})?d(\d{1,4})(?:([+-])(\d{1,3}))?$/i;

        let count = 1;
        let sides = 20;
        let mod = 0;
        let action = '';

        if (args.length > 0 && diceRegex.test(args[0])) {
            const match = args[0].match(diceRegex);
            count = match[1] ? Math.min(parseInt(match[1], 10), 30) : 1;
            sides = Math.min(parseInt(match[2], 10), 1000);
            if (match[3] && match[4]) {
                const val = parseInt(match[4], 10);
                mod = match[3] === '-' ? -val : val;
            }
            action = args.slice(1).join(' ').trim();
        } else {
            action = raw;
            count = 1;
            sides = 20;
        }

        const rolls = [];
        for (let i = 0; i < count; i++) {
            rolls.push(Math.floor(Math.random() * sides) + 1);
        }
        const sum = rolls.reduce((a, b) => a + b, 0);
        const total = sum + mod;

        let tier = 'Standard';
        if (sides === 20 && count === 1) {
            if (rolls[0] === 20) tier = 'CRITICAL SUCCESS (Nat 20)';
            else if (rolls[0] === 1) tier = 'CRITICAL FAILURE (Nat 1)';
            else if (total >= 15) tier = 'SUCCESS';
            else if (total >= 10) tier = 'MIXED SUCCESS';
            else tier = 'FAILURE';
        }

        const modStr = mod !== 0 ? (mod > 0 ? `+${mod}` : `${mod}`) : '';
        const rollDisplay = count === 1 && mod === 0 ? `**${total}**` : `[${rolls.join(', ')}]${modStr ? ' ' + modStr : ''} = **${total}**`;

        // If no narrative action provided, return fast instant calculation
        if (!action) {
            let replyText = `🎲 Rolled **${count}d${sides}${modStr}**: ${rollDisplay}`;
            if (sides === 20 && count === 1) {
                replyText += ` — **${tier}**`;
            }
            return await message.reply(replyText);
        }

        // Narrative action provided: generate witty D&D DM adjudication
        try {
            await message.channel.sendTyping();
        } catch (e) {}

        const speakerName = message.member?.displayName || message.author.username;
        const dmPrompt = (
            `You are ZenBot acting as a witty, deadpan D&D Dungeon Master in a Discord chat. ` +
            `The player (${speakerName}) made a D&D check or decision on: "${action}". ` +
            `They rolled ${total} on a d${sides}${modStr} -> Result: ${tier}.\n\n` +
            `RULES:\n` +
            `- Describe the brief, hilarious consequence or verdict in 1 to 2 punchy sentences.\n` +
            `- Match the outcome to the roll (${tier}). A Nat 20 is legendary, a Nat 1 is a catastrophic backfire, a Mixed Success has an awkward catch.\n` +
            `- Deadpan, sharp Discord banter tone. Zero generic AI filler. Zero emoji spam.`
        );

        try {
            const response = await this.llmManager.chat([
                { role: 'system', content: dmPrompt },
                { role: 'user', content: `Adjudicate the outcome for: "${action}".` }
            ]);

            const header = `🎲 **D&D Check: "${action}"**\n` +
                `Rolled **${count}d${sides}${modStr}**: ${rollDisplay} — **${tier}**\n\n`;

            return await message.reply(header + response.content.trim());
        } catch (err) {
            logger.warn(`DM adjudication failed: ${err.message}`);
            return await message.reply(`🎲 Rolled **${count}d${sides}${modStr}**: ${rollDisplay} — **${tier}** for *"${action}"*`);
        }
    }

    async cmdChoose(message, args) {
        const raw = args.join(' ').trim();
        if (!raw) {
            return await message.reply('Usage: `!choose <option 1>, <option 2>, <option 3>` or `!choose sleep or code`');
        }

        let options = [];
        if (raw.includes(',')) {
            options = raw.split(',').map(s => s.trim()).filter(Boolean);
        } else if (/\s+or\s+/i.test(raw)) {
            options = raw.split(/\s+or\s+/i).map(s => s.trim()).filter(Boolean);
        } else {
            options = raw.split(/\s+/).filter(Boolean);
        }

        if (options.length < 2) {
            return await message.reply('Please give me at least 2 options to choose between. Example: `!choose valorant, sleep, code`');
        }

        const rollIdx = Math.floor(Math.random() * options.length);
        const chosen = options[rollIdx];

        return await message.reply(`🎲 **Fate has chosen**: **${chosen}** *(d${options.length} rolled ${rollIdx + 1})*`);
    }

    async cmdCoin(message) {
        const isHeads = Math.random() < 0.5;
        const flip = isHeads ? 'Heads' : 'Tails';
        return await message.reply(`🪙 The coin landed on: **${flip}**.`);
    }

    async cmdClear(message) {
        this.memoryManager.clearShortTerm(message.channel.id);
        return await message.reply('Short-term conversation history for this channel cleared.');
    }

    async cmdHumor(message, argText) {
        const levels = this.config.persona.humorLevels;
        const current = this.config.persona.humorIntensity ?? 2;

        if (!argText) {
            const curInfo = levels[current] || levels[2];
            const list = Object.entries(levels)
                .map(([lvl, info]) => `${lvl === String(current) ? '▶ ' : '  '}**Level ${lvl}**: ${info.label} — _${info.desc}_`)
                .join('\n');

            const embed = new EmbedBuilder()
                .setTitle('ZenBot Humor Intensity')
                .setColor(0x7209b7)
                .setDescription(
                    `Current Setting: **Level ${current} (${curInfo.label})**\n_${curInfo.desc}_\n\n` +
                    `**Available Levels:**\n${list}\n\n` +
                    `*Lance (bot owner) can change this with \`!humor <0-5>\`.*`
                )
                .setFooter({ text: 'Default: Level 2 (Naturally Humorous)' });

            return await message.reply({ embeds: [embed] });
        }

        if (!this.isOwner(message)) {
            const curInfo = levels[current] || levels[2];
            return await message.reply(`Only Lance (bot owner) can change the humor intensity. Current setting is **Level ${current}** (${curInfo.label}).`);
        }

        const targetLevel = parseInt(argText.trim(), 10);
        if (isNaN(targetLevel) || targetLevel < 0 || targetLevel > 5) {
            return await message.reply('Please specify a humor level between **0** and **5**. Example: `!humor 2` or `!humor 4`.');
        }

        // Update in-memory config
        this.config.persona.humorIntensity = targetLevel;

        // Persist to zen.env if present
        try {
            const zenEnvPath = path.join(this.config.paths.root, 'zen.env');
            if (fs.existsSync(zenEnvPath)) {
                let envContent = fs.readFileSync(zenEnvPath, 'utf8');
                if (/^HUMOR_INTENSITY=.*$/m.test(envContent)) {
                    envContent = envContent.replace(/^HUMOR_INTENSITY=.*$/m, `HUMOR_INTENSITY=${targetLevel}`);
                } else {
                    envContent = envContent.trimEnd() + `\nHUMOR_INTENSITY=${targetLevel}\n`;
                }
                fs.writeFileSync(zenEnvPath, envContent, 'utf8');
            }
        } catch (e) {
            logger.warn(`Could not persist HUMOR_INTENSITY to zen.env: ${e.message}`);
        }

        const newInfo = levels[targetLevel];
        return await message.reply(
            `Humor intensity set to **Level ${targetLevel}** (${newInfo.label}).\n` +
            `_${newInfo.desc}_`
        );
    }

    /**
     * Manages Lance's availability & inactivity detection status or manual override.
     */
    async cmdAvailability(message, argText) {
        if (!this.ownerAvailability) {
            return await message.reply('Owner availability service is not initialized.');
        }

        const raw = (argText || '').trim();
        if (!raw || raw.toLowerCase() === 'status') {
            const embed = this.ownerAvailability.getStatusEmbed();
            return await message.reply({ embeds: [embed] });
        }

        const [action, ...durationParts] = raw.split(/\s+/);
        const duration = durationParts.join(' ').trim();
        const result = this.ownerAvailability.setManualState(action, duration);

        if (result.error) {
            return await message.reply(`⚠️ ${result.error}`);
        }

        return await message.reply(`✅ ${result.message}`);
    }

    /**
     * Interactive Acads & Flashcard Study System
     * Supports:
     * - !study notes <text> (Mode 1: Ingestion)
     * - !study quiz [deck] / !quiz [deck] (Mode 2: Review)
     * - !study stop / !quiz stop
     * - !study decks
     * - !study clear [deck]
     */
    /**
     * Interactive Acads & Flashcard Study System with Complete CRUD
     * Supports:
     * - !study use <deck> / !study switch <deck> (Set active deck)
     * - !study create <deck> (Create new deck)
     * - !study decks / !study list (List decks, showing active)
     * - !study view [deck] (Inspect deck cards with spoiler answers)
     * - !study rename <old> <new> (Rename deck)
     * - !study delete <deck> (Delete deck)
     * - !study clear [deck] (Clear cards in deck)
     * - !study addcard <answer> | <description> (Manual card add)
     * - !study remove <term_or_index> (Delete single card)
     * - !study notes <text> (Mode 1: Ingestion into active/named deck)
     * - !study quiz [deck] / !quiz [deck] (Mode 2: Review active/named deck)
     * - !study stop / !quiz stop (End session)
     */
    async cmdStudy(message, args = [], originalCmd = 'study') {
        if (!this.studyService) {
            return await message.reply('Study service is not initialized.');
        }

        const sub = (args[0] || '').toLowerCase();
        const rest = args.slice(1).join(' ').trim();
        const channelId = message.channel?.id;

        // Check if directly invoked as !quiz or !review
        if (originalCmd === 'quiz' || originalCmd === 'review') {
            if (sub === 'stop' || sub === 'quit' || sub === 'cancel' || sub === 'end') {
                if (!this.studyService.hasActiveSession(channelId)) {
                    return await message.reply('No active review session in this channel.');
                }
                const score = this.studyService.endSession(channelId);
                if (score && score.total > 0) {
                    return await message.reply(`🛑 **Study Session Ended.**\nScore: **${score.correct}/${score.total}** (${score.percentage}%)\nGood work!`);
                }
                return await message.reply('🛑 **Study Session Ended.**');
            }

            const deckName = sub || this.studyService.getActiveDeck(channelId);
            const review = this.studyService.startReview(channelId, message.author?.id || message.user?.id, deckName);
            if (!review.success) {
                return await message.reply(review.message);
            }
            return await message.reply(`📚 **Review Started** [Deck: *${review.deckName}* | ${review.totalCards} cards]\nType your answer directly in chat, or type **"stop"** to quit anytime.\n\n**${review.description}**`);
        }

        // 1. SET / SWITCH ACTIVE DECK
        if (sub === 'use' || sub === 'set' || sub === 'switch') {
            if (!rest) {
                const current = this.studyService.getActiveDeck(channelId);
                return await message.reply(`Current active deck is **${current}**. To switch: \`!study use <deck_name>\``);
            }
            const res = this.studyService.setActiveDeck(channelId, rest);
            return await message.reply(res.message);
        }

        // 2. CREATE DECK
        if (sub === 'create' || sub === 'new' || sub === 'adddeck') {
            if (!rest) {
                return await message.reply('Please specify a deck name: `!study create <name>`');
            }
            const res = this.studyService.createDeck(rest);
            return await message.reply(res.message);
        }

        // 3. RENAME DECK
        if (sub === 'rename') {
            const parts = rest.split(/\s+/);
            if (parts.length < 2) {
                return await message.reply('Usage: `!study rename <old_name> <new_name>`');
            }
            const res = this.studyService.renameDeck(parts[0], parts[1], channelId);
            return await message.reply(res.message);
        }

        // 4. DELETE DECK
        if (sub === 'delete' || sub === 'drop' || sub === 'removedeck') {
            if (!rest) {
                return await message.reply('Please specify the deck to delete: `!study delete <deck_name>`');
            }
            const res = this.studyService.deleteDeck(rest);
            return await message.reply(res.message);
        }

        // 5. VIEW / INSPECT DECK CARDS
        if (sub === 'view' || sub === 'cards' || sub === 'inspect') {
            const deckName = rest || this.studyService.getActiveDeck(channelId);
            const deckInfo = this.studyService.getDeck(deckName, channelId);
            if (!deckInfo.cards || deckInfo.cards.length === 0) {
                return await message.reply(`Deck **${deckInfo.name}** is empty. Ingest notes with \`!study notes <text>\` or add cards with \`!study addcard <answer> | <description>\`.`);
            }
            const cardList = deckInfo.cards.slice(0, 15).map((c, i) =>
                `**${i + 1}.** ${c.description} → ||**${c.answer}**||`
            ).join('\n');
            const moreText = deckInfo.cards.length > 15 ? `\n_...and ${deckInfo.cards.length - 15} more terms_` : '';
            return await message.reply(`📖 **Deck: ${deckInfo.name}** (${deckInfo.cards.length} card${deckInfo.cards.length === 1 ? '' : 's'})${deckInfo.isActive ? ' ⭐ [ACTIVE]' : ''}\n\n${cardList}${moreText}`);
        }

        // 6. ADD SINGLE CARD MANUALLY
        if (sub === 'addcard') {
            const parts = rest.split('|');
            if (parts.length < 2) {
                return await message.reply('Usage: `!study addcard <answer> | <description>`');
            }
            const answer = parts[0].trim();
            const description = parts.slice(1).join('|').trim();
            const activeDeck = this.studyService.getActiveDeck(channelId);
            const res = this.studyService.addCard(activeDeck, answer, description);
            return await message.reply(res.message);
        }

        // 7. DELETE SINGLE CARD
        if (sub === 'removecard' || sub === 'deletecard' || sub === 'remove') {
            if (!rest) {
                return await message.reply('Usage: `!study remove <term_or_number>` (removes matching card from active deck)');
            }
            const activeDeck = this.studyService.getActiveDeck(channelId);
            const res = this.studyService.deleteCard(activeDeck, rest);
            return await message.reply(res.message);
        }

        // 8. LIST DECKS
        if (sub === 'decks' || sub === 'list') {
            const decks = this.studyService.listDecks(channelId);
            if (decks.length === 0) {
                return await message.reply('No study decks found. Use `!study create <name>` or `!study notes <text>` to create your first deck!');
            }
            const lines = decks.map(d =>
                `• **${d.name}**: ${d.cardCount} card${d.cardCount === 1 ? '' : 's'}${d.isActive ? ' ⭐ **[ACTIVE]**' : ''}`
            );
            return await message.reply(`📂 **Study Decks**:\n${lines.join('\n')}\n\nSwitch active deck with \`!study use <name>\` or start review with \`!quiz\`!`);
        }

        // 9. CLEAR DECK CARDS
        if (sub === 'clear') {
            const deckName = rest || this.studyService.getActiveDeck(channelId);
            const res = this.studyService.clearDeck(deckName, channelId);
            return await message.reply(res.message);
        }

        // 10. INGEST NOTES
        if (sub === 'notes' || sub === 'ingest' || sub === 'add') {
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

            const content = attachmentText ? `${rest}\n\n${attachmentText}` : rest;
            if (!content || content.length < 5) {
                return await message.reply('Please provide your notes or attach a `.txt`/`.md` file: `!study notes <paste notes here>`');
            }

            try {
                if (typeof message.channel?.sendTyping === 'function') {
                    await message.channel.sendTyping();
                }
            } catch (e) {}

            const activeDeck = this.studyService.getActiveDeck(channelId);
            const res = await this.studyService.ingestNotes(content, activeDeck, channelId);
            if (res.success && res.addedCount > 0) {
                // MODE 1: Ingestion response rule:
                // "Reply ONLY with a brief confirmation of how many terms were saved and ask if the user is ready to begin the review. Do not list the terms."
                return await message.reply(`Saved **${res.addedCount}** terms to deck **${res.deckName}**! Ready to begin? (Reply **"Quiz me"** or type \`!quiz\` when you're ready)`);
            } else if (res.success) {
                return await message.reply('No distinct terms and definitions could be extracted from those notes. Make sure to provide concepts with descriptions or definitions!');
            } else {
                return await message.reply(`Failed to parse notes: ${res.error || 'Unknown error'}`);
            }
        }

        // 11. START REVIEW / QUIZ
        if (sub === 'quiz' || sub === 'start' || sub === 'review') {
            const deckName = rest || this.studyService.getActiveDeck(channelId);
            const review = this.studyService.startReview(channelId, message.author?.id || message.user?.id, deckName);
            if (!review.success) {
                return await message.reply(review.message);
            }
            return await message.reply(`📚 **Review Started** [Deck: *${review.deckName}* | ${review.totalCards} cards]\nType your answer directly in chat, or type **"stop"** to quit anytime.\n\n**${review.description}**`);
        }

        // 12. STOP REVIEW
        if (sub === 'stop' || sub === 'quit' || sub === 'cancel' || sub === 'end') {
            if (!this.studyService.hasActiveSession(channelId)) {
                return await message.reply('No active review session in this channel.');
            }
            const score = this.studyService.endSession(channelId);
            if (score && score.total > 0) {
                return await message.reply(`🛑 **Study Session Ended.**\nScore: **${score.correct}/${score.total}** (${score.percentage}%)\nGood effort!`);
            }
            return await message.reply('🛑 **Study Session Ended.**');
        }

        return await message.reply(
            '**Interactive Acads & Flashcard Commands:**\n' +
            '• `!study use <deck>` — Set active deck for notes & quizzes\n' +
            '• `!study create <deck>` — Create a new study deck\n' +
            '• `!study decks` — List all decks & view active deck\n' +
            '• `!study view [deck]` — Inspect flashcards in a deck\n' +
            '• `!study rename <old> <new>` — Rename a deck\n' +
            '• `!study delete <deck>` — Delete a deck completely\n' +
            '• `!study clear [deck]` — Clear cards in a deck\n' +
            '• `!study notes <text>` — Ingest raw notes into active deck\n' +
            '• `!quiz [deck]` — Start interactive review session\n' +
            '• `!study stop` or `stop` — End review session\n' +
            '• `!study remove <term>` — Delete a single card from active deck'
        );
    }

    /**
     * Handles Discord Slash Command interactions (/help, /status, /roll, etc.)
     */
    async handleInteraction(interaction) {
        if (!interaction.isChatInputCommand()) return;

        // Strict DM restriction: only the owner can interact with the bot in DMs
        if (!interaction.guild && !this.isOwner(interaction.user)) {
            logger.warn(`Rejected DM slash command from unauthorized user ${interaction.user.tag} (${interaction.user.id})`);
            return await interaction.reply({
                content: 'ZenBot direct messages are private and restricted to the bot owner.',
                ephemeral: true
            });
        }

        const cmd = interaction.commandName.toLowerCase();
        logger.info(`Slash command /${cmd} from ${interaction.user.tag}`);

        // Record owner activity if Lance invoked a slash command
        if (this.ownerAvailability && this.isOwner(interaction.user)) {
            this.ownerAvailability.recordActivity({
                type: 'bot_interaction',
                channelId: interaction.channelId,
                guildId: interaction.guildId
            });
        }

        let isDeferred = false;
        const targetUserOption = interaction.options.getUser('target');
        const usersMap = new Map();
        if (targetUserOption) usersMap.set(targetUserOption.id, targetUserOption);

        const adapter = {
            author: interaction.user,
            member: interaction.member,
            channel: interaction.channel,
            guild: interaction.guild,
            client: interaction.client,
            createdTimestamp: interaction.createdTimestamp,
            mentions: {
                users: {
                    filter: (fn) => {
                        const arr = Array.from(usersMap.values()).filter(fn);
                        return {
                            first: () => arr[0] || null
                        };
                    }
                }
            },
            async reply(options) {
                const payload = typeof options === 'string' ? { content: options } : options;
                if (interaction.replied) {
                    return await interaction.followUp(payload);
                } else if (isDeferred || interaction.deferred) {
                    return await interaction.editReply(payload);
                } else {
                    return await interaction.reply(payload);
                }
            }
        };

        const defer = async () => {
            if (!isDeferred && !interaction.replied && !interaction.deferred) {
                await interaction.deferReply();
                isDeferred = true;
            }
        };

        try {
            switch (cmd) {
                case 'help':
                    return await this.cmdHelp(adapter);

                case 'status':
                    return await this.cmdStatus(adapter);

                case 'limits':
                case 'usage':
                    return await this.cmdLimits(adapter);

                case 'humor':
                case 'intensity': {
                    const level = interaction.options.getInteger('level');
                    return await this.cmdHumor(adapter, level !== null ? String(level) : '');
                }

                case 'roast':
                case 'cook':
                case 'petty': {
                    await defer();
                    const target = interaction.options.getUser('target');
                    const name = interaction.options.getString('name') || '';
                    const topic = interaction.options.getString('topic') || '';

                    const roastArgs = [];
                    if (target) {
                        roastArgs.push(`<@${target.id}>`);
                    } else if (name) {
                        roastArgs.push(name);
                    }
                    if (topic) {
                        roastArgs.push(topic);
                    }
                    return await this.cmdRoast(adapter, roastArgs);
                }

                case 'roll':
                case 'r':
                case 'dice': {
                    const query = interaction.options.getString('query') || '';
                    const parts = query.split(/\s+/).filter(Boolean);
                    if (parts.length > 1 || (parts.length === 1 && !/^(\d{1,2})?d(\d{1,4})/i.test(parts[0]))) {
                        await defer();
                    }
                    return await this.cmdRoll(adapter, parts);
                }

                case 'choose': {
                    const opts = interaction.options.getString('options') || '';
                    return await this.cmdChoose(adapter, [opts]);
                }

                case 'coin':
                    return await this.cmdCoin(adapter);

                case 'summarize': {
                    await defer();
                    const target = interaction.options.getString('channel') || '';
                    const count = interaction.options.getInteger('count');
                    const args = [];
                    if (target) args.push(target);
                    if (count) args.push(String(count));
                    return await this.cmdSummarize(adapter, args);
                }

                case 'projects':
                    return await this.cmdProjects(adapter);

                case 'project': {
                    const name = interaction.options.getString('name') || '';
                    return await this.cmdProject(adapter, name.split(/\s+/));
                }

                case 'standup':
                    return await this.cmdStandup(adapter);

                case 'facts':
                case 'memories': {
                    const search = interaction.options.getString('search') || '';
                    return await this.cmdListFacts(adapter, search);
                }

                case 'profile':
                    return await this.cmdProfile(adapter);

                case 'ping':
                    return await this.cmdPing(adapter);

                case 'clear':
                    return await this.cmdClear(adapter);

                case 'provider': {
                    if (!this.isOwner(adapter)) {
                        return await adapter.reply('Only Lance (bot owner) can switch active AI providers.');
                    }
                    const name = interaction.options.getString('name') || '';
                    return await this.cmdProvider(adapter, name);
                }

                case 'model': {
                    if (!this.isOwner(adapter)) {
                        return await adapter.reply('Only Lance (bot owner) can change LLM models.');
                    }
                    const name = interaction.options.getString('name') || '';
                    return await this.cmdModel(adapter, name);
                }

                case 'availability': {
                    if (!this.isOwner(adapter)) {
                        return await adapter.reply('Only Lance (bot owner) can manage availability status.');
                    }
                    const action = interaction.options.getString('action') || 'status';
                    const duration = interaction.options.getString('duration') || '';
                    const argStr = `${action} ${duration}`.trim();
                    return await this.cmdAvailability(adapter, argStr);
                }

                case 'study': {
                    const sub = interaction.options.getSubcommand(false) || 'quiz';
                    if (sub === 'use') {
                        const deck = interaction.options.getString('deck') || '';
                        return await this.cmdStudy(adapter, ['use', deck]);
                    } else if (sub === 'create') {
                        const name = interaction.options.getString('name') || '';
                        return await this.cmdStudy(adapter, ['create', name]);
                    } else if (sub === 'delete') {
                        const deck = interaction.options.getString('deck') || '';
                        return await this.cmdStudy(adapter, ['delete', deck]);
                    } else if (sub === 'rename') {
                        const oldName = interaction.options.getString('old') || '';
                        const newName = interaction.options.getString('new') || '';
                        return await this.cmdStudy(adapter, ['rename', `${oldName} ${newName}`]);
                    } else if (sub === 'view') {
                        const deck = interaction.options.getString('deck') || '';
                        return await this.cmdStudy(adapter, ['view', deck]);
                    } else if (sub === 'notes') {
                        await defer();
                        const text = interaction.options.getString('text') || '';
                        return await this.cmdStudy(adapter, ['notes', text]);
                    } else if (sub === 'quiz') {
                        const deck = interaction.options.getString('deck') || '';
                        return await this.cmdStudy(adapter, ['quiz', deck]);
                    } else if (sub === 'stop') {
                        return await this.cmdStudy(adapter, ['stop']);
                    } else if (sub === 'decks') {
                        return await this.cmdStudy(adapter, ['decks']);
                    } else if (sub === 'clear') {
                        const deck = interaction.options.getString('deck') || '';
                        return await this.cmdStudy(adapter, ['clear', deck]);
                    }
                    return await this.cmdStudy(adapter, []);
                }

                case 'quiz': {
                    const deck = interaction.options.getString('deck') || 'acads';
                    return await this.cmdStudy(adapter, ['quiz', deck], 'quiz');
                }

                default:
                    return await adapter.reply(`Unknown slash command \`/${cmd}\`.`);
            }
        } catch (err) {
            logger.error(`Error executing slash command /${cmd}:`, err);
            const errReply = { content: `Error executing command: ${err.message}`, ephemeral: true };
            if (interaction.deferred || isDeferred) {
                return await interaction.editReply(errReply);
            } else if (!interaction.replied) {
                return await interaction.reply(errReply);
            }
        }
    }
}

module.exports = CommandHandler;
