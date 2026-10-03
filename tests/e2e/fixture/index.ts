import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Plugin, Provider, Model } from '@opencode/plugin'
import type {
  LanguageModelV3,
  LanguageModelV3Content,
  LanguageModelV3FinishReason,
  LanguageModelV3StreamPart,
  LanguageModelV3Usage,
} from '@ai-sdk/provider'

const EMPTY_USAGE = {
  inputTokens: { total: 0 },
  outputTokens: { total: 0 },
} as never as LanguageModelV3Usage

const DIR = process.env.FUSION_FIXTURE_DIR ?? path.join(os.tmpdir(), 'opencode-fusion-e2e')
const LOG = path.join(DIR, 'fixture-log.jsonl')
const HANG = path.join(DIR, 'worker-hang.flag')

try {
  fs.mkdirSync(DIR, { recursive: true })
} catch {}

const log = (entry: Record<string, unknown>) => {
  try {
    fs.appendFileSync(LOG, JSON.stringify(entry) + '\n')
  } catch {}
}

const TRIGGER = 'Fusion fixture assignment'
const LEAD_OK = 'FUSION_E2E_LEAD_OK'
const WORKER_OK = 'FUSION_E2E_WORKER_OK'

let callSeq = 0

function textOf(message: unknown): string {
  if (!message || typeof message !== 'object') return ''
  const parts = (message as { content?: unknown }).content
  if (typeof parts === 'string') return parts
  if (Array.isArray(parts)) {
    return parts
      .map((part) =>
        part && typeof part === 'object'
          ? String((part as { text?: unknown }).text ?? '')
          : '',
      )
      .join('')
  }
  return ''
}

function wireOptions(options: Record<string, unknown>) {
  const { prompt: _prompt, ...rest } = options ?? {}
  return rest
}

const workerModel = (modelID = 'worker'): LanguageModelV3 => ({
  specificationVersion: 'v3',
  provider: 'fakeproviderB',
  modelId: modelID,
  supportedUrls: {},
  async doStream(options) {
    log({ event: 'wire', provider: 'fakeproviderB', modelId: modelID, options: wireOptions(options as never) })
    const hang = fs.existsSync(HANG)
    const fail = /failprobe/i.test(textOf(options.prompt.at(-1)))
    const sawTool = options.prompt.at(-1)?.role === 'tool'
    const stream = new ReadableStream<LanguageModelV3StreamPart>({
      async start(controller) {
        controller.enqueue({ type: 'stream-start', warnings: [] })
        if (hang) {
          await new Promise((r) => setTimeout(r, 60_000))
        }
        if (fail) {
          controller.enqueue({ type: 'error', error: new Error('failprobe forced failure') })
          controller.close()
          return
        }
        if (sawTool) {
          controller.enqueue({ type: 'text-start', id: 't1' })
          controller.enqueue({ type: 'text-delta', id: 't1', delta: WORKER_OK })
          controller.enqueue({ type: 'text-end', id: 't1' })
          controller.enqueue({
            type: 'finish',
            finishReason: { unified: 'stop', raw: 'stop' },
            usage: EMPTY_USAGE,
          })
        } else {
          const echoID = `e${++callSeq}`
          controller.enqueue({ type: 'tool-input-start', id: echoID, toolName: 'fixture_echo' })
          controller.enqueue({ type: 'tool-input-delta', id: echoID, delta: '{"echo":"fusion-fixture"}' })
          controller.enqueue({ type: 'tool-input-end', id: echoID })
          controller.enqueue({
            type: 'tool-call',
            toolCallId: echoID,
            toolName: 'fixture_echo',
            input: '{"echo":"fusion-fixture"}',
          })
          controller.enqueue({
            type: 'finish',
            finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
            usage: EMPTY_USAGE,
          })
        }
        controller.close()
      },
    })
    return { stream }
  },
  async doGenerate(options) {
    const { stream } = await this.doStream(options)
    const reader = stream.getReader()
    const content: LanguageModelV3Content[] = []
    let finish: LanguageModelV3FinishReason = { unified: 'stop', raw: 'stop' }
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value.type === 'text-delta') content.push({ type: 'text', text: value.delta })
      if (value.type === 'tool-call')
        content.push({
          type: 'tool-call',
          toolCallId: value.toolCallId,
          toolName: value.toolName,
          input: value.input,
        })
      if (value.type === 'finish') finish = value.finishReason
    }
    return { content, finishReason: finish, usage: EMPTY_USAGE, warnings: [] }
  },
})

