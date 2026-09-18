const fs = require('fs');
const path = require('path');
const { EmbedBuilder } = require('discord.js');
const logger = require('../utils/logger');

class OwnerAvailabilityService {
    constructor({ config, client }) {
        this.config = config;
        this.client = client;
        this.storagePath = path.join(config.paths.data, 'owner_activity.json');
        this.timezone = process.env.OWNER_TIMEZONE || 'Asia/Manila';

        // Cooldown configuration
        this.cooldowns = {
            global: 2 * 60 * 1000,       // 2 minutes global
            channel: 8 * 60 * 1000,      // 8 minutes per channel
            user: 5 * 60 * 1000,         // 5 minutes per user
            dmAlert: 5 * 60 * 1000       // 5 minutes per channel alert to owner
        };

        // In-memory cooldown tracking
        this.lastGlobalReply = 0;
        this.lastChannelReply = new Map();
        this.lastUserReply = new Map();
        this.lastDmAlert = new Map();

        // In-memory voice state
        this.voiceState = {
            inVoice: false,
            channelId: null,
            guildId: null,
            streaming: false,
            lastVoiceTimestamp: 0
        };

        this.data = this.loadState();
    }

    /**
     * Loads persisted owner activity state.
     */
    loadState() {
        try {
            if (fs.existsSync(this.storagePath)) {
                const raw = fs.readFileSync(this.storagePath, 'utf8');
                return JSON.parse(raw);
            }
        } catch (e) {
            logger.warn(`Could not load owner_activity.json: ${e.message}`);
        }

        return {
            last_seen_timestamp: Date.now(),
            last_message_timestamp: 0,
            last_message_channel_id: null,
            last_message_guild_id: null,
            last_bot_interaction: 0,
            last_reaction_timestamp: 0,
            manual_state: null,
            manual_until: null,
            manual_reason: null
        };
    }

