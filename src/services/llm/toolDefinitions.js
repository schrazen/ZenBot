/**
 * Tool definitions and execution mapping for ZenBot's Agentic capabilities.
 * Strictly restricted to Lance (owner) to safeguard workspace and system integrity.
 */

const fs = require('fs');
const path = require('path');

const toolSpecs = [
    {
        name: 'read_file',
        description: 'Read contents of a text file or extract text directly from a PDF (.pdf) inside the project workspace or whitelisted Personal Vaults (Documents, Downloads, Desktop) with line numbers.',
        parameters: {
            type: 'object',
            properties: {
                filePath: {
                    type: 'string',
                    description: 'Relative workspace path (e.g. "src/bot.js") or vault path (e.g. "Documents/notes.txt", "Downloads/Resume.pdf").'
                },
                maxLines: {
                    type: 'integer',
                    description: 'Maximum lines of content to read (default: 100).'
                },
                offset: {
                    type: 'integer',
                    description: 'Line offset to start reading from (0-indexed).'
                }
            },
            required: ['filePath']
        }
    },
    {
        name: 'write_file',
        description: 'Create a new file or completely overwrite an existing file inside the project workspace. Note: Modifying ZenBot source code files (src/, index.js, etc.) automatically stages a permission request for Lance to approve.',
        parameters: {
            type: 'object',
            properties: {
                filePath: {
                    type: 'string',
                    description: 'Relative path of the file to create or overwrite.'
                },
                content: {
                    type: 'string',
                    description: 'The full text content to write into the file.'
                },
                reason: {
                    type: 'string',
                    description: 'Why this file is being created or modified.'
                }
            },
            required: ['filePath', 'content']
        }
    },
    {
        name: 'edit_file',
        description: 'Perform an exact substring replacement in a file. Note: Modifying ZenBot source code files (src/, index.js, etc.) automatically stages a permission request for Lance to approve before applying.',
        parameters: {
            type: 'object',
            properties: {
                filePath: {
                    type: 'string',
                    description: 'Relative path of the file to modify.'
                },
                targetContent: {
                    type: 'string',
                    description: 'The exact existing block of code/text to replace (must match exactly including whitespace).'
                },
                replacementContent: {
                    type: 'string',
                    description: 'The new block of code/text to insert.'
                },
                reason: {
                    type: 'string',
                    description: 'Brief explanation of why this code edit is needed.'
                }
            },
            required: ['filePath', 'targetContent', 'replacementContent']
        }
    },
    {
        name: 'propose_self_upgrade',
        description: 'Propose a code fix or new capability upgrade to ZenBot\'s own codebase when you encounter a bug, limitation, or missing feature. Stages the change and asks Lance for permission ("approve" / "reject") before modifying disk.',
        parameters: {
            type: 'object',
            properties: {
                filePath: {
                    type: 'string',
                    description: 'Relative path of the source file to fix or upgrade (e.g. "src/services/automationService.js").'
                },
                operation: {
                    type: 'string',
                    description: '"edit" for replacing a block of code in an existing file, or "write" for creating a new file.'
                },
                reason: {
                    type: 'string',
                    description: 'Clear explanation for Lance of what problem this fixes or what new capability it adds.'
                },
                targetContent: {
                    type: 'string',
                    description: 'Required if operation="edit": the exact existing code block to replace (read the file first with read_file).'
                },
                replacementContent: {
                    type: 'string',
                    description: 'Required if operation="edit": the new replacement code block.'
                },
                content: {
                    type: 'string',
                    description: 'Required if operation="write": full content of the new file.'
                }
            },
            required: ['filePath', 'operation', 'reason']
        }
    },
    {
        name: 'read_discord_channel',
        description: 'Read recent messages from any connected Discord server or channel (e.g. "BANORANTTT", "col", "rodericks", "#general", or a server/channel ID). Use this to check server activity or watch for new messages.',
        parameters: {
            type: 'object',
            properties: {
                target: {
                    type: 'string',
                    description: 'Server name (e.g. "banorant"), channel name (e.g. "general"), or Discord server/channel ID (e.g. "1484106877708013608").'
                },
                limit: {
                    type: 'integer',
                    description: 'Number of recent messages to fetch (default: 20, max: 50).'
                }
            },
            required: ['target']
        }
    },
    {
        name: 'post_discord_message',
        description: 'Send/post a message to a specific channel in a connected Discord server (e.g. "BANORANTTT", "col", "rodericks", "#general", or a channel/server ID). STRICT RULE: ONLY call this tool when Lance explicitly commands you to post or send a message to another channel/server. NEVER call this tool during normal conversation or banter.',
        parameters: {
            type: 'object',
            properties: {
                target: {
                    type: 'string',
                    description: 'Target server or channel name (e.g. "banorant #general", "BANORANTTT", "col", "#general") or channel/server ID.'
                },
                message: {
                    type: 'string',
                    description: 'The exact text message to post to the Discord channel.'
                }
            },
            required: ['target', 'message']
        }
    },
    {
        name: 'set_owner_availability',
        description: 'Check or update Lance\'s availability/AFK status (use "status" to read current status without changing it; use "online", "away", "sleep", or "auto" to update/override).',
        parameters: {
            type: 'object',
            properties: {
                state: {
                    type: 'string',
                    description: 'Target action/state: "status" (read-only check of current availability), "online" (active, suppress AFK replies), "away" (AFK/busy), "sleep" (asleep), or "auto" (automatic detection).'
                },
                reason: {
                    type: 'string',
                    description: 'Optional reason or duration (e.g. "in class for 2h", "active now").'
                }
            },
            required: ['state']
        }
    },
    {
        name: 'list_directory',
        description: 'List files and directories inside the project workspace or Personal Vaults ("Documents", "Downloads", "Desktop").',
        parameters: {
            type: 'object',
            properties: {
                dirPath: {
                    type: 'string',
                    description: 'Directory path to inspect (e.g. ".", "src", "Downloads", "Documents", "Desktop").'
                },
                depth: {
                    type: 'integer',
                    description: 'Recursion depth (default: 1).'
                }
            }
        }
    },
    {
        name: 'search_files',
        description: 'Search for a text string or keyword inside text files in the project workspace or Personal Vaults ("Documents", "Downloads", "Desktop").',
        parameters: {
            type: 'object',
            properties: {
                query: {
                    type: 'string',
                    description: 'The text or identifier to search for.'
                },
                dirPath: {
                    type: 'string',
                    description: 'Directory to start searching from (default: ".", or "Documents", "Downloads", "Desktop").'
                }
            },
            required: ['query']
        }
    },
    {
        name: 'find_files',
        description: 'Find files by filename or extension (including PDFs, docs, images, zips, code) across Lance\'s Personal Vaults (Documents, Downloads, Desktop) and the project workspace.',
        parameters: {
            type: 'object',
            properties: {
                query: {
                    type: 'string',
                    description: 'Filename keywords or extension to match (e.g. "resume", "pdf", "os lecture").'
                },
                location: {
                    type: 'string',
                    description: 'Where to search: "all" (default), "vault", "workspace", "Downloads", "Documents", or "Desktop".'
                }
            },
            required: ['query']
        }
    },
    {
        name: 'send_file_to_owner',
        description: 'Send/upload a file from Lance\'s PC (workspace or Personal Vault: Documents, Downloads, Desktop) directly to Lance in Discord DM (up to 25 MB). Sensitive files (.env, private keys, browser credentials) are blocked.',
        parameters: {
            type: 'object',
            properties: {
                filePath: {
                    type: 'string',
                    description: 'Path returned by find_files/list_directory (e.g. "Downloads/reviewer.pdf", "Documents/notes.txt").'
                },
                caption: {
                    type: 'string',
                    description: 'Optional short message to accompany the file attachment.'
                }
            },
            required: ['filePath']
        }
    },
    {
        name: 'remember_fact',
        description: 'Save a persistent personal fact, schedule, deadline, reminder note, or key context about Lance to long-term memory (facts.json). Use proactively when Lance shares important information.',
        parameters: {
            type: 'object',
            properties: {
                fact: {
                    type: 'string',
                    description: 'Concise, clear statement of the fact to remember.'
                },
                category: {
                    type: 'string',
                    description: 'Optional category: "Preference", "Routine/Health", "Work/Tech", "Goal", "Schedule", or "General".'
                }
            },
            required: ['fact']
        }
    },
    {
        name: 'save_preference',
        description: 'Save a recurring workflow rule, style preference, or behavioral instruction from Lance (preferences.json) so ZenBot always follows it.',
        parameters: {
            type: 'object',
            properties: {
                rule: {
                    type: 'string',
                    description: 'Clear actionable rule or preference statement.'
                },
                category: {
                    type: 'string',
                    description: 'Category such as "workflow", "coding_style", "communication", or "preference".'
                }
            },
            required: ['rule']
        }
    },
    {
        name: 'search_memory',
        description: 'Search across Lance\'s stored facts, learned preferences, tracked projects, and past conversation memories.',
        parameters: {
            type: 'object',
            properties: {
                query: {
                    type: 'string',
                    description: 'Topic, project name, or keyword to look up in memory.'
                }
            },
            required: ['query']
        }
    },
    {
        name: 'set_persona_mode',
        description: 'Switch ZenBot\'s live communication mode and humor level (e.g. when Lance asks for formal mode only, serious mode, or playful banter) and persist the preference.',
        parameters: {
            type: 'object',
            properties: {
                mode: {
                    type: 'string',
                    description: 'Target mode: "formal" (level 0, serious professional agent), "casual" (level 1-2), or "humorous" (level 3+).'
                },
                humorLevel: {
                    type: 'integer',
                    description: 'Explicit humor intensity 0 (formal/serious) to 5 (peak shitpost).'
                },
                rule: {
                    type: 'string',
                    description: 'Optional communication rule to persist in preferences.'
                }
            }
        }
    },
    {
        name: 'update_project_task',
        description: 'Add a new task or mark a task completed on one of Lance\'s tracked projects.',
        parameters: {
            type: 'object',
            properties: {
                project: {
                    type: 'string',
                    description: 'Project ID or name (e.g. "zenbot", "balik-belongings", "personal-portfolio").'
                },
                task: {
                    type: 'string',
                    description: 'The task text (for add) or substring/1-based index (for complete).'
                },
                action: {
                    type: 'string',
                    description: '"add" (default) or "complete".'
                }
            },
            required: ['project', 'task']
        }
    },
    {
        name: 'web_search',
        description: 'Search the live web for current real-time information, documentation, news, or technical questions using DuckDuckGo.',
        parameters: {
            type: 'object',
            properties: {
                query: {
                    type: 'string',
                    description: 'The search query or research topic.'
                },
                maxResults: {
                    type: 'integer',
                    description: 'Maximum search results to return (default: 5).'
                }
            },
            required: ['query']
        }
    },
    {
        name: 'fetch_web_page',
        description: 'Fetch and read the full text/markdown content of a web page by its URL. Useful for reading documentation, articles, or GitHub pages.',
        parameters: {
            type: 'object',
            properties: {
                url: {
                    type: 'string',
                    description: 'The full HTTP/HTTPS URL of the web page to read.'
                },
                maxChars: {
                    type: 'integer',
                    description: 'Maximum characters of text to extract (default: 4000).'
                }
            },
            required: ['url']
        }
    },
    {
        name: 'run_command',
        description: 'Execute a shell terminal command in the project directory (e.g. "git status", "git diff", "node -v", "npm test"). Restricted to safe workspace operations.',
        parameters: {
            type: 'object',
            properties: {
                command: {
                    type: 'string',
                    description: 'The terminal command line to run.'
                }
            },
            required: ['command']
        }
    },
    {
        name: 'set_reminder',
        description: 'Schedule a future task reminder or alarm for Lance (e.g. "in 30 mins", "in 2 hours", "tomorrow at 9am", "at 8:30pm"). Sends a Discord alert when due.',
        parameters: {
            type: 'object',
            properties: {
                task: {
                    type: 'string',
                    description: 'The task description or reminder text.'
                },
                timeString: {
                    type: 'string',
                    description: 'When to remind Lance, e.g. "in 30 mins", "in 2h", "tomorrow at 8am", "at 5:30pm".'
                }
            },
            required: ['task', 'timeString']
        }
    },
    {
        name: 'list_reminders',
        description: 'List all currently active, scheduled reminders and tasks for Lance.',
        parameters: {
            type: 'object',
            properties: {}
        }
    },
    {
        name: 'delete_reminder',
        description: 'Delete or cancel an upcoming reminder by ID or index number.',
        parameters: {
            type: 'object',
            properties: {
                id: {
                    type: 'string',
                    description: 'The reminder ID (e.g. "rem_123...") or numeric index.'
                }
            },
            required: ['id']
        }
    },
    {
        name: 'schedule_automation',
        description: 'Schedule a recurring autonomous Hermes Agent watcher or background task (e.g. "daily at 8am send my standup", "every 2 hours check https://example.com for price drops", "every 6 hours check git status"). Runs independently even when Lance is away.',
        parameters: {
            type: 'object',
            properties: {
                name: {
                    type: 'string',
                    description: 'Brief 2-5 word name describing the watcher or automation.'
                },
                scheduleStr: {
                    type: 'string',
                    description: 'When/how often to run: "every 30m", "every 1 hour", "every 2 hours", "daily at 8am", etc.'
                },
                prompt: {
                    type: 'string',
                    description: 'The task instructions or condition to monitor.'
                },
                url: {
                    type: 'string',
                    description: 'Optional URL to monitor for web watcher tasks.'
                }
            },
            required: ['name', 'scheduleStr', 'prompt']
        }
    },
    {
        name: 'list_automations',
        description: 'List all currently active scheduled autonomous watchers and background tasks.',
        parameters: {
            type: 'object',
            properties: {}
        }
    },
    {
        name: 'delete_automation',
        description: 'Cancel or delete an active automation by its ID or index number.',
        parameters: {
            type: 'object',
            properties: {
                id: {
                    type: 'string',
                    description: 'The automation ID (e.g. "auto_123...") or numeric index.'
                }
            },
            required: ['id']
        }
    },
    {
        name: 'unlock_tools',
        description: 'Unlock additional tool categories for this turn if a tool you need is not yet in your active list. Categories: "files", "code_edit", "discord", "memory", "web", "scheduling", or "all".',
        parameters: {
            type: 'object',
            properties: {
                categories: {
                    type: 'string',
                    description: 'Comma-separated categories to unlock: "files", "code_edit", "discord", "memory", "web", "scheduling", or "all".'
                }
            },
            required: ['categories']
        }
    }
];

