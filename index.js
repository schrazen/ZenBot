/**
 * ZenBot — Personal AI Assistant
 * Entrypoint
 */

const ZenBot = require('./src/bot');
const logger = require('./src/utils/logger');

const bot = new ZenBot();

// Handle graceful termination
process.on('SIGINT', () => bot.stop());
process.on('SIGTERM', () => bot.stop());

bot.start().catch((err) => {
    logger.error('Failed to start ZenBot:', err.message);
    process.exit(1);
});