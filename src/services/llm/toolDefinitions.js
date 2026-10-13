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
        description: 'Create a new file or completely overwrite an existing file inside the project workspace.',
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
                }
            },
            required: ['filePath', 'content']
        }
    },
    {
        name: 'edit_file',
        description: 'Perform an exact substring replacement in a file. Ideal for precise code modifications and updating specific functions without wiping the file.',
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
                }
            },
            required: ['filePath', 'targetContent', 'replacementContent']
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
async function executeTool(name, rawArgs, { workspaceService, reminderService, userId, channelId, isDM = false }) {
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
            case 'read_file': {
                if (!workspaceService) return { error: 'WorkspaceService is not available.' };
                return await workspaceService.readFile(args.filePath, args.maxLines, args.offset);
            }

            case 'write_file': {
                if (!workspaceService) return { error: 'WorkspaceService is not available.' };
                return await workspaceService.writeFile(args.filePath, args.content);
            }

            case 'edit_file': {
                if (!workspaceService) return { error: 'WorkspaceService is not available.' };
                return await workspaceService.editFile(args.filePath, args.targetContent, args.replacementContent);
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
