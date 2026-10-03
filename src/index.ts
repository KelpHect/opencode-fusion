import { Plugin } from '@opencode/plugin'
import {
  COMMAND_HELP,
  INPUT_TEXT,
  NOTICE,
  PLUGIN_ID,
  TOOL_NAMES,
  TOOL_TEXT,
} from './policy.js'
import { FusionController, stripUndefined, type CommandOutput } from './controller.js'
import { canonicalRef } from './models.js'
import { resolveOptions, resolvePresets } from './options.js'
import { registerPresets, type ResolvedPreset } from './presets.js'
import { FusionError, type ToolContextLike } from './types.js'

export { FusionController, stripUndefined, workerAgentIDFor } from './controller.js'
export { resolveOptions, resolvePresets } from './options.js'
export { registerPresets } from './presets.js'
export type { PresetRegistration, ResolvedPreset } from './presets.js'
export {
  parseModelReference,
  canonicalRef,
  findAvailable,
  requireAvailable,
  sameRef,
  safeModelListing,
} from './models.js'
export { FusionStore, MutexMap, STATE_PREFIX, stateKey } from './storage.js'
export { LeaseRegistry, canonicalDirectory, isReadOnlyTool } from './lease.js'
export { FusionError } from './types.js'
export type {
  ControllerDeps,
  FusionOptions,
  FusionPreset,
  JobRecord,
  ModelReference,
  Runner,
  RunnerInput,
  RunnerResult,
  SessionState,
  StorageLike,
  ToolContextLike,
} from './types.js'

const NOTICE_CODES = new Set(['disabled', 'busy', 'budget', 'nested', 'blocked_write'])

function errorText(error: unknown): string {
  if (error instanceof FusionError && NOTICE_CODES.has(error.code)) return error.message
  if (error instanceof FusionError) return JSON.stringify({ error: error.code, detail: error.message })
  return JSON.stringify({ error: 'internal', detail: String(error) })
}

async function emit(
  ctx: Plugin.Context,
  sessionID: string,
  output: CommandOutput,
): Promise<void> {
  const text = output.text ?? JSON.stringify(output.data ?? {})
  await ctx.session.synthetic({
    sessionID,
    text,
    resume: false,
    delivery: 'queue',
  } as never)
}

async function emitError(ctx: Plugin.Context, sessionID: string, error: unknown): Promise<void> {
  await emit(ctx, sessionID, { text: errorText(error) })
}

async function runCommand(
  controller: FusionController,
  sessionID: string,
  args: string[],
): Promise<CommandOutput> {
  const verb = args[0] ?? 'help'
  switch (verb) {
    case 'configure': {
      if (args.length !== 3) return { text: COMMAND_HELP }
      return controller.configure(sessionID, args[1], args[2])
    }
    case 'status':
      return controller.status(sessionID)
    case 'models':
      return controller.models()
    case 'pause':
      return controller.pause(sessionID)
    case 'resume':
      return controller.resume(sessionID)
    case 'off':
      return controller.disable(sessionID)
    case 'wait':
      return controller.wait(sessionID)
    case 'reset':
      return controller.reset(sessionID)
    default:
      return { text: COMMAND_HELP }
  }
}

