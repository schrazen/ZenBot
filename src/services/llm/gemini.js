const logger = require('../../utils/logger');

class GeminiProvider {
    constructor(config) {
        this.apiKey = config.apiKey;
        this.model = config.model || 'gemini-3.5-flash-lite';
        this.fallbackModel = config.fallbackModel || 'gemini-3.8-flash';
        this.maxTokens = config.maxTokens || 1500;
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
        const systemParts = [];
        const contents = [];

        for (const msg of messages) {
            if (msg.role === 'system') {
                if (msg.content) systemParts.push({ text: msg.content });
            } else if (msg.role === 'tool') {
                contents.push({
                    role: 'user',
                    parts: [{ text: `[Tool Output]: ${msg.content || '(empty)'}` }]
                });
            } else {
                let text = msg.content || '';
                if (!text && msg.tool_calls && msg.tool_calls.length > 0) {
                    text = msg.tool_calls.map(tc => `[Called tool ${tc.function?.name}(${tc.function?.arguments || ''})]`).join('\n');
                }
                if (text.trim()) {
                    contents.push({
                        role: msg.role === 'assistant' ? 'model' : 'user',
                        parts: [{ text }]
                    });
                }
            }
        }

        // Context-appropriate Discord formatting reinforcement for Gemini
        systemParts.push({
            text: (
                `[DISCORD OUTPUT FORMATTING]\n` +
                `- Never use Markdown tables (| Col | Col |) as Discord does not render them; use clean bullet lists instead.\n` +
                `- When the user asks to list files, show directory contents, or extract document/resume details, provide a complete, well-structured bulleted breakdown.\n` +
                `- For casual group-chat banter, keep replies concise (1 to 3 sentences).`
            )
        });

        const systemInstruction = systemParts.length > 0 ? { parts: systemParts } : null;

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

        if (options.geminiTools && Array.isArray(options.geminiTools)) {
            payload.tools = options.geminiTools;
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

                // If fallback also hit 429, pause 2s once and retry primary model
                if (res.status === 429 && !options._retried429) {
                    logger.warn(`Gemini fallback ${modelToUse} hit 429. Waiting 2s before single retry...`);
                    await new Promise(r => setTimeout(r, 2000));
                    return await this.chat(messages, { ...options, model: this.model, _retried429: true });
                }

                const errMessage = data?.error?.message || `HTTP ${res.status}: ${res.statusText}`;
                throw new Error(`Gemini API error: ${errMessage}`);
            }

            const candidate = data.candidates?.[0];
            const parts = candidate?.content?.parts || [];
            let textPart = '';
            const toolCalls = [];

            for (const part of parts) {
                if (part.text) {
                    textPart += part.text;
                }
                if (part.functionCall) {
                    toolCalls.push({
                        id: part.functionCall.id || `call_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
                        type: 'function',
                        function: {
                            name: part.functionCall.name,
                            arguments: JSON.stringify(part.functionCall.args || {})
                        }
                    });
                }
            }

            if (!textPart && toolCalls.length === 0) {
                if (candidate?.finishReason === 'SAFETY') {
                    throw new Error('Gemini response was blocked due to safety settings.');
                }
                throw new Error('Gemini returned an empty response.');
            }

            const rawFinish = candidate?.finishReason || 'STOP';
            const latencyMs = Date.now() - startTime;
            this.lastUsage = data.usageMetadata || null;

            return {
                content: textPart.trim(),
                toolCalls: toolCalls.length > 0 ? toolCalls : null,
                finishReason: (rawFinish === 'MAX_TOKENS' || rawFinish === 'length') ? 'length' : 'stop',
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
