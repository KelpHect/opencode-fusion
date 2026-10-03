import { Plugin } from '@opencode/plugin';
import { COMMAND_HELP, INPUT_TEXT, PLUGIN_ID, TOOL_NAMES, TOOL_TEXT, } from './policy.js';
import { FusionController, stripUndefined } from './controller.js';
import { resolveOptions } from './options.js';
import { FusionError } from './types.js';
export { FusionController, stripUndefined, workerAgentIDFor } from './controller.js';
export { resolveOptions } from './options.js';
export { parseModelReference, canonicalRef, findAvailable, requireAvailable, sameRef, safeModelListing, } from './models.js';
export { FusionStore, MutexMap, STATE_PREFIX, stateKey } from './storage.js';
export { LeaseRegistry, canonicalDirectory, isReadOnlyTool } from './lease.js';
export { FusionError } from './types.js';
const NOTICE_CODES = new Set(['disabled', 'busy', 'budget', 'nested', 'blocked_write']);
function errorText(error) {
    if (error instanceof FusionError && NOTICE_CODES.has(error.code))
        return error.message;
    if (error instanceof FusionError)
        return JSON.stringify({ error: error.code, detail: error.message });
    return JSON.stringify({ error: 'internal', detail: String(error) });
}
async function emit(ctx, sessionID, output) {
    const text = output.text ?? JSON.stringify(output.data ?? {});
    await ctx.session.synthetic({
        sessionID,
        text,
        resume: false,
        delivery: 'queue',
    });
}
async function emitError(ctx, sessionID, error) {
    await emit(ctx, sessionID, { text: errorText(error) });
}
async function runCommand(controller, sessionID, args) {
    const verb = args[0] ?? 'help';
    switch (verb) {
        case 'configure': {
            if (args.length !== 3)
                return { text: COMMAND_HELP };
            return controller.configure(sessionID, args[1], args[2]);
        }
        case 'status':
            return controller.status(sessionID);
        case 'models':
            return controller.models();
        case 'pause':
            return controller.pause(sessionID);
        case 'resume':
            return controller.resume(sessionID);
        case 'off':
            return controller.disable(sessionID);
        case 'wait':
            return controller.wait(sessionID);
        case 'reset':
            return controller.reset(sessionID);
        default:
            return { text: COMMAND_HELP };
    }
}
async function setupFusion(ctx) {
    const options = resolveOptions(ctx.options);
    const controller = new FusionController(ctx, options);
    const registrations = [];
    registrations.push(await ctx.tool.transform((editor) => {
        editor.add({
            name: TOOL_NAMES.delegate,
            description: TOOL_TEXT.delegate,
            input: {
                type: 'object',
                properties: {
                    task: { type: 'string', description: INPUT_TEXT.task },
                    brief: { type: 'string', description: INPUT_TEXT.brief },
                    background: { type: 'boolean', description: INPUT_TEXT.background },
                },
                required: ['task', 'brief'],
                additionalProperties: false,
            },
            options: { codemode: false },
            execute: async (input, context) => {
                try {
                    return await controller.delegate(input, context);
                }
                catch (error) {
                    return { content: errorText(error) };
                }
            },
        });
        editor.add({
            name: TOOL_NAMES.status,
            description: TOOL_TEXT.status,
            input: { type: 'object', properties: {}, additionalProperties: false },
            options: { codemode: false },
            execute: async (_input, context) => {
                try {
                    const result = await controller.status(context.sessionID);
                    return {
                        content: result.text ?? JSON.stringify(result.data ?? {}),
                        metadata: stripUndefined(result.data ?? {}),
                    };
                }
                catch (error) {
                    return { content: errorText(error) };
                }
            },
        });
        editor.add({
            name: TOOL_NAMES.wait,
            description: TOOL_TEXT.wait,
            input: { type: 'object', properties: {}, additionalProperties: false },
            options: { codemode: false },
            execute: async (_input, context) => {
                try {
                    const result = await controller.wait(context.sessionID, context.signal);
                    return {
                        content: result.text ?? JSON.stringify(result.data ?? {}),
                        metadata: stripUndefined(result.data ?? {}),
                    };
                }
                catch (error) {
                    return { content: errorText(error) };
                }
            },
        });
    }));
    registrations.push(await ctx.agent.transform((editor) => {
        for (const [id, def] of controller.workerDefinitions) {
            editor.update(id, (agent) => {
                agent.name = def.name;
                agent.mode = def.mode;
                agent.hidden = def.hidden;
                agent.description = def.description;
                agent.system = def.system;
                agent.steps = def.steps;
                agent.model = undefined;
                agent.permissions = [...def.permissions];
            });
        }
    }));
    registrations.push(await ctx.command.transform((editor) => {
        editor.add({
            name: 'fusion',
            description: COMMAND_HELP,
            execute: async (invocation) => {
                const sessionID = invocation.sessionID;
                try {
                    const raw = (invocation.prompt?.text ?? '').trim();
                    const stripped = raw.replace(/^\/?fusion\b/i, '').trim();
                    const args = stripped.length === 0 ? [] : stripped.split(/\s+/);
                    const output = await runCommand(controller, sessionID, args);
                    await emit(ctx, sessionID, output);
                }
                catch (error) {
                    await emitError(ctx, sessionID, error).catch(() => undefined);
                }
            },
        });
    }));
    registrations.push(await ctx.session.hook('context', (input) => controller.applyContext(input)));
    registrations.push(await ctx.session.hook('compaction', (input) => controller.applyCompaction(input)));
    registrations.push(await ctx.tool.hook('execute.before', (input) => controller.guardToolCall({
        tool: input.tool,
        sessionID: input.sessionID,
        agent: input.agent,
    })));
    const events = new AbortController();
    void (async () => {
        try {
            for await (const event of ctx.event.subscribe({ signal: events.signal })) {
                if (events.signal.aborted)
                    return;
                if (event.type === 'session.execution.interrupted') {
                    const data = event.data;
                    if (data.sessionID && (data.reason === 'user' || data.reason === 'shutdown')) {
                        await controller
                            .onSessionInterrupted(data.sessionID, data.reason)
                            .catch(() => undefined);
                    }
                }
                else if (event.type === 'session.model.selected') {
                    const data = event.data;
                    if (data.sessionID && data.model) {
                        await controller.onModelSelected(data.sessionID, data.model).catch(() => undefined);
                    }
                }
            }
        }
        catch { }
    })();
    await controller.recover();
    return async () => {
        events.abort();
        await controller.dispose().catch(() => undefined);
        for (const registration of registrations) {
            await registration.dispose().catch(() => undefined);
        }
    };
}
export default Plugin.define({
    id: PLUGIN_ID,
    setup: setupFusion,
});
