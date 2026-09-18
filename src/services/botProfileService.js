const fs = require('fs');
const path = require('path');
const { ActivityType, REST, Routes } = require('discord.js');
const logger = require('../utils/logger');

const ACTIVITY_TYPE_MAP = {
    watching: ActivityType.Watching,
    playing: ActivityType.Playing,
    listening: ActivityType.Listening,
    competing: ActivityType.Competing,
    streaming: ActivityType.Streaming,
    custom: ActivityType.Custom
};

class BotProfileService {
    constructor({ config, storagePath }) {
        this.config = config;
        this.storagePath = storagePath ||
            (config?.paths?.data ? path.join(config.paths.data, 'bot_profile.json') : path.join(__dirname, '../../data/bot_profile.json'));

        this.profile = this.loadProfile();
        this.fileWatcher = null;
        this.lastModified = 0;
    }

    /**
     * Loads persisted profile configuration from JSON.
     */
    loadProfile() {
        try {
            if (fs.existsSync(this.storagePath)) {
                const raw = fs.readFileSync(this.storagePath, 'utf8');
                const parsed = JSON.parse(raw);
                return {
                    activity: parsed.activity || 'Bisaya si Ed | /help',
                    activityType: parsed.activityType || 'Watching',
                    presence: parsed.presence || 'online',
                    bio: parsed.bio || '',
                    updatedAt: parsed.updatedAt || Date.now()
                };
            }
        } catch (e) {
            logger.warn(`Could not load bot_profile.json: ${e.message}`);
        }

        const defaults = {
            activity: 'Bisaya si Ed | /help',
            activityType: 'Watching',
            presence: 'online',
            bio: '',
            updatedAt: Date.now()
        };
        this.saveProfile(defaults);
        return defaults;
    }

    /**
     * Persists profile configuration to JSON.
     */
    saveProfile(updates = {}) {
        try {
            this.profile = {
                ...this.profile,
                ...updates,
                updatedAt: Date.now()
            };

            const dir = path.dirname(this.storagePath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }

            fs.writeFileSync(this.storagePath, JSON.stringify(this.profile, null, 2), 'utf8');
            this.lastModified = Date.now();
            return this.profile;
        } catch (e) {
            logger.error(`Failed to save bot_profile.json: ${e.message}`);
            return this.profile;
        }
    }

    /**
     * Applies presence (activity and status) to the live Discord client.
     */
    applyPresence(client) {
        if (!client || !client.user) return false;

        try {
            const typeKey = (this.profile.activityType || 'watching').toLowerCase();
            const actType = ACTIVITY_TYPE_MAP[typeKey] ?? ActivityType.Watching;

            client.user.setPresence({
                activities: [{
                    name: this.profile.activity || 'Bisaya si Ed | /help',
                    type: actType
                }],
                status: this.profile.presence || 'online'
            });

            logger.info(`Presence updated: [${this.profile.presence.toUpperCase()}] ${this.profile.activityType} "${this.profile.activity}"`);
            return true;
        } catch (e) {
            logger.error(`Failed to apply presence to Discord client: ${e.message}`);
            return false;
        }
    }

    /**
     * Sets activity name and optional type.
     */
    async setActivity(text, type = null, client = null) {
        const updates = { activity: String(text).trim() };
        if (type) {
            const cleanType = String(type).trim().toLowerCase();
            if (ACTIVITY_TYPE_MAP[cleanType] !== undefined) {
                updates.activityType = cleanType.charAt(0).toUpperCase() + cleanType.slice(1);
            }
        }

        this.saveProfile(updates);

        if (client) {
            this.applyPresence(client);
        }

        return {
            success: true,
            activity: this.profile.activity,
            activityType: this.profile.activityType,
            message: `Updated bot activity to **${this.profile.activityType} "${this.profile.activity}"**.`
        };
    }

    /**
     * Sets online presence status ('online', 'idle', 'dnd', 'invisible').
     */
    async setPresenceStatus(status, client = null) {
        const clean = String(status).trim().toLowerCase();
        const valid = ['online', 'idle', 'dnd', 'invisible'];
        if (!valid.includes(clean)) {
            return {
                success: false,
                message: `Invalid presence status. Choose from: \`${valid.join(', ')}\``
            };
        }

        this.saveProfile({ presence: clean });

        if (client) {
            this.applyPresence(client);
        }

        return {
            success: true,
            presence: clean,
            message: `Updated bot presence to **${clean.toUpperCase()}**.`
        };
    }