    /**
     * Persists owner activity state to JSON file.
     */
    saveState() {
        try {
            const dir = path.dirname(this.storagePath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            fs.writeFileSync(this.storagePath, JSON.stringify(this.data, null, 2), 'utf8');
        } catch (e) {
            logger.error(`Failed to save owner_activity.json: ${e.message}`);
        }
    }

    /**
     * Returns list of configured owner Discord IDs.
     */
    getOwnerIds() {
        const ids = this.config.discord.allowedUserIds || [];
        if (ids.length > 0) return ids;
        return ['1201887051520151656', '871274613227798589'];
    }

    /**
     * Checks if a user ID belongs to the bot owner (Lance).
     */
    isOwner(userId) {
        if (!userId) return false;
        return this.getOwnerIds().includes(String(userId));
    }

    /**
     * Records any observed owner activity.
     */
    recordActivity({ type = 'message', channelId = null, guildId = null, timestamp = Date.now() } = {}) {
        this.data.last_seen_timestamp = timestamp;

        if (type === 'message') {
            this.data.last_message_timestamp = timestamp;
            this.data.last_message_channel_id = channelId;
            this.data.last_message_guild_id = guildId;
        } else if (type === 'bot_interaction') {
            this.data.last_bot_interaction = timestamp;
        } else if (type === 'reaction') {
            this.data.last_reaction_timestamp = timestamp;
        } else if (type === 'voice') {
            this.voiceState.lastVoiceTimestamp = timestamp;
        }

        // Auto-clear manual away/sleep if owner is actively chatting or using the bot
        if (this.data.manual_state && (type === 'message' || type === 'bot_interaction')) {
            const timeSinceManual = Date.now() - (this.data.manual_set_at || 0);
            // If manual state was set more than 2 minutes ago, active chatting clears it
            if (timeSinceManual > 2 * 60 * 1000) {
                logger.info(`Owner became active; clearing manual state [${this.data.manual_state}]`);
                this.data.manual_state = null;
                this.data.manual_until = null;
                this.data.manual_reason = null;
            }
        }

        this.saveState();
    }

    /**
     * Updates voice channel state for Lance.
     */
    updateVoiceState(oldState, newState) {
        const userId = newState?.member?.id || oldState?.member?.id;
        if (!this.isOwner(userId)) return;

        const inVoice = !!newState?.channelId;
        this.voiceState = {
            inVoice,
            channelId: newState?.channelId || null,
            guildId: newState?.guild?.id || null,
            streaming: !!newState?.streaming,
            lastVoiceTimestamp: Date.now()
        };

        this.recordActivity({
            type: 'voice',
            channelId: newState?.channelId,
            guildId: newState?.guild?.id
        });

        logger.info(`Owner voice state updated: inVoice=${inVoice}, streaming=${this.voiceState.streaming}`);
    }

    /**
     * Computes the current availability state and confidence.
     * Possible states: AVAILABLE, LIKELY_AVAILABLE, INACTIVE, LIKELY_ASLEEP, UNKNOWN
     */
    getAvailabilityState() {
        const now = Date.now();

        // 1. Check manual override
        if (this.data.manual_state) {
            if (this.data.manual_until && now > this.data.manual_until) {
                logger.info(`Manual availability state expired.`);
                this.data.manual_state = null;
                this.data.manual_until = null;
                this.data.manual_reason = null;
                this.saveState();
            } else {
                return {
                    state: this.data.manual_state,
                    confidence: 1.0,
                    reason: `Manual override (${this.data.manual_reason || 'user specified'})`,
                    manualUntil: this.data.manual_until
                };
            }
        }

        // 2. Check voice channel state
        if (this.voiceState.inVoice) {
            return {
                state: 'AVAILABLE',
                confidence: 0.9,
                reason: `Currently in voice channel (#${this.voiceState.channelId})${this.voiceState.streaming ? ' streaming' : ''}`
            };
        }

        // 3. Evaluate time since last observed activity
        const lastActivity = Math.max(
            this.data.last_seen_timestamp || 0,
            this.data.last_message_timestamp || 0,
            this.data.last_bot_interaction || 0,
            this.data.last_reaction_timestamp || 0,
            this.voiceState.lastVoiceTimestamp || 0
        );

        if (!lastActivity) {
            return { state: 'UNKNOWN', confidence: 0.0, reason: 'No recorded owner activity' };
        }

        const diffMinutes = Math.floor((now - lastActivity) / (60 * 1000));

        // Active within last 15 minutes -> definitely AVAILABLE
        if (diffMinutes < 15) {
            return {
                state: 'AVAILABLE',
                confidence: 0.95,
                reason: `Active ${diffMinutes}m ago`
            };
        }

        // Active within 15-45 minutes -> LIKELY_AVAILABLE
        if (diffMinutes < 45) {
            return {
                state: 'LIKELY_AVAILABLE',
                confidence: 0.8,
                reason: `Active ${diffMinutes}m ago`
            };
        }

        // Inactive for 45 min - 2 hours -> INACTIVE
        if (diffMinutes < 120) {
            return {
                state: 'INACTIVE',
                confidence: 0.85,
                reason: `Inactive for ${diffMinutes}m`
            };
        }

        // Inactive > 2 hours: evaluate time-of-day in Asia/Manila
        let manilaHour = 12;
        try {
            const hourStr = new Intl.DateTimeFormat('en-US', {
                timeZone: this.timezone,
                hour: 'numeric',
                hour12: false
            }).format(new Date(now));
            manilaHour = parseInt(hourStr, 10);
        } catch (e) {
            manilaHour = new Date(now).getUTCHours() + 8; // Manila is UTC+8
            if (manilaHour >= 24) manilaHour -= 24;
        }

        const diffHours = (diffMinutes / 60).toFixed(1);

        // Nighttime (00:00 to 05:59): High sleep likelihood
        if (manilaHour >= 0 && manilaHour < 6) {
            return {
                state: 'LIKELY_ASLEEP',
                confidence: 0.9,
                reason: `Inactive for ${diffHours}h at night (${manilaHour}:00 Manila time)`
            };
        }

        // Early morning (06:00 to 08:59): Moderate sleep likelihood if inactive > 4 hours
        if (manilaHour >= 6 && manilaHour < 9) {
            if (diffMinutes >= 240) {
                return {
                    state: 'LIKELY_ASLEEP',
                    confidence: 0.8,
                    reason: `Inactive for ${diffHours}h into morning (${manilaHour}:00 Manila time)`
                };
            } else {
                return {
                    state: 'INACTIVE',
                    confidence: 0.85,
                    reason: `Inactive for ${diffHours}h in morning (${manilaHour}:00 Manila time)`
                };
            }
        }

        // Daytime / Evening (09:00 to 23:59): Assume away/AFK, NEVER assume sleep
        return {
            state: 'INACTIVE',
            confidence: 0.85,
            reason: `Inactive for ${diffHours}h during daytime/evening (${manilaHour}:00 Manila time)`
        };
    }

    /**
     * Checks if an incoming message is attempting to contact, ping, or ask about Lance.
     */
    async detectContactIntent(message) {
        if (!message.guild || message.author.bot || this.isOwner(message.author.id)) {
            return { isContact: false };
        }

        const ownerIds = this.getOwnerIds();

        // 1. Direct mention of Lance
        const directMention = ownerIds.some(id => message.mentions.users.has(id));
        if (directMention) {
            return {
                isContact: true,
                confidence: 1.0,
                reason: 'Direct mention of owner'
            };
        }

        // 2. Reply to a message previously sent by Lance
        if (message.reference && message.reference.messageId) {
            try {
                const refMsg = await message.channel.messages.fetch(message.reference.messageId);
                if (refMsg && this.isOwner(refMsg.author.id)) {
                    return {
                        isContact: true,
                        confidence: 0.95,
                        reason: 'Replied to owner message'
                    };
                }
            } catch (e) {}
        }

        const content = message.content.toLowerCase();

        // 3. Name references with contact/inquiry intent
        const hasOwnerName = /\b(lance|schrazen|zen)\b/i.test(content);
        if (!hasOwnerName) {
            return { isContact: false };
        }

        // Filter out purely casual / descriptive references (do NOT trigger)
        const isDescriptive = /\b(reminds me of|said earlier|was right|according to|kagaya ni|sabi ni)\s+(lance|schrazen|zen)\b/i.test(content);
        if (isDescriptive) {
            return { isContact: false };
        }

        // Check clear contact / where-is inquiry patterns
        const contactPatterns = [
            /\b(where('s| is|\s+is)|nasan|nasaan|asan)(\s+na)?(\s+si)?\s+(he|lance|schrazen|zen)\b/i,
            /\bhas anyone seen (lance|schrazen|zen|him)\b/i,
            /\b(tell|paki\s*sabi\s*kay|pakisabi\s*kay|paki\s*tawag\s*si|sabihin\s*kay)\s+(lance|schrazen|zen|him)\b/i,
            /\b(is|are|tulog\s*ba\s*si|tulog\s*na\s*ba\s*si|gising\s*ba\s*si|online\s*ba\s*si|nandito\s*ba\s*si|naka\s*afk\s*ba\s*si|afk\s*ba\s*si|wala\s*ba\s*si)\s+(lance|schrazen|zen)(\s+(awake|online|asleep|here|afk|active|around|tulog|gising))?\b/i,
            /\b(tulog\s*(na)?\s*(ata|yata|ba)?\s*si)\s+(lance|schrazen|zen)\b/i,
            /\b(yo|hey|hi|hello|hoi|hoy|psst|ping)\s+(lance|schrazen|zen)\b/i,
            /\b(calling|calling\s*for|looking\s*for|hanap\s*si|hinahanap\s*si)\s+(lance|schrazen|zen)\b/i,
            /\b(lance|schrazen|zen)\s*\?/i
        ];

        for (const pat of contactPatterns) {
            if (pat.test(content)) {
                return {
                    isContact: true,
                    confidence: 0.85,
                    reason: `Matched contact pattern: ${pat}`
                };
            }
        }

        return { isContact: false };
    }

    /**
     * Checks cooldowns to prevent spamming server channels or users.
     */
    isCooldownActive(channelId, userId) {
        const now = Date.now();

        // Global cooldown
        if (now - this.lastGlobalReply < this.cooldowns.global) {
            return { active: true, type: 'global', remainingMs: this.cooldowns.global - (now - this.lastGlobalReply) };
        }

        // Channel cooldown
        const lastChannel = this.lastChannelReply.get(channelId) || 0;
        if (now - lastChannel < this.cooldowns.channel) {
            return { active: true, type: 'channel', remainingMs: this.cooldowns.channel - (now - lastChannel) };
        }

        // User cooldown
        const lastUser = this.lastUserReply.get(userId) || 0;
        if (now - lastUser < this.cooldowns.user) {
            return { active: true, type: 'user', remainingMs: this.cooldowns.user - (now - lastUser) };
        }

        return { active: false };
    }

    /**
     * Generates a natural, non-impersonating response based on availability state.
     */
    generateAvailabilityResponse(state) {
        if (state === 'LIKELY_ASLEEP') {
            const responses = [
                "He's probably asleep rn. You can leave a message though.",
                "Pretty sure he's asleep right now. Leave it here, he'll see it later.",
                "Parang tulog na siya rn. I'll leave him to discover this later.",
                "He's likely asleep right now. Drop whatever you need and he'll check it when he wakes up."
            ];
            return responses[Math.floor(Math.random() * responses.length)];
        }

        if (state === 'INACTIVE') {
            const responses = [
                "He's probably away / AFK at the moment.",
                "Looks like he's inactive right now. Feel free to leave a message.",
                "I don't think he's around right now. Leave it here, he'll see it later.",
                "Parang wala pa siya ngayon or AFK. You can leave a message though."
            ];
            return responses[Math.floor(Math.random() * responses.length)];
        }

        return null;
    }

    /**
     * Sends a direct alert to Lance via Discord DM with caller information.
     */
    async sendOwnerDmAlert(message, callerName, stateInfo) {
        const now = Date.now();
        const channelId = message.channel.id;
        const lastAlert = this.lastDmAlert.get(channelId) || 0;

        // Rate limit DM alerts to 1 alert per channel every 10 minutes
        if (now - lastAlert < this.cooldowns.dmAlert) {
            return;
        }

        this.lastDmAlert.set(channelId, now);

        const ownerId = this.getOwnerIds()[0];
        if (!ownerId) return;

        try {
            const ownerUser = await this.client.users.fetch(ownerId);
            if (!ownerUser) return;

            const snippet = (message.cleanContent || message.content || '').slice(0, 300);
            const channelName = message.channel.name || 'channel';
            const guildName = message.guild?.name || 'Server';

            const embed = new EmbedBuilder()
                .setTitle('🔔 Discord Ping Alert')
                .setColor(0xf72585)
                .setDescription(
                    `**${callerName}** in **#${channelName}** (${guildName}) is trying to reach you while you appear **${stateInfo.state}**:\n\n` +
                    `> "${snippet}"\n\n` +
                    `[**Jump to Message**](${message.url})`
                )
                .setFooter({ text: `Status: ${stateInfo.state} • ${stateInfo.reason}` })
                .setTimestamp();

            await ownerUser.send({ embeds: [embed] });
            logger.info(`Dispatched DM alert to owner for ping from ${callerName} in #${channelName}`);
        } catch (err) {
            logger.warn(`Could not send DM alert to owner: ${err.message}`);
        }
    }

    /**
     * Core scanner method: inspects incoming message, evaluates availability,
     * and responds if Lance is away/asleep.
     */
    async checkAndRespond(message) {
        // 1. Detect contact intent
        const intent = await this.detectContactIntent(message);
        if (!intent.isContact) {
            return false;
        }

        // 2. Evaluate owner availability state
        const stateInfo = this.getAvailabilityState();
        logger.info(`Owner contact detected from ${message.author.tag}. Inferred state: ${stateInfo.state} (${stateInfo.reason})`);

        // If owner is AVAILABLE or LIKELY_AVAILABLE or UNKNOWN -> stay completely silent
        if (stateInfo.state === 'AVAILABLE' || stateInfo.state === 'LIKELY_AVAILABLE' || stateInfo.state === 'UNKNOWN') {
            return false;
        }

        // 3. Check cooldowns
        const cd = this.isCooldownActive(message.channel.id, message.author.id);
        if (cd.active) {
            logger.info(`Inactivity auto-reply suppressed by ${cd.type} cooldown (${Math.round(cd.remainingMs / 1000)}s remaining)`);
            return false;
        }

        // 4. Generate natural response
        const replyText = this.generateAvailabilityResponse(stateInfo.state);
        if (!replyText) {
            return false;
        }

        try {
            await message.channel.sendTyping();
        } catch (e) {}

        try {
            await message.reply(replyText);

            // Update cooldowns
            const now = Date.now();
            this.lastGlobalReply = now;
            this.lastChannelReply.set(message.channel.id, now);
            this.lastUserReply.set(message.author.id, now);

            logger.success(`Sent owner inactivity auto-reply (${stateInfo.state}) to ${message.author.tag} in #${message.channel.name}`);

            // Dispatch private DM alert to Lance
            const callerName = message.member?.displayName || message.author.username;
            await this.sendOwnerDmAlert(message, callerName, stateInfo);

            return true;
        } catch (err) {
            logger.error(`Failed to send inactivity reply: ${err.message}`);
            return false;
        }
    }

    /**
     * Sets manual availability state with optional duration.
     * e.g. setManualState('INACTIVE', '2h')
     */
    setManualState(stateInput, durationStr = null) {
        const s = (stateInput || '').toLowerCase().trim();

        if (s === 'auto' || s === 'reset' || s === 'clear') {
            this.data.manual_state = null;
            this.data.manual_until = null;
            this.data.manual_reason = null;
            this.saveState();
            return { state: 'AUTO', message: 'Availability reset to automatic detection.' };
        }

        let targetState = null;
        if (s === 'on' || s === 'available' || s === 'online') {
            targetState = 'AVAILABLE';
        } else if (s === 'off' || s === 'away' || s === 'afk' || s === 'inactive') {
            targetState = 'INACTIVE';
        } else if (s === 'sleep' || s === 'asleep') {
            targetState = 'LIKELY_ASLEEP';
        } else {
            return { error: `Invalid state "${stateInput}". Supported: on, off, away, sleep, auto.` };
        }

        let until = null;
        let durationDesc = '';
        if (durationStr) {
            const match = durationStr.match(/^(\d+)\s*(m|min|h|hr|d|day)?s?$/i);
            if (match) {
                const amount = parseInt(match[1], 10);
                const unit = (match[2] || 'h').toLowerCase();
                let multiplier = 60 * 60 * 1000; // default hours
                if (unit.startsWith('m')) multiplier = 60 * 1000;
                else if (unit.startsWith('d')) multiplier = 24 * 60 * 60 * 1000;

                const durationMs = amount * multiplier;
                until = Date.now() + durationMs;
                durationDesc = ` for ${amount} ${unit.startsWith('m') ? 'minutes' : (unit.startsWith('d') ? 'days' : 'hours')}`;
            }
        }

        this.data.manual_state = targetState;
        this.data.manual_until = until;
        this.data.manual_reason = durationDesc ? `Manual override${durationDesc}` : 'Manual override';
        this.data.manual_set_at = Date.now();
        this.saveState();

        return {
            state: targetState,
            until,
            message: `Availability set to **${targetState}**${durationDesc}.`
        };
    }

    /**
     * Builds a Discord Embed displaying owner availability state and stats.
     */
    getStatusEmbed() {
        const stateInfo = this.getAvailabilityState();
        const now = Date.now();
        const lastActivity = Math.max(
            this.data.last_seen_timestamp || 0,
            this.data.last_message_timestamp || 0,
            this.data.last_bot_interaction || 0,
            this.data.last_reaction_timestamp || 0,
            this.voiceState?.lastVoiceTimestamp || 0
        );

        let manilaTime = 'Unknown';
        try {
            manilaTime = new Intl.DateTimeFormat('en-US', {
                timeZone: this.timezone,
                timeStyle: 'medium',
                dateStyle: 'short'
            }).format(new Date());
        } catch (e) {}

        const stateColorMap = {
            'AVAILABLE': 0x4cc9f0,      // Cyan
            'LIKELY_AVAILABLE': 0x4895ef, // Blue
            'INACTIVE': 0xf72585,       // Pink/Magenta
            'LIKELY_ASLEEP': 0x7209b7,  // Purple
            'UNKNOWN': 0x6c757d        // Gray
        };

        const embed = new EmbedBuilder()
            .setTitle('Owner Availability Status (Lance)')
            .setColor(stateColorMap[stateInfo.state] || 0x3a0ca3)
            .addFields(
                {
                    name: 'Current Inferred State',
                    value: `**${stateInfo.state}** (${Math.round(stateInfo.confidence * 100)}% confidence)\n_${stateInfo.reason}_`,
                    inline: false
                },
                {
                    name: 'Last Activity Seen',
                    value: lastActivity > 0 ? `<t:${Math.floor(lastActivity / 1000)}:R> (<t:${Math.floor(lastActivity / 1000)}:f>)` : 'Never recorded',
                    inline: true
                },
                {
                    name: 'Voice Channel',
                    value: this.voiceState?.inVoice ? `Connected (${this.voiceState.streaming ? 'Streaming' : 'In Call'})` : 'Not in voice',
                    inline: true
                },
                {
                    name: 'Manual Override',
                    value: this.data.manual_state
                        ? `**${this.data.manual_state}**${this.data.manual_until ? ` (until <t:${Math.floor(this.data.manual_until / 1000)}:R>)` : ' (Indefinite)'}`
                        : 'None (Automatic Detection)',
                    inline: false
                },
                {
                    name: 'Local Time (Manila)',
                    value: `${manilaTime} (${this.timezone})`,
                    inline: true
                }
            )
            .setFooter({ text: 'Use !availability <on|off|away|sleep|auto> [duration] to override' })
            .setTimestamp();

        return embed;
    }
}

module.exports = OwnerAvailabilityService;
