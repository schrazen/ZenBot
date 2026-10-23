const fs = require('fs');
const path = require('path');
const { EmbedBuilder } = require('discord.js');
const logger = require('../utils/logger');
const { getGroqTools, executeTool } = require('./llm/toolDefinitions');

class GoalService {
    constructor({ config, llmManager, workspaceService, webSearchService, reminderService, memoryManager, client }) {
        this.config = config;
        this.llmManager = llmManager;
        this.workspaceService = workspaceService;
        this.webSearchService = webSearchService;
        this.reminderService = reminderService;
        this.memoryManager = memoryManager;
        this.client = client;

        this.storagePath = config.paths?.goals || path.join(__dirname, '../../data/goals.json');
        this.activeGoal = null;
        this.isProcessing = false;
        this.goalsHistory = [];

        this.load();
    }

    load() {
        try {
            if (fs.existsSync(this.storagePath)) {
                const data = JSON.parse(fs.readFileSync(this.storagePath, 'utf8'));
                this.goalsHistory = Array.isArray(data) ? data : [];
            }
        } catch (e) {
            this.goalsHistory = [];
        }
    }

    save() {
        try {
            const dir = path.dirname(this.storagePath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(this.storagePath, JSON.stringify(this.goalsHistory, null, 2), 'utf8');
        } catch (e) {
            logger.error(`Failed to save goals history: ${e.message}`);
        }
    }

    hasActiveGoal() {
        return Boolean(this.activeGoal && !['completed', 'failed', 'cancelled'].includes(this.activeGoal.status));
    }

    getActiveGoal() {
        return this.activeGoal;
    }

    /**
     * Creates and starts a new autonomous goal.
     */
    async startGoal({ prompt, userId, channelId, discordMessage }) {
        if (this.hasActiveGoal()) {
            throw new Error(`Another goal is currently active: "${this.activeGoal.prompt}" (Status: ${this.activeGoal.status}). Type "!goal stop" or "!goal cancel" first.`);
        }

        const goalId = `goal_${Date.now()}`;
        this.activeGoal = {
            id: goalId,
            prompt: prompt.trim(),
            userId,
            channelId,
            status: 'planning',
            plan: [],
            currentStepIndex: 0,
            startTime: Date.now(),
            progressMessage: null,
            logs: []
        };

        // Post initial status embed to Discord
        if (discordMessage) {
            try {
                const embed = this._renderProgressEmbed(this.activeGoal);
                this.activeGoal.progressMessage = await discordMessage.reply({ embeds: [embed] });
            } catch (e) {
                logger.warn(`Could not post progress embed: ${e.message}`);
            }
        }

        logger.info(`Goal [${goalId}] started: "${prompt}"`);

        // Run planning and execution asynchronously
        setImmediate(async () => {
            try {
                await this._planAndExecute();
            } catch (err) {
                logger.error(`Goal execution failed: ${err.message}`);
                if (this.activeGoal) {
                    this.activeGoal.status = 'failed';
                    this.activeGoal.error = err.message;
                    await this._syncProgressMessage();
                }
            }
        });

        return this.activeGoal;
    }

    /**
     * Pauses the active goal.
     */
    async pauseGoal() {
        if (!this.hasActiveGoal()) return { success: false, message: 'No active goal is currently running.' };
        this.activeGoal.status = 'paused';
        await this._syncProgressMessage();
        return { success: true, message: `Goal "${this.activeGoal.prompt}" has been paused.` };
    }

    /**
     * Resumes the active paused goal.
     */
    async resumeGoal() {
        if (!this.activeGoal || this.activeGoal.status !== 'paused') {
            return { success: false, message: 'No paused goal to resume.' };
        }
        this.activeGoal.status = 'executing';
        await this._syncProgressMessage();
        setImmediate(() => this._executeRemainingSteps());
        return { success: true, message: `Resumed goal: "${this.activeGoal.prompt}".` };
    }

    /**
     * Cancels the active goal.
     */
    async cancelGoal() {
        if (!this.hasActiveGoal()) return { success: false, message: 'No active goal is currently running.' };
        this.activeGoal.status = 'cancelled';
        await this._syncProgressMessage();
        const cancelled = this.activeGoal;
        this.goalsHistory.unshift(cancelled);
        if (this.goalsHistory.length > 30) this.goalsHistory.pop();
        this.save();
        this.activeGoal = null;
        return { success: true, message: `Cancelled goal: "${cancelled.prompt}".` };
    }

    /**
     * Decomposes the goal into actionable steps with the planner model.
     */
    async _planAndExecute() {
        const goal = this.activeGoal;
        if (!goal) return;

        // 1. Gather context: Workspace structure, lance preferences, remembered facts
        const preferences = this.memoryManager?.preferences?.toPromptContext() || '';
        const facts = this.memoryManager?.facts?.toPromptContext(goal.prompt) || '';
        const specialist = this.llmManager.getSpecialist('planning');

        const systemPrompt = (
            `You are ZenBot's Autonomous Goal Planner.\n` +
            `Your task is to break down a high-level job from Lance into 3 to 6 logical, executable milestones.\n\n` +
            `AVAILABLE TOOLS:\n` +
            `- web_search: search DuckDuckGo for live info, docs, syntax, or libraries\n` +
            `- fetch_web_page: fetch readable content from a URL\n` +
            `- read_file: inspect code, configurations, or logs\n` +
            `- write_file: create or overwrite code files\n` +
            `- edit_file: surgical search-and-replace edit in existing code\n` +
            `- search_files: search string or symbols across project files\n` +
            `- run_command: execute safe terminal commands (e.g. node, npm test, git)\n\n` +
            (preferences ? `${preferences}\n\n` : '') +
            (facts ? `${facts}\n\n` : '') +
            `OUTPUT FORMAT REQUIREMENTS:\n` +
            `Return ONLY a valid JSON array of step objects with this structure (no markdown fences, no extra text):\n` +
            `[\n` +
            `  { "stepNumber": 1, "title": "Brief title of step", "tool": "tool_name", "instruction": "Clear direction on what to do" }\n` +
            `]`
        );

        const plannerMessages = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: `Create a step-by-step plan to achieve this goal: "${goal.prompt}"` }
        ];

