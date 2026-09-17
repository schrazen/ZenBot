const { Client, GatewayIntentBits, Partials, ActivityType, Events } = require('discord.js');
const config = require('./config');
const LLMManager = require('./services/llm');
const MemoryManager = require('./services/memory');
const CommandHandler = require('./handlers/commandHandler');
const MessageHandler = require('./handlers/messageHandler');
const ChannelHistoryService = require('./services/channelHistory');
const OwnerAvailabilityService = require('./services/ownerAvailability');
const StudyService = require('./services/studyService');
const { registerSlashCommands } = require('./handlers/slashCommands');
const logger = require('./utils/logger');

class ZenBot {
    constructor() {
        this.config = config;
        this.client = new Client({
            intents: [
                GatewayIntentBits.Guilds,
                GatewayIntentBits.GuildMessages,
                GatewayIntentBits.MessageContent,
                GatewayIntentBits.DirectMessages,
                GatewayIntentBits.GuildVoiceStates,
                GatewayIntentBits.GuildMessageReactions
            ],
            partials: [
                Partials.Channel,
                Partials.Message,
                Partials.Reaction
            ]
        });

        this.llmManager = new LLMManager(this.config);
        this.memoryManager = new MemoryManager(this.config);
        this.channelHistory = new ChannelHistoryService(this.client);
        this.ownerAvailability = new OwnerAvailabilityService({
            config: this.config,
            client: this.client
        });
        this.studyService = new StudyService({
            config: this.config,
            llmManager: this.llmManager
        });

        this.commandHandler = new CommandHandler({
            config: this.config,
            llmManager: this.llmManager,
            memoryManager: this.memoryManager,
            channelHistory: this.channelHistory,
            ownerAvailability: this.ownerAvailability,
            studyService: this.studyService
        });

        this.messageHandler = new MessageHandler({
            config: this.config,
            llmManager: this.llmManager,
            memoryManager: this.memoryManager,
            commandHandler: this.commandHandler,
            channelHistory: this.channelHistory,
            client: this.client,
            ownerAvailability: this.ownerAvailability,
            studyService: this.studyService
        });

        this.commandHandler.messageHandler = this.messageHandler;

        this._setupEvents();
    }

    _setupEvents() {
        this.client.once(Events.ClientReady || 'ready', () => {
            logger.success(`=============================================`);
            logger.success(`ZenBot online as: ${this.client.user.tag}`);
            logger.info(`Active Provider: ${this.llmManager.currentProviderName.toUpperCase()}`);
            logger.info(`Channel lock: ${this.config.discord.channelIds?.join(', ') || this.config.discord.channelId || 'Any'}`);
            logger.info(`Authorized Owners: ${this.config.discord.allowedUserIds.join(', ') || 'All'}`);
            const servers = this.client.guilds.cache.map(g => `${g.name} (${g.id})`);
            logger.info(`Connected Servers (${servers.length}): ${servers.join(', ') || 'None'}`);
            logger.success(`=============================================`);

            this.client.user.setActivity('Bisaya si Ed | /help', { type: ActivityType.Watching });

            // Ensure slash commands are synced with Discord on startup
            registerSlashCommands(this.config).catch(err => {
                logger.error('Background slash command registration error:', err.message);
            });
        });

        this.client.on('messageCreate', async (message) => {
            try {
                await this.messageHandler.handle(message);
            } catch (err) {
                logger.error('Unhandled error in messageCreate event:', err);
            }
        });

        this.client.on(Events.InteractionCreate, async (interaction) => {
            try {
                await this.commandHandler.handleInteraction(interaction);
            } catch (err) {
                logger.error('Unhandled error in interactionCreate event:', err);
            }
        });

        this.client.on('voiceStateUpdate', (oldState, newState) => {
            try {
                this.ownerAvailability.updateVoiceState(oldState, newState);
            } catch (err) {
                logger.error('Error in voiceStateUpdate event:', err);
            }
        });

        this.client.on('messageReactionAdd', async (reaction, user) => {
            try {
                if (this.ownerAvailability.isOwner(user?.id)) {
                    this.ownerAvailability.recordActivity({
                        type: 'reaction',
                        channelId: reaction.message?.channel?.id,
                        guildId: reaction.message?.guild?.id
                    });
                }
            } catch (err) {
                logger.error('Error in messageReactionAdd event:', err);
            }
        });

        this.client.on('error', (err) => {
            logger.error('Discord client error:', err);
        });
    }

    async start() {
        if (!this.config.discord.token) {
            throw new Error('DISCORD_TOKEN is missing in zen.env!');
        }

        logger.info('Logging into Discord...');
        await this.client.login(this.config.discord.token);
    }

    async stop() {
        logger.info('Shutting down ZenBot gracefully...');
        this.client.destroy();
        process.exit(0);
    }
}

module.exports = ZenBot;
