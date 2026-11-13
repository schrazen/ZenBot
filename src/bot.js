const { Client, GatewayIntentBits, Partials, ActivityType, Events } = require('discord.js');
const config = require('./config');
const LLMManager = require('./services/llm');
const MemoryManager = require('./services/memory');
const CommandHandler = require('./handlers/commandHandler');
const MessageHandler = require('./handlers/messageHandler');
const ChannelHistoryService = require('./services/channelHistory');
const OwnerAvailabilityService = require('./services/ownerAvailability');
const StudyService = require('./services/studyService');
const BotProfileService = require('./services/botProfileService');
const WorkspaceService = require('./services/workspaceService');
const ReminderService = require('./services/reminderService');
const WebSearchService = require('./services/webSearchService');
const GoalService = require('./services/goalService');
const AutomationService = require('./services/automationService');
const MessageQueueService = require('./services/messageQueueService');
const SelfUpgradeService = require('./services/selfUpgradeService');
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
                GatewayIntentBits.GuildMessageReactions,
                GatewayIntentBits.GuildMessageTyping,
                GatewayIntentBits.DirectMessageTyping
            ],
            partials: [
                Partials.Channel,
                Partials.Message,
                Partials.Reaction
            ]
        });

        this.llmManager = new LLMManager(this.config);
        this.memoryManager = new MemoryManager(this.config);
        this.channelHistory = new ChannelHistoryService(this.client, this.config);
        this.ownerAvailability = new OwnerAvailabilityService({
            config: this.config,
            client: this.client
        });
        this.studyService = new StudyService({
            config: this.config,
            llmManager: this.llmManager
        });
        this.botProfileService = new BotProfileService({
            config: this.config
        });
        this.workspaceService = new WorkspaceService({
            rootDir: this.config.paths.root,
            vaultDirs: this.config.paths.vaultPaths
        });
        this.selfUpgradeService = new SelfUpgradeService({
            config: this.config,
            workspaceService: this.workspaceService,
            client: this.client
        });
        this.reminderService = new ReminderService({
            config: this.config,
            storagePath: this.config.paths.reminders
        });
        this.webSearchService = new WebSearchService();
        this.goalService = new GoalService({
            config: this.config,
            llmManager: this.llmManager,
            workspaceService: this.workspaceService,
            webSearchService: this.webSearchService,
            reminderService: this.reminderService,
            selfUpgradeService: this.selfUpgradeService,
            channelHistory: this.channelHistory,
            automationService: this.automationService,
            ownerAvailability: this.ownerAvailability,
            memoryManager: this.memoryManager,
            client: this.client
        });
        this.automationService = new AutomationService({
            config: this.config,
            llmManager: this.llmManager,
            webSearchService: this.webSearchService,
            workspaceService: this.workspaceService,
            memoryManager: this.memoryManager,
            selfUpgradeService: this.selfUpgradeService,
            channelHistory: this.channelHistory,
            reminderService: this.reminderService,
            ownerAvailability: this.ownerAvailability,
            client: this.client,
            storagePath: this.config.paths.automations
        });
        this.goalService.automationService = this.automationService;
        this.messageQueueService = new MessageQueueService(1800);

        this.commandHandler = new CommandHandler({
            config: this.config,
            llmManager: this.llmManager,
            memoryManager: this.memoryManager,
            channelHistory: this.channelHistory,
            ownerAvailability: this.ownerAvailability,
            studyService: this.studyService,
            botProfileService: this.botProfileService,
            workspaceService: this.workspaceService,
            selfUpgradeService: this.selfUpgradeService,
            reminderService: this.reminderService,
            webSearchService: this.webSearchService,
            goalService: this.goalService,
            automationService: this.automationService,
            client: this.client
        });

        this.messageHandler = new MessageHandler({
            config: this.config,
            llmManager: this.llmManager,
            memoryManager: this.memoryManager,
            commandHandler: this.commandHandler,
            channelHistory: this.channelHistory,
            ownerAvailability: this.ownerAvailability,
            studyService: this.studyService,
            workspaceService: this.workspaceService,
            selfUpgradeService: this.selfUpgradeService,
            reminderService: this.reminderService,
            webSearchService: this.webSearchService,
            goalService: this.goalService,
            automationService: this.automationService,
            client: this.client
        });

        this.commandHandler.messageHandler = this.messageHandler;

        this.setupEventHandlers();
    }

    setupEventHandlers() {
        this.client.once(Events.ClientReady || 'ready', () => {
            logger.success(`=============================================`);
            logger.success(`ZenBot online as: ${this.client.user.tag}`);
            logger.info(`Active Provider: ${this.llmManager.currentProviderName.toUpperCase()}`);
            logger.info(`Channel lock: ${this.config.discord.channelIds?.join(', ') || this.config.discord.channelId || 'Any'}`);
            logger.info(`Authorized Owners: ${this.config.discord.allowedUserIds.join(', ') || 'All'}`);
            const servers = this.client.guilds.cache.map(g => `${g.name} (${g.id})`);
            logger.info(`Connected Servers (${servers.length}): ${servers.join(', ') || 'None'}`);
            logger.success(`=============================================`);

            this.botProfileService.applyPresence(this.client);
            this.botProfileService.watchProfile(this.client);
            this.reminderService.start(this.client);
            this.automationService.start(this.client);
            this.ownerAvailability.syncRecentActivityFromGuilds(this.client).catch(() => {});

            if (!this.botProfileService.getProfile().bio) {
                this.botProfileService.fetchBio(this.config.discord.token).catch(() => {});
            }

            // Ensure slash commands are synced with Discord on startup
            registerSlashCommands(this.config).catch(err => {
                logger.error('Background slash command registration error:', err.message);
            });
        });

        this.client.on('messageCreate', async (message) => {
            try {
                if (message.author?.bot) return;
                this.messageQueueService.enqueue(message, async (finalMsg) => {
                    await this.messageHandler.handle(finalMsg);
                });
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

        this.client.on('typingStart', (typing) => {
            try {
                if (this.ownerAvailability.isOwner(typing?.user?.id)) {
                    this.ownerAvailability.recordActivity({
                        type: 'typing',
                        channelId: typing.channel?.id,
                        guildId: typing.guild?.id
                    });
                }
            } catch (err) {
                logger.error('Error in typingStart event:', err);
            }
        });

        this.client.on('presenceUpdate', (oldPresence, newPresence) => {
            try {
                if (this.ownerAvailability.isOwner(newPresence?.userId)) {
                    if (['online', 'idle', 'dnd'].includes(newPresence.status)) {
                        this.ownerAvailability.recordActivity({
                            type: 'presence',
                            guildId: newPresence.guild?.id
                        });
                    }
                }
            } catch (err) {}
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
        if (this.reminderService) {
            this.reminderService.stop();
        }
        if (this.automationService) {
            this.automationService.stop();
        }
        this.client.destroy();
        process.exit(0);
    }
}

module.exports = ZenBot;
