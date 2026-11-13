const GroqProvider = require('./groq');
const GeminiProvider = require('./gemini');
const HermesProvider = require('./hermes');
const logger = require('../../utils/logger');

class LLMManager {
    constructor(config) {
        this.config = config;
        this.providers = new Map();

        // Initialize providers
        this.providers.set('groq', new GroqProvider(config.llm.groq));
        this.providers.set('gemini', new GeminiProvider(config.llm.gemini));
        this.providers.set('hermes', new HermesProvider(config.llm.hermes || {}));

        // Determine default provider
        let preferred = config.llm.defaultProvider;
        if (!this.providers.get(preferred)?.isConfigured()) {
            // Find first configured provider
            for (const [name, provider] of this.providers.entries()) {
                if (provider.isConfigured()) {
                    preferred = name;
                    break;
                }
            }
        }

        this.currentProviderName = preferred;
        this.providerCooldownUntil = new Map();
        logger.info(`LLMManager initialized. Active provider: ${this.currentProviderName}`);
    }

    /**
     * Rough token count estimator (chars / 3.8) including tool schemas.
     */
    estimateTokens(messages, options = {}) {
        let chars = 0;
        if (Array.isArray(messages)) {
            for (const m of messages) {
                if (typeof m.content === 'string') chars += m.content.length;
                if (m.tool_calls) chars += JSON.stringify(m.tool_calls).length;
            }
        }
        if (options.tools) {
            chars += JSON.stringify(options.tools).length;
        }
        return Math.ceil(chars / 3.8);
    }

    /**
     * Resolves the optimal free specialist model for a specific agentic sub-job.
     * Prevents rate-limit saturation by distributing load across providers.
     */
    getSpecialist(taskType) {
        switch (taskType) {
            case 'planning':
            case 'orchestration':
                // High intelligence, complex step breakdown
                return {
                    provider: this.providers.get('groq'),
                    model: 'openai/gpt-oss-120b',
                    temperature: 0.3
                };

            case 'subtask':
            case 'evaluation':
            case 'grading':
                // Fast execution, high RPM & daily quota (14.4k RPD / fast fallback)
                return {
                    provider: this.providers.get('groq'),
                    model: 'openai/gpt-oss-20b',
                    temperature: 0.2
                };

            case 'web_research':
            case 'synthesis':
                // Massive token window (1M TPM)
                return {
                    provider: this.providers.get('gemini'),
                    model: 'gemini-3.5-flash-lite',
                    temperature: 0.5
                };

            case 'offline':
            case 'local':
                return {
                    provider: this.providers.get('hermes'),
                    model: 'hermes3:8b',
                    temperature: 0.7
                };

            default:
                return {
                    provider: this.getCurrentProvider(),
                    model: this.getCurrentProvider()?.model,
                    temperature: 0.7
                };
        }
    }

    getProvider(name) {
        return this.providers.get(name?.toLowerCase());
    }

    getCurrentProvider() {
        return this.providers.get(this.currentProviderName);
    }

    setProvider(name) {
        const target = name?.toLowerCase();
        if (!this.providers.has(target)) {
            throw new Error(`Unknown provider "${name}". Supported providers: ${Array.from(this.providers.keys()).join(', ')}`);
        }

        const provider = this.providers.get(target);
        if (!provider.isConfigured()) {
            throw new Error(`Provider "${name}" is not configured. Please add its API key to zen.env.`);
        }

        this.currentProviderName = target;
        logger.info(`Switched active provider to: ${this.currentProviderName}`);
        return this.currentProviderName;
    }

    setModel(modelName) {
        const provider = this.getCurrentProvider();
        if (!provider) throw new Error('No active provider.');
        provider.model = modelName.trim();
        logger.info(`Updated model for ${this.currentProviderName} to: ${provider.model}`);
        return provider.model;
    }

    getStatus() {
        const result = {
            activeProvider: this.currentProviderName,
            providers: {}
        };

        for (const [name, provider] of this.providers.entries()) {
            result.providers[name] = {
                configured: provider.isConfigured(),
                currentModel: provider.model,
                fallbackModel: provider.fallbackModel
            };
        }

        return result;
    }