const TOOL_CATEGORIES = {
    files: ['read_file', 'list_directory', 'search_files', 'find_files', 'send_file_to_owner'],
    code_edit: ['read_file', 'write_file', 'edit_file', 'propose_self_upgrade', 'run_command', 'search_files', 'list_directory'],
    discord: ['read_discord_channel', 'post_discord_message', 'set_owner_availability'],
    memory: ['remember_fact', 'save_preference', 'search_memory', 'set_persona_mode', 'update_project_task'],
    web: ['web_search', 'fetch_web_page'],
    scheduling: ['set_reminder', 'list_reminders', 'delete_reminder', 'schedule_automation', 'list_automations', 'delete_automation']
};

function _filterSpecs(allowedNames = null) {
    if (!allowedNames) return toolSpecs;
    const allowedSet = allowedNames instanceof Set ? allowedNames : new Set(allowedNames);
    return toolSpecs.filter(spec => allowedSet.has(spec.name));
}

/**
 * Infers the minimal relevant subset of tools for a given user query / task prompt.
 * Always keeps core proactive memory tools + `unlock_tools` so the agent can expand if needed.
 */
function inferToolNamesForQuery(query = '', extraCategories = []) {
    const text = String(query || '').toLowerCase();
    const names = new Set(['remember_fact', 'save_preference', 'unlock_tools']);
    const extras = Array.isArray(extraCategories) ? extraCategories : [extraCategories];

    if (extras.includes('all')) {
        return toolSpecs.map(s => s.name);
    }

    const addCategory = (cat) => {
        const list = TOOL_CATEGORIES[cat];
        if (list) list.forEach(n => names.add(n));
    };

    for (const cat of extras) {
        addCategory(cat);
    }

    let matchedAny = false;

    if (/\b(?:file|files|folder|dir|directory|downloads?|documents?|desktop|pdf|resume|cv|reviewer|notes?|txt|md|read|find|search|send\s+me|upload|attach|extract|contain|inside)\b/i.test(text)) {
        addCategory('files');
        matchedAny = true;
    }

    if (/\b(?:code|src|source|bug|fix|patch|edit|write|create\s+file|upgrade|propose|self[- ]?upgrade|run|command|cmd|terminal|shell|git|npm|node|test|script|package\.json|handler|service)\b/i.test(text)) {
        addCategory('code_edit');
        matchedAny = true;
    }

    if (/\b(?:discord|server|channel|banorant|banoranttt|rodericks|col|chat|messages?|recap|catch\s*up|summariz|post|reply|friends?|status|avail|availability|online|offline|away|afk|sleep|mute)\b/i.test(text)) {
        addCategory('discord');
        matchedAny = true;
    }

    if (/\b(?:remember|fact|memory|memories|forget|preference|prefer|rule|persona|formal|serious|casual|humor|mode|project|projects|task|tasks|balik|ti-to)\b/i.test(text)) {
        addCategory('memory');
        matchedAny = true;
    }

    if (/\b(?:web|google|internet|online|search|lookup|look\s*up|http|https|url|site|page|fetch|weather|rain|wttr|news|latest|price|docs?)\b/i.test(text)) {
        addCategory('web');
        matchedAny = true;
    }

    if (/\b(?:remind|reminder|alarm|schedule|automate|automation|cron|watch|watcher|monitor|every\s+\d+|daily\s+at|tomorrow|tonight|later)\b/i.test(text)) {
        addCategory('scheduling');
        matchedAny = true;
    }

    // Fallback for short/ambiguous follow-ups (e.g. "show it", "what happened", "check again")
    if (!matchedAny) {
        addCategory('files');
        addCategory('discord');
        addCategory('memory');
        addCategory('web');
    }

    return Array.from(names);
}

