const { readSseJsonStream } = require('../../utils/sseStream');
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

        // Keep internal reasoning compact on gpt-oss models so it never starves visible output tokens
        if (modelToUse.includes('gpt-oss')) {
            payload.reasoning_effort = options.reasoningEffort || 'low';
        }

        const useStream = Boolean(typeof options.onDelta === 'function' && (!options.tools || options.tools.length === 0));
        if (options.tools && Array.isArray(options.tools)) {
            payload.tools = options.tools;
            payload.tool_choice = options.tool_choice || 'auto';
        } else if (useStream) {
            payload.stream = true;
            payload.stream_options = { include_usage: true };
        }

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

            if (!res.ok) {
                let data = {};
                try { data = await res.json(); } catch (e) {}
                const errMessage = data?.error?.message || `HTTP ${res.status}: ${res.statusText}`;

                // Do NOT retry fallbackModel on 429 (same org 8,000 TPM pool) or malformed <|channel|> tool syntax;
                // let LLMManager immediately fail over to Gemini and start Groq's cooldown.
                const isChannelTokenErr = /<\|channel\|>/i.test(errMessage);
                const shouldRetryFallback = (
                    modelToUse !== this.fallbackModel &&
                    this.fallbackModel &&
                    !isChannelTokenErr &&
                    (res.status === 404 || res.status === 503)
                );

                if (shouldRetryFallback) {
                    logger.warn(`Groq model ${modelToUse} failed (${res.status}). Retrying with fallback ${this.fallbackModel}...`);
                    return await this.chat(messages, { ...options, model: this.fallbackModel });
                }

                throw new Error(`Groq API error: ${errMessage}`);
            }

            const rateLimits = {
                limitRequests: res.headers.get('x-ratelimit-limit-requests'),
                remainingRequests: res.headers.get('x-ratelimit-remaining-requests'),
                limitTokens: res.headers.get('x-ratelimit-limit-tokens'),
                remainingTokens: res.headers.get('x-ratelimit-remaining-tokens'),
                resetTokens: res.headers.get('x-ratelimit-reset-tokens')
            };

            if (useStream) {
                let reply = '';
                let finishReason = 'stop';
                let usage = null;
                await readSseJsonStream(res, async (chunk) => {
                    const ch = chunk.choices?.[0];
                    const deltaText = ch?.delta?.content || '';
                    if (deltaText) {
                        reply += deltaText;
                        try { await options.onDelta(reply); } catch (e) {}
                    }
                    if (ch?.finish_reason) finishReason = ch.finish_reason;
                    if (chunk.usage) usage = chunk.usage;
                });

                if (!reply.trim()) {
                    throw new Error('Groq returned empty response content.');
                }

                const latencyMs = Date.now() - startTime;
                this.lastUsage = usage;
                this.lastRateLimits = rateLimits;
                return {
                    content: reply.trim(),
                    toolCalls: null,
                    finishReason: finishReason === 'length' ? 'length' : 'stop',
                    rawMessage: { role: 'assistant', content: reply.trim() },
                    provider: 'groq',
                    model: modelToUse,
                    latencyMs,
                    usage,
                    rateLimits
                };
            }

            const data = await res.json();
            const choice = data.choices?.[0];
            const rawMsg = choice?.message;
            const finishReason = choice?.finish_reason || 'stop';
            const reply = rawMsg?.content;
            const toolCalls = Array.isArray(rawMsg?.tool_calls)
                ? rawMsg.tool_calls.map(tc => ({
                    ...tc,
                    function: tc.function
                        ? { ...tc.function, name: String(tc.function.name || '').replace(/<\|.*$/g, '').trim() }
                        : tc.function
                }))
                : null;

            if (!reply && (!toolCalls || toolCalls.length === 0)) {
                if (finishReason === 'length' && !options._retriedEmpty) {
                    logger.warn(`Groq model ${modelToUse} exhausted max_tokens (${maxTokensToUse}) during reasoning. Retrying with expanded token budget...`);
                    return await this.chat(messages, {
                        ...options,
                        maxTokens: Math.min(maxTokensToUse * 2, 2048),
                        reasoningEffort: 'low',
                        _retriedEmpty: true
                    });
                }
                throw new Error('Groq returned empty response content.');
            }

            const latencyMs = Date.now() - startTime;
            this.lastUsage = data.usage || null;
            this.lastRateLimits = rateLimits;

            return {
                content: (reply || '').trim(),
                toolCalls,
                finishReason: finishReason === 'length' ? 'length' : 'stop',
                rawMessage: rawMsg,
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