    /**
     * Detects whether an LLM response was cut off mid-thought or hit token limits.
     * Checks both API finishReason ('length' / 'MAX_TOKENS') and syntactic cutoff patterns.
     */
    isResponseIncomplete(content, finishReason) {
        if (finishReason === 'length' || finishReason === 'MAX_TOKENS') {
            return true;
        }
        if (!content || !content.trim()) {
            return false;
        }

        const trimmed = content.trim();

        // 1. Unclosed markdown code fence (odd number of ```)
        const fenceCount = (trimmed.match(/```/g) || []).length;
        if (fenceCount % 2 !== 0) {
            return true;
        }

        // 2. Unclosed inline backtick on the final line
        const lines = trimmed.split('\n');
        const lastLine = lines[lines.length - 1] || '';
        const inlineBackticks = (lastLine.replace(/```/g, '').match(/`/g) || []).length;
        if (inlineBackticks % 2 !== 0) {
            return true;
        }

        // 3. Ends with dangling punctuation or an empty list item marker
        if (/[:,;\-—\(\[]$/.test(trimmed) || /(?:^|\n)\s*(?:\d+\.|[-*•])\s*$/.test(trimmed)) {
            return true;
        }

        // 4. Ends with a dangling preposition, auxiliary verb, article, conjunction, or pronoun
        if (/\b(?:is|are|was|were|will|would|can|could|should|shall|may|might|must|have|has|had|the|a|an|to|for|of|in|on|at|by|with|from|against|into|onto|upon|between|among|through|during|before|after|above|below|under|over|and|or|but|nor|so|yet|because|although|though|since|unless|until|while|where|whether|that|which|who|whom|whose|this|these|those|my|your|his|her|its|our|their)$/i.test(trimmed)) {
            return true;
        }

        return false;
    }

    /**
     * Executes a chat completion with proactive token/cooldown routing and automatic failover.
     */
    async chat(messages, options = {}) {
        const primaryProvider = this.getCurrentProvider();
        if (!primaryProvider || !primaryProvider.isConfigured()) {
            // Check if any other provider is configured
            let fallbackName = null;
            for (const [name, p] of this.providers.entries()) {
                if (p.isConfigured()) {
                    fallbackName = name;
                    break;
                }
            }

            if (!fallbackName) {
                throw new Error('No AI provider is configured. Please provide GROQ_API_KEY or GEMINI_API_KEY in zen.env.');
            }

            this.currentProviderName = fallbackName;
        }

        const active = this.getCurrentProvider();
        const geminiProvider = this.providers.get('gemini');

        // Smart pre-routing: If primary is Groq and it's either in 429 cooldown OR request exceeds Groq's 8k TPM budget,
        // route directly to Gemini (1M TPM) without wasting latency/quota on doomed Groq calls.
        if (this.currentProviderName === 'groq' && geminiProvider?.isConfigured()) {
            const cooldownUntil = this.providerCooldownUntil.get('groq') || 0;
            const estTokens = this.estimateTokens(messages, options);
            if (Date.now() < cooldownUntil || estTokens > 6800) {
                return await geminiProvider.chat(messages, options);
            }
        }

        try {
            return await active.chat(messages, options);
        } catch (primaryError) {
            logger.warn(`Primary provider (${this.currentProviderName}) failed: ${primaryError.message}`);

            // Put Groq on a 35s cooldown whenever it hits 429 rate-limit / TPM saturation
            if (this.currentProviderName === 'groq' && /(?:429|rate limit|tokens per minute|request too large)/i.test(primaryError.message || '')) {
                this.providerCooldownUntil.set('groq', Date.now() + 35 * 1000);
            }

            // Find alternate configured provider for failover
            let failoverProvider = null;
            let failoverName = null;

            for (const [name, provider] of this.providers.entries()) {
                if (name !== this.currentProviderName && provider.isConfigured()) {
                    failoverProvider = provider;
                    failoverName = name;
                    break;
                }
            }

            if (failoverProvider) {
                logger.info(`Attempting automatic failover to ${failoverName}...`);
                try {
                    const result = await failoverProvider.chat(messages, options);
                    result.note = `(Failover from ${this.currentProviderName} to ${failoverName})`;
                    return result;
                } catch (failoverError) {
                    logger.error(`Failover to ${failoverName} also failed: ${failoverError.message}`);
                    throw new Error(`All providers failed. Primary: ${primaryError.message} | Secondary: ${failoverError.message}`);
                }
            }

            throw primaryError;
        }
    }

    /**
     * Extracts textual tool call patterns like `[Called tool read_file({"filePath":"..."})]`
     * in case a model emits tool syntax in plain text instead of native tool_calls.
     */
    extractTextualToolCalls(content) {
        if (!content || typeof content !== 'string') return { toolCalls: null, cleanContent: content || '' };
        const regex = /\[Called tool\s+([a-zA-Z0-9_]+)\s*\(([\s\S]*?)\)\]/g;
        const found = [];
        let match;
        while ((match = regex.exec(content)) !== null) {
            const name = match[1].trim();
            const rawJson = match[2].trim();
            try {
                // Validate JSON arguments
                JSON.parse(rawJson);
                found.push({
                    id: `call_txt_${Date.now()}_${found.length}`,
                    type: 'function',
                    function: {
                        name,
                        arguments: rawJson
                    }
                });
            } catch (e) {}
        }

        const cleanContent = content.replace(regex, '').trim();
        return {
            toolCalls: found.length > 0 ? found : null,
            cleanContent
        };
    }

    /**
     * Detects when the LLM promises an immediate action ("Let me check index.js...",
     * "Let me patch that file now...") without actually calling the tool yet.
     */
    isDeferredActionPromise(content, executedTools = []) {
        if (!content || typeof content !== 'string') return false;
        const text = content.trim();
        if (text.length > 600) return false; // Detailed explanations are usually complete answers

        // If the agent already staged an upgrade or performed the final action, do not force-continue
        const terminalTools = new Set([
            'propose_self_upgrade',
            'write_file',
            'edit_file',
            'post_discord_message',
            'set_owner_availability',
            'schedule_automation',
            'delete_automation',
            'set_reminder',
            'delete_reminder'
        ]);
        if (executedTools.some(t => terminalTools.has(t.name) || (t.result && t.result.status === 'pending_owner_approval'))) {
            return false;
        }

        // Check for explicit "I'm about to do X right now / one sec / let me check" patterns
        const promisePatterns = [
            /\b(?:let me|i(?:'ll| will)\s+now|allow me to)\s+(?:check|read|inspect|search|look\s+at|patch|fix|edit|write|update|wire|add|implement|run|test|pull|fetch|verify|scan)\b/i,
            /\b(?:one\s+sec(?:ond)?|give\s+me\s+a\s+sec(?:ond)?|hold\s+on)[,.\s—-]+(?:i(?:'ll| will)|let\s+me)\s+(?:check|read|inspect|search|patch|fix|pull|fetch|run)\b/i,
            /\blet\s+me\s+(?:run\s+the\s+fix|patch\s+the|double[- ]check\s+the|search\s+for)\b/i
        ];

        return promisePatterns.some(pat => pat.test(text));
    }

    /**
     * Executes an agentic loop with tool/function calling support.
     * Iterates until the model generates a final response or maxSteps is reached.
     */
    async chatWithAgent(messages, { tools = null, geminiTools = null, executeTool = null, maxSteps = 10, onProgress = null, ...options } = {}) {
        if (!tools || !executeTool) {
            return await this.chat(messages, options);
        }

        const workingMessages = [...messages];
        const executedTools = [];
        let currentStep = 0;
        let promiseContinuations = 0;
        const maxPromiseContinuations = 2;
        let lastResponse = null;

        while (currentStep < maxSteps) {
            currentStep++;

            const currentOptions = {
                ...options,
                tools,
                geminiTools
            };

            const response = await this.chat(workingMessages, currentOptions);

            // Check if the model emitted a textual `[Called tool ...]` instead of native toolCalls
            if ((!response.toolCalls || response.toolCalls.length === 0) && response.content) {
                const extracted = this.extractTextualToolCalls(response.content);
                if (extracted.toolCalls) {
                    response.toolCalls = extracted.toolCalls;
                    response.content = extracted.cleanContent;
                }
            }

            lastResponse = response;

            if (!response.toolCalls || response.toolCalls.length === 0) {
                // Check if the model made an unfulfilled deferred action promise ("Let me check index.js now...")
                if (
                    promiseContinuations < maxPromiseContinuations &&
                    currentStep < maxSteps &&
                    this.isDeferredActionPromise(response.content, executedTools)
                ) {
                    promiseContinuations++;
                    logger.info(`[Agent Auto-Step] Model promised action without calling a tool ("${response.content.slice(0, 80)}"). Continuing autonomously...`);

                    if (typeof onProgress === 'function') {
                        try {
                            await onProgress({
                                step: currentStep,
                                maxSteps,
                                phase: 'continuing',
                                statusText: response.content.slice(0, 120),
                                executedTools
                            });
                        } catch (e) {}
                    }

                    workingMessages.push({
                        role: 'assistant',
                        content: response.content
                    });
                    workingMessages.push({
                        role: 'user',
                        content: '[SYSTEM AUTONOMOUS CONTINUATION]: You just stated you would check, search, read, or fix something, but you did not call any tool. Do NOT wait for the user to reply "continue" or "okay"—invoke the appropriate tool right now and complete the task.'
                    });
                    continue;
                }

                // Clean any stray `[Called tool ...]` syntax before returning final answer
                const finalClean = this.extractTextualToolCalls(response.content || '').cleanContent;
                return {
                    ...response,
                    content: finalClean || response.content || '',
                    executedTools
                };
            }

            // Record assistant tool calls in working messages
            workingMessages.push({
                role: 'assistant',
                content: response.content || '',
                tool_calls: response.toolCalls
            });

            // Execute each requested tool call
            for (const call of response.toolCalls) {
                const name = call.function?.name;
                const rawArgs = call.function?.arguments;
                const argPreview = typeof rawArgs === 'string' ? rawArgs.slice(0, 100) : JSON.stringify(rawArgs).slice(0, 100);
                logger.info(`[Agent Tool Call ${currentStep}] -> ${name}(${argPreview})`);

                if (typeof onProgress === 'function') {
                    try {
                        await onProgress({
                            step: currentStep,
                            maxSteps,
                            phase: 'tool_start',
                            toolName: name,
                            toolArgs: rawArgs,
                            executedTools
                        });
                    } catch (e) {}
                }

                let result;
                try {
                    result = await executeTool(name, rawArgs);
                } catch (err) {
                    result = { error: err.message };
                }

                executedTools.push({
                    step: currentStep,
                    name,
                    args: rawArgs,
                    result
                });

                if (typeof onProgress === 'function') {
                    try {
                        await onProgress({
                            step: currentStep,
                            maxSteps,
                            phase: 'tool_done',
                            toolName: name,
                            toolArgs: rawArgs,
                            toolResult: result,
                            executedTools
                        });
                    } catch (e) {}
                }

                let serializedResult = typeof result === 'string' ? result : JSON.stringify(result);
                if (serializedResult.length > 6000) {
                    serializedResult = serializedResult.slice(0, 6000) + '\n...[truncated for context budget]';
                }

                workingMessages.push({
                    role: 'tool',
                    tool_call_id: call.id,
                    content: serializedResult
                });
            }
        }

        // If loop reached maxSteps, make one final call without tools and instruct model to summarize results
        try {
            workingMessages.push({
                role: 'system',
                content: '[SYSTEM]: Tool execution budget reached. Summarize what you found and accomplished clearly in plain text. NEVER output "[Called tool ...]" syntax.'
            });
            const finalSummary = await this.chat(workingMessages, { ...options, tools: undefined, geminiTools: undefined });
            const cleanSummary = this.extractTextualToolCalls(finalSummary.content || '').cleanContent;
            return {
                ...finalSummary,
                content: cleanSummary || finalSummary.content || this._buildFallbackToolSummary(executedTools),
                executedTools
            };
        } catch (e) {
            const fallbackText = (lastResponse?.content && lastResponse.content.trim())
                ? lastResponse.content.trim()
                : this._buildFallbackToolSummary(executedTools);
            return {
                ...lastResponse,
                content: fallbackText,
                executedTools
            };
        }
    }

    /**
     * Produces a safe non-empty summary from executed tool outputs if final LLM synthesis hits a rate limit.
     */
    _buildFallbackToolSummary(executedTools = []) {
        if (!Array.isArray(executedTools) || executedTools.length === 0) {
            return 'Completed processing, though the final response hit an API rate limit. Please try again in a moment.';
        }
        const lastWithResult = [...executedTools].reverse().find(t => t.result && !t.result.error);
        if (lastWithResult?.result) {
            const r = lastWithResult.result;
            if (typeof r.content === 'string' && r.content.trim()) {
                return `Here is the extracted output from \`${lastWithResult.name}\`:\n\n${r.content.slice(0, 1500)}`;
            }
            if (typeof r.stdout === 'string' && r.stdout.trim()) {
                return `Here is the command output:\n\n${r.stdout.slice(0, 1500)}`;
            }
            return `Completed \`${lastWithResult.name}\` (${JSON.stringify(r).slice(0, 500)}).`;
        }
        const lastErr = executedTools[executedTools.length - 1]?.result?.error;
        return lastErr
            ? `Unable to finish because tool execution encountered an error: ${lastErr}`
            : 'Reached the tool execution limit before completing a summary.';
    }
}

module.exports = LLMManager;
