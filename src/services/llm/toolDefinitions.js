/**
 * Tool definitions and execution mapping for ZenBot's Agentic capabilities.
 * Strictly restricted to Lance (owner) to safeguard workspace and system integrity.
 */

const toolSpecs = [
    {
        name: 'read_file',
        description: 'Read contents of a file inside the project workspace with line numbers. Use this to inspect code, notes, configurations, or logs.',
        parameters: {
            type: 'object',
            properties: {
                filePath: {
                    type: 'string',
                    description: 'Relative path of the file to read (e.g. "package.json", "src/bot.js", "data/facts.json").'
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
        name: 'list_directory',
        description: 'List files and directories inside the project workspace.',
        parameters: {
            type: 'object',
            properties: {
                dirPath: {
                    type: 'string',
                    description: 'Relative directory path to inspect (default: ".").'
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
        description: 'Search for a string, function name, or keyword across all text files in the project workspace.',
        parameters: {
            type: 'object',
            properties: {
                query: {
                    type: 'string',
                    description: 'The text or identifier to search for.'
                },
                dirPath: {
                    type: 'string',
                    description: 'Directory to start searching from (default: ".").'
                }
            },
            required: ['query']
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
    }
];

/**
 * Returns tools formatted for OpenAI / Groq standard API.
 */
function getGroqTools() {
    return toolSpecs.map(spec => ({
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
function getGeminiTools() {
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
        functionDeclarations: toolSpecs.map(spec => ({
            name: spec.name,
            description: spec.description,
            parameters: convertSchema(spec.parameters)
        }))
    }];
}

/**
 * Executes a tool by name with arguments against the corresponding service.
 */
async function executeTool(name, rawArgs, { workspaceService, reminderService, webSearchService, automationService, selfUpgradeService, channelHistory, userId, channelId, isDM = false }) {
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
                const data = await channelHistory.fetchRecentTranscript(targetCh, args.limit || 20);
                return {
                    server: data.guildName,
                    channel: `#${data.channelName}`,
                    channelId: targetCh.id,
                    messageCount: data.messageCount,
                    transcript: data.transcript || '(No recent messages)'
                };
            }

            case 'list_directory': {
                if (!workspaceService) return { error: 'WorkspaceService is not available.' };
                return await workspaceService.listDirectory(args.dirPath || '.', args.depth || 1);
            }

            case 'search_files': {
                if (!workspaceService) return { error: 'WorkspaceService is not available.' };
                return await workspaceService.searchFiles(args.query, args.dirPath || '.', 20);
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

            default:
                return { error: `Unknown tool: "${name}"` };
        }
    } catch (err) {
        return { error: err.message };
    }
}

module.exports = {
    toolSpecs,
    getGroqTools,
    getGeminiTools,
    executeTool
};

