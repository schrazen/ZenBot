const fs = require('fs');
const path = require('path');
const { EmbedBuilder } = require('discord.js');
const logger = require('../utils/logger');

class AutomationService {
    constructor({ config, llmManager, webSearchService, workspaceService, memoryManager, client, storagePath }) {
        this.config = config;
        this.llmManager = llmManager;
        this.webSearchService = webSearchService;
        this.workspaceService = workspaceService;
        this.memoryManager = memoryManager;
        this.client = client;

        this.storagePath = storagePath || (config?.paths?.automations
            ? config.paths.automations
            : path.join(__dirname, '../../data/automations.json'));

        this.automations = [];
        this.ticker = null;
        this.isChecking = false;

        this.load();
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

        const autoId = `auto_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
        const item = {
            id: autoId,
            name: name ? name.trim() : (prompt ? prompt.slice(0, 40) : 'Automation'),
            scheduleStr: parsed.formatted,
            scheduleMeta: parsed,
            actionType, // 'web_watch' | 'standup' | 'agent_task' | 'command'
            prompt: prompt?.trim() || '',
            url: url?.trim() || null,
            userId,
            channelId,
            isDM,
            active: true,
            createdAt: Date.now(),
            lastRun: null,
            lastStatus: 'pending',
            lastResult: null,
            runCount: 0
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
        const dueList = this.automations.filter(a => a.active && a.scheduleMeta?.nextRun && now >= a.scheduleMeta.nextRun);

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

        // 2. Web Watcher (Check a URL for price drops, keywords, updates)
        if (auto.actionType === 'web_watch' || auto.url || auto.prompt.toLowerCase().includes('check http')) {
            await this._runWebWatcher(auto);
            return;
        }

        // 3. Autonomous Task / Periodic Monitor
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
        const pendingReminders = this.config?.reminderService?.listReminders?.(auto.userId)?.slice(0, 3) || [];

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
            if (urlMatch) targetUrl = urlMatch[0];
        }

        if (!targetUrl) throw new Error('No URL specified for web watcher.');

        const pageContent = await this.webSearchService.fetchPage(targetUrl, 4000);
        
        // Use fast specialist model (gpt-oss-20b or gemini) to evaluate watcher condition
        const specialist = this.llmManager.getSpecialist('subtask');
        const evalPrompt = [
            {
                role: 'system',
                content: (
                    'You are an autonomous Hermes background watcher agent. Your job is to analyze webpage content against a user surveillance condition.\n' +
                    'Determine if the condition is met, and whether an alert should be dispatched to Lance.\n' +
                    'Return valid JSON only in this schema:\n' +
                    '{\n  "shouldAlert": boolean,\n  "summary": string (concise explanation of what changed or what was found)\n}'
                )
            },
            {
                role: 'user',
                content: `Target URL: ${targetUrl}\nWatcher Goal: ${auto.prompt}\n\nWebpage Content Snippet:\n"""\n${pageContent.slice(0, 3000)}\n"""`
            }
        ];

        const res = await specialist.provider.chat(evalPrompt, { model: specialist.model, temperature: 0.2 });
        let decision = { shouldAlert: true, summary: 'Watcher executed.' };
        try {
            const clean = res.content.replace(/```json/gi, '').replace(/```/g, '').trim();
            decision = JSON.parse(clean);
        } catch (e) {
            decision = { shouldAlert: true, summary: res.content.slice(0, 300) };
        }

        auto.lastStatus = decision.shouldAlert ? 'alerted' : 'checked_no_alert';
        auto.lastResult = decision.summary;

        if (decision.shouldAlert) {
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

            await this._sendAlert(auto, { embeds: [embed] });
        }
    }

    async _runAgentTask(auto) {
        const specialist = this.llmManager.getSpecialist('planning');
        const res = await specialist.provider.chat([
            {
                role: 'system',
                content: 'You are ZenBot acting as Lance\'s autonomous background Hermes Agent. Perform this task concisely. If there are important findings or actions needed, report them clearly.'
            },
            {
                role: 'user',
                content: auto.prompt
            }
        ], { model: specialist.model, temperature: 0.3 });

        auto.lastStatus = 'success';
        auto.lastResult = res.content.slice(0, 200);

        const embed = new EmbedBuilder()
            .setTitle(`🤖 Scheduled Task Update: ${auto.name}`)
            .setColor(0x2ec4b6)
            .setDescription(res.content.slice(0, 1900))
            .setFooter({ text: `Automated Task • ${auto.scheduleStr}` })
            .setTimestamp();

        await this._sendAlert(auto, { embeds: [embed] });
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

