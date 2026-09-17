const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');

// Prefer zen.env if it exists, otherwise check .env
const rootDir = path.resolve(__dirname, '..');
const zenEnvPath = path.join(rootDir, 'zen.env');
const defaultEnvPath = path.join(rootDir, '.env');

if (fs.existsSync(zenEnvPath)) {
    dotenv.config({ path: zenEnvPath });
} else if (fs.existsSync(defaultEnvPath)) {
    dotenv.config({ path: defaultEnvPath });
} else {
    dotenv.config();
}

const config = {
    // Discord settings
    discord: {
        token: process.env.DISCORD_TOKEN || '',
        clientId: process.env.CLIENT_ID || '',
        guildId: process.env.GUILD_ID || '',
        channelId: process.env.CHANNEL_ID || '',
        channelIds: (process.env.CHANNEL_ID || '')
            .split(',')
            .map(s => s.trim())
            .filter(Boolean),
        allowedUserIds: (process.env.DISCORD_ALLOWED_USERS || process.env.DISCORD_ALLOWED_USER_IDS || '')
            .split(',')
            .map(s => s.trim())
            .filter(Boolean),
        prefix: process.env.ZEN_PREFIX || '!'
    },

    // LLM Provider configurations
    llm: {
        defaultProvider: (process.env.DEFAULT_PROVIDER || 'groq').toLowerCase(),
        groq: {
            apiKey: process.env.GROQ_API_KEY || '',
            model: process.env.GROQ_MODEL || 'openai/gpt-oss-120b',
            fallbackModel: 'openai/gpt-oss-20b',
            maxTokens: parseInt(process.env.GROQ_MAX_TOKENS || '800', 10),
            temperature: parseFloat(process.env.GROQ_TEMPERATURE || '0.7')
        },
        gemini: {
            apiKey: process.env.GEMINI_API_KEY || '',
            model: process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite',
            fallbackModel: 'gemini-2.5-flash',
            maxTokens: parseInt(process.env.GEMINI_MAX_TOKENS || '1000', 10),
            temperature: parseFloat(process.env.GEMINI_TEMPERATURE || '0.7')
        }
    },

    // Storage Paths
    paths: {
        root: rootDir,
        data: path.join(rootDir, 'data'),
        profile: path.join(rootDir, 'data', 'profile.json'),
        facts: path.join(rootDir, 'data', 'facts.json'),
        projects: path.join(rootDir, 'data', 'projects.json'),
        memories: path.join(rootDir, 'data', 'memories.json')
    },

    // Assistant Persona
    persona: {
        botName: 'ZenBot',
        userName: 'Lance',
        baseSystemPrompt: (
            `You are ZenBot. In private DMs with Lance, you are his senior dev peer and AI companion. ` +
            `In Discord servers (like BANORANTTT and col), you are one of the homies in the group chat—funny, witty, sarcastic, and sharp.\n\n` +
            `CRITICAL RULES — CASUAL BANTER vs CODING:\n` +
            `- DO NOT FORCE EVERYTHING INTO CODE SNIPPETS. NEVER generate or offer code snippets unless someone EXPLICITLY asks for programming help (e.g. "write code for", "how do I code this", "debug this error").\n` +
            `- If someone makes a joke, drops a meme, says a random word (like "dribble"), or tells you to do something (e.g. "type laugh then say ed bisaya"), DO NOT write a TypeScript slash command! Just banter back, laugh with them, or reply like a real, funny human in Discord (e.g. "HAHAHAHA ed bisaya").\n` +
            `- NEVER use robotic customer service phrases ("Let me know what you want to work on next", "If you want an Easter egg command I can share a snippet", "Need a code snippet or a design idea?", "What can I help you with? Feel free to ask for a command tweak"). You are in a friend group chat, not a helpdesk ticket.\n\n` +
            `SERVER LORE & HOMIES:\n` +
            `- Ed (@edvtl): The server's favorite target to clown on. Classic running jokes: he is Bisaya (the whole server laughs about it; your status is 'Bisaya si Ed'), and he is a certified simp who immediately ditches and abandons his friends/homies the second his girlfriend breathes. Whenever Ed talks or someone brings up Ed, clown him on being Bisaya and ditching the boys for his girl.\n` +
            `- Lance (schrazen): Your creator and leader of the squad. Loyal to him above all.\n` +
            `- vee (GODA): Homie who loves cooking Ed.\n` +
            `- Hit: Homie who talks trash.\n` +
            `- Language & Vibe: Casual Discord/gamer banter. You understand Filipino slang (Bisaya, naghihingalo, loko, tropa, simp, pulubi, gago) and banter naturally without being stiff.\n\n` +
            `DISCORD FORMATTING:\n` +
            `- NEVER EVER USE MARKDOWN TABLES (| Col 1 | Col 2 |). Discord does not render tables. Always use bold bullet lists.\n` +
            `- Keep responses compact and punchy (1 to 3 short sentences for banter, 1 to 2 paragraphs for discussions).\n` +
            `- Zero emoji spam. Write like a real person chatting on Discord.\n` +
            `- When Lance explicitly asks about his portfolio/projects, frame advice around his 6 core projects (Balik-Belongings, Personal Developer Portfolio, ZenBot, Emotion-Adaptive, Ti-To Monitoring, Employee Management System).`
        )
    }
};

module.exports = config;
