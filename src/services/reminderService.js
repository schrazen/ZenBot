const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

class ReminderService {
    constructor({ config, storagePath } = {}) {
        this.config = config;
        this.storagePath = storagePath || (config?.paths?.data
            ? path.join(config.paths.data, 'reminders.json')
            : path.join(__dirname, '../../data/reminders.json'));
        this.reminders = [];
        this.timer = null;
        this.client = null;

        this.load();
    }

    load() {
        try {
            if (fs.existsSync(this.storagePath)) {
                const data = JSON.parse(fs.readFileSync(this.storagePath, 'utf8'));
                this.reminders = Array.isArray(data) ? data : [];
            } else {
                this.reminders = [];
                this.save();
            }
        } catch (err) {
            logger.warn(`Failed to read reminders file (${this.storagePath}): ${err.message}`);
            this.reminders = [];
        }
    }

    save() {
        try {
            const dir = path.dirname(this.storagePath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            fs.writeFileSync(this.storagePath, JSON.stringify(this.reminders, null, 2), 'utf8');
        } catch (err) {
            logger.error(`Failed to save reminders: ${err.message}`);
        }
    }

    /**
     * Parses a natural language time expression into a target timestamp (in ms).
     * Supports:
     * - "in 10m", "in 10 mins", "in 2 hours", "in 45s", "30m", "2h", "1d"
     * - "at 8:30pm", "at 9am", "9:00 AM", "14:00"
     * - "tomorrow at 9am", "tonight at 8pm", "later at 5pm"
     */
    parseNaturalTime(timeStr) {
        if (!timeStr || typeof timeStr !== 'string') return null;
        const text = timeStr.trim().toLowerCase();
        const now = Date.now();

        // 1. Relative offset: in X (seconds|minutes|hours|days)
        const relMatch = text.match(/^(?:in\s+)?(\d+)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)$/i);
        if (relMatch) {
            const num = parseInt(relMatch[1], 10);
            const unit = relMatch[2].toLowerCase();

            let ms = 0;
            if (unit.startsWith('s')) ms = num * 1000;
            else if (unit.startsWith('m')) ms = num * 60 * 1000;
            else if (unit.startsWith('h')) ms = num * 60 * 60 * 1000;
            else if (unit.startsWith('d')) ms = num * 24 * 60 * 60 * 1000;

            if (ms > 0) {
                return {
                    timestamp: now + ms,
                    formatted: new Date(now + ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                };
            }
        }

        // 2. "tomorrow at HH[:MM] [am|pm]"
        const tomorrowMatch = text.match(/^tomorrow(?:\s+at)?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
        if (tomorrowMatch) {
            let hour = parseInt(tomorrowMatch[1], 10);
            const minute = tomorrowMatch[2] ? parseInt(tomorrowMatch[2], 10) : 0;
            const mer = tomorrowMatch[3]?.toLowerCase();

            if (mer === 'pm' && hour < 12) hour += 12;
            if (mer === 'am' && hour === 12) hour = 0;

            const targetDate = new Date();
            targetDate.setDate(targetDate.getDate() + 1);
            targetDate.setHours(hour, minute, 0, 0);

            return {
                timestamp: targetDate.getTime(),
                formatted: `Tomorrow at ${targetDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
            };
        }

        // 3. "tonight at HH[:MM] [am|pm]" or "tonight"
        const tonightMatch = text.match(/^tonight(?:\s+at)?(?:\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?$/i);
        if (tonightMatch) {
            let hour = tonightMatch[1] ? parseInt(tonightMatch[1], 10) : 20; // Default 8 PM
            const minute = tonightMatch[2] ? parseInt(tonightMatch[2], 10) : 0;
            const mer = tonightMatch[3]?.toLowerCase() || 'pm';

            if (mer === 'pm' && hour < 12) hour += 12;
            if (mer === 'am' && hour === 12) hour = 0;

            const targetDate = new Date();
            targetDate.setHours(hour, minute, 0, 0);

            if (targetDate.getTime() <= now) {
                targetDate.setDate(targetDate.getDate() + 1);
            }

            return {
                timestamp: targetDate.getTime(),
                formatted: `Tonight at ${targetDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
            };
        }

        // 4. "at HH[:MM] [am|pm]" or "HH[:MM] [am|pm]"
        const clockMatch = text.match(/^(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
        if (clockMatch) {
            let hour = parseInt(clockMatch[1], 10);
            const minute = clockMatch[2] ? parseInt(clockMatch[2], 10) : 0;
            const mer = clockMatch[3]?.toLowerCase();

            if (mer === 'pm' && hour < 12) hour += 12;
            if (mer === 'am' && hour === 12) hour = 0;

            const targetDate = new Date();
            targetDate.setHours(hour, minute, 0, 0);

            // If time already passed today, assume tomorrow
            if (targetDate.getTime() <= now) {
                targetDate.setDate(targetDate.getDate() + 1);
            }

            return {
                timestamp: targetDate.getTime(),
                formatted: targetDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            };
        }

        return null;
    }

    /**
     * Parses a full sentence command like:
     * "in 30 mins to take a break"
     * "tomorrow at 9am to submit clearance"
     * "study for exam in 2h"
     */
    parseNaturalInput(input) {
        if (!input || !input.trim()) return null;
        const text = input.trim();

        // Pattern A: "<time> to <task>" or "<time>: <task>"
        const matchA = text.match(/^(.+?)\s+(?:to|:|-)\s+(.+)$/i);
        if (matchA) {
            const parsedTime = this.parseNaturalTime(matchA[1]);
            if (parsedTime) {
                return {
                    task: matchA[2].trim(),
                    timestamp: parsedTime.timestamp,
                    dueStr: parsedTime.formatted
                };
            }
        }

        // Pattern B: "<task> in <time>"
        const matchB = text.match(/^(.+?)\s+(in\s+\d+\s*(?:s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days))$/i);
        if (matchB) {
            const parsedTime = this.parseNaturalTime(matchB[2]);
            if (parsedTime) {
                return {
                    task: matchB[1].trim(),
                    timestamp: parsedTime.timestamp,
                    dueStr: parsedTime.formatted
                };
            }
        }

        // Pattern C: "<time> <task>" where time is 2-3 words e.g. "in 30m stretch"
        const words = text.split(/\s+/);
        if (words.length >= 2) {
            const possibleTime1 = words.slice(0, 2).join(' ');
            const parsed1 = this.parseNaturalTime(possibleTime1);
            if (parsed1 && words.length > 2) {
                return {
                    task: words.slice(2).join(' '),
                    timestamp: parsed1.timestamp,
                    dueStr: parsed1.formatted
                };
            }

            const possibleTime2 = words[0];
            const parsed2 = this.parseNaturalTime(possibleTime2);
            if (parsed2 && words.length > 1) {
                return {
                    task: words.slice(1).join(' '),
                    timestamp: parsed2.timestamp,
                    dueStr: parsed2.formatted
                };
            }
        }

        return null;
    }

    /**
     * Schedules a new reminder.
     */
    addReminder({ userId, channelId, isDM = false, task, dueAt, dueTimeStr, repeat = null }) {
        if (!task || !task.trim()) {
            throw new Error('Reminder task description cannot be empty.');
        }

        if (!dueAt || dueAt <= Date.now()) {
            throw new Error('Reminder due time must be in the future.');
        }

        const id = `rem_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
        const formatted = dueTimeStr || new Date(dueAt).toLocaleString('en-US', {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        });

        const reminder = {
            id,
            userId,
            channelId,
            isDM,
            task: task.trim(),
            dueAt,
            dueTimeStr: formatted,
            createdAt: Date.now(),
            repeat,
            completed: false
        };

        this.reminders.push(reminder);
        this.save();

        logger.info(`Reminder added [${id}] for user ${userId}: "${task}" due at ${formatted}`);
        return reminder;
    }

    /**
     * Returns pending reminders for a user.
     */
    listReminders(userId, includeCompleted = false) {
        return this.reminders
            .filter(r => (r.userId === userId || !userId) && (includeCompleted || !r.completed))
            .sort((a, b) => a.dueAt - b.dueAt);
    }

    /**
     * Deletes a reminder by ID or index.
     */
    deleteReminder(idOrIndex, userId) {
        const query = String(idOrIndex).trim().toLowerCase();
        const initialLen = this.reminders.length;

        // Try direct ID match
        let targetIndex = this.reminders.findIndex(r => r.id.toLowerCase() === query);

        // Try numeric index (1-based)
        if (targetIndex === -1 && /^\d+$/.test(query)) {
            const idx = parseInt(query, 10) - 1;
            const userReminders = this.listReminders(userId);
            if (userReminders[idx]) {
                targetIndex = this.reminders.findIndex(r => r.id === userReminders[idx].id);
            }
        }

        if (targetIndex !== -1) {
            const removed = this.reminders.splice(targetIndex, 1)[0];
            this.save();
            logger.info(`Reminder deleted [${removed.id}]`);
            return { success: true, removed };
        }

        return { success: false, message: `No reminder found matching "${idOrIndex}".` };
    }

    /**
     * Clears all completed reminders for a user.
     */
    clearCompleted(userId) {
        const before = this.reminders.length;
        this.reminders = this.reminders.filter(r => !(r.userId === userId && r.completed));
        this.save();
        return before - this.reminders.length;
    }

    /**
     * Starts the periodic reminder evaluation loop (every 15s).
     */
    start(client) {
        if (this.timer) clearInterval(this.timer);
        this.client = client;

        logger.info('ReminderService background scheduler started.');

        this.timer = setInterval(async () => {
            await this.tick();
        }, 15000);
    }

    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    /**
     * Checks due reminders and delivers Discord notifications.
     */
    async tick() {
        if (!this.client) return;
        const now = Date.now();

        const dueReminders = this.reminders.filter(r => !r.completed && r.dueAt <= now);
        if (dueReminders.length === 0) return;

        for (const rem of dueReminders) {
            try {
                let delivered = false;

                // 1. Try sending DM if it's owner or created in DM
                if (rem.userId) {
                    try {
                        const user = await this.client.users.fetch(rem.userId);
                        if (user) {
                            await user.send(
                                `⏰ **REMINDER ALERT**\n\n` +
                                `**Task:** ${rem.task}\n` +
                                `*(Scheduled for ${rem.dueTimeStr})*`
                            );
                            delivered = true;
                        }
                    } catch (dmErr) {
                        logger.warn(`Could not deliver reminder via DM to ${rem.userId}: ${dmErr.message}`);
                    }
                }

                // 2. If DM failed or was a channel-based reminder, post in channel
                if (!delivered && rem.channelId) {
                    try {
                        const channel = await this.client.channels.fetch(rem.channelId);
                        if (channel && channel.isTextBased()) {
                            await channel.send(
                                `⏰ **REMINDER ALERT** <@${rem.userId}>\n\n` +
                                `**Task:** ${rem.task}\n` +
                                `*(Scheduled for ${rem.dueTimeStr})*`
                            );
                            delivered = true;
                        }
                    } catch (chErr) {
                        logger.error(`Could not deliver reminder in channel ${rem.channelId}: ${chErr.message}`);
                    }
                }

                if (delivered) {
                    logger.success(`Delivered reminder [${rem.id}]: "${rem.task}" to ${rem.userId}`);
                    rem.completed = true;
                }
            } catch (err) {
                logger.error(`Error processing reminder ${rem.id}: ${err.message}`);
            }
        }

        this.save();
    }
}

module.exports = ReminderService;

