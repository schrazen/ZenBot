const GroqProvider = require('./groq');
const GeminiProvider = require('./gemini');
const logger = require('../../utils/logger');

class LLMManager {
    constructor(config) {
        this.config = config;
        this.providers = new Map();

        // Initialize providers
        this.providers.set('groq', new GroqProvider(config.llm.groq));
        this.providers.set('gemini', new GeminiProvider(config.llm.gemini));

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
