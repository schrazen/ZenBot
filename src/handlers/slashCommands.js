const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
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
        ),

    new SlashCommandBuilder()
        .setName('availability')
        .setDescription("View or set Lance's availability & inactivity detection (Owner only)")
        .addStringOption(opt =>
            opt.setName('action')
                .setDescription('Status action (status, on, off, away, sleep, auto)')
                .setRequired(false)
                .addChoices(
                    { name: 'status (Show current inferred status)', value: 'status' },
                    { name: 'on (Mark available / online)', value: 'on' },
                    { name: 'away (Mark away / AFK)', value: 'away' },
                    { name: 'sleep (Mark asleep)', value: 'sleep' },
                    { name: 'auto (Reset to automatic detection)', value: 'auto' }
                )
        )
        .addStringOption(opt =>
            opt.setName('duration')
                .setDescription('Optional duration for away/sleep (e.g. 2h, 30m, 6h)')
                .setRequired(false)
        ),

    new SlashCommandBuilder()
        .setName('study')
        .setDescription('Interactive Acads Study Companion (ingest notes, review flashcards, quiz)')
        .addSubcommand(sub =>
            sub.setName('use')
                .setDescription('Set or switch the active study deck')
                .addStringOption(opt =>
                    opt.setName('deck')
                        .setDescription('Deck name to set active')
                        .setRequired(true)
                )
        )
        .addSubcommand(sub =>
            sub.setName('create')
                .setDescription('Create a new study deck')
                .addStringOption(opt =>
                    opt.setName('name')
                        .setDescription('Name of the new deck')
                        .setRequired(true)
                )
        )
        .addSubcommand(sub =>
            sub.setName('delete')
                .setDescription('Delete a study deck completely')
                .addStringOption(opt =>
                    opt.setName('deck')
                        .setDescription('Name of the deck to delete')
                        .setRequired(true)
                )
        )
        .addSubcommand(sub =>
            sub.setName('rename')
                .setDescription('Rename a study deck')
                .addStringOption(opt =>
                    opt.setName('old')
                        .setDescription('Current deck name')
                        .setRequired(true)
                )
                .addStringOption(opt =>
                    opt.setName('new')
                        .setDescription('New deck name')
                        .setRequired(true)
                )
        )
        .addSubcommand(sub =>
            sub.setName('view')
                .setDescription('Inspect cards in a study deck')
                .addStringOption(opt =>
                    opt.setName('deck')
                        .setDescription('Deck name to inspect (defaults to active)')
                        .setRequired(false)
                )
                .addIntegerOption(opt =>
                    opt.setName('page')
                        .setDescription('Page number to inspect (default: 1)')
                        .setRequired(false)
                        .setMinValue(1)
                )
        )
        .addSubcommand(sub =>
            sub.setName('notes')
                .setDescription('Ingest raw notes into [Description -> Word Answer] pairs silently')
                .addStringOption(opt =>
                    opt.setName('text')
                        .setDescription('Notes content to parse and save')
                        .setRequired(true)
                )
        )
        .addSubcommand(sub =>
            sub.setName('quiz')
                .setDescription('Start an interactive quiz session')
                .addStringOption(opt =>
                    opt.setName('deck')
                        .setDescription('Deck name (defaults to active)')
                        .setRequired(false)
                )
        )
        .addSubcommand(sub =>
            sub.setName('stop')
                .setDescription('End current review session')
        )
        .addSubcommand(sub =>
            sub.setName('decks')
                .setDescription('List all flashcard decks and show active deck')
        )
        .addSubcommand(sub =>
            sub.setName('clear')
                .setDescription('Clear cards in a flashcard deck')
                .addStringOption(opt =>
                    opt.setName('deck')
                        .setDescription('Deck name to clear (defaults to active)')
                        .setRequired(false)
                )
        ),

    new SlashCommandBuilder()
        .setName('quiz')
        .setDescription('Quickly start an acads study quiz')
        .addStringOption(opt =>
            opt.setName('deck')
                .setDescription('Deck name (default: acads)')
                .setRequired(false)
        ),

    new SlashCommandBuilder()
        .setName('bot')
        .setDescription('Manage ZenBot Discord profile, status, bio, and presence (Owner only)')
        .addSubcommand(sub =>
            sub.setName('profile')
                .setDescription('View current bot profile, status, bio, and uptime')
        )
        .addSubcommand(sub =>
            sub.setName('status')
                .setDescription('Change bot activity status name and type')
                .addStringOption(opt =>
                    opt.setName('text')
                        .setDescription('Status or activity text')
                        .setRequired(true)
                )
                .addStringOption(opt =>
                    opt.setName('type')
                        .setDescription('Activity type')
                        .setRequired(false)
                        .addChoices(
                            { name: 'Watching', value: 'watching' },
                            { name: 'Playing', value: 'playing' },
                            { name: 'Listening to', value: 'listening' },
                            { name: 'Competing in', value: 'competing' }
                        )
                )
        )
        .addSubcommand(sub =>
            sub.setName('bio')
                .setDescription('Update the bot\'s Discord "About Me" application bio')
                .addStringOption(opt =>
                    opt.setName('text')
                        .setDescription('New bio text')
                        .setRequired(true)
                )
        )
        .addSubcommand(sub =>
            sub.setName('presence')
                .setDescription('Change online presence state')
                .addStringOption(opt =>
                    opt.setName('status')
                        .setDescription('Online presence')
                        .setRequired(true)
                        .addChoices(
                            { name: 'Online (Green)', value: 'online' },
                            { name: 'Idle (Orange)', value: 'idle' },
                            { name: 'Do Not Disturb (Red)', value: 'dnd' }
                        )
                )
        )
        .addSubcommand(sub =>
            sub.setName('username')
                .setDescription('Change bot username (2 changes per hour limit)')
                .addStringOption(opt =>
                    opt.setName('name')
                        .setDescription('New bot username')
                        .setRequired(true)
                )
        )
        .addSubcommand(sub =>
            sub.setName('avatar')
                .setDescription('Change bot avatar picture')
                .addStringOption(opt =>
                    opt.setName('url')
                        .setDescription('Image URL for avatar')
                        .setRequired(true)
                )
        ),

    new SlashCommandBuilder()
        .setName('goal')
        .setDescription('Manage autonomous AI agent goals (Lance only)')
        .addStringOption(opt =>
            opt.setName('action')
                .setDescription('Goal action')
                .setRequired(true)
                .addChoices(
                    { name: 'start — Launch a new autonomous goal', value: 'start' },
                    { name: 'status — Check current progress', value: 'status' },
                    { name: 'pause — Pause active goal', value: 'pause' },
                    { name: 'resume — Resume paused goal', value: 'resume' },
                    { name: 'cancel — Stop active goal', value: 'cancel' },
                    { name: 'history — View past goals', value: 'history' }
                )
        )
        .addStringOption(opt =>
            opt.setName('prompt')
                .setDescription('Task description if action is "start"')
                .setRequired(false)
        ),

    new SlashCommandBuilder()
        .setName('web')
        .setDescription('Zero-key DuckDuckGo search')
        .addStringOption(opt =>
            opt.setName('query')
                .setDescription('Search query')
                .setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName('learn')
        .setDescription('Teach ZenBot a new workflow rule or habit (Lance only)')
        .addStringOption(opt =>
            opt.setName('rule')
                .setDescription('Rule or habit to learn (e.g. "Prefer TypeScript over JavaScript")')
                .setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName('preferences')
        .setDescription('View all learned agent preferences & habits (Lance only)'),

    new SlashCommandBuilder()
        .setName('automate')
        .setDescription('Schedule background watcher or morning briefing (Lance only)')
        .addStringOption(opt =>
            opt.setName('schedule')
                .setDescription('Interval or time (e.g. "daily at 8am", "every 2 hours", "every 30m")')
                .setRequired(true)
        )
        .addStringOption(opt =>
            opt.setName('task')
                .setDescription('Task to run (e.g. "morning standup", "check https://... for price drop")')
                .setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName('automations')
        .setDescription('List all active background automations and watchers (Lance only)')
];

/**
 * Registers global slash commands and purges legacy/dead guild commands.
 * Uses SHA-256 hash caching in data/.slash_commands_hash to skip redundant REST PUTs on unchanged boots.
 */
async function registerSlashCommands(config, options = {}) {
    if (!config.discord.token || !config.discord.clientId) {
        logger.warn('Skipping slash command registration: missing token or clientId');
        return { skipped: true, reason: 'missing_credentials' };
    }

    const payload = slashCommands.map(cmd => cmd.toJSON());
    const guildsToClean = Array.from(new Set([
        config.discord.guildId,
        '873791689939107861',
        '1484106877708013608'
    ].filter(Boolean)));

    const hashFile = path.join(config.paths?.data || path.join(__dirname, '../../data'), '.slash_commands_hash');
    const currentHash = crypto
        .createHash('sha256')
        .update(JSON.stringify({ clientId: config.discord.clientId, payload, guildsToClean }))
        .digest('hex');

    if (!options.force && fs.existsSync(hashFile)) {
        try {
            const cachedHash = fs.readFileSync(hashFile, 'utf8').trim();
            if (cachedHash === currentHash) {
                logger.info(`Slash commands unchanged (SHA-256 ${currentHash.slice(0, 8)}) — skipped redundant Discord API sync.`);
                return { skipped: true, reason: 'unchanged_hash', hash: currentHash };
            }
        } catch (e) {}
    }

    const rest = new REST({ version: '10' }).setToken(config.discord.token);

    try {
        logger.info('Registering ZenBot slash commands with Discord API...');

        // 1. Register global application commands
        const registered = await rest.put(
            Routes.applicationCommands(config.discord.clientId),
            { body: payload }
        );
        logger.success(`Successfully registered ${registered.length} global slash commands with Discord.`);

        // 2. Clear any stale guild-level commands from known guilds (deduplicated)
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

        try {
            const dir = path.dirname(hashFile);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(hashFile, currentHash, 'utf8');
        } catch (e) {}

        return { skipped: false, count: registered.length, hash: currentHash };
    } catch (error) {
        logger.error(`Failed to register slash commands: ${error.message}`);
        return { skipped: false, error: error.message };
    }
}

module.exports = {
    slashCommands,
    registerSlashCommands
};

