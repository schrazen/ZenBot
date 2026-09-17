/**
 * Converts Markdown tables into Discord-friendly formatted bullet cards.
 * Discord does not render markdown tables, resulting in broken/garbled text.
 */
function convertTablesToDiscord(text) {
    if (!text || !text.includes('|')) return text;

    const lines = text.split('\n');
    const result = [];
    let i = 0;

    while (i < lines.length) {
        const line = lines[i];
        const trimmed = line.trim();

        // Check if this line looks like a table header: starts and ends with |
        if (trimmed.startsWith('|') && trimmed.endsWith('|') && i + 1 < lines.length) {
            const nextLine = lines[i + 1].trim();
            // Check if next line is separator line (e.g. |---|---| or |:---|:---:|)
            const isSeparator = /^\|?[\s\-:|]+\|?$/.test(nextLine) && nextLine.includes('-');

            if (isSeparator) {
                // Parse headers from the first row
                const rawHeaders = trimmed.split('|').map(s => s.trim()).filter(Boolean);
                i += 2; // skip header and separator

                const tableCards = [];
                while (i < lines.length && lines[i].trim().startsWith('|') && lines[i].trim().endsWith('|')) {
                    const rowLine = lines[i].trim();
                    const cells = rowLine.split('|').map(s => s.trim()).filter(Boolean);
                    if (cells.length > 0) {
                        const title = cells[0];
                        const subItems = [];
                        for (let c = 1; c < cells.length; c++) {
                            const headerLabel = rawHeaders[c] ? `_${rawHeaders[c]}_: ` : '';
                            subItems.push(`  - ${headerLabel}${cells[c]}`);
                        }
                        if (subItems.length > 0) {
                            tableCards.push(`• **${title}**\n${subItems.join('\n')}`);
                        } else {
                            tableCards.push(`• **${title}**`);
                        }
                    }
                    i++;
                }

                if (tableCards.length > 0) {
                    result.push(tableCards.join('\n\n'));
                }
                continue;
            }
        }

        result.push(line);
        i++;
    }

    return result.join('\n');
}

/**
 * Utility to split long responses into Discord-safe chunks (<= 1800 chars)
 * while preserving markdown formatting, codeblock syntax, and readability.
 */
function splitMessage(text, maxLength = 1800) {
    if (!text) return [];

    // Automatically convert broken markdown tables into clean Discord bullet cards
    text = convertTablesToDiscord(text);

    if (text.length <= maxLength) {
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
