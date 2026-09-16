const fs = require('fs');
const path = require('path');
const logger = require('../../utils/logger');

const DEFAULT_PROFILE = {
    userName: 'Lance',
    title: 'Software Developer / Engineer',
    bio: 'Building innovative projects, modernizing web apps, and preparing a standout software engineering portfolio.',
    interests: ['Node.js', 'Web Development', 'AI Systems & LLMs', 'Clean Architecture', 'Productivity'],
    goals: [
        'Build and deploy ZenBot as a personal AI assistant and portfolio showcase',
        'Master modern cloud AI APIs and system design',
        'Maintain efficient daily routines and organized project workflows'
    ],
    preferences: {
        tone: 'Pragmatic, direct, encouraging, and clear',
        codeStyle: 'Clean, modern, modular, well-documented'
    },
    updatedAt: new Date().toISOString()
};

class ProfileManager {
    constructor(filePath) {
        this.filePath = filePath;
        this.profile = this._load();
    }

    _load() {
        try {
            if (fs.existsSync(this.filePath)) {
                const data = fs.readFileSync(this.filePath, 'utf8');
                return { ...DEFAULT_PROFILE, ...JSON.parse(data) };
            }
        } catch (e) {
            logger.warn(`Could not read profile from ${this.filePath}, initializing with defaults.`, e.message);
        }

        this._save(DEFAULT_PROFILE);
        return { ...DEFAULT_PROFILE };
    }

    _save(data) {
        try {
            const dir = path.dirname(this.filePath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            data.updatedAt = new Date().toISOString();
            fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2), 'utf8');
        } catch (e) {
            logger.error(`Failed to save profile: ${e.message}`);
        }
    }

    getProfile() {
        return this.profile;
    }

    update(partial) {
        this.profile = {
            ...this.profile,
            ...partial,
            updatedAt: new Date().toISOString()
        };
        this._save(this.profile);
        return this.profile;
    }

    addGoal(goal) {
        if (!this.profile.goals.includes(goal)) {
            this.profile.goals.push(goal);
            this._save(this.profile);
        }
        return this.profile.goals;
    }

    toPromptContext() {
        const p = this.profile;
        const lines = [
            `User Profile:`,
            `- Name: ${p.userName}`,
            `- Role/Title: ${p.title || 'Developer'}`,
            p.bio ? `- Bio: ${p.bio}` : null,
            p.interests?.length ? `- Interests: ${p.interests.join(', ')}` : null,
            p.goals?.length ? `- Active Goals:\n  * ` + p.goals.join('\n  * ') : null,
            p.preferences?.tone ? `- Preferred Tone: ${p.preferences.tone}` : null
        ].filter(Boolean);

        return lines.join('\n');
    }
}

module.exports = ProfileManager;
