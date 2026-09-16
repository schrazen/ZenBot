# 🧘 ZenBot — Personal AI Assistant

[![Node.js](https://img.shields.io/badge/Node.js-v18%2B-green?logo=node.js)](https://nodejs.org/)
[![Discord.js](https://img.shields.io/badge/Discord.js-v14-blue?logo=discord)](https://discord.js.org/)
[![Groq](https://img.shields.io/badge/LLM-Groq%20Cloud-orange)](https://groq.com/)
[![Google Gemini](https://img.shields.io/badge/LLM-Google%20Gemini-4285F4?logo=google)](https://aistudio.google.com/)
[![License](https://img.shields.io/badge/License-MIT-purple)](#license)

> An intelligent, cloud-powered Discord AI assistant built with Node.js. ZenBot features **multi-tiered persistent memory**, **multi-provider LLM orchestration** (Groq + Google Gemini with automatic failover), and contextual awareness tailored for personal productivity, software engineering, and daily life questions.

---

## 🌟 Key Highlights

- ⚡ **Multi-Provider LLM Orchestration**: Integrated with **Groq** (for ultra-fast sub-second token generation) and **Google Gemini** (for deep analytical reasoning). Includes automatic provider failover and instant on-the-fly switching (`!provider groq` / `!provider gemini`).
- 🧠 **Multi-Tiered Personal Memory System**:
  - **Tier 1 (Core Profile)**: Structured personal context (identity, goals, preferences, tech stack) always present in the system prompt.
  - **Tier 2 (Discrete Fact Store)**: Dynamic knowledge base updated conversationally or via `!remember <fact>` with category inference (`[Work]`, `[Preference]`, `[Goal]`, etc.).
  - **Tier 3 (Episodic Recall)**: Pure JavaScript hybrid relevance search across past interactions using token frequency, exact phrase matching, and recency decay.
- 💬 **Discord Native UX**: Real-time typing indicators, rich Discord Embeds, smart 2000-character message chunking that preserves codeblocks and formatting.
- 🛡️ **Channel & User Scoping**: Restrictable to your specific test channels and Discord user IDs for security and privacy.
- 🏗️ **Modular, Clean Architecture**: Fully refactored into decoupled service layers (`llm/`, `memory/`, `handlers/`, `utils/`) ready for production deployment or portfolio showcase.

---

## 🏛️ System Architecture

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
                     |  Manage / Query                                 |  Build Context
                     v                                                 v
  +---------------------------------------------------------------------------------------+
  |                                  MemoryManager                                        |
  |  +------------------------+  +------------------------+  +-------------------------+  |
  |  |  Tier 1: User Profile  |  |   Tier 2: Fact Store   |  | Tier 3: Episodic Recall |  |
  |  |  (data/profile.json)   |  |   (data/facts.json)    |  |   (data/memories.json)  |  |
  |  +------------------------+  +------------------------+  +-------------------------+  |
  +---------------------------------------------------------------------------------------+
                                              |
                                              | Assembled Prompt & Context
                                              v
  +---------------------------------------------------------------------------------------+
  |                                    LLMManager                                         |
  |               (Auto-Failover, Model Switching, Provider Orchestration)                |
  |                                                                                       |
  |         +---------------------------+       +----------------------------+            |
  |         |       Groq Provider       | <---> |      Gemini Provider       |            |
  |         | (e.g. gpt-oss-120b, Qwen) |       |  (e.g. gemini-2.5-flash)   |            |
  |         +---------------------------+       +----------------------------+            |
  +---------------------------------------------------------------------------------------+
                                              |
                                              v
                                  +-----------------------+
                                  | Discord Smart Chunker | (Splits <= 2000 chars)
                                  +-----------+-----------+
                                              |
                                              v
                                  +-----------------------+
                                  | Discord Reply to User |
                                  +-----------------------+
```

---

## 🚀 Quick Start

### 1. Prerequisites
- **Node.js**: v18.0.0 or higher
- **Discord Bot Token**: From the [Discord Developer Portal](https://discord.com/developers/applications)
- **API Keys**:
  - [Groq API Key](https://console.groq.com/keys) (Free, fast inference)
  - [Google AI Studio Gemini API Key](https://aistudio.google.com/app/apikey) (Free, long context)

### 2. Installation & Setup
Clone the repository and install dependencies:
```bash
git clone https://github.com/schrazen/zen.git
cd zen
npm install
```

### 3. Configure Environment Variables
Copy `.env.example` to `zen.env` (or `.env`):
```bash
cp .env.example zen.env
```
Fill in your credentials:
```env
DISCORD_TOKEN=your_discord_bot_token
CLIENT_ID=your_client_id
GUILD_ID=your_guild_id

# Optional: Channel Lock & Allowed User ID
CHANNEL_ID=
DISCORD_ALLOWED_USER_IDS=

# AI Settings
DEFAULT_PROVIDER=groq
GROQ_API_KEY=your_groq_api_key
GEMINI_API_KEY=your_gemini_api_key
```

### 4. Run the Bot
```bash
# Start in production mode
npm start

# Or start in live-reload development mode (Node 18+)
npm run dev
```

---

## 🎮 Commands Reference

| Command | Description | Example |
|---|---|---|
| `!help` | Displays the help menu | `!help` |
| `!status` | Checks active provider, model, latency & memory stats | `!status` |
| `!limits` | Shows real-time token breakdown and remaining rate limits | `!limits` |
| `!projects` | Lists all your tracked engineering and portfolio projects | `!projects` |
| `!project <id>` | Deep dive into architecture, stack, and tasks of a project | `!project balik-belongings` |
| `!project task <id> <text>` | Adds an active task to a project | `!project task zenbot Add unit tests` |
| `!standup` | Daily focus check-in based on goals and active tasks | `!standup` |
| `!remember <fact>` | Saves a discrete personal note or fact to memory | `!remember I prefer TypeScript for frontend` |
| `!facts [search]` | Lists or searches stored facts | `!facts coding` |
| `!forget <text/id>` | Removes a remembered fact | `!forget TypeScript` |
| `!profile` | Displays the user's compiled personal profile | `!profile` |
| `!addgoal <goal>` | Adds an active goal to your profile | `!addgoal Launch ZenBot portfolio project` |
| `!provider <name>` | Switches active LLM provider (`groq` or `gemini`) | `!provider gemini` |
| `!model <name>` | Updates the active model on the current provider | `!model openai/gpt-oss-120b` |
| `!clear` | Clears short-term conversation context for the channel | `!clear` |
| `!ping` | Tests Discord websocket round-trip latency | `!ping` |

---

## 📁 Project Structure

```
zen/
├── src/
│   ├── bot.js                  # Discord bot client orchestrator
│   ├── config.js               # Environment variables validation & defaults
│   ├── services/
│   │   ├── llm/
│   │   │   ├── groq.js         # Groq API integration (OpenAI-compatible)
│   │   │   ├── gemini.js       # Google Gemini REST integration
│   │   │   └── index.js        # LLMManager with automatic failover
│   │   └── memory/
│   │       ├── profile.js      # Tier 1: User Profile store
│   │       ├── factStore.js    # Tier 2: Categorized Fact knowledge base
│   │       ├── episodic.js     # Tier 3: Hybrid search episodic memories
│   │       └── index.js        # Unified MemoryManager
│   ├── handlers/
│   │   ├── commandHandler.js   # Discord command dispatcher
│   │   └── messageHandler.js   # Chat completions & context assembly
│   └── utils/
│       ├── logger.js           # Formatted console logger
│       └── chunker.js          # Discord markdown message chunker
├── data/                       # Local persistent JSON datastores
│   ├── profile.json            # User profile data
│   ├── facts.json              # Learned knowledge
│   └── memories.json           # Past conversation turns
├── .env.example                # Example environment configuration
├── .gitignore                  # Security-first ignore list
├── index.js                    # Application entrypoint
├── package.json                # Project dependencies & scripts
└── README.md                   # Project documentation
```

---

## 🔒 Security & Privacy
- **No Token Leaks**: API tokens and Discord credentials are read exclusively from environment variables and strictly gitignored.
- **Data Isolation**: Real chat logs and user memory stores in `data/` are excluded by `.gitignore`, ensuring personal information is never pushed to public repositories.
- **User Authorization**: ZenBot supports strict user ID and channel whitelisting (`DISCORD_ALLOWED_USER_IDS` and `CHANNEL_ID`) to prevent unauthorized usage in public Discord servers.

---

## 📄 License
This project is licensed under the [MIT License](LICENSE).
