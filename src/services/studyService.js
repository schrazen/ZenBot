const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

/**
 * Calculates Levenshtein Distance between two strings for typo tolerance.
 */
function levenshtein(a, b) {
    const matrix = [];
    for (let i = 0; i <= b.length; i++) matrix[i] = [i];
    for (let j = 0; j <= a.length; j++) matrix[0][j] = j;

    for (let i = 1; i <= b.length; i++) {
        for (let j = 1; j <= a.length; j++) {
            if (b.charAt(i - 1) === a.charAt(j - 1)) {
                matrix[i][j] = matrix[i - 1][j - 1];
            } else {
                matrix[i][j] = Math.min(
                    matrix[i - 1][j - 1] + 1, // substitution
                    matrix[i][j - 1] + 1,     // insertion
                    matrix[i - 1][j] + 1      // deletion
                );
            }
        }
    }
    return matrix[b.length][a.length];
}

class StudyService {
    constructor({ config, llmManager, storagePath }) {
        this.config = config;
        this.llmManager = llmManager;
        this.storagePath = storagePath ||
            (config?.paths?.data ? path.join(config.paths.data, 'study_decks.json') : path.join(__dirname, '../../data/study_decks.json'));

        // Map of channelId -> ActiveSession
        // ActiveSession: { channelId, userId, deckName, cardIds, currentIndex, score: { correct, incorrect }, currentCard }
        this.activeSessions = new Map();

        this.decks = this.loadDecks();
    }

    /**
     * Loads persisted decks from JSON storage.
     */
    loadDecks() {
        try {
            if (fs.existsSync(this.storagePath)) {
                const raw = fs.readFileSync(this.storagePath, 'utf8');
                return JSON.parse(raw);
            }
        } catch (e) {
            logger.warn(`Could not load study_decks.json: ${e.message}`);
        }
        return {
            acads: []
        };
    }