/**
 * Returns formatted Groq + Gemini tool arrays scoped to the inferred intent.
 */
function getToolsForQuery(query = '', extraCategories = []) {
    const toolNames = inferToolNamesForQuery(query, extraCategories);
    return {
        toolNames,
        groqTools: getGroqTools(toolNames),
        geminiTools: getGeminiTools(toolNames)
    };
}

/**
 * Returns tools formatted for OpenAI / Groq standard API.
 */
function getGroqTools(allowedNames = null) {
    return _filterSpecs(allowedNames).map(spec => ({
        type: 'function',
        function: {
            name: spec.name,
            description: spec.description,
            parameters: spec.parameters
        }
    }));
}

/**
 * Returns tools formatted for Google Gemini API schema.
 */
function getGeminiTools(allowedNames = null) {
    // Map standard JSON schema type to Gemini uppercase type
    function convertSchema(paramObj) {
        if (!paramObj) return { type: 'OBJECT', properties: {} };
        const copy = JSON.parse(JSON.stringify(paramObj));
        function fixTypes(node) {
            if (node.type) {
                node.type = node.type.toUpperCase();
            }
            if (node.properties) {
                for (const key of Object.keys(node.properties)) {
                    fixTypes(node.properties[key]);
                }
            }
        }
        fixTypes(copy);
        return copy;
    }

    return [{
        functionDeclarations: _filterSpecs(allowedNames).map(spec => ({
            name: spec.name,
            description: spec.description,
            parameters: convertSchema(spec.parameters)
        }))
    }];
}