        let planData = [];
        try {
            const planResponse = await specialist.provider.chat(plannerMessages, {
                model: specialist.model,
                temperature: 0.2
            });

            const rawText = planResponse.content.trim();
            const cleanJson = rawText.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
            const parsed = JSON.parse(cleanJson);
            if (Array.isArray(parsed) && parsed.length > 0) {
                planData = parsed.map((s, idx) => ({
                    stepNumber: idx + 1,
                    title: s.title || `Step ${idx + 1}`,
                    tool: s.tool || 'workspace',
                    instruction: s.instruction || s.title,
                    status: 'pending',
                    retries: 0,
                    output: null
                }));
            }
        } catch (planErr) {
            logger.warn(`Structured JSON planning failed, using fallback plan: ${planErr.message}`);
            planData = [
                { stepNumber: 1, title: 'Analyze goal & inspect workspace', tool: 'read_file', instruction: goal.prompt, status: 'pending', retries: 0 },
                { stepNumber: 2, title: 'Execute required modifications / research', tool: 'workspace', instruction: goal.prompt, status: 'pending', retries: 0 },
                { stepNumber: 3, title: 'Verify and run tests', tool: 'run_command', instruction: 'Verify all changes', status: 'pending', retries: 0 }
            ];
        }

        goal.plan = planData;
        goal.status = 'executing';
        await this._syncProgressMessage();

