const { SlashCommandBuilder, REST, Routes } = require('discord.js');
const logger = require('../utils/logger');

const slashCommands = [
    new SlashCommandBuilder()
        .setName('help')
        .setDescription('Overview of ZenBot commands and features'),

    new SlashCommandBuilder()
        .setName('status')
        .setDescription('System status, active AI model, memory counts, and humor intensity'),

    new SlashCommandBuilder()
        .setName('limits')
        .setDescription('Real-time API token usage, remaining requests, and rate limits'),

    new SlashCommandBuilder()
        .setName('humor')
        .setDescription('View or change humor intensity (0=serious, 2=natural, 4=shitpost, 5=degeneracy)')
        .addIntegerOption(opt =>
            opt.setName('level')
                .setDescription('Humor level (0 to 5)')
                .setRequired(false)
                .setMinValue(0)
                .setMaxValue(5)
        ),

    new SlashCommandBuilder()
        .setName('roast')
        .setDescription('Ruthlessly roast a target on Discord (Owner only)')
        .addUserOption(opt =>
            opt.setName('target')
                .setDescription('User to cook')
                .setRequired(false)
        )
        .addStringOption(opt =>
            opt.setName('name')
                .setDescription('Name of the victim if not tagging')
                .setRequired(false)
        )
        .addStringOption(opt =>
            opt.setName('topic')
                .setDescription('Context or ammunition for the roast')
                .setRequired(false)
        ),

    new SlashCommandBuilder()
        .setName('roll')
        .setDescription('Roll D&D dice with DM outcomes (e.g. d20 sneak into kitchen, 2d6+3)')
        .addStringOption(opt =>
            opt.setName('query')
                .setDescription('Dice formula and/or action (e.g. "d20 sneak past guards", "2d6+3", "deploy to prod")')
                .setRequired(false)
        ),

    new SlashCommandBuilder()
        .setName('choose')
        .setDescription('Let fate pick between options')
        .addStringOption(opt =>
            opt.setName('options')
                .setDescription('Comma-separated options (e.g. "Valorant, sleep, code")')
                .setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName('coin')
        .setDescription('Flip a coin (Heads or Tails)'),

    new SlashCommandBuilder()
        .setName('summarize')
        .setDescription('Summarize recent Discord chat in this or another channel')
        .addStringOption(opt =>
            opt.setName('channel')
                .setDescription('Channel name or server name to summarize')
                .setRequired(false)
        )
        .addIntegerOption(opt =>
            opt.setName('count')
                .setDescription('Number of messages to analyze (default 35)')
                .setRequired(false)
                .setMinValue(5)
                .setMaxValue(100)
        ),

    new SlashCommandBuilder()
        .setName('projects')
        .setDescription("Overview of Lance's active tracked projects & tech stacks"),

    new SlashCommandBuilder()
        .setName('project')
        .setDescription('Detailed architecture and tasks for a project')
        .addStringOption(opt =>
            opt.setName('name')
                .setDescription('Project name or ID (e.g. "balik-belongings", "portfolio")')
                .setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName('standup')
        .setDescription('Daily planning check-in based on goals & projects'),

    new SlashCommandBuilder()
        .setName('facts')
        .setDescription('List or search remembered knowledge')
        .addStringOption(opt =>
            opt.setName('search')
                .setDescription('Search query for remembered facts')
                .setRequired(false)
        ),

    new SlashCommandBuilder()
        .setName('profile')
        .setDescription("Review Lance's compiled profile & goals"),

    new SlashCommandBuilder()
        .setName('ping')
        .setDescription('Test bot latency and response time'),

    new SlashCommandBuilder()
        .setName('clear')
        .setDescription('Reset short-term conversation context for this channel'),

    new SlashCommandBuilder()
        .setName('provider')
        .setDescription('Switch active AI provider (Owner only)')
        .addStringOption(opt =>
            opt.setName('name')
                .setDescription('Provider name (groq or gemini)')
                .setRequired(false)
                .addChoices(
                    { name: 'Groq (Ultra-fast GPT-OSS 120B)', value: 'groq' },
                    { name: 'Gemini (Google 3.1 Flash-Lite)', value: 'gemini' }
                )
        ),

    new SlashCommandBuilder()
        .setName('model')
        .setDescription('Switch active LLM model (Owner only)')
        .addStringOption(opt =>
            opt.setName('name')
                .setDescription('Model name')
                .setRequired(false)
        )
];

/**
 * Registers global slash commands and purges legacy/dead guild commands.
 */
async function registerSlashCommands(config) {
    if (!config.discord.token || !config.discord.clientId) {
        logger.warn('Skipping slash command registration: missing token or clientId');
        return;
    }

    const rest = new REST({ version: '10' }).setToken(config.discord.token);

    try {
        logger.info('Registering ZenBot slash commands with Discord API...');
        const payload = slashCommands.map(cmd => cmd.toJSON());

        // 1. Register global application commands (atomically replaces all 46 dead legacy Hermes commands)
        const registered = await rest.put(
            Routes.applicationCommands(config.discord.clientId),
            { body: payload }
        );
        logger.success(`Successfully registered ${registered.length} global slash commands with Discord.`);

        // 2. Clear any stale guild-level commands from known guilds
        const guildsToClean = [
            config.discord.guildId,
            '873791689939107861',
            '1484106877708013608'
        ].filter(Boolean);

        for (const gId of guildsToClean) {
            try {
                await rest.put(
                    Routes.applicationGuildCommands(config.discord.clientId, gId),
                    { body: [] }
                );
                logger.info(`Cleared stale guild-specific slash commands for guild ${gId}.`);
            } catch (err) {
                // Guild might not be accessible or bot might not be there
            }
        }
    } catch (error) {
        logger.error(`Failed to register slash commands: ${error.message}`);
    }
}

module.exports = {
    slashCommands,
    registerSlashCommands
};

