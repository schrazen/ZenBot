const { EmbedBuilder } = require('discord.js');
const logger = require('../utils/logger');

class CommandHandler {
    constructor({ config, llmManager, memoryManager }) {
        this.config = config;
        this.llmManager = llmManager;
        this.memoryManager = memoryManager;
    }

    /**
     * Checks whether a message is a command.
     */
    isCommand(message) {
        return message.content.trim().startsWith('!');
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
                return await this.cmdRemember(message, argText);
            case 'facts':
            case 'memories':
                return await this.cmdListFacts(message, argText);
            case 'forget':
                return await this.cmdForget(message, argText);
            case 'profile':
                return await this.cmdProfile(message);
            case 'addgoal':
                return await this.cmdAddGoal(message, argText);
            case 'provider':
                return await this.cmdProvider(message, argText);
            case 'model':
                return await this.cmdModel(message, argText);
            case 'tokens':
                return await this.cmdTokens(message, argText);
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
                        '`!projects` — Overview of your active projects & tech stacks\n' +
                        '`!project <name>` — Detailed architecture & tasks for a project\n' +
                        '`!project task <name> <task>` — Add a task to a project\n' +
                        '`!standup` — Daily planning check-in based on goals & projects'
                    )
                },
                {
                    name: 'Memory & Profile',
                    value: (
                        '`!remember <fact>` — Store a personal note, habit, or preference\n' +
                        '`!facts [search]` — List or search remembered knowledge\n' +
                        '`!forget <text/id>` — Remove a fact from memory\n' +
                        '`!profile` — Review your compiled profile & goals\n' +
                        '`!addgoal <goal>` — Add a new career or personal goal\n' +
                        '`!clear` — Reset short-term conversation context for this channel'
                    )
                },
                {
                    name: 'AI Engine & Limits',
                    value: (
                        '`!status` — Provider status, active model, and memory counts\n' +
                        '`!limits` — Real-time tokens, remaining requests, and rate limits\n' +
                        '`!provider <groq|gemini>` — Switch active AI provider\n' +
                        '`!model <name>` — Switch model for active provider\n' +
                        '`!ping` — Test bot latency'
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

    async cmdClear(message) {
        this.memoryManager.clearShortTerm(message.channel.id);
        return await message.reply('Short-term conversation history for this channel cleared.');
    }
}

module.exports = CommandHandler;
