const logger = require('../../utils/logger');

class GroqProvider {
    constructor(config) {
        this.apiKey = config.apiKey;
        this.model = config.model || 'openai/gpt-oss-120b';
        this.fallbackModel = config.fallbackModel || 'openai/gpt-oss-20b';
        this.maxTokens = config.maxTokens || 1500;
        this.temperature = config.temperature ?? 0.7;
        this.name = 'groq';
    }

    isConfigured() {
        return Boolean(this.apiKey && this.apiKey.trim().length > 10);
    }

    async chat(messages, options = {}) {
        if (!this.isConfigured()) {
            throw new Error('Groq API key is not configured in environment variables.');
        }

        const modelToUse = options.model || this.model;
        const maxTokensToUse = options.maxTokens || this.maxTokens;

        const payload = {
            model: modelToUse,
            messages,
            max_tokens: maxTokensToUse,
            temperature: options.temperature ?? this.temperature
        };

        const startTime = Date.now();

        try {
            const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.apiKey}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(payload)
            });

            const data = await res.json();

            if (!res.ok) {
                // If the primary model failed due to token limits or 404, try the fallback model once
                if (modelToUse !== this.fallbackModel && (res.status === 400 || res.status === 404 || res.status === 429)) {
                    logger.warn(`Groq model ${modelToUse} failed (${res.status}). Retrying with fallback ${this.fallbackModel}...`);
                    return await this.chat(messages, { ...options, model: this.fallbackModel });
                }

                const errMessage = data?.error?.message || `HTTP ${res.status}: ${res.statusText}`;
                throw new Error(`Groq API error: ${errMessage}`);
            }

            const reply = data.choices?.[0]?.message?.content;
            if (!reply) {
                throw new Error('Groq returned empty response content.');
            }

            const latencyMs = Date.now() - startTime;
            const rateLimits = {
                limitRequests: res.headers.get('x-ratelimit-limit-requests'),
                remainingRequests: res.headers.get('x-ratelimit-remaining-requests'),
                limitTokens: res.headers.get('x-ratelimit-limit-tokens'),
                remainingTokens: res.headers.get('x-ratelimit-remaining-tokens'),
                resetTokens: res.headers.get('x-ratelimit-reset-tokens')
            };

            this.lastUsage = data.usage || null;
            this.lastRateLimits = rateLimits;

            return {
                content: reply.trim(),
                provider: 'groq',
                model: modelToUse,
                latencyMs,
                usage: data.usage || null,
                rateLimits
            };
        } catch (error) {
            logger.error(`Groq completion error: ${error.message}`);
            throw error;
        }
    }
}

module.exports = GroqProvider;