        await this._executeRemainingSteps();
    }

    /**
     * Executes the planned steps sequentially.
     */
    async _executeRemainingSteps() {
        const goal = this.activeGoal;
        if (!goal || goal.status !== 'executing') return;

        const groqTools = getGroqTools();

        while (goal.currentStepIndex < goal.plan.length && goal.status === 'executing') {
            const step = goal.plan[goal.currentStepIndex];
            step.status = 'in_progress';
            await this._syncProgressMessage();

            logger.info(`Goal [${goal.id}] executing step ${step.stepNumber}/${goal.plan.length}: "${step.title}"`);

            // Execute step with agentic tools loop
            const stepMessages = [
                {
                    role: 'system',
                    content: (
                        `You are ZenBot executing Step ${step.stepNumber} of an autonomous goal for Lance.\n` +
                        `Goal: "${goal.prompt}"\n` +
                        `Step Objective: "${step.title}" - ${step.instruction}\n\n` +
                        `Adhere strictly to Lance's rules and coding preferences. Use your tools to perform the action.`
                    )
                },
                {
                    role: 'user',
                    content: `Execute this step now: ${step.title}. If creating or modifying code, ensure you test or verify it.`
                }
            ];

            try {
                const result = await this.llmManager.chatWithAgent(stepMessages, {
                    tools: groqTools,
                    executeTool: (name, args) => executeTool(name, args, {
                        workspaceService: this.workspaceService,
                        webSearchService: this.webSearchService,
                        reminderService: this.reminderService,
                        userId: goal.userId,
                        channelId: goal.channelId
                    }),
                    maxSteps: 4
                });

                step.status = 'completed';
                step.output = result.content ? result.content.slice(0, 300) : 'Done';
                goal.logs.push(`Step ${step.stepNumber} [${step.title}]: Completed successfully.`);
                goal.currentStepIndex++;
            } catch (stepErr) {
                logger.error(`Step ${step.stepNumber} encountered error: ${stepErr.message}`);
                step.retries = (step.retries || 0) + 1;

                if (step.retries <= 2) {
                    logger.info(`Retrying step ${step.stepNumber} (attempt ${step.retries}/2)...`);
                    step.status = 'in_progress';
                    continue;
                } else {
                    step.status = 'failed';
                    step.output = `Error: ${stepErr.message}`;
                    goal.status = 'failed';
                    goal.error = `Step ${step.stepNumber} failed after retries: ${stepErr.message}`;
                    break;
                }
            }

            await this._syncProgressMessage();
        }

        if (goal.status === 'executing' && goal.currentStepIndex >= goal.plan.length) {
            goal.status = 'completed';
            goal.completedAt = Date.now();
            await this._syncProgressMessage();

            // Archive to history
            this.goalsHistory.unshift(goal);
            if (this.goalsHistory.length > 30) this.goalsHistory.pop();
            this.save();

            // Send notification ping to Lance
            if (goal.channelId && this.client) {
                try {
                    const channel = await this.client.channels.fetch(goal.channelId);
                    if (channel && channel.isTextBased()) {
                        await channel.send(`🎉 <@${goal.userId}> **Goal Accomplished!**\n> "${goal.prompt}"\nAll **${goal.plan.length}** steps executed and verified.`);
                    }
                } catch (e) {}
            }
        }
    }

    /**
     * Renders a live Discord Embed representing current progress.
     */
    _renderProgressEmbed(goal) {
        let statusIcon = '⏳';
        let statusColor = 0x00b4d8;

        if (goal.status === 'planning') {
            statusIcon = '📋';
            statusColor = 0xffb703;
        } else if (goal.status === 'executing') {
            statusIcon = '🚀';
            statusColor = 0x2ec4b6;
        } else if (goal.status === 'completed') {
            statusIcon = '✅';
            statusColor = 0x57cc99;
        } else if (goal.status === 'failed') {
            statusIcon = '❌';
            statusColor = 0xe63946;
        } else if (goal.status === 'paused') {
            statusIcon = '⏸️';
            statusColor = 0xf4a261;
        }

        const embed = new EmbedBuilder()
            .setTitle(`${statusIcon} Autonomous Goal: ${goal.prompt.slice(0, 100)}`)
            .setColor(statusColor)
            .setTimestamp();

        if (goal.plan.length === 0) {
            embed.setDescription('*Decomposing job into milestones and analyzing workspace...*');
        } else {
            let checklist = goal.plan.map(step => {
                let mark = '⬜';
                if (step.status === 'completed') mark = '✅';
                else if (step.status === 'in_progress') mark = '🔄 **[ACTIVE]**';
                else if (step.status === 'failed') mark = '❌';

                return `${mark} **Step ${step.stepNumber}:** ${step.title}`;
            }).join('\n');

            if (goal.status === 'completed') {
                checklist += `\n\n**All milestones achieved!** Use \`!goal status\` to review logs.`;
            } else if (goal.error) {
                checklist += `\n\n⚠️ **Stopped:** ${goal.error}`;
            }

            embed.setDescription(checklist);
        }

        const elapsed = Math.round((Date.now() - goal.startTime) / 1000);
        embed.setFooter({ text: `Status: ${goal.status.toUpperCase()} • Elapsed: ${elapsed}s • Tools: Web, Files, Shell` });

        return embed;
    }

    /**
     * Edits the existing Discord status message to reflect real-time progress.
     */
    async _syncProgressMessage() {
        if (!this.activeGoal || !this.activeGoal.progressMessage) return;
        try {
            const embed = this._renderProgressEmbed(this.activeGoal);
            await this.activeGoal.progressMessage.edit({ embeds: [embed] });
        } catch (e) {
            // Ignore edit errors (e.g. rate limit or message deleted)
        }
    }
}

module.exports = GoalService;

