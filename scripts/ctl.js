const fs = require('fs');
const path = require('path');
const { spawn, exec, execSync } = require('child_process');
const readline = require('readline');

const ROOT_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const PID_FILE = path.join(DATA_DIR, 'zenbot.pid');
const LOG_FILE = path.join(DATA_DIR, 'zenbot.log');
const DECKS_FILE = path.join(DATA_DIR, 'study_decks.json');
const MEMORIES_FILE = path.join(DATA_DIR, 'memories.json');
const BOT_PROFILE_FILE = path.join(DATA_DIR, 'bot_profile.json');
const ENV_FILE = path.join(ROOT_DIR, 'zen.env');

// ANSI Color helper
const c = {
    reset: '\x1b[0m',
    bold: '\x1b[1m',
    dim: '\x1b[2m',
    green: '\x1b[32m',
    red: '\x1b[31m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    cyan: '\x1b[36m',
    magenta: '\x1b[35m',
    gray: '\x1b[90m'
};

/**
 * Searches for active node processes running index.js (excluding ctl.js).
 */
function findZenProcesses() {
    const results = [];
    try {
        const out = execSync('wmic process where "name=\'node.exe\'" get ProcessId,CommandLine /format:csv', {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore']
        });

        const lines = out.split(/\r?\n/).filter(line => line.includes('index.js') && !line.includes('ctl.js'));
        for (const line of lines) {
            const parts = line.split(',');
            const pidStr = parts[parts.length - 1]?.trim();
            const pid = parseInt(pidStr, 10);
            if (!isNaN(pid)) {
                let memMB = 0;
                try {
                    const taskOut = execSync(`tasklist /fi "PID eq ${pid}" /fo csv /nh`, {
                        encoding: 'utf8',
                        stdio: ['ignore', 'pipe', 'ignore']
                    }).trim();
                    const m = taskOut.match(/,"([0-9,]+)\s*K"/i);
                    if (m) {
                        const kb = parseInt(m[1].replace(/,/g, ''), 10);
                        memMB = Math.round((kb / 1024) * 10) / 10;
                    }
                } catch (e) {}

                results.push({ ProcessId: pid, MemoryMB: memMB });
            }
        }
    } catch (e) {}
    return results;
}

/**
 * Reads active AI model and provider from zen.env
 */
function getEnvSummary() {
    let provider = 'groq';
    let model = 'openai/gpt-oss-120b';
    if (fs.existsSync(ENV_FILE)) {
        try {
            const raw = fs.readFileSync(ENV_FILE, 'utf8');
            const pMatch = raw.match(/^LLM_PROVIDER\s*=\s*(.+)$/m);
            const mMatch = raw.match(/^GROQ_MODEL\s*=\s*(.+)$/m);
            if (pMatch) provider = pMatch[1].trim();
            if (mMatch) model = mMatch[1].trim();
        } catch (e) {}
    }
    return { provider, model };
}

/**
 * Reads flashcards and memory counts
 */
function getDataSummary() {
    let deckCount = 0;
    let cardCount = 0;
    let factCount = 0;

    if (fs.existsSync(DECKS_FILE)) {
        try {
            const decks = JSON.parse(fs.readFileSync(DECKS_FILE, 'utf8'));
            const keys = Object.keys(decks).filter(k => !k.startsWith('_'));
            deckCount = keys.length;
            cardCount = keys.reduce((sum, k) => sum + (Array.isArray(decks[k]) ? decks[k].length : (decks[k]?.cards?.length || 0)), 0);
        } catch (e) {}
    }

    if (fs.existsSync(MEMORIES_FILE)) {
        try {
            const mem = JSON.parse(fs.readFileSync(MEMORIES_FILE, 'utf8'));
            factCount = mem.facts?.length || 0;
        } catch (e) {}
    }

    return { deckCount, cardCount, factCount };
}

/**
 * Reads bot profile and presence configuration
 */
function getBotProfile() {
    if (fs.existsSync(BOT_PROFILE_FILE)) {
        try {
            return JSON.parse(fs.readFileSync(BOT_PROFILE_FILE, 'utf8'));
        } catch (e) {}
    }
    return {
        activity: 'Bisaya si Ed | /help',
        activityType: 'Watching',
        presence: 'online',
        bio: ''
    };
}

/**
 * Saves bot profile and presence configuration
 */
function saveBotProfile(updates = {}) {
    try {
        const current = getBotProfile();
        const merged = { ...current, ...updates, updatedAt: Date.now() };
        if (!fs.existsSync(DATA_DIR)) {
            fs.mkdirSync(DATA_DIR, { recursive: true });
        }
        fs.writeFileSync(BOT_PROFILE_FILE, JSON.stringify(merged, null, 2), 'utf8');
        return merged;
    } catch (e) {
        console.log(`${c.red}Failed to save bot_profile.json: ${e.message}${c.reset}`);
        return null;
    }
}

/**
 * Extracts Discord token from zen.env
 */
function getDiscordToken() {
    if (fs.existsSync(ENV_FILE)) {
        try {
            const raw = fs.readFileSync(ENV_FILE, 'utf8');
            const m = raw.match(/^DISCORD_TOKEN\s*=\s*(.+)$/m);
            if (m) return m[1].trim().replace(/^["']|["']$/g, '');
        } catch (e) {}
    }
    return process.env.DISCORD_TOKEN || '';
}

/**
 * Updates application bio description directly on Discord API via REST
 */
async function updateBioRemote(newBio) {
    const token = getDiscordToken();
    if (!token) {
        console.log(`\n${c.yellow}[!] DISCORD_TOKEN not found in zen.env. Saved to bot_profile.json only.${c.reset}`);
        return;
    }

    try {
        const { REST, Routes } = require('discord.js');
        const rest = new REST({ version: '10' }).setToken(token);
        await rest.patch(Routes.currentApplication(), {
            body: { description: newBio }
        });
        console.log(`\n${c.green}✓ Bot "About Me" bio updated directly on Discord API!${c.reset}`);
    } catch (e) {
        console.log(`\n${c.red}✗ Failed to update Discord bio via REST: ${e.message}${c.reset}`);
    }
}

/**
 * Formats status output
 */
function printStatus(verbose = false) {
    const procs = findZenProcesses();
    const env = getEnvSummary();
    const data = getDataSummary();
    const prof = getBotProfile();

    const isRunning = procs.length > 0;
    const statusTag = isRunning
        ? `${c.green}${c.bold}● ONLINE${c.reset} (PID: ${procs.map(p => p.ProcessId).join(', ')} | Mem: ${procs.reduce((acc, p) => acc + (p.MemoryMB || 0), 0).toFixed(1)} MB)`
        : `${c.red}${c.bold}○ OFFLINE${c.reset}`;

    console.log(`\n${c.cyan}${c.bold}======================================================================${c.reset}`);
    console.log(`                   ${c.yellow}⚡ ZENBOT CONTROL CENTER ⚡${c.reset}`);
    console.log(`${c.cyan}${c.bold}======================================================================${c.reset}`);
    console.log(`  Status:     ${statusTag}`);
    console.log(`  Presence:   ${c.yellow}${prof.activityType || 'Watching'}${c.reset} "${prof.activity || 'None'}" [${c.green}${c.bold}${(prof.presence || 'online').toUpperCase()}${c.reset}]`);
    console.log(`  AI Engine:  ${c.bold}${env.provider.toUpperCase()}${c.reset} [${env.model}] (Gemini Fallback: active)`);
    console.log(`  Data:       ${c.magenta}${data.deckCount} study deck(s)${c.reset} (${data.cardCount} cards) | ${c.blue}${data.factCount} persistent facts${c.reset}`);
    console.log(`  Directory:  ${c.dim}${ROOT_DIR}${c.reset}`);
    console.log(`${c.cyan}----------------------------------------------------------------------${c.reset}`);

    return isRunning;
}

/**
 * Launches ZenBot in a dedicated Live Console window.
 * The Control Center menu remains completely active in this window!
 */
function startLiveWindow() {
    const procs = findZenProcesses();
    if (procs.length > 0) {
        console.log(`\n${c.yellow}[!] ZenBot is already running (PID: ${procs.map(p => p.ProcessId).join(', ')}).${c.reset}`);
        console.log(`To stop: choose option [3] or type 'off'.`);
        return;
    }

    console.log(`\n${c.green}[+] Opening ZenBot Live Console in a new window...${c.reset}`);
    const child = spawn('cmd.exe', ['/c', 'start', 'ZenBot Live Console', 'cmd.exe', '/c', 'node index.js'], {
        cwd: ROOT_DIR,
        detached: true,
        stdio: 'ignore'
    });
    child.unref();
    console.log(`  ${c.green}✓ Live Console window launched!${c.reset}`);
    console.log(`  ${c.dim}The Control Center is still active here. Type [3] or 'off' anytime to stop.${c.reset}`);
}

/**
 * Starts ZenBot directly in the current terminal window.
 */
function startForeground(callback = null) {
    const procs = findZenProcesses();
    if (procs.length > 0) {
        console.log(`\n${c.yellow}[!] ZenBot is already running (PID: ${procs.map(p => p.ProcessId).join(', ')}).${c.reset}`);
        console.log(`To stop: choose option [3] or type 'off'.`);
        if (callback) callback();
        return;
    }

    console.log(`\n${c.green}[+] Starting ZenBot in this terminal...${c.reset}`);
    console.log(`${c.dim}Press Ctrl+C to stop ZenBot and return to the menu.${c.reset}\n`);

    const child = spawn('node', ['index.js'], {
        cwd: ROOT_DIR,
        stdio: 'inherit'
    });

    child.on('exit', (code) => {
        console.log(`\n${c.yellow}[*] ZenBot process finished (exit code ${code}).${c.reset}`);
        if (callback) {
            setTimeout(callback, 1000);
        }
    });
}

/**
 * Starts ZenBot as a background daemon
 */
function startBackground() {
    const procs = findZenProcesses();
    if (procs.length > 0) {
        console.log(`\n${c.yellow}[!] ZenBot is already running (PID: ${procs.map(p => p.ProcessId).join(', ')}).${c.reset}`);
        return;
    }

    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }

    const out = fs.openSync(LOG_FILE, 'a');
    const err = fs.openSync(LOG_FILE, 'a');

    const child = spawn('node', ['index.js'], {
        cwd: ROOT_DIR,
        detached: true,
        stdio: ['ignore', out, err]
    });

    child.unref();

    console.log(`\n${c.green}${c.bold}[✓] ZenBot launched in Background Daemon mode!${c.reset}`);
    console.log(`  PID:        ${child.pid}`);
    console.log(`  Log File:   ${c.cyan}${LOG_FILE}${c.reset}`);
    console.log(`  To stop:    Run 'start-zenbot.bat off' or choose option [3] in menu.`);
}

/**
 * Stops any running ZenBot processes
 */
function stopBot() {
    const procs = findZenProcesses();
    if (procs.length === 0) {
        console.log(`\n${c.yellow}[*] ZenBot is not currently running.${c.reset}`);
        if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE);
        return;
    }

    console.log(`\n${c.yellow}[*] Stopping ${procs.length} ZenBot process(es)...${c.reset}`);
    for (const p of procs) {
        try {
            execSync(`taskkill /pid ${p.ProcessId} /f /t`, { stdio: 'ignore' });
            console.log(`  ${c.green}✓ Terminated PID ${p.ProcessId}${c.reset}`);
        } catch (e) {
            console.log(`  ${c.red}✗ Failed to terminate PID ${p.ProcessId}: ${e.message}${c.reset}`);
        }
    }

    try {
        execSync('taskkill /fi "WINDOWTITLE eq ZenBot Live Console*" /f /t', { stdio: 'ignore' });
    } catch (e) {}

    if (fs.existsSync(PID_FILE)) {
        try { fs.unlinkSync(PID_FILE); } catch (e) {}
    }

    console.log(`${c.green}${c.bold}[✓] ZenBot has been turned OFF.${c.reset}`);
}

/**
 * Restarts ZenBot
 */
function restartBot(bg = false) {
    console.log(`\n${c.cyan}[*] Restarting ZenBot...${c.reset}`);
    stopBot();
    setTimeout(() => {
        if (bg) {
            startBackground();
        } else {
            startLiveWindow();
        }
    }, 1200);
}

/**
 * Displays recent log entries
 */
function showLogs() {
    if (!fs.existsSync(LOG_FILE)) {
        console.log(`\n${c.yellow}[!] No background log file found at ${LOG_FILE}.${c.reset}`);
        return;
    }

    try {
        const content = fs.readFileSync(LOG_FILE, 'utf8');
        const lines = content.trim().split(/\r?\n/);
        const lastLines = lines.slice(-35);
        console.log(`\n${c.cyan}--- Last 35 lines of ${LOG_FILE} ---${c.reset}`);
        console.log(lastLines.join('\n'));
        console.log(`${c.cyan}--- End of logs ---${c.reset}\n`);
    } catch (e) {
        console.log(`\n${c.red}Failed to read log file: ${e.message}${c.reset}`);
    }
}

/**
 * Registers Discord slash commands
 */
function registerSlash() {
    console.log(`\n${c.cyan}[*] Synchronizing Discord Slash Commands...${c.reset}`);
    try {
        execSync('node -e "require(\'./src/handlers/slashCommands\').registerSlashCommands(require(\'./src/config\'))"', {
            cwd: ROOT_DIR,
            stdio: 'inherit'
        });
        console.log(`\n${c.green}[✓] Slash command registration finished.${c.reset}`);
    } catch (e) {
        console.log(`\n${c.red}[✗] Error registering slash commands: ${e.message}${c.reset}`);
    }
}

/**
 * Sub-menu for managing bot profile, presence, and bio
 */
function manageBotProfile(rl, backCallback) {
    const prof = getBotProfile();
    console.log(`\n${c.magenta}${c.bold}======================================================================${c.reset}`);
    console.log(`                   ${c.yellow}🤖 BOT DISCORD PROFILE & PRESENCE 🤖${c.reset}`);
    console.log(`${c.magenta}${c.bold}======================================================================${c.reset}`);
    console.log(`  Current Activity: ${c.bold}${prof.activityType || 'Watching'}${c.reset} "${c.cyan}${prof.activity || 'None'}${c.reset}"`);
    console.log(`  Current Presence: ${c.green}${c.bold}${(prof.presence || 'online').toUpperCase()}${c.reset}`);
    console.log(`  Current Bio:      ${c.dim}${prof.bio ? prof.bio.slice(0, 100) : '(No bio set)'}${c.reset}`);
    console.log(`${c.magenta}----------------------------------------------------------------------${c.reset}`);
    console.log(`  ${c.bold}[1]${c.reset} Change Status / Activity Name`);
    console.log(`  ${c.bold}[2]${c.reset} Change Activity Type (Watching / Playing / Listening / Competing)`);
    console.log(`  ${c.bold}[3]${c.reset} Change Online Presence (Online / Idle / DND)`);
    console.log(`  ${c.bold}[4]${c.reset} Change Application Bio / About Me (Syncs to Discord)`);
    console.log(`  ${c.bold}[0]${c.reset} Return to Main Menu`);
    console.log(`${c.magenta}----------------------------------------------------------------------${c.reset}`);

    rl.question(`\n${c.bold}Profile>${c.reset} `, async (ans) => {
        const choice = ans.trim();
        switch (choice) {
            case '1':
                rl.question(`\nEnter new activity text (e.g. Bisaya si Ed | /help): `, (text) => {
                    const clean = text.trim();
                    if (clean) {
                        saveBotProfile({ activity: clean });
                        console.log(`\n${c.green}✓ Status name updated to: "${clean}"${c.reset}`);
                        console.log(`${c.dim}(Live bot will auto-reload presence within seconds)${c.reset}`);
                    }
                    setTimeout(() => manageBotProfile(rl, backCallback), 1000);
                });
                break;

            case '2':
                console.log(`\nSelect Activity Type:`);
                console.log(`  [1] Watching`);
                console.log(`  [2] Playing`);
                console.log(`  [3] Listening to`);
                console.log(`  [4] Competing in`);
                rl.question(`Choice (1-4): `, (typeChoice) => {
                    const map = { '1': 'Watching', '2': 'Playing', '3': 'Listening', '4': 'Competing' };
                    const selected = map[typeChoice.trim()];
                    if (selected) {
                        saveBotProfile({ activityType: selected });
                        console.log(`\n${c.green}✓ Activity type updated to: ${selected}${c.reset}`);
                    } else {
                        console.log(`\n${c.yellow}Invalid choice.${c.reset}`);
                    }
                    setTimeout(() => manageBotProfile(rl, backCallback), 1000);
                });
                break;

            case '3':
                console.log(`\nSelect Presence Status:`);
                console.log(`  [1] Online (Green)`);
                console.log(`  [2] Idle (Orange)`);
                console.log(`  [3] Do Not Disturb (Red)`);
                rl.question(`Choice (1-3): `, (pChoice) => {
                    const map = { '1': 'online', '2': 'idle', '3': 'dnd' };
                    const selected = map[pChoice.trim()];
                    if (selected) {
                        saveBotProfile({ presence: selected });
                        console.log(`\n${c.green}✓ Presence updated to: ${selected.toUpperCase()}${c.reset}`);
                    } else {
                        console.log(`\n${c.yellow}Invalid choice.${c.reset}`);
                    }
                    setTimeout(() => manageBotProfile(rl, backCallback), 1000);
                });
                break;

            case '4':
                rl.question(`\nEnter new "About Me" bio text: `, async (newBio) => {
                    const clean = newBio.trim();
                    if (clean) {
                        saveBotProfile({ bio: clean });
                        await updateBioRemote(clean);
                    }
                    setTimeout(() => manageBotProfile(rl, backCallback), 1500);
                });
                break;

            case '0':
            case 'back':
            case 'exit':
                backCallback();
                break;

            default:
                console.log(`\n${c.yellow}Unknown option.${c.reset}`);
                setTimeout(() => manageBotProfile(rl, backCallback), 1000);
                break;
        }
    });
}

/**
 * Interactive Menu loop
 */
function runMenu() {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    function showPrompt() {
        printStatus();
        console.log(`  ${c.bold}[1]${c.reset} Turn ON  (Live Console Window - keeps Control Center active)`);
        console.log(`  ${c.bold}[2]${c.reset} Turn ON  (Background Daemon - Silent)`);
        console.log(`  ${c.bold}[3]${c.reset} Turn OFF (Stop ZenBot)`);
        console.log(`  ${c.bold}[4]${c.reset} Restart ZenBot`);
        console.log(`  ${c.bold}[5]${c.reset} Refresh Status`);
        console.log(`  ${c.bold}[6]${c.reset} Sync / Register Slash Commands`);
        console.log(`  ${c.bold}[7]${c.reset} View Daemon Logs`);
        console.log(`  ${c.bold}[8]${c.reset} Run in Current Window (Foreground)`);
        console.log(`  ${c.bold}[9]${c.reset} Manage Discord Profile (Status / Bio / Presence)`);
        console.log(`  ${c.bold}[0]${c.reset} Exit Control Center`);
        console.log(`${c.cyan}----------------------------------------------------------------------${c.reset}`);

        rl.question(`\n${c.bold}ZenBot>${c.reset} `, (answer) => {
            const cmd = answer.trim().toLowerCase();

            switch (cmd) {
                case '1':
                case 'on':
                case 'start':
                case 'win':
                    startLiveWindow();
                    setTimeout(showPrompt, 1500);
                    break;

                case '2':
                case 'bg':
                case 'background':
                case 'daemon':
                    startBackground();
                    setTimeout(showPrompt, 1500);
                    break;

                case '3':
                case 'off':
                case 'stop':
                    stopBot();
                    setTimeout(showPrompt, 1200);
                    break;

                case '4':
                case 'restart':
                    stopBot();
                    setTimeout(() => {
                        startLiveWindow();
                        setTimeout(showPrompt, 1500);
                    }, 1200);
                    break;

                case '5':
                case 'status':
                    showPrompt();
                    break;

                case '6':
                case 'slash':
                case 'register':
                    registerSlash();
                    setTimeout(showPrompt, 2000);
                    break;

                case '7':
                case 'logs':
                case 'log':
                    showLogs();
                    setTimeout(showPrompt, 2000);
                    break;

                case '8':
                case 'fg':
                    rl.close();
                    startForeground(() => {
                        runMenu();
                    });
                    break;

                case '9':
                case 'profile':
                case 'bot':
                    manageBotProfile(rl, () => showPrompt());
                    break;

                case '0':
                case 'exit':
                case 'quit':
                case 'q':
                    console.log(`\n${c.green}Goodbye! ZenBot operations intact.${c.reset}\n`);
                    rl.close();
                    process.exit(0);
                    break;

                default:
                    console.log(`\n${c.yellow}Unknown option "${answer}". Choose 0-9 or on/off/restart.${c.reset}`);
                    setTimeout(showPrompt, 1500);
                    break;
            }
        });
    }

    showPrompt();
}

// CLI argument handling
const arg = (process.argv[2] || '').toLowerCase();

switch (arg) {
    case 'on':
    case 'start':
    case 'win':
        startLiveWindow();
        break;

    case 'fg':
    case 'foreground':
        startForeground();
        break;

    case 'bg':
    case 'background':
    case 'daemon':
        startBackground();
        break;

    case 'off':
    case 'stop':
        stopBot();
        break;

    case 'restart':
        restartBot(process.argv.includes('--bg') || process.argv.includes('-bg'));
        break;

    case 'status':
        printStatus(true);
        break;

    case 'bot':
    case 'profile':
    case 'bot-profile': {
        const prof = getBotProfile();
        console.log(`\n${c.magenta}======================================================================${c.reset}`);
        console.log(`                   ${c.yellow}🤖 BOT DISCORD PROFILE & PRESENCE 🤖${c.reset}`);
        console.log(`${c.magenta}======================================================================${c.reset}`);
        console.log(`  Status Name:   "${prof.activity || 'None'}"`);
        console.log(`  Activity Type: ${prof.activityType || 'Watching'}`);
        console.log(`  Presence:      ${(prof.presence || 'online').toUpperCase()}`);
        console.log(`  Bio/About Me:  ${prof.bio || '(None)'}`);
        console.log(`${c.magenta}======================================================================${c.reset}\n`);
        break;
    }

    case 'set-status':
    case 'status-set': {
        const text = process.argv.slice(3).join(' ').trim();
        if (!text) {
            console.log(`\nUsage: node scripts/ctl.js set-status "Your status text"`);
            process.exit(1);
        }
        saveBotProfile({ activity: text });
        console.log(`\n${c.green}[✓] Updated bot activity to: "${text}"${c.reset}`);
        console.log(`${c.dim}(Live bot will auto-reload presence within seconds)${c.reset}\n`);
        break;
    }

    case 'set-bio':
    case 'bio-set': {
        const bio = process.argv.slice(3).join(' ').trim();
        if (!bio) {
            console.log(`\nUsage: node scripts/ctl.js set-bio "Your bio text"`);
            process.exit(1);
        }
        saveBotProfile({ bio });
        updateBioRemote(bio);
        break;
    }

    case 'set-presence': {
        const presence = (process.argv[3] || '').toLowerCase().trim();
        if (!['online', 'idle', 'dnd'].includes(presence)) {
            console.log(`\nUsage: node scripts/ctl.js set-presence [online|idle|dnd]`);
            process.exit(1);
        }
        saveBotProfile({ presence });
        console.log(`\n${c.green}[✓] Updated bot presence to: ${presence.toUpperCase()}${c.reset}\n`);
        break;
    }

    case 'logs':
    case 'log':
        showLogs();
        break;

    case 'register':
    case 'slash':
        registerSlash();
        break;

    case 'menu':
    case '':
        runMenu();
        break;

    default:
        console.log(`\nUsage: node scripts/ctl.js [on|off|restart|status|bg|logs|register|bot|set-status|set-bio|set-presence]`);
        process.exit(1);
}
