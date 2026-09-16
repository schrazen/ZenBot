/**
 * Utility to split long responses into Discord-safe chunks (<= 1800 chars)
 * while preserving markdown formatting, codeblock syntax, and readability.
 */

function splitMessage(text, maxLength = 1800) {
    if (!text || text.length <= maxLength) {
        return [text];
    }

    const chunks = [];
    let currentChunk = '';
    let inCodeBlock = false;
    let codeBlockLang = '';

    const lines = text.split('\n');

    for (let i = 0; i < lines.length; i++) {
        let line = lines[i];

        // If a single line without newlines exceeds maxLength, hard-slice it
        if (line.length > maxLength) {
            while (line.length > maxLength) {
                const part = line.slice(0, maxLength);
                line = line.slice(maxLength);
                if (currentChunk.trim()) {
                    chunks.push(currentChunk.trim());
                    currentChunk = '';
                }
                chunks.push(part);
            }
        }

        // Detect codeblock boundary
        const codeBlockMatch = line.match(/^```(\w*)/);
        let toggledCodeBlock = false;
        if (codeBlockMatch) {
            toggledCodeBlock = true;
            if (!inCodeBlock) {
                inCodeBlock = true;
                codeBlockLang = codeBlockMatch[1] || '';
            } else {
                inCodeBlock = false;
                codeBlockLang = '';
            }
        }

        // Check if adding this line would exceed the Discord chunk limit
        const candidate = currentChunk ? currentChunk + '\n' + line : line;

        if (candidate.length > maxLength) {
            if (inCodeBlock && !toggledCodeBlock) {
                // Safely close the active code block before pushing
                currentChunk += '\n```';
                chunks.push(currentChunk.trim());
                // Reopen the code block at the start of the next chunk
                currentChunk = '```' + codeBlockLang + '\n' + line;
            } else {
                if (currentChunk.trim()) {
                    chunks.push(currentChunk.trim());
                }
                currentChunk = line;
            }
        } else {
            currentChunk = candidate;
        }
    }

    if (currentChunk && currentChunk.trim().length > 0) {
        // If an unclosed code block remains, close it
        if (inCodeBlock) {
            currentChunk += '\n```';
        }
        chunks.push(currentChunk.trim());
    }

    return chunks;
}

module.exports = { splitMessage };
