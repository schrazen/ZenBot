# ZenBot

[![Node.js](https://img.shields.io/badge/Node.js-v18%2B-green?logo=node.js)](https://nodejs.org/)
[![Discord.js](https://img.shields.io/badge/Discord.js-v14-blue?logo=discord)](https://discord.js.org/)
[![Groq](https://img.shields.io/badge/LLM-Groq%20Cloud-orange)](https://groq.com/)
[![Google Gemini](https://img.shields.io/badge/LLM-Google%20Gemini-4285F4?logo=google)](https://aistudio.google.com/)
[![License](https://img.shields.io/badge/License-MIT-purple)](#license)

ZenBot is a cloud-powered personal AI Discord assistant and engineering companion built with Node.js. It features a multi-tiered persistent memory architecture, deep awareness of your active software projects, and multi-provider LLM orchestration (Groq and Google Gemini) with automatic failover.

Designed as a personal productivity companion and software engineering portfolio showcase, ZenBot operates with sub-second inference speeds and zero local GPU overhead.

---

## Key Capabilities

- **Multi-Provider LLM Orchestration**: Interfaces with **Groq** (using `openai/gpt-oss-120b` for sub-second token generation) and **Google Gemini** (using `gemini-3.1-flash-lite` for high-throughput reasoning). Automatically fails over between providers if rate limits or network errors occur.
- **Multi-Tiered Memory Architecture**:
  - **User Profile Tier**: Static personal context (identity, bio, preferences, active career goals) injected into every conversation turn.
  - **Project Knowledge Tier**: Structured registry of active engineering projects. Detects project mentions in conversation and injects architecture, stack, and active roadmap items into the context window.
  - **Discrete Fact Store**: Categorized personal knowledge base (`Preference`, `Routine`, `Work/Tech`, `Goal`) updated via commands or passive conversational extraction.
  - **Episodic Memory**: Rolling conversation history with hybrid keyword frequency, phrase matching, and recency decay scoring in pure JavaScript.
- **Discord-Optimized Output**: Formatted specifically for Discord readability. Enforces concise responses, avoids massive walls of text, restricts code examples to focused snippets, and splits messages safely without breaking codeblock syntax.
- **DM and Multi-Server Flexibility**: Responds directly in private DMs without requiring mentions, and operates across multiple Discord servers when mentioned.
- **Real-Time Token & Limits Auditing**: Tracks prompt, completion, and total tokens per turn, along with remaining requests and tokens-per-minute (TPM) quotas via live API response headers.

---

## System Architecture

```
                                  +-----------------------+
                                  |     Discord User      |
                                  +-----------+-----------+
                                              |
                                              v
                                  +-----------------------+
                                  |    Discord Client     |
                                  |     (discord.js)      |
                                  +-----------+-----------+
                                              |
                     +------------------------+------------------------+
                     |                                                 |
             [Command: !...]                                   [Chat Message]
                     v                                                 v
         +-----------------------+                         +-----------------------+
         |    CommandHandler     |                         |    MessageHandler     |
         +-----------------------+                         +-----------+-----------+
                     |                                                 |
                     | Manage / Query                                  | Build Context
                     v                                                 v
  +---------------------------------------------------------------------------------------+
  |                                  MemoryManager                                        |
  |  +---------------------+  +---------------------+  +-------------------------------+  |
  |  |   1. User Profile   |  | 2. Projects Registry|  | 3. Fact Store & Episodic RAG  |  |
  |  | (data/profile.json) |  | (data/projects.json)|  | (data/facts.json & memories)  |  |
  |  +---------------------+  +---------------------+  +-------------------------------+  |
  +---------------------------------------------------------------------------------------+
                                              |
                                              | Assembled Prompt Payload
                                              v
  +---------------------------------------------------------------------------------------+
  |                                    LLMManager                                         |
  |               (Auto-Failover, Model Switching, Provider Orchestration)                |
  |                                                                                       |
  |         +---------------------------+       +----------------------------+            |
  |         |       Groq Provider       | <---> |      Gemini Provider       |            |
  |         | (e.g. gpt-oss-120b, Qwen) |       |  (e.g. gemini-3.1-flash)   |            |
  |         +---------------------------+       +----------------------------+            |
  +---------------------------------------------------------------------------------------+
                                              |
                                              v
                                  +-----------------------+
                                  | Discord Smart Chunker | (Splits <= 1800 chars)
                                  +-----------+-----------+
                                              |
                                              v
                                  +-----------------------+
                                  | Discord Reply to User |
                                  +-----------------------+
```

---

## Quick Start

### 1. Prerequisites
- **Node.js**: v18.0.0 or higher
- **Discord Bot Token**: From the [Discord Developer Portal](https://discord.com/developers/applications)
- **API Keys**:
  - [Groq API Key](https://console.groq.com/keys) (Free, fast LPU inference)
  - [Google AI Studio Gemini API Key](https://aistudio.google.com/app/apikey) (Free, 500 RPM capacity)

### 2. Installation
Clone the repository and install dependencies:
```bash
git clone https://github.com/schrazen/ZenBot.git
cd ZenBot
npm install
```

### 3. Environment Configuration
Copy `.env.example` to `zen.env` (or `.env`):
```bash
cp .env.example zen.env
```

Configure your credentials:
```env
# Discord Settings
DISCORD_TOKEN=your_discord_bot_token
CLIENT_ID=your_client_id
GUILD_ID=your_guild_id

# Optional Security Scoping
CHANNEL_ID=
DISCORD_ALLOWED_USER_IDS=

# AI Provider Settings
DEFAULT_PROVIDER=groq
GROQ_API_KEY=your_groq_api_key
GROQ_MODEL=openai/gpt-oss-120b

GEMINI_API_KEY=your_gemini_api_key
GEMINI_MODEL=gemini-3.1-flash-lite
```

### 4. Running the Bot
```bash
# Production mode
npm start

# Development mode with file watching
npm run dev
```

---

## Commands Reference

| Command | Description | Example |
|---|---|---|
| `!help` | Displays the command help menu | `!help` |
| `!status` | Checks active provider, model, and memory counts | `!status` |
| `!limits` | Shows live token breakdown and API rate limits | `!limits` |
| `!projects` | Lists all tracked software and portfolio projects | `!projects` |
| `!project <id>` | Inspects architecture, stack, and tasks of a project | `!project balik-belongings` |
| `!project task <id> <text>` | Adds an active task to a project roadmap | `!project task zenbot Add unit tests` |
| `!standup` | Generates a daily focus plan based on active goals | `!standup` |
| `!remember <fact>` | Saves a personal preference or note to memory | `!remember I prefer TypeScript for frontend` |
| `!facts [search]` | Lists or searches stored knowledge | `!facts coding` |
| `!forget <text/id>` | Removes a remembered fact | `!forget TypeScript` |
| `!profile` | Displays your compiled personal developer profile | `!profile` |
| `!addgoal <goal>` | Appends an active goal to your profile | `!addgoal Ship ZenBot to GitHub portfolio` |
| `!provider <name>` | Switches active LLM provider (`groq` or `gemini`) | `!provider gemini` |
| `!model <name>` | Updates the active model on the current provider | `!model openai/gpt-oss-120b` |
| `!tokens [on\|off]` | Toggles in-chat token indicator metadata | `!tokens off` |
| `!clear` | Clears short-term conversation context for the channel | `!clear` |
| `!ping` | Tests Discord websocket round-trip latency | `!ping` |

---

## Project Structure

```
ZenBot/
├── src/
│   ├── bot.js                  # Discord bot client orchestrator
│   ├── config.js               # Environment validation and defaults
│   ├── services/
│   │   ├── llm/
│   │   │   ├── groq.js         # Groq API provider
│   │   │   ├── gemini.js       # Google Gemini REST provider
│   │   │   └── index.js        # LLMManager with automatic failover
│   │   └── memory/
│   │       ├── profile.js      # User profile store
│   │       ├── projectStore.js # Tracked projects registry
│   │       ├── factStore.js    # Categorized fact knowledge base
│   │       ├── episodic.js     # Episodic memory and search
│   │       └── index.js        # Unified MemoryManager facade
│   ├── handlers/
│   │   ├── commandHandler.js   # Command parsing and dispatching
│   │   └── messageHandler.js   # Chat completions and context assembly
│   └── utils/
│       ├── logger.js           # Formatted console logger
│       └── chunker.js          # Discord markdown message chunker
├── data/                       # Persistent JSON datastores
│   ├── projects.json           # Tracked engineering projects
│   ├── profile.json            # (Ignored) User profile context
│   ├── facts.json              # (Ignored) Learned personal facts
│   └── memories.json           # (Ignored) Past conversation history
├── .env.example                # Configuration template
├── .gitignore                  # Security-first ignore rules
├── index.js                    # Application entrypoint
├── package.json                # Project dependencies and scripts
└── README.md                   # Project documentation
```

---

## Security & Privacy

- **Zero Credential Exposure**: Discord tokens and AI API keys are read exclusively from environment variables and strictly gitignored.
- **Data Isolation**: Private chat logs (`memories.json`), personal facts (`facts.json`), and user profiles (`profile.json`) are excluded by `.gitignore` to ensure personal data is never pushed to public repositories.
- **Access Control**: ZenBot supports user ID and channel whitelisting via `DISCORD_ALLOWED_USER_IDS` and `CHANNEL_ID` to restrict usage on shared Discord servers.

---

## License

This project is licensed under the [MIT License](LICENSE).
