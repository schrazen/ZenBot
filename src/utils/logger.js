/**
 * Simple, formatted console logger with timestamps and levels.
 */

const colors = {
    reset: '\x1b[0m',
    dim: '\x1b[2m',
    bright: '\x1b[1m',
    blue: '\x1b[34m',
    cyan: '\x1b[36m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    red: '\x1b[31m',
    magenta: '\x1b[35m'
};

function formatTime() {
    return new Date().toLocaleTimeString('en-US', { hour12: false });
}

const logger = {
    info(msg, ...args) {
        console.log(`${colors.dim}[${formatTime()}]${colors.reset} ${colors.blue}[INFO]${colors.reset} ${msg}`, ...args);
    },
    success(msg, ...args) {
        console.log(`${colors.dim}[${formatTime()}]${colors.reset} ${colors.green}[SUCCESS]${colors.reset} ${msg}`, ...args);
    },
    warn(msg, ...args) {
        console.warn(`${colors.dim}[${formatTime()}]${colors.reset} ${colors.yellow}[WARN]${colors.reset} ${msg}`, ...args);
    },
    error(msg, ...args) {
        console.error(`${colors.dim}[${formatTime()}]${colors.reset} ${colors.red}[ERROR]${colors.reset} ${msg}`, ...args);
    },
    bot(msg, ...args) {
        console.log(`${colors.dim}[${formatTime()}]${colors.reset} ${colors.cyan}[ZENBOT]${colors.reset} ${msg}`, ...args);
    },
    debug(msg, ...args) {
        if (process.env.DEBUG === 'true') {
            console.log(`${colors.dim}[${formatTime()}]${colors.reset} ${colors.magenta}[DEBUG]${colors.reset} ${msg}`, ...args);
        }
    }
};

module.exports = logger;