const leadModel = (): LanguageModelV3 => ({
  specificationVersion: 'v3',
  provider: 'fakeproviderA',
  modelId: 'lead',
  supportedUrls: {},
  async doStream(options) {
    log({ event: 'wire', provider: 'fakeproviderA', modelId: 'lead', options: wireOptions(options as never) })
    const last = options.prompt.at(-1)
    const lastText = textOf(last)
    const triggered = last?.role === 'user' && lastText.includes(TRIGGER)
    const background = /\bin\s+background\b/i.test(lastText)
    const sleep = /sleeps?probe/i.test(lastText)
    const probe = /subagentprobe/i.test(lastText)
    const stream = new ReadableStream<LanguageModelV3StreamPart>({
      start(controller) {
        controller.enqueue({ type: 'stream-start', warnings: [] })
        if (sleep) {
          const input = JSON.stringify({ ms: 400 })
          controller.enqueue({ type: 'tool-input-start', id: 's1', toolName: 'fixture_sleep' })
          controller.enqueue({ type: 'tool-input-delta', id: 's1', delta: input })
          controller.enqueue({ type: 'tool-input-end', id: 's1' })
          controller.enqueue({
            type: 'tool-call',
            toolCallId: 's1',
            toolName: 'fixture_sleep',
            input,
          })
          controller.enqueue({
            type: 'finish',
            finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
            usage: EMPTY_USAGE,
          })
        } else if (probe) {
          const input = JSON.stringify({ prompt: lastText })
          controller.enqueue({ type: 'tool-input-start', id: 'p1', toolName: 'fixture_probe' })
          controller.enqueue({ type: 'tool-input-delta', id: 'p1', delta: input })
          controller.enqueue({ type: 'tool-input-end', id: 'p1' })
          controller.enqueue({
            type: 'tool-call',
            toolCallId: 'p1',
            toolName: 'fixture_probe',
            input,
          })
          controller.enqueue({
            type: 'finish',
            finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
            usage: EMPTY_USAGE,
          })
        } else if (triggered) {
          const input = JSON.stringify({
            task: /failprobe/i.test(lastText)
              ? 'Run the Fusion fixture assignment failprobe.'
              : 'Run the Fusion fixture assignment.',
            brief: 'Fixture assignment brief.',
            ...(background ? { background: true } : {}),
          })
          const callID = `d${++callSeq}`
          controller.enqueue({ type: 'tool-input-start', id: callID, toolName: 'fusion_delegate' })
          controller.enqueue({ type: 'tool-input-delta', id: callID, delta: input })
          controller.enqueue({ type: 'tool-input-end', id: callID })
          controller.enqueue({
            type: 'tool-call',
            toolCallId: callID,
            toolName: 'fusion_delegate',
            input,
          })
          controller.enqueue({
            type: 'finish',
            finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
            usage: EMPTY_USAGE,
          })
        } else {
          controller.enqueue({ type: 'text-start', id: 't1' })
          controller.enqueue({ type: 'text-delta', id: 't1', delta: LEAD_OK })
          controller.enqueue({ type: 'text-end', id: 't1' })
          controller.enqueue({
            type: 'finish',
            finishReason: { unified: 'stop', raw: 'stop' },
            usage: EMPTY_USAGE,
          })
        }
        controller.close()
      },
    })
    return { stream }
  },
  async doGenerate(options) {
    const { stream } = await this.doStream(options)
    const reader = stream.getReader()
    const content: LanguageModelV3Content[] = []
    let finish: LanguageModelV3FinishReason = { unified: 'stop', raw: 'stop' }
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value.type === 'text-delta') content.push({ type: 'text', text: value.delta })
      if (value.type === 'tool-call')
        content.push({
          type: 'tool-call',
          toolCallId: value.toolCallId,
          toolName: value.toolName,
          input: value.input,
        })
      if (value.type === 'finish') finish = value.finishReason
    }
    return { content, finishReason: finish, usage: EMPTY_USAGE, warnings: [] }
  },
})

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