    /**
     * Persists decks to JSON storage.
     */
    saveDecks() {
        try {
            const dir = path.dirname(this.storagePath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            fs.writeFileSync(this.storagePath, JSON.stringify(this.decks, null, 2), 'utf8');
        } catch (e) {
            logger.error(`Failed to save study_decks.json: ${e.message}`);
        }
    }

    /**
     * Normalizes a deck name.
     */
    normalizeDeckName(name) {
        if (!name || typeof name !== 'string') return 'acads';
        return name.toLowerCase().trim().replace(/[^a-z0-9_-]/g, '_') || 'acads';
    }

    /**
     * Returns list of all decks and their card counts.
     */
    listDecks() {
        return Object.entries(this.decks).map(([name, cards]) => ({
            name,
            cardCount: Array.isArray(cards) ? cards.length : 0,
            count: Array.isArray(cards) ? cards.length : 0,
            updatedAt: Array.isArray(cards) && cards.length > 0 ? cards[cards.length - 1].createdAt : null
        }));
    }

    getDecksSummary() {
        return this.listDecks();
    }

    /**
     * Gets a single deck by name.
     */
    getDeck(name = 'acads') {
        const deckKey = this.normalizeDeckName(name);
        return {
            name: deckKey,
            cards: this.decks[deckKey] || []
        };
    }

    /**
     * Clears all cards in a deck.
     */
    clearDeck(deckName = 'acads') {
        const deckKey = this.normalizeDeckName(deckName);
        if (this.decks[deckKey]) {
            const count = this.decks[deckKey].length;
            this.decks[deckKey] = [];
            this.saveDecks();
            return { success: true, count, deck: deckKey };
        }
        return { success: false, error: `Deck "${deckName}" not found.` };
    }

    /**
     * MODE 1: INGESTION
     * Extracts key concepts into exact pairs of [Description] and [Word Answer].
     */
    async ingestNotes(rawNotes, deckName = 'acads') {
        if (!rawNotes || !rawNotes.trim()) {
            throw new Error('No notes provided for ingestion.');
        }

        const deckKey = this.normalizeDeckName(deckName);
        if (!this.decks[deckKey]) {
            this.decks[deckKey] = [];
        }

        const extractionPrompt = [
            {
                role: 'system',
                content: (
                    `You are an academic concept extraction engine. Your task is to extract study concepts from the user's notes into exact pairs of [Description] and [Word Answer].\n\n` +
                    `RULES:\n` +
                    `1. "description": A clear, unambiguous definition or clue that uniquely tests the term. Do NOT include the answer inside the description.\n` +
                    `2. "answer": The exact concept, term, acronym, or word being described (concise, usually 1 to 3 words).\n` +
                    `3. "aliases": An array of optional valid synonyms, abbreviations, or alternate spellings (e.g. ["OS", "operating system"]).\n` +
                    `4. Output MUST be ONLY a valid raw JSON array of objects with keys: "description", "answer", and "aliases". No markdown fences, no explanatory text.`
                )
            },
            {
                role: 'user',
                content: `Extract all study pairs from these notes:\n\n${rawNotes.trim()}`
            }
        ];

        logger.info(`Extracting study concepts for deck "${deckKey}" using LLM...`);
        const response = await this.llmManager.chat(extractionPrompt, { maxTokens: 1200, temperature: 0.2 });

        let parsed = [];
        const rawContent = (typeof response === 'string' ? response : (response?.content || '')).trim();
        try {
            let jsonText = rawContent;
            if (jsonText.startsWith('```')) {
                jsonText = jsonText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
            }
            parsed = JSON.parse(jsonText);
        } catch (err) {
            logger.error(`Failed to parse extracted notes JSON: ${err.message}. Raw output: ${rawContent.slice(0, 200)}`);
            throw new Error('Could not parse extracted study terms from notes. Please try again with cleaner text.');
        }

        if (!Array.isArray(parsed) || parsed.length === 0) {
            throw new Error('No valid concept pairs could be extracted from the provided notes.');
        }

        let addedCount = 0;
        const now = Date.now();

        for (const item of parsed) {
            if (!item.description || !item.answer) continue;

            const cleanDesc = String(item.description).trim();
            const cleanAnswer = String(item.answer).trim();
            if (cleanDesc.length < 5 || cleanAnswer.length < 1) continue;

            // Deduplicate in this deck
            const exists = this.decks[deckKey].some(c =>
                c.answer.toLowerCase() === cleanAnswer.toLowerCase() ||
                c.description.toLowerCase() === cleanDesc.toLowerCase()
            );

            if (!exists) {
                const card = {
                    id: `card_${now}_${Math.random().toString(36).substring(2, 6)}`,
                    description: cleanDesc,
                    answer: cleanAnswer,
                    aliases: Array.isArray(item.aliases) ? item.aliases.map(a => String(a).trim().toLowerCase()) : [],
                    createdAt: now,
                    stats: {
                        asked: 0,
                        correct: 0,
                        incorrect: 0
                    }
                };

                this.decks[deckKey].push(card);
                addedCount++;
            }
        }

        this.saveDecks();
        logger.success(`Ingested ${addedCount} terms into deck "${deckKey}". Total in deck: ${this.decks[deckKey].length}`);

        return {
            success: true,
            addedCount,
            totalInDeck: this.decks[deckKey].length,
            deckName: deckKey
        };
    }

    /**
     * Checks if a channel has an ongoing review session.
     */
    hasActiveSession(channelId) {
        return this.activeSessions.has(channelId);
    }

    /**
     * Gets the current active session for a channel.
     */
    getSession(channelId) {
        return this.activeSessions.get(channelId) || null;
    }

    /**
     * Cancels / ends an active review session.
     */
    endSession(channelId) {
        const session = this.activeSessions.get(channelId);
        if (!session) return null;

        this.activeSessions.delete(channelId);
        const total = session.score.correct + session.score.incorrect;
        return {
            correct: session.score.correct,
            incorrect: session.score.incorrect,
            total,
            percentage: total > 0 ? Math.round((session.score.correct / total) * 100) : 0,
            deckName: session.deckName
        };
    }

    /**
     * MODE 2: REVIEW
     * Starts or continues a quiz session, returning ONLY ONE [Description].
     */
    startReview(channelId, userId, deckName = 'acads') {
        const deckKey = this.normalizeDeckName(deckName);
        const deck = this.decks[deckKey] || [];

        if (deck.length === 0) {
            return {
                success: false,
                message: `Deck "${deckKey}" is empty! Add notes first using \`!study notes <text>\` or by pasting your acads notes.`
            };
        }

        // Shuffle card indices
        const indices = deck.map((_, idx) => idx);
        for (let i = indices.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [indices[i], indices[j]] = [indices[j], indices[i]];
        }

        const firstCard = deck[indices[0]];

        const session = {
            channelId,
            userId,
            deckName: deckKey,
            shuffledIndices: indices,
            currentIndex: 0,
            totalCards: indices.length,
            score: {
                correct: 0,
                incorrect: 0
            },
            currentCard: firstCard,
            startedAt: Date.now()
        };

        this.activeSessions.set(channelId, session);

        return {
            success: true,
            isNew: true,
            deckName: deckKey,
            cardIndex: 1,
            totalCards: indices.length,
            description: firstCard.description,
            session
        };
    }

    /**
     * Fast-path local grading evaluation.
     */
    _evaluateLocally(userAnswer, targetAnswer, aliases = []) {
        const cleanUser = userAnswer.toLowerCase().trim().replace(/^(the|a|an)\s+/i, '');
        const cleanTarget = targetAnswer.toLowerCase().trim().replace(/^(the|a|an)\s+/i, '');

        // 1. Exact match
        if (cleanUser === cleanTarget) return true;

        // 2. Alias match
        if (aliases.some(alias => cleanUser === alias.replace(/^(the|a|an)\s+/i, ''))) {
            return true;
        }

        // 3. Typo tolerance (Levenshtein distance <= 2 for words with length > 4)
        if (cleanTarget.length >= 5) {
            const dist = levenshtein(cleanUser, cleanTarget);
            if (dist <= 2) return true;

            for (const alias of aliases) {
                if (alias.length >= 5 && levenshtein(cleanUser, alias) <= 2) {
                    return true;
                }
            }
        }

        return false;
    }

    /**
     * MODE 3: GRADING
     * Evaluates user answer, updates statistics, and serves the next random Description.
     */
    async evaluateAnswer(channelId, userAnswer) {
        const session = this.activeSessions.get(channelId);
        if (!session) return null;

        const currentCard = session.currentCard;
        const targetAnswer = currentCard.answer;
        const aliases = currentCard.aliases || [];

        // 1. Evaluate locally
        let isCorrect = this._evaluateLocally(userAnswer, targetAnswer, aliases);

        // 2. If local check fails, use quick LLM semantic check for technical equivalence
        if (!isCorrect && userAnswer.trim().length > 1) {
            try {
                const evalPrompt = [
                    {
                        role: 'system',
                        content: (
                            `You are an academic grading assistant. Determine if the student's answer correctly matches the target answer for a study card.\n` +
                            `Accept minor typos, singular/plural differences, or standard synonymous phrasing.\n` +
                            `Target Answer: "${targetAnswer}"\n` +
                            `Target Aliases: ${JSON.stringify(aliases)}\n` +
                            `Student Answer: "${userAnswer.trim()}"\n\n` +
                            `Respond with ONLY "CORRECT" or "INCORRECT".`
                        )
                    }
                ];

                const res = await this.llmManager.chat(evalPrompt, { maxTokens: 10, temperature: 0.0 });
                const verdict = (typeof res === 'string' ? res : (res?.content || '')).trim().toUpperCase();
                if (verdict.includes('CORRECT') && !verdict.includes('INCORRECT')) {
                    isCorrect = true;
                }
            } catch (e) {
                // Fall back to local evaluation
            }
        }

        // Update card stats in deck
        const deckKey = session.deckName;
        const cardInDeck = this.decks[deckKey]?.find(c => c.id === currentCard.id);
        if (cardInDeck) {
            cardInDeck.stats.asked = (cardInDeck.stats.asked || 0) + 1;
            if (isCorrect) {
                cardInDeck.stats.correct = (cardInDeck.stats.correct || 0) + 1;
            } else {
                cardInDeck.stats.incorrect = (cardInDeck.stats.incorrect || 0) + 1;
            }
            this.saveDecks();
        }

        // Update session score
        if (isCorrect) {
            session.score.correct++;
        } else {
            session.score.incorrect++;
        }

        // Build feedback according to user's strict format specification:
        // If correct: "Correct!"
        // If incorrect: "Incorrect. The answer is: [Word Answer]"
        const feedback = isCorrect
            ? 'Correct!'
            : `Incorrect. The answer is: **${targetAnswer}**`;

        // Advance to next card
        session.currentIndex++;

        if (session.currentIndex >= session.totalCards) {
            // Deck complete!
            this.activeSessions.delete(channelId);
            const total = session.totalCards;
            const correct = session.score.correct;
            const pct = Math.round((correct / total) * 100);

            return {
                isCorrect,
                feedback,
                finished: true,
                isFinished: true,
                score: {
                    correct,
                    incorrect: session.score.incorrect,
                    total,
                    percentage: pct
                },
                deckName: session.deckName
            };
        }

        // Pull next card
        const nextCardIndex = session.shuffledIndices[session.currentIndex];
        const nextCard = this.decks[deckKey][nextCardIndex];
        session.currentCard = nextCard;

        return {
            isCorrect,
            feedback,
            finished: false,
            isFinished: false,
            nextDescription: nextCard.description,
            cardNumber: session.currentIndex + 1,
            totalCards: session.totalCards,
            deckName: session.deckName
        };
    }
}

module.exports = StudyService;
