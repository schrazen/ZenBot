const { EmbedBuilder } = require('discord.js');
const { splitMessage } = require('../utils/chunker');
const logger = require('../utils/logger');

class CommandHandler {
    constructor({ config, llmManager, memoryManager, channelHistory }) {
        this.config = config;
        this.llmManager = llmManager;
        this.memoryManager = memoryManager;
        this.channelHistory = channelHistory;
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
        return this.config.discord.allowedUserIds.length === 0 ||
            this.config.discord.allowedUserIds.includes(message.author.id);
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
                    name: 'Project Tracking',
                    value: (
                        '`!projects` — Overview of active projects & tech stacks\n' +
                        '`!project <name>` — Detailed architecture & tasks for a project\n' +
                        '`!project task <name> <task>` — Add a task to a project (Owner only)\n' +
                        '`!standup` — Daily planning check-in based on goals & projects'
                    )
                },
                {
                    name: 'Dice & Decisions (D&D)',
                    value: (
                        '`!roll [dice] [action]` — Roll D&D dice with DM outcomes (e.g. `!roll d20 sneak past guards`, `!roll 2d6+3`, `!roll deploy to prod`)\n' +
                        '`!choose <opt1>, <opt2>, <opt3>` — Let fate pick between options (or `!choose sleep or code`)\n' +
                        '`!coin` — Flip a coin'
                    )
                },
                {
                    name: 'Chat History & Summaries',
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
                        '`!ping` — Test bot latency'
                    )
                },
                {
                    name: 'Owner Controls (Lance Only)',
                    value: (
                        '`!roast <@user|name> [topic]` — Ruthlessly cook a target on Discord (or reply with `!roast`)\n' +
                        '`!provider <groq|gemini>` — Switch active AI provider\n' +
                        '`!model <name>` — Switch active LLM model\n' +
                        '`!remember <fact>` / `!forget <id>` — Store or delete permanent memories\n' +
                        '`!addgoal <goal>` — Add a new career/dev goal'
                    )
                },
                {
                    name: 'Usage',
                    value: 'Chat directly in this channel, mention `@ZenBot` in any server, or send a DM anytime.'
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
                    name: 'Context & Knowledge Stores',
                    value: (
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
        const mentioned = message.mentions.users.filter(u => u.id !== botId).first();
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
}

module.exports = CommandHandler;