async function setupFusion(ctx: Plugin.Context) {
  const rawOptions = ctx.options as Record<string, unknown> | undefined
  const options = resolveOptions(rawOptions)
  const controller = new FusionController(ctx, options)
  const registrations: { dispose: () => Promise<void> }[] = []

  // `/models` presets: each entry becomes a composite model under a
  // `opencode-fusion-*` provider. Selecting it configures the session.
  // Registration retries until the lead provider appears (plugin load order is
  // arbitrary), so it runs in the background and must not delay setup.
  const declared = resolvePresets(rawOptions)
  const presetByModel = new Map<string, ResolvedPreset>()
  if (declared.length > 0) {
    void (async () => {
      const registration = await registerPresets(ctx, declared, registrations)
      controller.setPresets(registration)
      for (const preset of registration.presets) {
        presetByModel.set(`${preset.providerID}/${preset.modelID}`, preset)
      }
    })().catch(() => undefined)
  }

  registrations.push(
    await ctx.tool.transform((editor) => {
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
        execute: async (input: { task: string; brief: string; background?: boolean }, context: ToolContextLike) => {
          try {
            return await controller.delegate(input, context)
          } catch (error) {
            return { content: errorText(error) }
          }
        },
      } as never)
      editor.add({
        name: TOOL_NAMES.status,
        description: TOOL_TEXT.status,
        input: { type: 'object', properties: {}, additionalProperties: false },
        options: { codemode: false },
        execute: async (_input: unknown, context: ToolContextLike) => {
          try {
            const result = await controller.status(context.sessionID)
            return {
              content: result.text ?? JSON.stringify(result.data ?? {}),
              metadata: stripUndefined((result.data as Record<string, unknown>) ?? {}),
            }
          } catch (error) {
            return { content: errorText(error) }
          }
        },
      } as never)
      editor.add({
        name: TOOL_NAMES.wait,
        description: TOOL_TEXT.wait,
        input: { type: 'object', properties: {}, additionalProperties: false },
        options: { codemode: false },
        execute: async (_input: unknown, context: ToolContextLike) => {
          try {
            const result = await controller.wait(context.sessionID, context.signal)
            return {
              content: result.text ?? JSON.stringify(result.data ?? {}),
              metadata: stripUndefined((result.data as Record<string, unknown>) ?? {}),
            }
          } catch (error) {
            return { content: errorText(error) }
          }
        },
      } as never)
    }),
  )

  registrations.push(
    await ctx.agent.transform((editor) => {
      for (const [id, def] of controller.workerDefinitions) {
        editor.update(id, (agent) => {
          agent.name = def.name as unknown as typeof agent.name
          agent.mode = def.mode
          agent.hidden = def.hidden
          agent.description = def.description
          agent.system = def.system
          agent.steps = def.steps
          agent.model = undefined
          agent.permissions = [...def.permissions] as never
        })
      }
    }),
  )

  registrations.push(
    await ctx.command.transform((editor) => {
      editor.add({
        name: 'fusion',
        description: COMMAND_HELP,
        execute: async (invocation) => {
          const sessionID = invocation.sessionID
          try {
            const raw = (invocation.prompt?.text ?? '').trim()
            const stripped = raw.replace(/^\/?fusion\b/i, '').trim()
            const args = stripped.length === 0 ? [] : stripped.split(/\s+/)
            const output = await runCommand(controller, sessionID, args)
            await emit(ctx, sessionID, output)
          } catch (error) {
            await emitError(ctx, sessionID, error).catch(() => undefined)
          }
        },
      })
    }),
  )

  registrations.push(
    await ctx.session.hook('context', (input) => controller.applyContext(input as never)),
  )
  registrations.push(
    await ctx.session.hook('compaction', (input) =>
      controller.applyCompaction(input as never),
    ),
  )
  registrations.push(
    await ctx.tool.hook('execute.before', (input) =>
      controller.guardToolCall({
        tool: input.tool,
        sessionID: input.sessionID,
        agent: input.agent,
      }),
    ),
  )

  const events = new AbortController()
  void (async () => {
    try {
      for await (const event of ctx.event.subscribe({ signal: events.signal })) {
        if (events.signal.aborted) return
        if (event.type === 'session.execution.interrupted') {
          const data = event.data as { sessionID?: string; reason?: string }
          if (data.sessionID && (data.reason === 'user' || data.reason === 'shutdown')) {
            await controller
              .onSessionInterrupted(data.sessionID, data.reason)
              .catch(() => undefined)
          }
        } else if (event.type === 'session.model.selected') {
          const data = event.data as {
            sessionID?: string
            model?: { id: string; providerID: string; variant?: string }
          }
          if (data.sessionID && data.model) {
            const preset = presetByModel.get(`${data.model.providerID}/${data.model.id}`)
            if (preset) {
              await controller
                .configure(data.sessionID, canonicalRef(preset.lead), preset.partner, {
                  composite: {
                    providerID: data.model.providerID,
                    id: data.model.id,
                    variant: data.model.variant,
                  },
                })
                .catch((error) =>
                  emitError(ctx, data.sessionID as string, error).catch(() => undefined),
                )
            } else {
              await controller.onModelSelected(data.sessionID, data.model).catch(() => undefined)
            }
          }
        }
      }
    } catch {}
  })()

  await controller.recover()

  return async () => {
    events.abort()
    await controller.dispose().catch(() => undefined)
    for (const registration of registrations) {
      await registration.dispose().catch(() => undefined)
    }
  }
}
export default Plugin.define({
  id: PLUGIN_ID,
  setup: setupFusion,
})
