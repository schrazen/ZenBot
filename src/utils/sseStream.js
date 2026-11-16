/**
 * Reads an SSE (Server-Sent Events) `fetch()` Response body line by line and
 * invokes `onEvent(parsedJson)` for every valid JSON `data: ...` frame.
 */
async function readSseJsonStream(response, onEvent) {
    if (!response?.body || typeof response.body.getReader !== 'function') {
        throw new Error('Streaming response body is unavailable.');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || '';

        for (const rawLine of lines) {
            const line = rawLine.trim();
            if (!line || !line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            if (!payload || payload === '[DONE]') continue;
            try {
                const json = JSON.parse(payload);
                await onEvent(json);
            } catch (e) {
                // Skip partial/non-JSON heartbeat frames
            }
        }
    }

    if (buffer.trim().startsWith('data:')) {
        const payload = buffer.trim().slice(5).trim();
        if (payload && payload !== '[DONE]') {
            try {
                const json = JSON.parse(payload);
                await onEvent(json);
            } catch (e) {}
        }
    }
}

module.exports = {
    readSseJsonStream
};
