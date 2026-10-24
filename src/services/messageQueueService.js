const logger = require('../utils/logger');

class MessageQueueService {
    constructor(debounceMs = 1800) {
        this.debounceMs = debounceMs;
        this.queues = new Map(); // key -> { messages, timer, resolveHandler }
    }

    /**
     * Enqueues an incoming message.
     * Returns a promise that resolves with the aggregated message once the debounce window closes,
     * OR resolves immediately if it is a command.
     */
    enqueue(message, onReady) {
        const text = (message.content || '').trim();

        // Commands (!help, !goal, /slash, etc.) should bypass debouncing for immediate snappy reaction
        if (text.startsWith('!') || message.interaction) {
            return onReady(message);
        }

        const key = `${message.author.id}:${message.channel.id}`;

        if (this.queues.has(key)) {
            // User sent another message within debounce window -> aggregate!
            const entry = this.queues.get(key);
            clearTimeout(entry.timer);
            entry.messages.push(message);

            // Re-trigger typing
            try {
                message.channel.sendTyping().catch(() => {});
            } catch (e) {}

            entry.timer = setTimeout(() => this._flush(key, onReady), this.debounceMs);
            logger.info(`MessageQueue: Aggregating turn for ${message.author.tag} (${entry.messages.length} messages buffered)`);
        } else {
            // First message in sequence -> start timer
            const entry = {
                messages: [message],
                timer: setTimeout(() => this._flush(key, onReady), this.debounceMs)
            };
            this.queues.set(key, entry);
        }
    }

    async _flush(key, onReady) {
        const entry = this.queues.get(key);
        if (!entry) return;
        this.queues.delete(key);

        const messages = entry.messages;
        const lastMsg = messages[messages.length - 1];

        if (messages.length === 1) {
            return await onReady(lastMsg);
        }

        // Aggregate multiple rapid messages into one coherent multi-line prompt
        const combinedContent = messages.map(m => m.content.trim()).filter(Boolean).join('\n');
        logger.info(`MessageQueue: Dispatched aggregated prompt (${messages.length} parts) for ${lastMsg.author.tag}`);

        // Proxy the last message with combined content
        const aggregatedProxy = Object.create(lastMsg, {
            content: { value: combinedContent, writable: true, enumerable: true },
            _aggregatedCount: { value: messages.length, writable: false }
        });

        return await onReady(aggregatedProxy);
    }
}

module.exports = MessageQueueService;

