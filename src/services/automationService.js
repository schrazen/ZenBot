const fs = require('fs');
const path = require('path');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const logger = require('../utils/logger');

class AutomationService {
    constructor({ config, llmManager, webSearchService, workspaceService, memoryManager, selfUpgradeService, channelHistory, reminderService, ownerAvailability, client, storagePath }) {
        this.config = config;
        this.llmManager = llmManager;
        this.webSearchService = webSearchService;
        this.workspaceService = workspaceService;
        this.memoryManager = memoryManager;
        this.selfUpgradeService = selfUpgradeService;
        this.channelHistory = channelHistory;
        this.reminderService = reminderService;
        this.ownerAvailability = ownerAvailability;
        this.client = client;

        this.storagePath = storagePath || (config?.paths?.automations
            ? config.paths.automations
            : path.join(__dirname, '../../data/automations.json'));

        this.automations = [];
        this.ticker = null;
        this.isChecking = false;
        this.eventsHooked = false;
        this.lastChannelEventAt = new Map();

        this.load();
    }

    /**
     * Marks real-time Discord event buffering active and records non-owner guild messages.
     * Enables zero-token skip when watched channels had zero new messages since lastRun.
     */
    markEventsHooked() {
        this.eventsHooked = true;
    }

    recordWatchedGuildEvent(message) {
        this.eventsHooked = true;
        if (!message || message.author?.bot || !message.guild) return;
        if (this.ownerAvailability?.isOwner?.(message.author?.id)) return;
        if (message.channel?.id) {
            this.lastChannelEventAt.set(message.channel.id, Date.now());
        }
    }

    /**
     * Temporarily snoozes/mutes an automation by ID.
     */
    muteAutomation(id, durationMs = 60 * 60 * 1000) {
        const auto = this.automations.find(a => a.id.toLowerCase() === String(id).trim().toLowerCase());
        if (!auto) return { success: false, message: `No automation found matching "${id}".` };
        auto.mutedUntil = Date.now() + durationMs;
        this.save();
        logger.info(`Automation [${auto.id}] snoozed for ${Math.round(durationMs / 60000)}m.`);
        return { success: true, automation: auto };
    }

    /**
     * Builds interactive action buttons attached to autonomous watcher alerts.
     */
    buildAlertComponents(auto) {
        const row = new ActionRowBuilder();
        const cursorChannels = Object.keys(auto?.state?.channelCursors || {});
        if (cursorChannels.length > 0) {
            row.addComponents(
                new ButtonBuilder()
                    .setCustomId(`zen_reply_modal:${cursorChannels[0]}`)
                    .setLabel('💬 Quick Reply')
                    .setStyle(ButtonStyle.Primary)
            );
        }
        row.addComponents(
            new ButtonBuilder()
                .setCustomId(`zen_auto_mute:${auto.id}:3600000`)
                .setLabel('🔕 Snooze 1h')
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId(`zen_auto_del:${auto.id}`)
                .setLabel('🗑️ Disable')
                .setStyle(ButtonStyle.Danger)
        );
        return [row];
    }

    load() {
        try {
            if (fs.existsSync(this.storagePath)) {
                const data = JSON.parse(fs.readFileSync(this.storagePath, 'utf8'));
                this.automations = Array.isArray(data) ? data : [];
            } else {
                this.automations = [];
                this.save();
            }
        } catch (err) {
            logger.warn(`Failed to read automations file (${this.storagePath}): ${err.message}`);
            this.automations = [];
        }
    }