/**
 * Executes a tool by name with arguments against the corresponding service.
 */
async function executeTool(name, rawArgs, { config, workspaceService, reminderService, webSearchService, automationService, selfUpgradeService, channelHistory, ownerAvailability, memoryManager, client, automationState, channelCheckStats, userId, channelId, isDM = false }) {
    let args = rawArgs;
    if (typeof args === 'string') {
        try {
            args = JSON.parse(args);
        } catch (e) {
            return { error: `Failed to parse tool arguments: ${e.message}` };
        }
    }
    args = args || {};

    try {
        switch (name) {
            case 'web_search': {
                if (!webSearchService) return { error: 'WebSearchService is not available.' };
                return await webSearchService.search(args.query, args.maxResults);
            }

            case 'fetch_web_page': {
                if (!webSearchService) return { error: 'WebSearchService is not available.' };
                return await webSearchService.fetchPage(args.url, args.maxChars);
            }

            case 'read_file': {
                if (!workspaceService) return { error: 'WorkspaceService is not available.' };
                return await workspaceService.readFile(args.filePath, args.maxLines, args.offset);
            }

            case 'write_file': {
                if (!workspaceService) return { error: 'WorkspaceService is not available.' };
                if (selfUpgradeService && selfUpgradeService.requiresPermission(args.filePath)) {
                    const proposal = selfUpgradeService.stageProposal({
                        filePath: args.filePath,
                        operation: 'write',
                        content: args.content,
                        reason: args.reason || `Write to protected source file ${args.filePath}`,
                        userId,
                        channelId
                    });
                    return {
                        status: 'pending_owner_approval',
                        proposalId: proposal.id,
                        filePath: proposal.filePath,
                        message: `Staged self-upgrade proposal [${proposal.id}] for "${proposal.filePath}". Explain the change to Lance and ask him to reply "approve" (or "yes") to apply it.`
                    };
                }
                return await workspaceService.writeFile(args.filePath, args.content);
            }

            case 'edit_file': {
                if (!workspaceService) return { error: 'WorkspaceService is not available.' };
                if (selfUpgradeService && selfUpgradeService.requiresPermission(args.filePath)) {
                    const proposal = selfUpgradeService.stageProposal({
                        filePath: args.filePath,
                        operation: 'edit',
                        targetContent: args.targetContent,
                        replacementContent: args.replacementContent,
                        reason: args.reason || `Edit protected source file ${args.filePath}`,
                        userId,
                        channelId
                    });
                    return {
                        status: 'pending_owner_approval',
                        proposalId: proposal.id,
                        filePath: proposal.filePath,
                        message: `Staged self-upgrade proposal [${proposal.id}] for "${proposal.filePath}". Explain the fix/upgrade to Lance and ask him to reply "approve" (or "yes") to apply it.`
                    };
                }
                return await workspaceService.editFile(args.filePath, args.targetContent, args.replacementContent);
            }

            case 'propose_self_upgrade': {
                if (!selfUpgradeService) return { error: 'SelfUpgradeService is not available.' };
                const proposal = selfUpgradeService.stageProposal({
                    filePath: args.filePath,
                    operation: args.operation === 'write' ? 'write' : 'edit',
                    targetContent: args.targetContent,
                    replacementContent: args.replacementContent,
                    content: args.content,
                    reason: args.reason,
                    userId,
                    channelId
                });
                return {
                    status: 'pending_owner_approval',
                    proposalId: proposal.id,
                    filePath: proposal.filePath,
                    reason: proposal.reason,
                    message: `Staged self-upgrade proposal [${proposal.id}] for "${proposal.filePath}". A permission request card will be shown to Lance so he can reply "approve" or "reject".`
                };
            }

            case 'read_discord_channel': {
                if (!channelHistory) return { error: 'ChannelHistoryService is not available.' };
                const targetCh = channelHistory.resolveTargetChannel(args.target || '');
                if (!targetCh) {
                    return { error: `Could not find a readable text channel matching "${args.target}". Connected servers: col (873791689939107861), rodericks (1422544961597083712), BANORANTTT (1484106877708013608).` };
                }

                const cursorId = args.afterMessageId || automationState?.channelCursors?.[targetCh.id] || null;
                const ownerIds = ownerAvailability?.getOwnerIds?.()
                    || config?.discord?.allowedUserIds
                    || (userId ? [userId] : []);
                const data = await channelHistory.fetchRecentTranscript(targetCh, args.limit || 20, cursorId, ownerIds);

                if (automationState && data.latestMessageId) {
                    automationState.channelCursors = automationState.channelCursors || {};
                    automationState.channelCursors[targetCh.id] = data.latestMessageId;
                }

                const availState = ownerAvailability ? ownerAvailability.getAvailabilityState() : null;
                const ownerIsAvailable = availState?.state === 'AVAILABLE';
                const noOtherUserActivity = Boolean(
                    automationState &&
                    cursorId &&
                    (data.newMessageCount === 0 || data.nonOwnerNewMessageCount === 0 || data.ownerPostedInNewBatch || ownerIsAvailable)
                );

                if (channelCheckStats) {
                    channelCheckStats.checkedChannels += 1;
                    if (cursorId) channelCheckStats.hadBaselineCursor = true;
                    if (!noOtherUserActivity) {
                        channelCheckStats.totalNewMessages += (data.nonOwnerNewMessageCount ?? data.newMessageCount ?? 0);
                    }
                }

                if (noOtherUserActivity) {
                    return {
                        server: data.guildName,
                        channel: `#${data.channelName}`,
                        channelId: targetCh.id,
                        status: 'NO_ALERT_NEEDED',
                        newMessageCount: 0,
                        ownerAvailability: availState?.state || 'UNKNOWN',
                        message: data.ownerPostedInNewBatch || ownerIsAvailable
                            ? 'Lance is currently active/AVAILABLE or already participating in this channel. Do NOT send a notification; reply starting with [NO_ALERT].'
                            : 'No new messages from other users in this channel since the last check. Reply starting with [NO_ALERT].'
                    };
                }

                return {
                    server: data.guildName,
                    channel: `#${data.channelName}`,
                    channelId: targetCh.id,
                    messageCount: data.messageCount,
                    newMessageCount: data.newMessageCount,
                    nonOwnerNewMessageCount: data.nonOwnerNewMessageCount,
                    transcript: (cursorId && data.newMessageCount > 0 ? data.newTranscript : data.transcript) || '(No recent messages)'
                };
            }

            case 'post_discord_message': {
                if (!channelHistory) return { error: 'ChannelHistoryService is not available.' };
                if (!args.message || !args.message.trim()) {
                    return { error: 'Message content cannot be empty.' };
                }
                const targetCh = channelHistory.resolveTargetChannel(args.target || '');
                if (!targetCh) {
                    return { error: `Could not find a readable text channel matching "${args.target}". Connected servers: col (873791689939107861), rodericks (1422544961597083712), BANORANTTT (1484106877708013608).` };
                }
                if (!targetCh.isTextBased()) {
                    return { error: `Channel "${targetCh.name}" is not text-based.` };
                }
                const sent = await targetCh.send(args.message.trim());
                return {
                    success: true,
                    messageId: sent.id,
                    server: targetCh.guild?.name || 'Direct Messages',
                    channel: `#${targetCh.name || 'channel'}`,
                    content: args.message.trim()
                };
            }

            case 'set_owner_availability': {
                if (!ownerAvailability) return { error: 'OwnerAvailabilityService is not available.' };
                const stateArg = (args.state || 'status').toLowerCase().trim();
                if (stateArg === 'status' || stateArg === 'check' || stateArg === 'get' || stateArg === 'current') {
                    const current = ownerAvailability.getAvailabilityState();
                    return {
                        success: true,
                        readOnly: true,
                        state: current.state,
                        confidence: current.confidence,
                        reason: current.reason,
                        manualUntil: current.manualUntil || null
                    };
                }
                if (stateArg === 'online' || stateArg === 'available' || stateArg === 'on' || stateArg === 'active') {
                    ownerAvailability.suppressChannel('global', 60 * 60 * 1000);
                    const res = ownerAvailability.setManualState('on', args.reason || 'Active (confirmed by Lance)');
                    return {
                        success: true,
                        state: 'AVAILABLE',
                        message: res.message || 'Status set to AVAILABLE. AFK auto-replies to friends are suppressed.'
                    };
                }
                const res = ownerAvailability.setManualState(stateArg, args.reason || null);
                if (res.error) return { error: res.error };
                return {
                    success: true,
                    state: res.state,
                    message: res.message
                };
            }

            case 'list_directory': {
                if (!workspaceService) return { error: 'WorkspaceService is not available.' };
                return await workspaceService.listDirectory(args.dirPath || args.path || '.', args.depth || 1);
            }

            case 'search_files': {
                if (!workspaceService) return { error: 'WorkspaceService is not available.' };
                return await workspaceService.searchFiles(args.query, args.dirPath || args.path || args.file || '.', 20);
            }

            case 'find_files': {
                if (!workspaceService) return { error: 'WorkspaceService is not available.' };
                return await workspaceService.findFilesByName(args.query, args.location || 'all', 25);
            }

            case 'send_file_to_owner': {
                if (!workspaceService) return { error: 'WorkspaceService is not available.' };
                if (!client || !userId) return { error: 'Discord client or owner userId is not available.' };

                const fullPath = workspaceService.resolveReadPath(args.filePath);
                if (!fs.existsSync(fullPath)) {
                    return { error: `File not found: "${args.filePath}". Use find_files first to verify the exact path.` };
                }
                const stat = fs.statSync(fullPath);
                if (!stat.isFile()) {
                    return { error: `"${args.filePath}" is a directory, not a file.` };
                }
                const maxBytes = 25 * 1024 * 1024;
                if (stat.size > maxBytes) {
                    return { error: `File "${path.basename(fullPath)}" is ${(stat.size / (1024 * 1024)).toFixed(2)} MB, which exceeds Discord's 25 MB upload limit.` };
                }

                const ownerUser = await client.users.fetch(userId);
                if (!ownerUser) {
                    return { error: `Could not fetch Discord user ${userId}.` };
                }

                const fileName = path.basename(fullPath);
                await ownerUser.send({
                    content: args.caption ? `${args.caption}\n📎 \`${fileName}\`` : `📎 **File from your PC:** \`${fileName}\``,
                    files: [fullPath]
                });

                return {
                    success: true,
                    fileName,
                    sizeBytes: stat.size,
                    deliveredToDM: userId
                };
            }

            case 'remember_fact': {
                if (!memoryManager?.facts) return { error: 'FactStore is not available.' };
                const entry = memoryManager.facts.addFact(args.fact, args.category || null);
                return {
                    success: true,
                    factId: entry.id,
                    category: entry.category,
                    fact: entry.fact
                };
            }

            case 'save_preference': {
                if (!memoryManager?.preferences) return { error: 'PreferenceStore is not available.' };
                const item = memoryManager.preferences.addPreference(args.rule, args.category || 'workflow', 'agent');
                if (!item) return { error: 'Preference rule is too short or invalid.' };
                return {
                    success: true,
                    preferenceId: item.id,
                    category: item.category,
                    rule: item.rule
                };
            }

            case 'search_memory': {
                if (!memoryManager) return { error: 'MemoryManager is not available.' };
                const q = args.query || '';
                return {
                    query: q,
                    facts: memoryManager.facts?.search(q, 5) || [],
                    preferences: (memoryManager.preferences?.listPreferences() || []).filter(p => !q || p.rule.toLowerCase().includes(q.toLowerCase())).slice(0, 8),
                    projects: memoryManager.projects?.getRelevantProjects(q) || [],
                    episodicMatches: (memoryManager.episodic?.retrieve(q, 5, { isDM: true, includeGuild: true }) || []).map(m => ({
                        date: m.date,
                        scope: m.scope || 'unknown',
                        role: m.role,
                        excerpt: (m.content || '').slice(0, 220)
                    }))
                };
            }

            case 'set_persona_mode': {
                const mode = (args.mode || 'formal').toLowerCase().trim();
                let level = args.humorLevel !== undefined ? parseInt(args.humorLevel, 10) : NaN;
                if (isNaN(level)) {
                    if (mode === 'formal' || mode === 'serious' || mode === 'professional') level = 0;
                    else if (mode === 'casual') level = 1;
                    else if (mode === 'humorous' || mode === 'playful') level = 3;
                    else level = 0;
                }
                level = Math.max(0, Math.min(5, level));
                if (config?.persona) {
                    config.persona.humorIntensity = level;
                }
                const ruleText = args.rule || (level === 0
                    ? 'Operate strictly as a formal, professional, and direct personal agent. Do not make jokes, roast files, or use sarcastic banter.'
                    : `Operate in ${mode} mode (humor intensity ${level}).`);
                if (memoryManager?.preferences) {
                    memoryManager.preferences.addPreference(ruleText, 'communication', 'agent');
                }
                return {
                    success: true,
                    mode,
                    humorLevel: level,
                    ruleSaved: ruleText
                };
            }

            case 'update_project_task': {
                if (!memoryManager?.projects) return { error: 'ProjectStore is not available.' };
                const action = (args.action || 'add').toLowerCase().trim();
                if (action === 'complete' || action === 'done' || action === 'remove') {
                    const res = memoryManager.projects.completeTask(args.project, args.task);
                    if (!res.project) return { error: `No tracked project found matching "${args.project}".` };
                    if (!res.removed) return { error: `No matching task found for "${args.task}" on project "${res.project.name}".` };
                    return { success: true, project: res.project.name, completedTask: res.removed, remainingTasks: res.project.tasks.length };
                }
                const updated = memoryManager.projects.addTask(args.project, args.task);
                if (!updated) return { error: `No tracked project found matching "${args.project}".` };
                return { success: true, project: updated.name, addedTask: args.task, totalTasks: updated.tasks.length };
            }

            case 'run_command': {
                if (!workspaceService) return { error: 'WorkspaceService is not available.' };
                return await workspaceService.runCommand(args.command);
            }

            case 'set_reminder': {
                if (!reminderService) return { error: 'ReminderService is not available.' };
                const parsed = reminderService.parseNaturalTime(args.timeString);
                if (!parsed) {
                    return { error: `Could not understand time format: "${args.timeString}". Try "in 30 mins", "in 2h", "tomorrow at 9am", or "at 5pm".` };
                }
                const rem = reminderService.addReminder({
                    userId,
                    channelId,
                    isDM,
                    task: args.task,
                    dueAt: parsed.timestamp,
                    dueTimeStr: parsed.formatted
                });
                return {
                    success: true,
                    reminderId: rem.id,
                    task: rem.task,
                    scheduledFor: rem.dueTimeStr
                };
            }

            case 'list_reminders': {
                if (!reminderService) return { error: 'ReminderService is not available.' };
                const list = reminderService.listReminders(userId);
                return {
                    count: list.length,
                    reminders: list.map((r, i) => ({
                        index: i + 1,
                        id: r.id,
                        task: r.task,
                        dueAt: r.dueTimeStr
                    }))
                };
            }

            case 'delete_reminder': {
                if (!reminderService) return { error: 'ReminderService is not available.' };
                return reminderService.deleteReminder(args.id, userId);
            }

            case 'schedule_automation': {
                if (!automationService) return { error: 'AutomationService is not available.' };
                try {
                    const auto = automationService.addAutomation({
                        name: args.name,
                        scheduleStr: args.scheduleStr,
                        prompt: args.prompt,
                        url: args.url,
                        userId,
                        channelId,
                        isDM
                    });
                    return {
                        success: true,
                        automationId: auto.id,
                        name: auto.name,
                        schedule: auto.scheduleStr,
                        nextRun: new Date(auto.scheduleMeta.nextRun).toLocaleString()
                    };
                } catch (e) {
                    return { error: e.message };
                }
            }

            case 'list_automations': {
                if (!automationService) return { error: 'AutomationService is not available.' };
                const list = automationService.listAutomations(userId);
                return {
                    count: list.length,
                    automations: list.map((a, i) => ({
                        index: i + 1,
                        id: a.id,
                        name: a.name,
                        schedule: a.scheduleStr,
                        nextRun: new Date(a.scheduleMeta?.nextRun || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                        lastStatus: a.lastStatus
                    }))
                };
            }

            case 'delete_automation': {
                if (!automationService) return { error: 'AutomationService is not available.' };
                return automationService.deleteAutomation(args.id, userId);
            }

            case 'unlock_tools': {
                const rawCats = String(args.categories || 'all')
                    .toLowerCase()
                    .split(/[,\s]+/)
                    .map(s => s.trim())
                    .filter(Boolean);
                const unlockedSet = new Set();
                if (rawCats.includes('all')) {
                    toolSpecs.forEach(s => unlockedSet.add(s.name));
                } else {
                    for (const cat of rawCats) {
                        const list = TOOL_CATEGORIES[cat];
                        if (list) list.forEach(n => unlockedSet.add(n));
                    }
                }
                const unlockedToolNames = Array.from(unlockedSet);
                return {
                    success: unlockedToolNames.length > 0,
                    unlockedCategories: rawCats,
                    unlockedTools: unlockedToolNames,
                    message: unlockedToolNames.length > 0
                        ? `Unlocked tools (${unlockedToolNames.join(', ')}). Proceed to invoke the required tool now.`
                        : `Unknown category "${args.categories}". Valid categories: files, code_edit, discord, memory, web, scheduling, all.`
                };
            }

            default:
                return { error: `Unknown tool: "${name}"` };
        }
    } catch (err) {
        return { error: err.message };
    }
}

module.exports = {
    toolSpecs,
    TOOL_CATEGORIES,
    inferToolNamesForQuery,
    getToolsForQuery,
    getGroqTools,
    getGeminiTools,
    executeTool
};

