const logger = require('../utils/logger');

class WebSearchService {
    constructor() {
        this.userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
    }

    /**
     * Performs a web search using DuckDuckGo HTML endpoint without needing an API key.
     */
    async search(query, maxResults = 5) {
        if (!query || !query.trim()) {
            throw new Error('Search query cannot be empty.');
        }

        const cleanQuery = query.trim();
        logger.info(`WebSearch: searching for "${cleanQuery}"`);

        try {
            const url = 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(cleanQuery);
            const res = await fetch(url, {
                headers: {
                    'User-Agent': this.userAgent,
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.9'
                },
                signal: AbortSignal.timeout(10000)
            });

            if (!res.ok) {
                throw new Error(`DuckDuckGo returned HTTP ${res.status}: ${res.statusText}`);
            }

            const html = await res.text();
            const results = [];

            // Split by result block in DuckDuckGo HTML
            const blocks = html.split('result__body').slice(1);

            for (const block of blocks) {
                if (results.length >= maxResults) break;

                // Extract link and title from result__a
                const titleMatch = block.match(/<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
                if (!titleMatch) continue;

                let rawUrl = titleMatch[1];
                let cleanUrl = rawUrl;
                if (rawUrl.includes('uddg=')) {
                    const raw = rawUrl.split('uddg=')[1]?.split('&')[0];
                    if (raw) cleanUrl = decodeURIComponent(raw);
                } else if (rawUrl.startsWith('//')) {
                    cleanUrl = 'https:' + rawUrl;
                }

                // Decode HTML entities in title
                const cleanTitle = titleMatch[2]
                    .replace(/<[^>]+>/g, '')
                    .replace(/&amp;/g, '&')
                    .replace(/&#x27;/g, "'")
                    .replace(/&quot;/g, '"')
                    .replace(/&lt;/g, '<')
                    .replace(/&gt;/g, '>')
                    .trim();

                // Extract snippet from result__snippet
                const snippetMatch = block.match(/<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i);
                let cleanSnippet = 'No preview snippet available.';
                if (snippetMatch) {
                    cleanSnippet = snippetMatch[1]
                        .replace(/<[^>]+>/g, '')
                        .replace(/&amp;/g, '&')
                        .replace(/&#x27;/g, "'")
                        .replace(/&quot;/g, '"')
                        .replace(/&lt;/g, '<')
                        .replace(/&gt;/g, '>')
                        .trim();
                }

                if (cleanUrl.startsWith('http')) {
                    results.push({
                        title: cleanTitle || `Result ${results.length + 1}`,
                        url: cleanUrl,
                        snippet: cleanSnippet
                    });
                }
            }

            logger.info(`WebSearch: retrieved ${results.length} results for "${cleanQuery}"`);
            return {
                query: cleanQuery,
                totalResults: results.length,
                results
            };
        } catch (err) {
            logger.error(`WebSearch failed for "${cleanQuery}": ${err.message}`);
            return {
                query: cleanQuery,
                totalResults: 0,
                results: [],
                error: err.message
            };
        }
    }

    /**
     * Fetches a web page by URL, strips HTML/CSS/scripts, and returns clean text.
     */
    async fetchPage(targetUrl, maxChars = 4000) {
        if (!targetUrl || !targetUrl.startsWith('http')) {
            throw new Error(`Invalid URL: "${targetUrl}". URL must start with http:// or https://`);
        }

        logger.info(`WebSearch: fetching web page "${targetUrl}"`);

        try {
            const res = await fetch(targetUrl, {
                headers: {
                    'User-Agent': this.userAgent,
                    'Accept': 'text/html,application/xhtml+xml,text/plain;q=0.9'
                },
                signal: AbortSignal.timeout(12000)
            });

            if (!res.ok) {
                throw new Error(`HTTP ${res.status}: ${res.statusText}`);
            }

            const contentType = res.headers.get('content-type') || '';
            if (!contentType.includes('text') && !contentType.includes('json') && !contentType.includes('html')) {
                throw new Error(`Unsupported content type: ${contentType}. Can only read text or html pages.`);
            }

            const raw = await res.text();

            // Clean HTML: Remove scripts, styles, comments
            let clean = raw
                .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, ' ')
                .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, ' ')
                .replace(/<!--[\s\S]*?-->/g, ' ')
                .replace(/<nav\b[^<]*(?:(?!<\/nav>)<[^<]*)*<\/nav>/gi, ' ')
                .replace(/<footer\b[^<]*(?:(?!<\/footer>)<[^<]*)*<\/footer>/gi, ' ')
                .replace(/<header\b[^<]*(?:(?!<\/header>)<[^<]*)*<\/header>/gi, ' ')
                .replace(/<[^>]+>/g, ' ')
                .replace(/\s+/g, ' ')
                .trim();

            const truncated = clean.length > maxChars;
            const content = truncated ? clean.slice(0, maxChars) + '\n\n[...Content truncated due to length...]' : clean;

            return {
                url: targetUrl,
                charCount: content.length,
                truncated,
                content
            };
        } catch (err) {
            logger.error(`Failed to fetch web page "${targetUrl}": ${err.message}`);
            return {
                url: targetUrl,
                error: err.message
            };
        }
    }
}

module.exports = WebSearchService;

