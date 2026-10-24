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
        logger.info(`LLMManager initialized. Active provider: ${this.currentProviderName}`);
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
     * Executes a chat completion with automatic failover.
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

        try {
            return await active.chat(messages, options);
        } catch (primaryError) {
            logger.warn(`Primary provider (${this.currentProviderName}) failed: ${primaryError.message}`);

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
     * Executes an agentic loop with tool/function calling support.
     * Iterates until the model generates a final response or maxSteps is reached.
     */
    async chatWithAgent(messages, { tools = null, geminiTools = null, executeTool = null, maxSteps = 5, ...options } = {}) {
        if (!tools || !executeTool) {
            return await this.chat(messages, options);
        }

        const workingMessages = [...messages];
        const executedTools = [];
        let currentStep = 0;
        let lastResponse = null;

        while (currentStep < maxSteps) {
            currentStep++;

            const currentOptions = {
                ...options,
                tools,
                geminiTools
            };

            const response = await this.chat(workingMessages, currentOptions);
            lastResponse = response;

            if (!response.toolCalls || response.toolCalls.length === 0) {
                // Assistant provided final text answer
                return {
                    ...response,
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
                logger.info(`[Agent Tool Call ${currentStep}] -> ${name}(${typeof rawArgs === 'string' ? rawArgs.slice(0, 100) : JSON.stringify(rawArgs).slice(0, 100)})`);

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

                workingMessages.push({
                    role: 'tool',
                    tool_call_id: call.id,
                    content: typeof result === 'string' ? result : JSON.stringify(result)
                });
            }
        }

        // If loop exceeded maxSteps, make one final call without tools to summarize
        try {
            const finalSummary = await this.chat(workingMessages, { ...options, tools: undefined, geminiTools: undefined });
            return {
                ...finalSummary,
                executedTools
            };
        } catch (e) {
            return {
                content: lastResponse?.content || 'Agent completed all actions.',
                executedTools,
                ...lastResponse
            };
        }
    }
}

module.exports = LLMManager;
