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
        this.suppressedChannels = new Map();

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
     * Safeguards against overwriting newer timestamps with older backfilled history.
     */
    recordActivity({ type = 'message', channelId = null, guildId = null, timestamp = Date.now(), isCommand = false } = {}) {
        const ts = Number(timestamp) || Date.now();
        if (ts > (this.data.last_seen_timestamp || 0)) {
            this.data.last_seen_timestamp = ts;
        }

        if (type === 'message') {
            if (ts >= (this.data.last_message_timestamp || 0)) {
                this.data.last_message_timestamp = ts;
                if (channelId) this.data.last_message_channel_id = channelId;
                if (guildId) this.data.last_message_guild_id = guildId;
            }
        } else if (type === 'bot_interaction') {
            if (ts > (this.data.last_bot_interaction || 0)) {
                this.data.last_bot_interaction = ts;
            }
        } else if (type === 'reaction') {
            if (ts > (this.data.last_reaction_timestamp || 0)) {
                this.data.last_reaction_timestamp = ts;
            }
        } else if (type === 'voice') {
            if (ts > (this.voiceState.lastVoiceTimestamp || 0)) {
                this.voiceState.lastVoiceTimestamp = ts;
            }
        } else if (type === 'typing' || type === 'presence') {
            // Updates last_seen_timestamp above
        }

        // Auto-clear manual away/sleep if owner is actively chatting in a server channel
        // Never clear on bot commands (!), bot interactions, or private DMs
        if (this.data.manual_state && (this.data.manual_state === 'INACTIVE' || this.data.manual_state === 'LIKELY_ASLEEP') && type === 'message' && guildId && !isCommand) {
            const timeSinceManual = Date.now() - (this.data.manual_set_at || 0);
            if (timeSinceManual > 5 * 60 * 1000 && ts >= Date.now() - 60 * 1000) {
                logger.info(`Owner actively chatting in public channel; clearing manual state [${this.data.manual_state}]`);
                this.data.manual_state = null;
                this.data.manual_until = null;
                this.data.manual_reason = null;
            }
        }

        this.saveState();
    }

    /**
     * Suppresses unsolicited auto-replies in a specific channel (or 'global') for a duration.
     */
    suppressChannel(channelId = 'global', durationMs = 30 * 60 * 1000) {
        const until = Date.now() + durationMs;
        this.suppressedChannels.set(channelId, until);
        this.suppressedChannels.set('global', until);
        this.recordActivity({ type: 'message', channelId: channelId !== 'global' ? channelId : null, timestamp: Date.now() });
        logger.info(`Suppressed owner availability auto-replies for ${Math.round(durationMs / 60000)}m (channel=${channelId})`);
    }

    /**
     * Checks if auto-replies are currently suppressed by the owner.
     */
    isSuppressed(channelId) {
        const now = Date.now();
        const globalUntil = this.suppressedChannels.get('global') || 0;
        if (now < globalUntil) return true;
        if (channelId) {
            const chUntil = this.suppressedChannels.get(channelId) || 0;
            if (now < chUntil) return true;
        }
        return false;
    }

    /**
     * Inspects a single channel's recent messages to sync any recent owner activity
     * that occurred while the bot was restarting or offline.
     */
    async syncChannelActivity(channel) {
        if (!channel || !channel.messages) return;
        try {
            let messages = channel.messages.cache;
            if (!messages || messages.size < 5) {
                messages = await channel.messages.fetch({ limit: 15 }).catch(() => channel.messages.cache);
            }
            if (!messages) return;

            let newestOwnerMsg = null;
            for (const msg of messages.values()) {
                if (msg && msg.author && this.isOwner(msg.author.id)) {
                    if (!newestOwnerMsg || msg.createdTimestamp > newestOwnerMsg.createdTimestamp) {
                        newestOwnerMsg = msg;
                    }
                }
            }

            if (newestOwnerMsg && newestOwnerMsg.createdTimestamp > (this.data.last_message_timestamp || 0)) {
                this.recordActivity({
                    type: 'message',
                    channelId: channel.id,
                    guildId: channel.guild?.id || null,
                    timestamp: newestOwnerMsg.createdTimestamp,
                    isCommand: false
                });
                logger.info(`Synced recent owner activity from #${channel.name || channel.id} (${Math.round((Date.now() - newestOwnerMsg.createdTimestamp) / 60000)}m ago)`);
            }
        } catch (e) {}
    }

    /**
     * Scans connected guilds on startup for live voice states and recent owner messages
     * so the bot never wakes up with a stale multi-day timestamp when Lance was just chatting.
     */
    async syncRecentActivityFromGuilds(client = this.client) {
        if (!client || !client.guilds?.cache) return;
        try {
            for (const guild of client.guilds.cache.values()) {
                // 1. Check active voice states in this guild
                if (guild.voiceStates?.cache) {
                    for (const vs of guild.voiceStates.cache.values()) {
                        if (vs.channelId && this.isOwner(vs.id || vs.member?.id)) {
                            this.voiceState = {
                                inVoice: true,
                                channelId: vs.channelId,
                                guildId: guild.id,
                                streaming: !!vs.streaming,
                                lastVoiceTimestamp: Date.now()
                            };
                            this.recordActivity({ type: 'voice', channelId: vs.channelId, guildId: guild.id });
                        }
                    }
                }

                // 2. Scan primary text channels (up to 3 readable text channels per guild)
                if (guild.channels?.cache) {
                    const textChannels = Array.from(guild.channels.cache.values())
                        .filter(ch => ch && typeof ch.isTextBased === 'function' && ch.isTextBased() && !ch.isVoiceBased?.() && ch.viewable !== false)
                        .slice(0, 3);

                    for (const ch of textChannels) {
                        await this.syncChannelActivity(ch);
                    }
                }
            }
        } catch (err) {
            logger.warn(`Startup owner activity sync warning: ${err.message}`);
        }
    }

    /**
     * Checks live Discord presence across mutual guilds (if Presence Intent is available)
     * as well as active voice channels.
     */
    checkLiveDiscordPresence() {
        if (!this.client || !this.client.guilds?.cache) return { isOnline: false, status: null };
        for (const guild of this.client.guilds.cache.values()) {
            // Check voice state directly from guild cache
            if (guild.voiceStates?.cache) {
                for (const id of this.getOwnerIds()) {
                    const vs = guild.voiceStates.cache.get(id);
                    if (vs && vs.channelId) {
                        return { isOnline: true, status: 'in_voice', channelId: vs.channelId };
                    }
                }
            }

            // Check presence cache if available
            if (guild.presences?.cache) {
                for (const id of this.getOwnerIds()) {
                    const pres = guild.presences.cache.get(id);
                    if (pres && ['online', 'idle', 'dnd'].includes(pres.status)) {
                        return { isOnline: true, status: pres.status };
                    }
                }
            }
        }
        return { isOnline: false, status: null };
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

        // 2. Check voice channel state & live Discord presence
        if (this.voiceState.inVoice) {
            return {
                state: 'AVAILABLE',
                confidence: 0.95,
                reason: `Currently in voice channel (#${this.voiceState.channelId})${this.voiceState.streaming ? ' streaming' : ''}`
            };
        }

        const livePresence = this.checkLiveDiscordPresence();
        if (livePresence.isOnline) {
            return {
                state: 'AVAILABLE',
                confidence: 0.95,
                reason: livePresence.status === 'in_voice'
                    ? `Currently in voice channel (#${livePresence.channelId})`
                    : `Discord presence is ${livePresence.status.toUpperCase()}`
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

        const diffMinutes = Math.max(0, Math.floor((now - lastActivity) / (60 * 1000)));

        // Active within last 20 minutes -> definitely AVAILABLE
        if (diffMinutes < 20) {
            return {
                state: 'AVAILABLE',
                confidence: 0.95,
                reason: `Active ${diffMinutes}m ago`
            };
        }

        // Active within 20-60 minutes -> LIKELY_AVAILABLE
        if (diffMinutes < 60) {
            return {
                state: 'LIKELY_AVAILABLE',
                confidence: 0.85,
                reason: `Active ${diffMinutes}m ago`
            };
        }

        // Inactive for 60 min - 2 hours -> INACTIVE
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
        const content = (message.content || '').trim();
        const lower = content.toLowerCase();

        // 1. Direct mention of Lance (@schrazen)
        // Note: In Discord, replying to a message also adds the author to message.mentions.users
        // unless the user turns off @mention on reply. Distinguish between an explicit @tag in text
        // vs a reply reference!
        const hasExplicitTagInContent = ownerIds.some(id => content.includes(`<@${id}>`) || content.includes(`<@!${id}>`));
        if (hasExplicitTagInContent) {
            return {
                isContact: true,
                confidence: 1.0,
                reason: 'Direct @mention of owner in message text'
            };
        }

        // 2. Reply to a message previously sent by Lance
        if (message.reference && message.reference.messageId) {
            try {
                const refMsg = await message.channel.messages.fetch(message.reference.messageId);
                if (refMsg && this.isOwner(refMsg.author.id)) {
                    // CRITICAL: Immediately record the timestamp of Lance's referenced message!
                    // If the bot was offline when Lance sent refMsg, this ensures we never claim
                    // Lance has been inactive for 43 hours when his message was sent 3 minutes ago.
                    if (refMsg.createdTimestamp) {
                        this.recordActivity({
                            type: 'message',
                            channelId: message.channel.id,
                            guildId: message.guild.id,
                            timestamp: refMsg.createdTimestamp,
                            isCommand: false
                        });
                    }

                    const refAgeMinutes = (Date.now() - (refMsg.createdTimestamp || 0)) / (60 * 1000);
                    // If Lance sent that message within the last 60 minutes, he is part of the current conversation
                    if (refAgeMinutes < 60) {
                        return { isContact: false };
                    }

                    // Even on older messages, ignore passive reactions/laughter ("thats so crZy", "AHAHAHA", "lmao", "oo nga")
                    // Only treat a reply as contact intent if it asks a question or calls out to Lance
                    const isActiveInquiryOrCall = /[?]|\b(lance|schrazen|zen|asan|nasan|san|wer|where|tara|laro|valo|valorant|g\s*ba|online|tulog|gising|hoy|uy|pre|bro|tol|lods|bakit|ano|paano|kelan|kailan|wait|paki|check|tingnan)\b/i.test(lower);
                    if (!isActiveInquiryOrCall) {
                        return { isContact: false };
                    }

                    return {
                        isContact: true,
                        confidence: 0.9,
                        reason: 'Replied to owner message with inquiry'
                    };
                }
            } catch (e) {}
        }

        // 3. Name references with contact/inquiry intent
        const hasOwnerName = /\b(lance|schrazen|zen)\b/i.test(lower);
        if (!hasOwnerName) {
            return { isContact: false };
        }

        // Filter out purely casual / descriptive references (do NOT trigger)
        const isDescriptive = /\b(reminds me of|said earlier|was right|according to|kagaya ni|tulad ni|sabi ni|kwento ni|balita kay)\s+(lance|schrazen|zen)\b/i.test(lower);
        if (isDescriptive) {
            return { isContact: false };
        }

        // Check clear contact / where-is inquiry patterns (English & Tagalog/Filipino)
        const contactPatterns = [
            // Where is Lance / Asan / Nasan / San / Wer
            /\b(where('s| is|\s+is)|nasan|nasaan|asan|san|wer)(\s+na)?(\s+si)?\s+(he|lance|schrazen|zen)\b/i,
            // Has anyone seen Lance / Nakita niyo ba si Lance
            /\b(has anyone seen|nakita n(iy)?o ba|nakita nyo si|nasan na|asan na)\s+(lance|schrazen|zen|him)\b/i,
            // Tell / Call / Message / PM / DM Lance
            /\b(tell|paki\s*sabi\s*kay|pakisabi\s*kay|paki\s*tawag\s*si|pakitawag\s*si|sabihin\s*kay|sabihan\s*si|tawagin\s*(mo)?\s*si|chat\s*(mo)?\s*si|pm\s*(mo)?\s*si|dm\s*(mo)?\s*si)\s+(lance|schrazen|zen|him)\b/i,
            // Is Lance asleep / awake / online / buhay / afk / wala
            /\b(is|are|tulog\s*(na)?\s*(ba|ata|yata)?\s*si|gising\s*(na|pa)?\s*(ba|ata|yata)?\s*si|buhay\s*(pa)?\s*(ba|kaya)?\s*si|online\s*(pa|ba)?\s*si|nandito\s*ba\s*si|nandyan\s*ba\s*si|nanjan\s*ba\s*si|naka\s*afk\s*ba\s*si|afk\s*ba\s*si|wala\s*(ba|ata|yata)?\s*si)\s+(lance|schrazen|zen)(\s+(awake|online|asleep|here|afk|active|around|tulog|gising))?\b/i,
            // Tulog na ata si lance
            /\b(tulog\s*(na)?\s*(ata|yata|ba)?\s*si)\s+(lance|schrazen|zen)\b/i,
            // Greetings / Pings: hoy, uy, psst, yo
            /\b(yo|hey|hi|hello|hoi|hoy|psst|uy|oi)\s+(lance|schrazen|zen)\b/i,
            // Calling / looking for / hinahanap
            /\b(calling|calling\s*for|looking\s*for|hanap\s*si|hinahanap\s*(ko|namin)?\s*si)\s+(lance|schrazen|zen)\b/i,
            // Direct address with question or location: "lance?", "lance asan ka", "lance gising ka pa"
            /\b(lance|schrazen|zen)\s*(\?|\b(asan ka|san ka|wer u|where are you|gising ka|online ka|buhay ka|nandyan ka|nanjan ka)\b)/i
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
     * Checks if a message is written in Tagalog/Taglish, or if it's a general/ambiguous ping.
     * Defaults to true since Lance's server friends predominantly speak Filipino.
     */
    isTagalogMessage(text) {
        if (!text) return true;
        const lower = text.toLowerCase();

        // Strong Filipino words and slang particles
        const tagalogWords = /\b(ba|na|mo|ka|ko|ni|ng|mga|saan|nasaan|asan|san|wer|tulog|gising|buhay|wala|meron|paki|pakisabi|pakitawag|tara|oy|uy|hoy|ata|yata|daw|raw|dito|dyan|diyan|dun|doon|kanina|mamaya|babalik|kasi|kase|bakit|ano|paano|sino|natin|namin|nila|kayo|tayo|sila|si|ikaw|ako|siya|nya|niya|nito|niyan|nandito|nandyan|nanjan|kelan|kailan|talaga|kamusta|musta|geh|sige|eto|heto|kuya|pre|bro|tol|lods|lodz|paps|idol|idolo|haha|hahaha|heh|eh)\b/i;
        if (tagalogWords.test(lower)) return true;

        // Pure English detection: if the query uses explicit English markers without any Tagalog
        const englishMarkers = /\b(where|what|when|why|who|how|is|are|does|did|has|have|can|could|will|would|anyone|someone|anybody|somebody|asleep|awake|online|busy|message|tell|call|check|please|thanks)\b/i;
        if (englishMarkers.test(lower)) {
            return false;
        }

        // Default to Tagalog/Taglish for short pings or casual tags like "@Lance" or "Lance?"
        return true;
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
     * Automatically adapts between Filipino/Taglish and English based on the caller's message.
     */
    generateAvailabilityResponse(state, callerMessage = '', customReason = null) {
        const isTagalog = this.isTagalogMessage(callerMessage);
        const hasReason = customReason && customReason !== 'Manual override' && !customReason.startsWith('Manual override');

        if (state === 'LIKELY_ASLEEP') {
            if (isTagalog) {
                if (hasReason) {
                    const tagalogWithReason = [
                        `Tulog na ata si Lance ngayon (${customReason}). Iwan ka na lang muna ng message rito, makikita naman niya paggising.`,
                        `Parang bagsak / tulog na si Lance rn (${customReason}). Iwan mo na lang message mo rito, babasahin niya 'yan pag gising.`,
                        `Nakatulog na ata siya (${customReason}). Drop mo na lang sasabihin mo rito, pina-alert ko na rin sa kanya.`
                    ];
                    return tagalogWithReason[Math.floor(Math.random() * tagalogWithReason.length)];
                }
                const tagalogAsleep = [
                    "Parang tulog na ata si Lance ngayon. Iwan ka na lang muna ng message rito, makikita naman niya paggising.",
                    "Baka bagsak / tulog na si Lance rn. Iwan mo na lang dito sasabihin mo, babasahin niya 'yan pag gising.",
                    "Tulog na ata 'yun haha. Drop mo na lang message mo rito, pina-alert ko na rin sa kanya sa DM.",
                    "Mukhang tulog na si Lance ngayon. Iwan ka na lang ng chat dito para mabalikan ka niya later.",
                    "Parang natutulog na siya rn. Iwanan mo na lang dito sasabihin mo, makikita naman niya pag check niya ng phone."
                ];
                return tagalogAsleep[Math.floor(Math.random() * tagalogAsleep.length)];
            } else {
                if (hasReason) {
                    return `Looks like Lance is asleep right now (${customReason}). Feel free to leave a message and he'll see it when he wakes up.`;
                }
                const englishAsleep = [
                    "Looks like Lance is probably asleep right now. Feel free to leave a message, he'll see it when he wakes up.",
                    "Pretty sure he's asleep right now. Drop whatever you need here and he'll check it later.",
                    "He's likely asleep right now. Leave it here, I already sent an alert to his DM."
                ];
                return englishAsleep[Math.floor(Math.random() * englishAsleep.length)];
            }
        }

        if (state === 'INACTIVE') {
            if (isTagalog) {
                if (hasReason) {
                    const tagalogWithReason = [
                        `Naka-away si Lance ngayon: "${customReason}". Iwan ka na lang muna ng message dito, makikita niya 'yan pagbalik.`,
                        `Wala muna si Lance sa paligid rn (${customReason}). Drop mo na lang dito sasabihin mo, babalikan ka nun later.`,
                        `Parang busy o away si Lance ngayon (${customReason}). Iwanan mo na lang ng chat rito para mabasa niya.`
                    ];
                    return tagalogWithReason[Math.floor(Math.random() * tagalogWithReason.length)];
                }
                const tagalogInactive = [
                    "Parang AFK / wala pa si Lance ngayon. Iwan ka na lang muna ng message, babalikan ka nun pagbalik.",
                    "Wala ata si Lance sa PC/phone rn. Drop mo na lang dito sasabihin mo, makikita naman niya 'yan.",
                    "Parang di pa active si Lance ngayon. Iwan mo na lang message mo rito para mabasa niya later.",
                    "Naka-away ata si Lance ngayon. Iwan ka na lang ng message dito, nag-ping na rin ako sa DM niya.",
                    "Wala pa ata si Lance sa paligid. Iwanan mo na lang ng chat dito, sasagutin ka rin nun maya-maya."
                ];
                return tagalogInactive[Math.floor(Math.random() * tagalogInactive.length)];
            } else {
                if (hasReason) {
                    return `Lance is currently away (${customReason}). Feel free to leave a message and he'll get back to you.`;
                }
                const englishInactive = [
                    "Looks like Lance is away / AFK right now. Feel free to leave a message and he'll get back to you.",
                    "He's probably away from his desk at the moment. Leave your message here, he'll check it later.",
                    "I don't think Lance is around right now. Leave your message here, he'll check it later."
                ];
                return englishInactive[Math.floor(Math.random() * englishInactive.length)];
            }
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

        // Rate limit DM alerts to 1 alert per channel every 5 minutes
        if (now - lastAlert < this.cooldowns.dmAlert) {
            return;
        }

        this.lastDmAlert.set(channelId, now);

        const ownerIds = this.getOwnerIds();
        if (!ownerIds || ownerIds.length === 0) return;

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

        // Try each configured owner ID until one succeeds (e.g. primary active account 871274613227798589)
        const orderedIds = [...ownerIds].sort((a, b) => (a === '871274613227798589' ? -1 : b === '871274613227798589' ? 1 : 0));
        let lastErr = null;
        for (const ownerId of orderedIds) {
            try {
                const ownerUser = await this.client.users.fetch(ownerId);
                if (!ownerUser) continue;
                await ownerUser.send({ embeds: [embed] });
                logger.info(`Dispatched DM alert to owner (${ownerId}) for ping from ${callerName} in #${channelName}`);
                return;
            } catch (err) {
                lastErr = err;
            }
        }
        if (lastErr) {
            logger.warn(`Could not send DM alert to owner: ${lastErr.message}`);
        }
    }

    /**
     * Generates an honest response when someone asks where Lance is while he is AVAILABLE.
     */
    generateOnlineResponse(diffMinutes = 0, callerMessage = '') {
        const isTagalog = this.isTagalogMessage(callerMessage);
        const timeDesc = diffMinutes <= 1 ? 'kanina lang' : `${diffMinutes}m ago`;

        if (isTagalog) {
            const replies = [
                `Online naman si Lance ${timeDesc}. Nandyan lang 'yun sa Discord, baka may ginagawa lang saglit. Pwede mo siyang i-ping!`,
                `Nandito lang si Lance sa Discord kanina (${timeDesc}). Active 'yun sa paligid, i-chat mo na lang directly.`,
                `Active si Lance sa Discord ${timeDesc}. Baka nagbabasa o may tinatapos lang saglit, replyan ka rin nun.`
            ];
            return replies[Math.floor(Math.random() * replies.length)];
        } else {
            return `Lance was active just ${timeDesc} on Discord. He's around, feel free to ping him directly!`;
        }
    }

    /**
     * Core scanner method: inspects incoming message, evaluates availability,
     * and responds if Lance is away/asleep.
     * Returns: { isContact: boolean, responded: boolean, state: string, diffMinutes: number }
     */
    async checkAndRespond(message) {
        // 0. If owner explicitly suppressed auto-replies recently, stay silent
        if (this.isSuppressed(message.channel?.id)) {
            return { isContact: false, responded: false, suppressedByOwner: true };
        }

        // 1. Detect contact intent
        const intent = await this.detectContactIntent(message);
        if (!intent.isContact) {
            return { isContact: false, responded: false };
        }

        // 1b. Sync recent channel messages before claiming owner is inactive!
        // Ensures we never miss messages Lance sent while the bot was restarting.
        await this.syncChannelActivity(message.channel);

        // 2. Evaluate owner availability state
        const stateInfo = this.getAvailabilityState();
        logger.info(`Owner contact detected from ${message.author.tag}. Inferred state: ${stateInfo.state} (${stateInfo.reason})`);

        const lastActivity = Math.max(
            this.data.last_seen_timestamp || 0,
            this.data.last_message_timestamp || 0,
            this.data.last_bot_interaction || 0,
            this.data.last_reaction_timestamp || 0,
            this.voiceState?.lastVoiceTimestamp || 0
        );
        const diffMinutes = Math.max(0, Math.floor((Date.now() - lastActivity) / (60 * 1000)));

        // If owner is AVAILABLE or LIKELY_AVAILABLE or UNKNOWN -> stay completely silent
        if (stateInfo.state === 'AVAILABLE' || stateInfo.state === 'LIKELY_AVAILABLE' || stateInfo.state === 'UNKNOWN') {
            return { isContact: true, responded: false, state: stateInfo.state, diffMinutes };
        }

        // 3. Check cooldowns
        const cd = this.isCooldownActive(message.channel.id, message.author.id);
        if (cd.active) {
            logger.info(`Inactivity auto-reply suppressed by ${cd.type} cooldown (${Math.round(cd.remainingMs / 1000)}s remaining)`);
            return { isContact: true, responded: false, suppressedByCooldown: true, state: stateInfo.state, diffMinutes };
        }

        // 4. Generate natural response (Tagalog/Taglish & reason aware)
        const customReason = this.data.manual_state ? this.data.manual_reason : null;
        const replyText = this.generateAvailabilityResponse(stateInfo.state, message.content, customReason);
        if (!replyText) {
            return { isContact: true, responded: false, state: stateInfo.state, diffMinutes };
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

            return { isContact: true, responded: true, replyText, state: stateInfo.state, diffMinutes };
        } catch (err) {
            logger.error(`Failed to send inactivity reply: ${err.message}`);
            return { isContact: true, responded: false, error: err.message, state: stateInfo.state, diffMinutes };
        }
    }

    /**
     * Sets manual availability state with optional reason or duration.
     * e.g. setManualState('away', 'kumakain')
     * e.g. setManualState('away', 'in class for 2h')
     * e.g. setManualState('sleep')
     * e.g. setManualState('auto')
     */
    setManualState(stateInput, reasonOrDuration = null) {
        const s = (stateInput || '').toLowerCase().trim();

        if (s === 'auto' || s === 'reset' || s === 'clear' || s === 'back') {
            this.data.manual_state = null;
            this.data.manual_until = null;
            this.data.manual_reason = null;
            this.saveState();
            return { state: 'AUTO', message: 'Availability reset to automatic detection (Auto-Away & Sleep Scanner active).' };
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
        let cleanReason = '';

        if (reasonOrDuration) {
            const rawText = String(reasonOrDuration).trim();
            const durationMatch = rawText.match(/\b(\d+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)\b/i);
            if (durationMatch) {
                const amount = parseInt(durationMatch[1], 10);
                const unit = durationMatch[2].toLowerCase();
                let multiplier = 60 * 60 * 1000; // default hours
                if (unit.startsWith('m')) multiplier = 60 * 1000;
                else if (unit.startsWith('d')) multiplier = 24 * 60 * 60 * 1000;

                const durationMs = amount * multiplier;
                until = Date.now() + durationMs;
                durationDesc = ` for ${amount} ${unit.startsWith('m') ? 'minutes' : (unit.startsWith('d') ? 'days' : 'hours')}`;
            }

            cleanReason = rawText
                .replace(/\b(for\s+)?\d+\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)\b/gi, '')
                .replace(/^[-–—()\[\]\s]+|[-–—()\[\]\s]+$/g, '')
                .trim();
        }

        this.data.manual_state = targetState;
        this.data.manual_until = until;
        this.data.manual_reason = cleanReason || (durationDesc ? `Manual override${durationDesc}` : 'Manual override');
        this.data.manual_set_at = Date.now();
        this.saveState();

        const reasonText = cleanReason ? ` (${cleanReason})` : '';
        return {
            state: targetState,
            until,
            reason: cleanReason,
            message: `Availability set to **${targetState}**${reasonText}${durationDesc}.`
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
