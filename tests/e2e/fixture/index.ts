import { Plugin, Provider, Model } from '@opencode/plugin'
import { leadModel, log, workerModel } from './models.js'

export default Plugin.define({
  id: 'local.fusion-e2e-fixture',
  setup: async (ctx) => {
    const sdk = `aisdk:${new URL('./sdk.ts', import.meta.url).href}`
    await ctx.provider.transform((editor) => {
      editor.add({
        info: {
          ...Provider.Info.empty(Provider.ID.make('fakeproviderA')),
          name: 'Fusion fixture A',
          activation: 'enabled',
          package: sdk,
        },
        models: [
          Model.Info.make({
            ...Model.Info.default(Provider.ID.make('fakeproviderA'), Model.ID.make('lead')),
            name: 'Fixture lead',
            capabilities: { tools: true, input: ['text'], output: ['text'] },
            limit: { context: 200_000, output: 32_000 },
            cost: [],
            variants: [{ id: Model.VariantID.make('max'), settings: { reasoningEffort: 'max' } }],
          }),
        ],
      })
      editor.add({
        info: {
          ...Provider.Info.empty(Provider.ID.make('fakeproviderB')),
          name: 'Fusion fixture B',
          activation: 'enabled',
          package: sdk,
        },
        models: [
          Model.Info.make({
            ...Model.Info.default(Provider.ID.make('fakeproviderB'), Model.ID.make('worker')),
            name: 'Fixture worker',
            capabilities: { tools: true, input: ['text'], output: ['text'] },
            limit: { context: 200_000, output: 16_000 },
            cost: [],
            variants: [{ id: Model.VariantID.make('max'), settings: { reasoningEffort: 'max' } }],
          }),
          Model.Info.make({
            ...Model.Info.default(Provider.ID.make('fakeproviderB'), Model.ID.make('worker2')),
            name: 'Fixture worker 2',
            capabilities: { tools: true, input: ['text'], output: ['text'] },
            limit: { context: 200_000, output: 16_000 },
            cost: [],
            variants: [{ id: Model.VariantID.make('max'), settings: { reasoningEffort: 'max' } }],
          }),
        ],
      })
    })
    await ctx.aisdk.hook(
      'language',
      (event) => {
        event.language = leadModel()
      },
      { providerID: 'fakeproviderA' },
    )
    await ctx.aisdk.hook(
      'language',
      (event) => {
        event.language = workerModel(String(event.model.id))
      },
      { providerID: 'fakeproviderB' },
    )
    await ctx.tool.transform((editor) => {
      editor.add({
        name: 'fixture_echo',
        description: 'Echoes fixture input without external side effects.',
        input: {
          type: 'object',
          properties: { echo: { type: 'string' } },
          additionalProperties: false,
        },
        options: { codemode: false },
        execute: async (input: { echo?: string }) => ({
          content: JSON.stringify({ echo: input?.echo ?? null }),
        }),
      } as never)
      editor.add({
        name: 'fixture_sleep',
        description: 'Sleeps for ms then returns content; probes slow plugin-tool settlement.',
        input: {
          type: 'object',
          properties: { ms: { type: 'number' } },
          additionalProperties: false,
        },
        options: { codemode: false },
        execute: async (input: { ms?: number }, context: { signal?: AbortSignal }) => {
          const ms = input?.ms ?? 300
          log({ event: 'sleep-start', ms, hasSignal: context?.signal !== undefined })
          await new Promise((r) => setTimeout(r, ms))
          log({ event: 'sleep-done', ms, aborted: context?.signal?.aborted })
          return { content: `slept ${ms}ms` }
        },
      } as never)
      editor.add({
        name: 'fixture_probe',
        description: 'Runs a fixture subagent inline and returns its output verbatim.',
        input: {
          type: 'object',
          properties: { prompt: { type: 'string' } },
          additionalProperties: false,
        },
        options: { codemode: false },
        execute: async (input: { prompt?: string }, context: unknown) => {
          try {
            const tools = await ctx.tool.list()
            const subagent = tools.find((t: { id?: string; name?: string }) => t.id === 'subagent' || t.name === 'subagent')
            log({ event: 'probe-tool-list', count: tools.length, found: !!subagent })
            if (!subagent) return { content: 'probe-error: subagent missing' }
            const result = await (subagent.execute as (i: unknown, c: unknown) => Promise<{ output?: unknown }>)(
              {
                agent: 'fusion-e2e-worker',
                description: 'probe delegation',
                prompt: input?.prompt ?? 'Say hi',
                model: 'fakeproviderB/worker#max',
                background: false,
              },
              context,
            )
            log({ event: 'probe-result', result })
            const childID =
              result?.output && typeof result.output === 'object'
                ? (result.output as { sessionID?: string }).sessionID
                : undefined
            return {
              content: JSON.stringify(result?.output ?? result),
              metadata: { probe: true, sessionID: childID },
            }
          } catch (error) {
            log({ event: 'probe-error', error: String(error) })
            return { content: `probe-error: ${String(error)}` }
          }
        },
      } as never)
    })
    return () => {}
  },
})
