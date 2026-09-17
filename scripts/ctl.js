const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');
const readline = require('readline');

const ROOT_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const PID_FILE = path.join(DATA_DIR, 'zenbot.pid');
const LOG_FILE = path.join(DATA_DIR, 'zenbot.log');
const DECKS_FILE = path.join(DATA_DIR, 'study_decks.json');
const MEMORIES_FILE = path.join(DATA_DIR, 'memories.json');
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
            const keys = Object.keys(decks);
            deckCount = keys.length;
            cardCount = keys.reduce((sum, k) => sum + (decks[k].cards?.length || 0), 0);
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
 * Formats status output
 */
function printStatus(verbose = false) {
    const procs = findZenProcesses();
    const env = getEnvSummary();
    const data = getDataSummary();

    const isRunning = procs.length > 0;
    const statusTag = isRunning
        ? `${c.green}${c.bold}● ONLINE${c.reset} (PID: ${procs.map(p => p.ProcessId).join(', ')} | Mem: ${procs.reduce((acc, p) => acc + (p.MemoryMB || 0), 0).toFixed(1)} MB)`
        : `${c.red}${c.bold}○ OFFLINE${c.reset}`;

    console.log(`\n${c.cyan}${c.bold}======================================================================${c.reset}`);
    console.log(`                   ${c.yellow}⚡ ZENBOT CONTROL CENTER ⚡${c.reset}`);
    console.log(`${c.cyan}${c.bold}======================================================================${c.reset}`);
    console.log(`  Status:     ${statusTag}`);
    console.log(`  AI Engine:  ${c.bold}${env.provider.toUpperCase()}${c.reset} [${env.model}] (Gemini Fallback: active)`);
    console.log(`  Data:       ${c.magenta}${data.deckCount} study deck(s)${c.reset} (${data.cardCount} cards) | ${c.blue}${data.factCount} persistent facts${c.reset}`);
    console.log(`  Directory:  ${c.dim}${ROOT_DIR}${c.reset}`);
    console.log(`${c.cyan}----------------------------------------------------------------------${c.reset}`);

    return isRunning;
}

/**
 * Starts ZenBot in the foreground
 */
function startForeground() {
    const procs = findZenProcesses();
    if (procs.length > 0) {
        console.log(`\n${c.yellow}[!] ZenBot is already running (PID: ${procs.map(p => p.ProcessId).join(', ')}).${c.reset}`);
        console.log(`Stop it first with option [3] or command: start-zenbot.bat off`);
        return;
    }

    console.log(`\n${c.green}[+] Starting ZenBot in Foreground Console...${c.reset}`);
    console.log(`${c.dim}Press Ctrl+C anytime to stop.${c.reset}\n`);

    const child = spawn('node', ['index.js'], {
        cwd: ROOT_DIR,
        stdio: 'inherit'
    });

    child.on('exit', (code) => {
        console.log(`\n${c.yellow}[*] ZenBot process exited with code ${code}.${c.reset}`);
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

    exec('cmd.exe /c "start /b node index.js > data\\zenbot.log 2>&1"', {
        cwd: ROOT_DIR
    });

    console.log(`\n${c.green}${c.bold}[✓] ZenBot launched in Background Daemon mode!${c.reset}`);
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
            startForeground();
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
 * Interactive Menu loop
 */
function runMenu() {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    function showPrompt() {
        printStatus();
        console.log(`  ${c.bold}[1]${c.reset} Turn ON  (Foreground Console)`);
        console.log(`  ${c.bold}[2]${c.reset} Turn ON  (Background Daemon)`);
        console.log(`  ${c.bold}[3]${c.reset} Turn OFF (Stop ZenBot)`);
        console.log(`  ${c.bold}[4]${c.reset} Restart ZenBot`);
        console.log(`  ${c.bold}[5]${c.reset} Refresh Status`);
        console.log(`  ${c.bold}[6]${c.reset} Sync / Register Slash Commands`);
        console.log(`  ${c.bold}[7]${c.reset} View Daemon Logs`);
        console.log(`  ${c.bold}[0]${c.reset} Exit Control Center`);
        console.log(`${c.cyan}----------------------------------------------------------------------${c.reset}`);

        rl.question(`\n${c.bold}ZenBot>${c.reset} `, (answer) => {
            const cmd = answer.trim().toLowerCase();

            switch (cmd) {
                case '1':
                case 'on':
                case 'start':
                    rl.close();
                    startForeground();
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
                    rl.close();
                    restartBot(false);
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

                case '0':
                case 'exit':
                case 'quit':
                case 'q':
                    console.log(`\n${c.green}Goodbye! ZenBot operations intact.${c.reset}\n`);
                    rl.close();
                    process.exit(0);
                    break;

                default:
                    console.log(`\n${c.yellow}Unknown option "${answer}". Choose 0-7 or on/off/restart.${c.reset}`);
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
    case 'fg':
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
        console.log(`\nUsage: node scripts/ctl.js [on|off|restart|status|bg|logs|register]`);
        process.exit(1);
}
