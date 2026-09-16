const logger = require('../../utils/logger');

class GeminiProvider {
    constructor(config) {
        this.apiKey = config.apiKey;
        this.model = config.model || 'gemini-3.1-flash-lite';
        this.fallbackModel = config.fallbackModel || 'gemini-2.5-flash';
        this.maxTokens = config.maxTokens || 2048;
        this.temperature = config.temperature ?? 0.7;
        this.name = 'gemini';
    }

    isConfigured() {
        return Boolean(this.apiKey && this.apiKey.trim().length > 10);
    }

    /**
     * Converts standard {role, content} array into Gemini API schema.
     */
    _formatMessages(messages) {
        let systemInstruction = null;
        const contents = [];

        for (const msg of messages) {
            if (msg.role === 'system') {
                systemInstruction = {
                    parts: [{ text: msg.content }]
                };
            } else {
                contents.push({
                    role: msg.role === 'assistant' ? 'model' : 'user',
                    parts: [{ text: msg.content }]
                });
            }
        }

        // If no user messages were present, ensure at least one
        if (contents.length === 0) {
            contents.push({
                role: 'user',
                parts: [{ text: 'Hello' }]
            });
        }

        return { systemInstruction, contents };
    }

    async chat(messages, options = {}) {
        if (!this.isConfigured()) {
            throw new Error('Gemini API key is not configured in environment variables.');
        }

        const modelToUse = options.model || this.model;
        const maxTokensToUse = options.maxTokens || this.maxTokens;
        const { systemInstruction, contents } = this._formatMessages(messages);

        const payload = {
            contents,
            generationConfig: {
                temperature: options.temperature ?? this.temperature,
                maxOutputTokens: maxTokensToUse
            }
        };

        if (systemInstruction) {
            payload.systemInstruction = systemInstruction;
        }

        const startTime = Date.now();
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelToUse}:generateContent?key=${this.apiKey}`;

        try {
            const res = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(payload)
            });

            const data = await res.json();

            if (!res.ok) {
                // If the primary model failed (e.g. 404 on newer preview or rate limit), try fallback
                if (modelToUse !== this.fallbackModel && (res.status === 404 || res.status === 429 || res.status === 400)) {
                    logger.warn(`Gemini model ${modelToUse} failed (${res.status}). Retrying with fallback ${this.fallbackModel}...`);
                    return await this.chat(messages, { ...options, model: this.fallbackModel });
                }

                const errMessage = data?.error?.message || `HTTP ${res.status}: ${res.statusText}`;
                throw new Error(`Gemini API error: ${errMessage}`);
            }

            const candidate = data.candidates?.[0];
            const textPart = candidate?.content?.parts?.[0]?.text;

            if (!textPart) {
                if (candidate?.finishReason === 'SAFETY') {
                    throw new Error('Gemini response was blocked due to safety settings.');
                }
                throw new Error('Gemini returned an empty response.');
            }

            const latencyMs = Date.now() - startTime;
            this.lastUsage = data.usageMetadata || null;

            return {
                content: textPart.trim(),
                provider: 'gemini',
                model: modelToUse,
                latencyMs,
                usage: data.usageMetadata || null
            };
        } catch (error) {
            logger.error(`Gemini completion error: ${error.message}`);
            throw error;
        }
    }
}

module.exports = GeminiProvider;
