const fs = require('fs');
const path = require('path');
const logger = require('../../utils/logger');

class ProjectStore {
    constructor(filePath) {
        this.filePath = filePath;
        this.projects = this._load();
    }

    _load() {
        try {
            if (fs.existsSync(this.filePath)) {
                const data = fs.readFileSync(this.filePath, 'utf8');
                return JSON.parse(data);
            }
            // Fallback to example template if main projects file does not exist yet
            const examplePath = path.join(path.dirname(this.filePath), 'projects.example.json');
            if (fs.existsSync(examplePath)) {
                const data = fs.readFileSync(examplePath, 'utf8');
                const parsed = JSON.parse(data);
                this._save(parsed);
                return parsed;
            }
        } catch (e) {
            logger.warn(`Could not read projects from ${this.filePath}:`, e.message);
        }
        return [];
    }

    _save(data) {
        try {
            const dir = path.dirname(this.filePath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2), 'utf8');
        } catch (e) {
            logger.error(`Failed to save projects: ${e.message}`);
        }
    }

    list() {
        return this.projects;
    }

    find(query) {
        const q = query.toLowerCase().trim();
        return this.projects.find(p =>
            p.id.toLowerCase() === q ||
            p.name.toLowerCase().includes(q)
        );
    }

    addTask(projectIdOrName, taskText) {
        const project = this.find(projectIdOrName);
        if (!project) return null;

        if (!Array.isArray(project.tasks)) project.tasks = [];
        project.tasks.push(taskText.trim());
        this._save(this.projects);
        return project;
    }

    /**
     * Detects if any tracked project is referenced in a query.
     */
    getRelevantProjects(query) {
        if (!query) return [];
        const clean = query.toLowerCase();

        // Specific aliases per project to prevent false triggers on common words like "system", "app", "code"
        const projectTriggers = {
            'balik-belongings': ['balik', 'belongings', 'bbs', 'mrt-3', 'mrt3', 'lost and found'],
            'personal-portfolio': ['portfolio', 'my portfolio', 'personal website', 'resume site'],
            'zenbot': ['zenbot project', 'zenbot repo', 'zenbot code', 'zenbot architecture'],
            'emotion-adaptive': ['emotion-adaptive', 'emotion adaptive', 'facial emotion'],
            'ti-to-monitoring': ['ti-to', 'tito monitoring', 'time-in', 'time-out', 'attendance tracking'],
            'employee-management': ['employee management', 'ems project', 'staff records']
        };

        return this.projects.filter(p => {
            const idMatch = clean.includes(p.id.toLowerCase());
            const triggers = projectTriggers[p.id.toLowerCase()] || [p.id.toLowerCase()];
            const triggerMatch = triggers.some(t => clean.includes(t));
            return idMatch || triggerMatch;
        });
    }

    /**
     * Builds prompt context. If specific projects are mentioned, detail them;
     * otherwise, include a compact roster only if explicitly inquiring about projects.
     */
    toPromptContext(userQuery = '') {
        const relevant = this.getRelevantProjects(userQuery);

        if (relevant.length > 0) {
            const details = relevant.map(p => {
                const stack = p.stack?.join(', ') || 'N/A';
                const highlights = p.highlights?.map(h => `    - ${h}`).join('\n') || '';
                const tasks = p.tasks?.length ? `\n  * Active Tasks:\n${p.tasks.map(t => `    - [ ] ${t}`).join('\n')}` : '';

                return (
                    `Project: ${p.name} (${p.status})\n` +
                    `  * Category: ${p.category}\n` +
                    `  * Description: ${p.description}\n` +
                    `  * Tech Stack: ${stack}\n` +
                    (highlights ? `  * Architecture & Highlights:\n${highlights}\n` : '') +
                    tasks
                );
            }).join('\n\n');

            return `Active Project Context:\n${details}`;
        }

        // Only inject project roster if the user query is explicitly about projects or portfolio
        const isProjectRelated = /\b(what projects|my projects|lance's projects|tracked projects|portfolio stack|project list)\b/i.test(userQuery);
        if (isProjectRelated) {
            const roster = this.projects.map(p => `- ${p.name} (${p.category}): ${p.stack?.slice(0, 3).join(', ')}`).join('\n');
            return `Lance's Tracked Projects (High-level awareness):\n${roster}`;
        }

        return null;
    }
}

module.exports = ProjectStore;

