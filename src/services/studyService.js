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

        this.defaultDeck = 'acads';
        this.channelActiveDecks = new Map();
        this.activeSessions = new Map();

        this.decks = this.loadDecks();
        if (!this.decks.acads && Object.keys(this.decks).filter(k => !k.startsWith('_')).length === 0) {
            this.decks.acads = [];
        }
    }

    /**
     * Loads persisted decks from JSON storage.
     */
    loadDecks() {
        try {
            if (fs.existsSync(this.storagePath)) {
                const raw = fs.readFileSync(this.storagePath, 'utf8');
                const parsed = JSON.parse(raw);
                if (parsed._metadata?.defaultDeck) {
                    this.defaultDeck = parsed._metadata.defaultDeck;
                }
                return parsed;
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
            const payload = {
                _metadata: {
                    defaultDeck: this.defaultDeck || 'acads',
                    updatedAt: Date.now()
                },
                ...this.decks
            };
            fs.writeFileSync(this.storagePath, JSON.stringify(payload, null, 2), 'utf8');
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
     * Gets the active deck for a channel (or default).
     */
    getActiveDeck(channelId = null) {
        if (channelId && this.channelActiveDecks.has(channelId)) {
            const chDeck = this.channelActiveDecks.get(channelId);
            if (this.decks[chDeck]) return chDeck;
        }
        if (this.decks[this.defaultDeck]) {
            return this.defaultDeck;
        }
        const available = Object.keys(this.decks).filter(k => !k.startsWith('_'));
        if (available.length > 0) {
            return available[0];
        }
        return 'acads';
    }

    /**
     * Sets the active deck for a channel (or globally).
     */
    setActiveDeck(channelId, deckName) {
        const deckKey = this.normalizeDeckName(deckName);
        if (!this.decks[deckKey]) {
            return {
                success: false,
                message: `Deck **${deckKey}** does not exist. Use \`!study create ${deckKey}\` to create it first.`
            };
        }

        if (channelId) {
            this.channelActiveDecks.set(channelId, deckKey);
        }
        this.defaultDeck = deckKey;
        this.saveDecks();

        const cardCount = Array.isArray(this.decks[deckKey]) ? this.decks[deckKey].length : 0;
        return {
            success: true,
            deck: deckKey,
            cardCount,
            message: `Switched active deck to **${deckKey}** (${cardCount} card${cardCount === 1 ? '' : 's'}). Subsequent notes and quizzes will default to this deck.`
        };
    }

    /**
     * Creates a new empty study deck.
     */
    createDeck(name) {
        const deckKey = this.normalizeDeckName(name);
        if (this.decks[deckKey]) {
            return {
                success: false,
                message: `Deck **${deckKey}** already exists! Switch to it using \`!study use ${deckKey}\`.`
            };
        }

        this.decks[deckKey] = [];
        this.saveDecks();
        logger.info(`Created new study deck: "${deckKey}"`);

        return {
            success: true,
            deck: deckKey,
            message: `Created new deck **${deckKey}**! Use \`!study use ${deckKey}\` to set it active, or \`!study notes <text>\` to add cards.`
        };
    }

    /**
     * Returns list of all decks, card counts, and active indicator.
     */
    listDecks(channelId = null) {
        const active = this.getActiveDeck(channelId);
        return Object.entries(this.decks)
            .filter(([name]) => !name.startsWith('_'))
            .map(([name, cards]) => ({
                name,
                isActive: name === active,
                cardCount: Array.isArray(cards) ? cards.length : 0,
                count: Array.isArray(cards) ? cards.length : 0,
                updatedAt: Array.isArray(cards) && cards.length > 0 ? cards[cards.length - 1].createdAt : null
            }));
    }

    getDecksSummary(channelId = null) {
        return this.listDecks(channelId);
    }

    /**
     * Gets a single deck by name.
     */
    getDeck(name = null, channelId = null) {
        const targetName = name || this.getActiveDeck(channelId);
        const deckKey = this.normalizeDeckName(targetName);
        return {
            name: deckKey,
            isActive: deckKey === this.getActiveDeck(channelId),
            cards: Array.isArray(this.decks[deckKey]) ? this.decks[deckKey] : []
        };
    }

    /**
     * Renames a deck.
     */
    renameDeck(oldName, newName, channelId = null) {
        const oldKey = this.normalizeDeckName(oldName);
        const newKey = this.normalizeDeckName(newName);

        if (!this.decks[oldKey]) {
            return { success: false, message: `Deck **${oldKey}** does not exist.` };
        }
        if (this.decks[newKey] && oldKey !== newKey) {
            return { success: false, message: `Deck **${newKey}** already exists! Choose a different name.` };
        }

        this.decks[newKey] = this.decks[oldKey];
        if (oldKey !== newKey) {
            delete this.decks[oldKey];
        }

        if (this.defaultDeck === oldKey) {
            this.defaultDeck = newKey;
        }
        for (const [chId, d] of this.channelActiveDecks.entries()) {
            if (d === oldKey) this.channelActiveDecks.set(chId, newKey);
        }

        this.saveDecks();
        return {
            success: true,
            oldDeck: oldKey,
            newDeck: newKey,
            message: `Renamed deck **${oldKey}** to **${newKey}** (${this.decks[newKey].length} cards).`
        };
    }

    /**
     * Deletes a deck completely.
     */
    deleteDeck(deckName) {
        const deckKey = this.normalizeDeckName(deckName);
        if (!this.decks[deckKey]) {
            return { success: false, message: `Deck **${deckKey}** not found.` };
        }

        const count = Array.isArray(this.decks[deckKey]) ? this.decks[deckKey].length : 0;
        delete this.decks[deckKey];

        // Ensure at least 'acads' exists
        if (Object.keys(this.decks).filter(k => !k.startsWith('_')).length === 0) {
            this.decks.acads = [];
        }

        if (this.defaultDeck === deckKey) {
            const remaining = Object.keys(this.decks).filter(k => !k.startsWith('_'));
            this.defaultDeck = remaining[0] || 'acads';
        }

        for (const [chId, d] of this.channelActiveDecks.entries()) {
            if (d === deckKey) {
                this.channelActiveDecks.set(chId, this.defaultDeck);
            }
        }

        this.saveDecks();
        logger.info(`Deleted deck: "${deckKey}" (${count} cards)`);
        return {
            success: true,
            deck: deckKey,
            removedCount: count,
            activeDeck: this.defaultDeck,
            message: `Deleted deck **${deckKey}** (${count} card${count === 1 ? '' : 's'} removed). Active deck is now **${this.defaultDeck}**.`
        };
    }

    /**
     * Clears all cards in a deck without deleting the deck itself.
     */
    clearDeck(deckName = null, channelId = null) {
        const target = deckName || this.getActiveDeck(channelId);
        const deckKey = this.normalizeDeckName(target);
        if (this.decks[deckKey]) {
            const count = this.decks[deckKey].length;
            this.decks[deckKey] = [];
            this.saveDecks();
            return {
                success: true,
                count,
                deck: deckKey,
                message: `Cleared all **${count}** card${count === 1 ? '' : 's'} in deck **${deckKey}**.`
            };
        }
        return { success: false, message: `Deck **${target}** not found.` };
    }

    /**
     * Adds a single card manually to a deck.
     */
    addCard(deckName, answer, description, aliases = []) {
        const deckKey = this.normalizeDeckName(deckName);
        if (!this.decks[deckKey]) {
            this.decks[deckKey] = [];
        }

        const card = {
            id: `card_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            description: String(description).trim(),
            answer: String(answer).trim(),
            aliases: Array.isArray(aliases) ? aliases.map(a => String(a).toLowerCase().trim()) : [],
            createdAt: Date.now(),
            stats: { asked: 0, correct: 0, incorrect: 0 }
        };

        this.decks[deckKey].push(card);
        this.saveDecks();
        return {
            success: true,
            card,
            deck: deckKey,
            message: `Added card **"${card.answer}"** to deck **${deckKey}** (${this.decks[deckKey].length} cards total).`
        };
    }

    /**
     * Deletes a specific card by term answer, alias, or 1-based index.
     */
    deleteCard(deckName, target) {
        const deckKey = this.normalizeDeckName(deckName);
        const deck = this.decks[deckKey];
        if (!deck || deck.length === 0) {
            return { success: false, message: `Deck **${deckKey}** is empty or not found.` };
        }

        const cleanTarget = String(target).toLowerCase().trim();
        let removeIndex = -1;

        const numIndex = parseInt(cleanTarget, 10);
        if (!isNaN(numIndex) && numIndex >= 1 && numIndex <= deck.length) {
            removeIndex = numIndex - 1;
        } else {
            removeIndex = deck.findIndex(c =>
                c.id === cleanTarget ||
                c.answer.toLowerCase() === cleanTarget ||
                (Array.isArray(c.aliases) && c.aliases.includes(cleanTarget))
            );
        }

        if (removeIndex === -1) {
            return { success: false, message: `Card matching "${target}" not found in deck **${deckKey}**.` };
        }

        const removedCard = deck.splice(removeIndex, 1)[0];
        this.saveDecks();
        return {
            success: true,
            deck: deckKey,
            removedCard,
            remainingCount: deck.length,
            message: `Removed card **"${removedCard.answer}"** from deck **${deckKey}** (${deck.length} remaining).`
        };
    }

    /**
     * MODE 1: INGESTION
     * Extracts key concepts into exact pairs of [Description] and [Word Answer].
     */
    async ingestNotes(rawNotes, deckName = null, channelId = null) {
        if (!rawNotes || !rawNotes.trim()) {
            throw new Error('No notes provided for ingestion.');
        }

        const targetDeck = deckName || this.getActiveDeck(channelId);
        const deckKey = this.normalizeDeckName(targetDeck);
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
            deckName: session.deckName,
            participants: session.participants || {}
        };
    }

    /**
     * MODE 2: REVIEW
     * Starts or continues a quiz session, returning ONLY ONE [Description].
     */
    startReview(channelId, userId, deckName = null) {
        const targetDeck = deckName || this.getActiveDeck(channelId);
        const deckKey = this.normalizeDeckName(targetDeck);
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
            participants: {},
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
     * Skips the current card, reveals the answer, and advances to the next card.
     */
    skipCard(channelId, speakerName = null) {
        const session = this.activeSessions.get(channelId);
        if (!session) return null;

        const currentCard = session.currentCard;
        const targetAnswer = currentCard.answer;
        const deckKey = session.deckName;

        // Update card stats in deck
        const cardInDeck = this.decks[deckKey]?.find(c => c.id === currentCard.id);
        if (cardInDeck) {
            cardInDeck.stats.asked = (cardInDeck.stats.asked || 0) + 1;
            cardInDeck.stats.incorrect = (cardInDeck.stats.incorrect || 0) + 1;
            this.saveDecks();
        }

        session.score.incorrect++;
        session.currentIndex++;

        const feedback = `⏩ **Card Skipped.** The answer is: **${targetAnswer}**`;

        if (session.currentIndex >= session.totalCards) {
            this.activeSessions.delete(channelId);
            const total = session.totalCards;
            const correct = session.score.correct;
            const pct = Math.round((correct / total) * 100);

            return {
                skipped: true,
                feedback,
                targetAnswer,
                finished: true,
                isFinished: true,
                score: {
                    correct,
                    incorrect: session.score.incorrect,
                    total,
                    percentage: pct
                },
                deckName: session.deckName,
                participants: session.participants || {}
            };
        }

        const nextCardIndex = session.shuffledIndices[session.currentIndex];
        const nextCard = this.decks[deckKey][nextCardIndex];
        session.currentCard = nextCard;

        return {
            skipped: true,
            feedback,
            targetAnswer,
            finished: false,
            isFinished: false,
            nextDescription: nextCard.description,
            cardNumber: session.currentIndex + 1,
            totalCards: session.totalCards,
            deckName: session.deckName
        };
    }

    /**
     * MODE 3: GRADING & CHAT DISCRIMINATION
     * Evaluates user answer, distinguishes casual banter from actual attempts,
     * updates statistics, and serves the next random Description.
     */
    async evaluateAnswer(channelId, userAnswer, speakerName = 'Student', speakerId = null) {
        const session = this.activeSessions.get(channelId);
        if (!session) return null;

        const currentCard = session.currentCard;
        const targetAnswer = currentCard.answer;
        const aliases = currentCard.aliases || [];
        const cleanUser = userAnswer.trim();

        // 1. Fast local evaluation
        let isCorrect = this._evaluateLocally(cleanUser, targetAnswer, aliases);
        let isAttempt = true;

        // 2. If local check fails, determine if this is an attempted answer or casual conversation
        if (!isCorrect) {
            const casualRegex = /^(?:paalam|teka|wait(?!\s+state)|namatay|o\s*shit|tangina|gago|bakit|ano\s+ba|haha|lmao|lol|ay\s+mali|niga|sir\b|di\s+ako)/i;
            const looksConversational = casualRegex.test(cleanUser) || cleanUser.includes('?') || cleanUser.length > 75;

            try {
                const evalPrompt = [
                    {
                        role: 'system',
                        content: (
                            `You are an academic study quiz referee. A flashcard question is currently active in Discord chat.\n\n` +
                            `FLASHCARD DESCRIPTION: "${currentCard.description}"\n` +
                            `TARGET ANSWER: "${targetAnswer}"\n` +
                            `TARGET ALIASES: ${JSON.stringify(aliases)}\n\n` +
                            `A Discord user sent this message in the channel:\n` +
                            `"${cleanUser}"\n\n` +
                            `TASK:\n` +
                            `1. "isAttempt": Is the user attempting to answer the flashcard question? (True if they guessed a term, concept, acronym, or option. False if they are having off-topic casual chat, reacting to friends, talking about something else, or commenting on the quiz itself like "wait mali", "namatay memory", "paalam na ako").\n` +
                            `2. "isCorrect": If it IS an attempt, is it technically correct or an acceptable synonymous variant/acronym (e.g. "microservices" for "microservices architecture", "put" for "HTTP PUT")?\n\n` +
                            `Respond with ONLY valid JSON: {"isAttempt": true/false, "isCorrect": true/false}`
                        )
                    }
                ];

                const res = await this.llmManager.chat(evalPrompt, { maxTokens: 25, temperature: 0.0 });
                const rawVerdict = (typeof res === 'string' ? res : (res?.content || '')).trim();
                const jsonMatch = rawVerdict.match(/\{[\s\S]*\}/);
                if (jsonMatch) {
                    const parsed = JSON.parse(jsonMatch[0]);
                    isAttempt = parsed.isAttempt === true;
                    isCorrect = isAttempt && parsed.isCorrect === true;
                } else if (rawVerdict.includes('CORRECT') && !rawVerdict.includes('INCORRECT')) {
                    isAttempt = true;
                    isCorrect = true;
                } else if (looksConversational) {
                    isAttempt = false;
                }
            } catch (e) {
                if (looksConversational) {
                    isAttempt = false;
                }
            }
        }

        // If the message was off-topic casual conversation, DO NOT burn the card!
        if (!isAttempt) {
            return {
                ignored: true,
                isAttempt: false,
                currentDescription: currentCard.description,
                deckName: session.deckName
            };
        }

        // Track participant statistics
        if (speakerId) {
            if (!session.participants) session.participants = {};
            if (!session.participants[speakerId]) {
                session.participants[speakerId] = { name: speakerName, correct: 0, answers: 0 };
            }
            session.participants[speakerId].answers++;
            if (isCorrect) {
                session.participants[speakerId].correct++;
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

        const feedback = isCorrect
            ? 'Correct!'
            : `Incorrect. The answer is: **${targetAnswer}**`;

        session.currentIndex++;

        if (session.currentIndex >= session.totalCards) {
            this.activeSessions.delete(channelId);
            const total = session.totalCards;
            const correct = session.score.correct;
            const pct = Math.round((correct / total) * 100);

            return {
                isAttempt: true,
                isCorrect,
                feedback,
                targetAnswer,
                finished: true,
                isFinished: true,
                score: {
                    correct,
                    incorrect: session.score.incorrect,
                    total,
                    percentage: pct
                },
                deckName: session.deckName,
                participants: session.participants || {}
            };
        }

        const nextCardIndex = session.shuffledIndices[session.currentIndex];
        const nextCard = this.decks[deckKey][nextCardIndex];
        session.currentCard = nextCard;

        return {
            isAttempt: true,
            isCorrect,
            feedback,
            targetAnswer,
            finished: false,
            isFinished: false,
            nextDescription: nextCard.description,
            cardNumber: session.currentIndex + 1,
            totalCards: session.totalCards,
            deckName: session.deckName,
            participants: session.participants || {}
        };
    }
}

module.exports = StudyService;
