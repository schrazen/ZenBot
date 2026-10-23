const logger = require('../../utils/logger');

class HermesProvider {
    constructor(config = {}) {
        this.baseUrl = (config.url || process.env.HERMES_URL || process.env.LOCAL_LLM_URL || 'http://localhost:11434/v1')
            .replace(/\/+$/, '');
        
        // Ensure /v1 is present for OpenAI compatibility if not specified
        if (!this.baseUrl.endsWith('/v1') && !this.baseUrl.includes('/v1/')) {
            this.baseUrl += '/v1';
        }

        this.model = config.model || process.env.HERMES_MODEL || 'hermes3:8b';
        this.fallbackModel = config.fallbackModel || 'hermes3:latest';
        this.apiKey = config.apiKey || process.env.HERMES_API_KEY || 'ollama';
        this.maxTokens = config.maxTokens || 1500;
        this.temperature = config.temperature ?? 0.7;
        this.name = 'hermes';
    }

    isConfigured() {
        return Boolean(this.baseUrl && this.baseUrl.startsWith('http'));
    }

    /**
     * Checks if the local/remote Hermes instance is running and reachable.
     */
    async checkHealth() {
        try {
            const res = await fetch(`${this.baseUrl}/models`, {
                headers: { 'Authorization': `Bearer ${this.apiKey}` },
                signal: AbortSignal.timeout(2500)
            });
            if (res.ok) {
                const data = await res.json();
                const models = (data.data || []).map(m => m.id);
                return {
                    online: true,
                    endpoint: this.baseUrl,
                    availableModels: models,
                    hasActiveModel: models.some(m => m.toLowerCase().includes('hermes'))
                };
            }
            return { online: false, endpoint: this.baseUrl, error: `HTTP ${res.status}` };
        } catch (e) {
            return { online: false, endpoint: this.baseUrl, error: e.message };
        }
    }

    async chat(messages, options = {}) {
        if (!this.isConfigured()) {
            throw new Error('Hermes endpoint is not configured. Set HERMES_URL in zen.env.');
        }

        const modelToUse = options.model || this.model;
        const maxTokensToUse = options.maxTokens || this.maxTokens;

        const payload = {
            model: modelToUse,
            messages,
            max_tokens: maxTokensToUse,
            temperature: options.temperature ?? this.temperature
        };

        if (options.tools && Array.isArray(options.tools)) {
            payload.tools = options.tools;
            payload.tool_choice = options.tool_choice || 'auto';
        }

        const startTime = Date.now();
        const endpoint = `${this.baseUrl}/chat/completions`;

        try {
            const res = await fetch(endpoint, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.apiKey}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(payload),
                signal: AbortSignal.timeout(60000)
            });

            const data = await res.json();

            if (!res.ok) {
                const errMessage = data?.error?.message || `HTTP ${res.status}: ${res.statusText}`;
                throw new Error(`Hermes API error (${endpoint}): ${errMessage}`);
            }

            const rawMsg = data.choices?.[0]?.message;
            const reply = rawMsg?.content;
            const toolCalls = rawMsg?.tool_calls || null;

            if (!reply && (!toolCalls || toolCalls.length === 0)) {
                throw new Error('Hermes returned an empty response.');
            }

            const latencyMs = Date.now() - startTime;

            return {
                content: (reply || '').trim(),
                toolCalls,
                rawMessage: rawMsg,
                provider: 'hermes',
                model: modelToUse,
                latencyMs,
                usage: data.usage || null
            };
        } catch (error) {
            logger.error(`Hermes completion error: ${error.message}`);
            // Check if user simply hasn't started Ollama
            if (error.message.includes('ECONNREFUSED') || error.message.includes('fetch failed')) {
                throw new Error(`Cannot connect to Hermes at ${this.baseUrl}. Is Ollama or your Hermes server running? (Run: "ollama run hermes3:8b")`);
            }
            throw error;
        }
    }
}

module.exports = HermesProvider;

