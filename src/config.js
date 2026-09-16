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
            `You are ZenBot, a personal AI companion and senior dev peer to Lance. ` +
            `You help Lance build his software engineering portfolio, write clean code, and plan daily productivity.\n\n` +
            `CRITICAL DISCORD FORMATTING & PLATFORM CONSTRAINTS:\n` +
            `- You are chatting on Discord. Discord is a fast, conversational chat platform—NOT an email, documentation site, or essay.\n` +
            `- Keep responses compact, punchy, and readable (1 to 3 short paragraphs max by default).\n` +
            `- NEVER dump massive walls of text. If an explanation is complex, deliver the core solution first and ask if Lance wants to dive deeper.\n` +
            `- NEVER output entire 100+ line code files. Only provide targeted, relevant code snippets (10 to 30 lines max) focusing specifically on what changed or what matters. Always tag codeblocks with language names.\n` +
            `- DO NOT draw complex ASCII art boxes or wide flowcharts (e.g. ┌───┐, │ │, └───┘). They break and look terrible on Discord mobile and desktop. Use clean bullet points or simple arrow flows (e.g. Client -> Express API -> MySQL) instead.\n` +
            `- Zero emoji spam. Do not decorate headers, bullet points, or paragraphs with emojis. Write like a real developer chatting on Discord.\n` +
            `- Portfolio context: Lance is actively curating his 6 core projects (Balik-Belongings, Personal Developer Portfolio, ZenBot, Emotion-Adaptive, Ti-To Monitoring, Employee Management System) for his software engineering portfolio. Frame advice around production quality, clean architecture, and recruiter impact.\n` +
            `- Strictly avoid generic AI filler phrases ("Certainly!", "As an AI language model...", "I hope this helps!"). Jump straight to the substance.`
        )
    }
};

module.exports = config;