    /**
     * Updates the bot's application "About Me" (bio) description.
     */
    async setBio(newBio, client = null, token = null) {
        const cleanBio = String(newBio).trim();
        const botToken = token || this.config?.discord?.token || process.env.DISCORD_TOKEN;

        try {
            if (client && client.application) {
                await client.application.edit({ description: cleanBio });
            } else if (botToken) {
                const rest = new REST({ version: '10' }).setToken(botToken);
                await rest.patch(Routes.currentApplication(), {
                    body: { description: cleanBio }
                });
            } else {
                throw new Error('No Discord client or bot token available to update bio.');
            }

            this.saveProfile({ bio: cleanBio });
            logger.success(`Bot bio updated via Discord API (${cleanBio.length} chars).`);

            return {
                success: true,
                bio: cleanBio,
                message: `Updated bot "About Me" bio successfully!\n>>> ${cleanBio}`
            };
        } catch (e) {
            logger.error(`Failed to update bot bio: ${e.message}`);
            return {
                success: false,
                message: `Failed to update bio: ${e.message}`
            };
        }
    }

    /**
     * Updates the bot's username (Discord rate limited: 2 times per hour).
     */
    async setUsername(newName, client) {
        if (!client || !client.user) {
            return { success: false, message: 'Discord client is not ready.' };
        }

        try {
            const clean = String(newName).trim();
            await client.user.setUsername(clean);
            logger.success(`Bot username updated to "${clean}".`);
            return {
                success: true,
                username: clean,
                message: `Updated bot username to **${clean}**!`
            };
        } catch (e) {
            logger.error(`Failed to update bot username: ${e.message}`);
            return {
                success: false,
                message: `Failed to update username: ${e.message} (Note: Discord limits username changes to 2 per hour).`
            };
        }
    }

    /**
     * Updates the bot's avatar icon.
     */
    async setAvatar(avatarInput, client) {
        if (!client || !client.user) {
            return { success: false, message: 'Discord client is not ready.' };
        }

        try {
            await client.user.setAvatar(avatarInput);
            logger.success(`Bot avatar updated.`);
            return {
                success: true,
                message: `Updated bot avatar successfully!`
            };
        } catch (e) {
            logger.error(`Failed to update bot avatar: ${e.message}`);
            return {
                success: false,
                message: `Failed to update avatar: ${e.message}`
            };
        }
    }

    /**
     * Fetches current application bio from Discord REST API.
     */
    async fetchBio(token = null) {
        const botToken = token || this.config?.discord?.token || process.env.DISCORD_TOKEN;
        if (!botToken) return this.profile.bio;

        try {
            const rest = new REST({ version: '10' }).setToken(botToken);
            const app = await rest.get(Routes.currentApplication());
            if (app && typeof app.description === 'string') {
                this.saveProfile({ bio: app.description });
                return app.description;
            }
        } catch (e) {
            logger.warn(`Could not fetch application bio: ${e.message}`);
        }
        return this.profile.bio;
    }

    /**
     * Returns a consolidated profile summary.
     */
    getProfile() {
        return { ...this.profile };
    }

    /**
     * Watches bot_profile.json for changes made from terminal or external tools,
     * and automatically hot-reloads presence without restarting the bot.
     */
    watchProfile(client) {
        if (this.fileWatcher) return;

        try {
            let debounceTimer = null;
            this.fileWatcher = fs.watch(this.storagePath, (eventType) => {
                if (eventType === 'change') {
                    if (Date.now() - this.lastModified < 1500) {
                        return; // Ignore self-triggered updates
                    }
                    if (debounceTimer) clearTimeout(debounceTimer);
                    debounceTimer = setTimeout(() => {
                        try {
                            const reloaded = this.loadProfile();
                            this.profile = reloaded;
                            if (client && client.user) {
                                this.applyPresence(client);
                                logger.info('Hot-reloaded presence from bot_profile.json');
                            }
                        } catch (e) {}
                    }, 250);
                }
            });
        } catch (e) {
            logger.warn(`Could not watch bot_profile.json: ${e.message}`);
        }
    }
}

module.exports = BotProfileService;