    save() {
        try {
            const dir = path.dirname(this.storagePath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(this.storagePath, JSON.stringify(this.automations, null, 2), 'utf8');
        } catch (err) {
            logger.error(`Failed to save automations: ${err.message}`);
        }
    }

    /**
     * Starts background evaluation loop (checks every 30 seconds).
     */
    start(client = null) {
        if (client) this.client = client;
        if (this.ticker) clearInterval(this.ticker);

        logger.info(`AutomationService: Background watcher ticker started (30s interval).`);
        this.ticker = setInterval(() => this.tick(), 30 * 1000);
        // Initial tick after 5 seconds
        setTimeout(() => this.tick(), 5000);
    }

    stop() {
        if (this.ticker) {
            clearInterval(this.ticker);
            this.ticker = null;
            logger.info('AutomationService: Stopped background ticker.');
        }
    }

    /**
     * Parses interval or recurring time string.
     * Examples:
     * - "every 30m", "every 2 hours", "every 6h", "every 1d"
     * - "daily at 8am", "daily at 8:30pm", "at 9:00 AM"
     */
    parseSchedule(scheduleStr) {
        if (!scheduleStr || typeof scheduleStr !== 'string') return null;
        const text = scheduleStr.trim().toLowerCase();
        const now = Date.now();

        // Pattern 1: "every X (m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)"
        const everyMatch = text.match(/^every\s+(\d+)\s*(s|sec|secs|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)$/i);
        if (everyMatch) {
            const num = parseInt(everyMatch[1], 10);
            const unit = everyMatch[2].toLowerCase();

            let ms = 0;
            if (unit.startsWith('s')) ms = num * 1000;
            else if (unit.startsWith('m')) ms = num * 60 * 1000;
            else if (unit.startsWith('h')) ms = num * 60 * 60 * 1000;
            else if (unit.startsWith('d')) ms = num * 24 * 60 * 60 * 1000;

            if (ms >= 60 * 1000) { // Minimum 1 minute interval to prevent spam
                return {
                    type: 'interval',
                    intervalMs: ms,
                    nextRun: now + ms,
                    formatted: `Every ${num} ${unit}`
                };
            }
        }

        // Pattern 2: "daily at HH[:MM] [am|pm]" or "every day at ..."
        const dailyMatch = text.match(/^(?:daily|every\s+day)?(?:\s*at)?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
        if (dailyMatch && (text.includes('daily') || text.includes('every day') || text.includes('at'))) {
            let hour = parseInt(dailyMatch[1], 10);
            const minute = dailyMatch[2] ? parseInt(dailyMatch[2], 10) : 0;
            const meridian = dailyMatch[3]?.toLowerCase();

            if (meridian === 'pm' && hour < 12) hour += 12;
            if (meridian === 'am' && hour === 12) hour = 0;

            const target = new Date();
            target.setHours(hour, minute, 0, 0);

            // If time already passed today, schedule for tomorrow
            if (target.getTime() <= now) {
                target.setDate(target.getDate() + 1);
            }

            const timeStr = `${hour % 12 || 12}:${minute.toString().padStart(2, '0')} ${hour >= 12 ? 'PM' : 'AM'}`;
            return {
                type: 'daily',
                hour,
                minute,
                nextRun: target.getTime(),
                formatted: `Daily at ${timeStr}`
            };
        }

        return null;
    }

    /**
     * Creates and registers a new autonomous automation.
     */
    addAutomation({ name, scheduleStr, actionType = 'agent_task', prompt, url, userId, channelId, isDM = true }) {
        const parsed = this.parseSchedule(scheduleStr);
        if (!parsed) {
            throw new Error(`Could not parse schedule: "${scheduleStr}". Try "every 1 hour", "every 30m", or "daily at 8am".`);
        }

        const cleanName = name ? name.trim() : (prompt ? prompt.slice(0, 40) : 'Automation');
        const cleanUrl = url?.trim() || null;
        const normName = cleanName.toLowerCase().replace(/[^a-z0-9]/g, '');
        const normUrl = cleanUrl ? cleanUrl.toLowerCase().replace(/\/+$/, '').split('?')[0] : null;

        const existing = this.automations.find(a => {
            if (!a.active) return false;
            if (userId && a.userId && a.userId !== userId) return false;
            const existingNormName = (a.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
            const existingNormUrl = a.url ? a.url.toLowerCase().replace(/\/+$/, '').split('?')[0] : null;
            if (normName && existingNormName && normName === existingNormName) return true;
            if (normUrl && existingNormUrl && normUrl === existingNormUrl && a.actionType === actionType) return true;
            return false;
        });

        if (existing) {
            existing.name = cleanName;
            existing.scheduleStr = parsed.formatted;
            existing.scheduleMeta = parsed;
            existing.actionType = actionType;
            existing.prompt = prompt?.trim() || existing.prompt;
            if (cleanUrl) existing.url = cleanUrl;
            this.save();
            logger.info(`Automation [${existing.id}] updated in place: "${existing.name}" (${existing.scheduleStr})`);
            return existing;
        }

        const autoId = `auto_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
        const item = {
            id: autoId,
            name: cleanName,
            scheduleStr: parsed.formatted,
            scheduleMeta: parsed,
            actionType, // 'web_watch' | 'standup' | 'agent_task' | 'command'
            prompt: prompt?.trim() || '',
            url: cleanUrl,
            userId,
            channelId,
            isDM,
            active: true,
            createdAt: Date.now(),
            lastRun: null,
            lastStatus: 'pending',
            lastResult: null,
            runCount: 0,
            state: {
                channelCursors: {},
                lastAlertValue: null,
                lastAlertAt: null
            }
        };

        this.automations.push(item);
        this.save();
        logger.info(`Automation [${autoId}] created: "${item.name}" (${item.scheduleStr})`);
        return item;
    }

    listAutomations(userId = null) {
        if (!userId) return [...this.automations];
        return this.automations.filter(a => a.userId === userId || !a.userId);
    }

    deleteAutomation(idOrIndex, userId = null) {
        const query = String(idOrIndex).trim().toLowerCase();
        let idx = this.automations.findIndex(a => a.id.toLowerCase() === query);

        if (idx === -1 && /^\d+$/.test(query)) {
            const num = parseInt(query, 10) - 1;
            if (num >= 0 && num < this.automations.length) {
                idx = num;
            }
        }

        if (idx !== -1) {
            const auto = this.automations[idx];
            if (userId && auto.userId && auto.userId !== userId) {
                return { success: false, message: 'You do not have permission to delete this automation.' };
            }
            const removed = this.automations.splice(idx, 1)[0];
            this.save();
            logger.info(`Deleted automation [${removed.id}]: "${removed.name}"`);
            return { success: true, removed };
        }

        return { success: false, message: `No automation found matching "${idOrIndex}".` };
    }

    /**
     * Main background tick evaluating due automations.
     */
    async tick() {
        if (this.isChecking) return;
        this.isChecking = true;

        const now = Date.now();
        const dueList = this.automations.filter(a =>
            a.active &&
            (!a.mutedUntil || now >= a.mutedUntil) &&
            a.scheduleMeta?.nextRun &&
            now >= a.scheduleMeta.nextRun
        );

        for (const auto of dueList) {
            try {
                logger.info(`Running scheduled automation [${auto.id}]: "${auto.name}"`);
                await this.executeAutomation(auto);
            } catch (err) {
                logger.error(`Error running automation [${auto.id}]: ${err.message}`);
                auto.lastStatus = 'failed';
                auto.lastResult = `Error: ${err.message}`;
            } finally {
                auto.lastRun = Date.now();
                auto.runCount = (auto.runCount || 0) + 1;

                // Compute next run timestamp
                if (auto.scheduleMeta.type === 'interval') {
                    auto.scheduleMeta.nextRun = Date.now() + auto.scheduleMeta.intervalMs;
                } else if (auto.scheduleMeta.type === 'daily') {
                    const next = new Date();
                    next.setDate(next.getDate() + 1);
                    next.setHours(auto.scheduleMeta.hour, auto.scheduleMeta.minute, 0, 0);
                    auto.scheduleMeta.nextRun = next.getTime();
                }

                this.save();
            }
        }

        this.isChecking = false;
    }

    /**
     * Executes a single automation based on its actionType.
     */
    async executeAutomation(auto) {
        // 1. Proactive Morning Standup / Daily Briefing
        if (auto.actionType === 'standup' || auto.prompt.toLowerCase().includes('standup') || auto.prompt.toLowerCase().includes('briefing')) {
            await this._runStandup(auto);
            return;
        }

        // 2. Web Watcher (Check a URL for weather, price drops, keywords, updates)
        // Note: discord.com/channels/... URLs require the bot's native read_discord_channel tool via _runAgentTask
        const targetUrlCandidate = auto.url || (auto.prompt?.match(/https?:\/\/[^\s]+/i)?.[0] || '');
        const isDiscordChannelUrl = /discord\.com\/channels\//i.test(targetUrlCandidate);
        if (!isDiscordChannelUrl && (auto.actionType === 'web_watch' || targetUrlCandidate)) {
            await this._runWebWatcher(auto);
            return;
        }

        // 3. Autonomous Task / Periodic Monitor (with full Agent Tools)
        await this._runAgentTask(auto);
    }

    async _runStandup(auto) {
        const profile = this.memoryManager?.profile?.getProfile() || {};
        const projects = this.memoryManager?.projects?.list() || [];
        const activeProjects = projects.filter(p => p.status === 'Active');
        const tasksSummary = activeProjects
            .filter(p => p.tasks?.length)
            .map(p => `• **${p.name}**:\n${p.tasks.slice(0, 2).map(t => `  - ${t}`).join('\n')}`)
            .join('\n');

        const goals = profile.goals?.slice(0, 3).map(g => `• ${g}`).join('\n') || 'None recorded yet';
        const pendingReminders = this.reminderService?.listReminders?.(auto.userId)?.slice(0, 3) || [];

        const embed = new EmbedBuilder()
            .setTitle(`🌅 Good Morning, Lance! Daily Standup & Focus Plan`)
            .setColor(0x00b4d8)
            .setDescription(`Here is your scheduled autonomous briefing to keep your momentum going today:`)
            .addFields(
                { name: '🎯 Core Roadmap Goals', value: goals, inline: false },
                { name: '⚡ Active Projects & Next Tasks', value: tasksSummary || 'All caught up on open tasks!', inline: false }
            );

        if (pendingReminders.length > 0) {
            embed.addFields({
                name: '⏰ Upcoming Reminders',
                value: pendingReminders.map(r => `• **[${r.dueTimeStr}]** ${r.task}`).join('\n'),
                inline: false
            });
        }

        embed.setFooter({ text: `Automated Hermes Agent Briefing • ${auto.scheduleStr}` })
            .setTimestamp();

        await this._sendAlert(auto, { embeds: [embed] });
        auto.lastStatus = 'success';
        auto.lastResult = 'Sent daily standup briefing.';
    }

    async _runWebWatcher(auto) {
        if (!this.webSearchService) throw new Error('WebSearchService not available.');
        
        let targetUrl = auto.url;
        if (!targetUrl) {
            const urlMatch = auto.prompt.match(/https?:\/\/[^\s]+/i);
            if (urlMatch) {
                targetUrl = urlMatch[0].replace(/[.,;)'"]+$/, '');
            }
        }

        if (!targetUrl) throw new Error('No URL specified for web watcher.');

        const pageRes = await this.webSearchService.fetchPage(targetUrl, 4000);
        const pageText = typeof pageRes === 'string'
            ? pageRes
            : (pageRes.content || pageRes.error || JSON.stringify(pageRes));

        auto.state = auto.state || { channelCursors: {}, lastAlertValue: null, lastAlertAt: null };
        
        // Use fast specialist model (gpt-oss-20b or gemini) to evaluate watcher condition
        const specialist = this.llmManager.getSpecialist('subtask');
        const evalPrompt = [
            {
                role: 'system',
                content: (
                    'You are an autonomous Hermes background watcher agent. Your job is to analyze live fetched webpage/API content against a user surveillance condition.\n' +
                    'Determine if the condition is met right now, and whether an alert should be dispatched to Lance.\n' +
                    'IMPORTANT: If the user only wants to be notified WHEN a specific condition happens (e.g. if rain is forecasted, if price drops), set "shouldAlert": false when the condition is NOT met so you do not spam him.\n' +
                    'Return valid JSON only in this schema:\n' +
                    '{\n  "shouldAlert": boolean,\n  "summary": string (concise explanation of what was found)\n}'
                )
            },
            {
                role: 'user',
                content: (
                    `Target URL: ${targetUrl}\n` +
                    `Watcher Goal: ${auto.prompt}\n` +
                    `Previous Check Status: ${auto.lastStatus || 'none'} | Previous Summary: ${auto.lastResult || 'none'}\n\n` +
                    `Fetched Live Content:\n"""\n${pageText.slice(0, 3000)}\n"""`
                )
            }
        ];

        const res = await this.llmManager.chat(evalPrompt, { model: specialist.model, temperature: 0.2 });
        let decision = { shouldAlert: false, summary: 'Watcher executed.' };
        try {
            const clean = res.content.replace(/```json/gi, '').replace(/```/g, '').trim();
            decision = JSON.parse(clean);
        } catch (e) {
            decision = { shouldAlert: false, summary: res.content.slice(0, 300) };
        }

        // Deduplicate unchanged web alerts within a 3-hour cooldown window
        const normalizedValue = pageText.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 500);
        const cooldownMs = 3 * 60 * 60 * 1000;
        if (decision.shouldAlert && auto.state.lastAlertValue === normalizedValue && auto.state.lastAlertAt && (Date.now() - auto.state.lastAlertAt) < cooldownMs) {
            logger.info(`Automation [${auto.id}] WebWatcher suppressed duplicate unchanged alert within 3h cooldown.`);
            auto.lastStatus = 'checked_no_alert';
            auto.lastResult = `${decision.summary} (unchanged since last alert)`;
            return;
        }

        auto.lastStatus = decision.shouldAlert ? 'alerted' : 'checked_no_alert';
        auto.lastResult = decision.summary;
        logger.info(`Automation [${auto.id}] WebWatcher result: shouldAlert=${decision.shouldAlert} | ${decision.summary}`);

        if (decision.shouldAlert) {
            auto.state.lastAlertValue = normalizedValue;
            auto.state.lastAlertAt = Date.now();
            const embed = new EmbedBuilder()
                .setTitle(`🔔 Autonomous Watcher Alert: ${auto.name}`)
                .setColor(0xff9f1c)
                .setDescription(decision.summary)
                .addFields(
                    { name: 'Target URL', value: `[Open Monitored Page](${targetUrl})`, inline: true },
                    { name: 'Schedule', value: auto.scheduleStr, inline: true }
                )
                .setFooter({ text: 'Hermes Agent Autonomous Surveillance' })
                .setTimestamp();

            await this._sendAlert(auto, { embeds: [embed], components: this.buildAlertComponents(auto) });
        }
    }

    async _runAgentTask(auto) {
        const { getToolsForQuery, executeTool } = require('./llm/toolDefinitions');
        auto.state = auto.state || { channelCursors: {}, lastAlertValue: null, lastAlertAt: null };
        if (!auto.state.channelCursors) auto.state.channelCursors = {};
        const channelCheckStats = { checkedChannels: 0, totalNewMessages: 0, hadBaselineCursor: false };

        const avail = this.ownerAvailability ? this.ownerAvailability.getAvailabilityState() : { state: 'UNKNOWN', reason: '' };
        const prefContext = this.memoryManager?.preferences?.toPromptContext() || '';
        const isDiscordWatcher = /discord\.com\/channels\//i.test(auto.url || '') || /\b(?:banorant|discord|server|channel|messages)\b/i.test(auto.prompt || '');

        // Zero-token pre-gate for Discord watchers:
        // 1. If Lance is currently AVAILABLE, sync channel cursors silently (0 LLM calls).
        if (isDiscordWatcher && avail.state === 'AVAILABLE') {
            if (this.channelHistory) {
                for (const chId of Object.keys(auto.state.channelCursors)) {
                    const ch = this.channelHistory.resolveTargetChannel(chId);
                    if (ch) {
                        const data = await this.channelHistory.fetchRecentTranscript(ch, 5, auto.state.channelCursors[chId]).catch(() => null);
                        if (data?.latestMessageId) auto.state.channelCursors[chId] = data.latestMessageId;
                    }
                }
            }
            auto.lastStatus = 'checked_no_alert';
            auto.lastResult = 'Skipped LLM check: Owner is currently AVAILABLE.';
            logger.info(`Automation [${auto.id}] AgentTask pre-gated (0 LLM tokens): ${auto.lastResult}`);
            return;
        }

        // 2. If real-time event buffering is active and watched cursor channels had zero non-owner messages since lastRun, skip LLM call.
        const cursorIds = Object.keys(auto.state.channelCursors);
        if (isDiscordWatcher && this.eventsHooked && cursorIds.length > 0 && auto.lastRun) {
            const hasRecentEvent = cursorIds.some(chId => (this.lastChannelEventAt.get(chId) || 0) > auto.lastRun);
            if (!hasRecentEvent) {
                auto.lastStatus = 'checked_no_alert';
                auto.lastResult = 'Skipped LLM check: No new non-owner messages buffered since last run.';
                logger.info(`Automation [${auto.id}] AgentTask event-gated (0 LLM tokens): ${auto.lastResult}`);
                return;
            }
        }

        const { groqTools, geminiTools } = getToolsForQuery(auto.prompt, ['discord', 'web']);

        const res = await this.llmManager.chatWithAgent([
            {
                role: 'system',
                content: (
                    'You are ZenBot acting as Lance\'s autonomous background Hermes Agent.\n' +
                    'You HAVE live tools (`fetch_web_page`, `web_search`, `read_discord_channel`, `read_file`, `search_files`, `run_command`, `propose_self_upgrade`). Use them directly to perform the scheduled task.\n' +
                    `[OWNER LIVE AVAILABILITY]: ${avail.state} (${avail.reason || 'auto-detected'})\n` +
                    `[PREVIOUS RUN CONTEXT]: Last Run Status: ${auto.lastStatus || 'never'} | Last Result: "${auto.lastResult || 'none'}". Only alert if there is NEW activity or a NEW condition since the last run.\n` +
                    (prefContext ? `${prefContext}\n` : '') +
                    '- If this task is a conditional check (e.g. "notify me IF rain is forecasted" or "ping me IF someone messages in Banorant") and there are NO new messages from others, Lance is already AVAILABLE/active in the channel, or the condition is NOT met right now, start your final response with `[NO_ALERT]` so Lance is not spammed.\n' +
                    '- If you encounter a bug or missing capability in your own source code (`src/`) that prevents you from doing what Lance asked, inspect the relevant file with `read_file` and call `propose_self_upgrade` so Lance can approve the fix.'
                )
            },
            {
                role: 'user',
                content: auto.prompt
            }
        ], {
            tools: groqTools,
            geminiTools,
            executeTool: (name, args) => executeTool(name, args, {
                config: this.config,
                workspaceService: this.workspaceService,
                webSearchService: this.webSearchService,
                automationService: this,
                selfUpgradeService: this.selfUpgradeService,
                channelHistory: this.channelHistory,
                reminderService: this.reminderService,
                ownerAvailability: this.ownerAvailability,
                memoryManager: this.memoryManager,
                client: this.client,
                automationState: auto.state,
                channelCheckStats,
                userId: auto.userId,
                channelId: auto.channelId,
                isDM: true
            }),
            maxSteps: 4,
            temperature: 0.2
        });

        const content = (res.content || '').trim();
        let isSilent = content.includes('[NO_ALERT]');
        const cleanSummary = content.replace(/\[NO_ALERT\]/gi, '').trim();

        // Check if the background task staged any self-upgrade proposals
        const stagedUpgrades = (res.executedTools || [])
            .filter(t => t.result && t.result.status === 'pending_owner_approval')
            .map(t => t.result.proposalId);

        // Enforce deterministic silence when Discord channel watcher saw a prior cursor and 0 new messages arrived
        if (channelCheckStats.checkedChannels > 0 && channelCheckStats.hadBaselineCursor && channelCheckStats.totalNewMessages === 0 && stagedUpgrades.length === 0) {
            isSilent = true;
        }

        // Prevent duplicate unchanged alert loops on non-channel tasks (e.g. weather API polled via agent_task)
        if (!isSilent && stagedUpgrades.length === 0 && cleanSummary && auto.state.lastAlertValue === cleanSummary.toLowerCase().slice(0, 300) && auto.state.lastAlertAt && (Date.now() - auto.state.lastAlertAt) < 3 * 60 * 60 * 1000) {
            isSilent = true;
        }

        if (stagedUpgrades.length > 0 && this.selfUpgradeService) {
            const pendingList = this.selfUpgradeService.getPendingProposals().filter(p => stagedUpgrades.includes(p.id));
            if (pendingList.length > 0) {
                const upgEmbed = this.selfUpgradeService.buildProposalEmbed(pendingList);
                const upgComponents = this.selfUpgradeService.buildProposalComponents(pendingList);
                await this._sendAlert(auto, { embeds: [upgEmbed], components: upgComponents });
            }
        }

        if (isSilent && stagedUpgrades.length === 0) {
            auto.lastStatus = 'checked_no_alert';
            auto.lastResult = cleanSummary.slice(0, 200) || 'Checked; no new updates.';
            logger.info(`Automation [${auto.id}] AgentTask silent check: ${auto.lastResult}`);
            return;
        }

        auto.state.lastAlertValue = cleanSummary.toLowerCase().slice(0, 300);
        auto.state.lastAlertAt = Date.now();
        auto.lastStatus = 'success';
        auto.lastResult = cleanSummary.slice(0, 200);

        const embed = new EmbedBuilder()
            .setTitle(`🤖 Scheduled Task Update: ${auto.name}`)
            .setColor(0x2ec4b6)
            .setDescription(cleanSummary.slice(0, 1900) || 'Task completed.')
            .setFooter({ text: `Automated Task • ${auto.scheduleStr}` })
            .setTimestamp();

        await this._sendAlert(auto, { embeds: [embed], components: this.buildAlertComponents(auto) });
    }

    async _sendAlert(auto, payload) {
        if (!this.client) return;

        try {
            // Priority 1: DM the owner Lance directly
            if (auto.userId) {
                const user = await this.client.users.fetch(auto.userId);
                if (user) {
                    await user.send(payload);
                    return;
                }
            }

            // Priority 2: Channel where registered
            if (auto.channelId) {
                const channel = await this.client.channels.fetch(auto.channelId);
                if (channel && channel.isTextBased()) {
                    await channel.send(payload);
                }
            }
        } catch (err) {
            logger.error(`Failed to send automation alert: ${err.message}`);
        }
    }
}

module.exports = AutomationService;

