const { Client, GatewayIntentBits, Partials, ActivityType, Events } = require('discord.js');
const config = require('./config');
const LLMManager = require('./services/llm');
const MemoryManager = require('./services/memory');
const CommandHandler = require('./handlers/commandHandler');
const MessageHandler = require('./handlers/messageHandler');
const logger = require('./utils/logger');

class ZenBot {
    constructor() {
        this.config = config;
        this.client = new Client({
            intents: [
                GatewayIntentBits.Guilds,
                GatewayIntentBits.GuildMessages,
                GatewayIntentBits.MessageContent,
                GatewayIntentBits.DirectMessages
            ],
            partials: [
                Partials.Channel,
                Partials.Message
            ]
        });

        this.llmManager = new LLMManager(this.config);
        this.memoryManager = new MemoryManager(this.config);

        this.commandHandler = new CommandHandler({
            config: this.config,
            llmManager: this.llmManager,
            memoryManager: this.memoryManager
        });

        this.messageHandler = new MessageHandler({
            config: this.config,
            llmManager: this.llmManager,
            memoryManager: this.memoryManager,
            commandHandler: this.commandHandler,
            client: this.client
        });

        this.commandHandler.messageHandler = this.messageHandler;

        this._setupEvents();
    }

    _setupEvents() {
        this.client.once(Events.ClientReady || 'ready', () => {
            logger.success(`=============================================`);
            logger.success(`ZenBot online as: ${this.client.user.tag}`);
            logger.info(`Active Provider: ${this.llmManager.currentProviderName.toUpperCase()}`);
            logger.info(`Channel lock: ${this.config.discord.channelId || 'Any'}`);
            logger.info(`Authorized Users: ${this.config.discord.allowedUserIds.join(', ') || 'All'}`);
            logger.success(`=============================================`);

            this.client.user.setActivity('over Lance | !help', { type: ActivityType.Watching });
        });

        this.client.on('messageCreate', async (message) => {
            try {
                await this.messageHandler.handle(message);
            } catch (err) {
                logger.error('Unhandled error in messageCreate event:', err);
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
