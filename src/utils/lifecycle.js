const path = require('path');
const { spawn } = require('child_process');
const logger = require('./logger');

/**
 * Shared ZenBot lifecycle transitions (Standby, Wake, Shutdown, Restart)
 * used by natural-language tools, prefix/slash commands, and Discord buttons.
 */
function applyStandbyMode(config, { client = null, reason = null } = {}) {
    if (!config) return { error: 'Config unavailable.' };
    config.runtime = config.runtime || {};
    config.runtime.standbyMode = true;
    config.runtime.standbyReason = reason || 'Standby mode requested by Lance';
    config.runtime.standbySince = Date.now();

    try {
        if (client?.user?.setPresence) {
            client.user.setPresence({
                status: 'idle',
                activities: [{ name: "Standby Mode (DM 'wake')" }]
            });
        }
    } catch (e) {}

    logger.info(`ZenBot entered STANDBY mode (${config.runtime.standbyReason}).`);
    return {
        success: true,
        mode: 'STANDBY',
        message: 'ZenBot is now in **Standby Mode**. Background automations, reminders, and server replies are paused. Send **"wake"** or `!wake` in DM anytime to resume.'
    };
}

function applyWakeMode(config, { client = null, botProfileService = null } = {}) {
    if (!config) return { error: 'Config unavailable.' };
    config.runtime = config.runtime || {};
    config.runtime.standbyMode = false;
    config.runtime.standbyReason = null;
    config.runtime.standbySince = null;

    try {
        if (botProfileService?.applyPresence && client) {
            botProfileService.applyPresence(client);
        } else if (client?.user?.setPresence) {
            client.user.setPresence({
                status: 'online',
                activities: [{ name: 'trying my best | !help' }]
            });
        }
    } catch (e) {}

    logger.info('ZenBot resumed ONLINE mode from Standby.');
    return {
        success: true,
        mode: 'ONLINE',
        message: 'ZenBot is back **ONLINE**. Background automations, reminders, and availability monitoring have resumed.'
    };
}

function _stopServices({ ownerAvailability, reminderService, automationService }) {
    try { ownerAvailability?.stopHardwareMonitor?.(); } catch (e) {}
    try { reminderService?.stop?.(); } catch (e) {}
    try { automationService?.stop?.(); } catch (e) {}
}

function scheduleShutdown(config, { client = null, ownerAvailability = null, reminderService = null, automationService = null, delayMs = 1500, skipExit = false } = {}) {
    if (config) {
        config.runtime = config.runtime || {};
        config.runtime.shuttingDown = true;
    }

    logger.info('ZenBot full process shutdown scheduled by owner...');

    if (!skipExit) {
        const t = setTimeout(() => {
            _stopServices({ ownerAvailability, reminderService, automationService });
            try { client?.destroy?.(); } catch (e) {}
            process.exit(0);
        }, delayMs);
        if (typeof t.unref === 'function') t.unref();
    }

    return {
        success: true,
        mode: 'SHUTDOWN',
        message: 'Shutting down the ZenBot Node process cleanly now. You will need to start ZenBot from your PC to turn it back on.'
    };
}

function scheduleRestart(config, { client = null, rootDir = null, ownerAvailability = null, reminderService = null, automationService = null, delayMs = 1500, skipExit = false } = {}) {
    if (config) {
        config.runtime = config.runtime || {};
        config.runtime.shuttingDown = true;
    }

    const workDir = rootDir || config?.paths?.root || path.resolve(__dirname, '../..');
    logger.info('ZenBot process restart scheduled by owner...');

    if (!skipExit) {
        const t = setTimeout(() => {
            _stopServices({ ownerAvailability, reminderService, automationService });
            try { client?.destroy?.(); } catch (e) {}
            try {
                const child = spawn('node', ['index.js'], {
                    cwd: workDir,
                    detached: true,
                    stdio: 'ignore',
                    windowsHide: true
                });
                child.unref();
            } catch (e) {
                logger.error(`Failed to spawn restarted ZenBot process: ${e.message}`);
            }
            process.exit(0);
        }, delayMs);
        if (typeof t.unref === 'function') t.unref();
    }

    return {
        success: true,
        mode: 'RESTARTING',
        message: 'Restarting ZenBot process cleanly now. Expect ZenBot back online in a few seconds.'
    };
}

module.exports = {
    applyStandbyMode,
    applyWakeMode,
    scheduleShutdown,
    scheduleRestart
};
