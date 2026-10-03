import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
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

export const DIR = process.env.FUSION_FIXTURE_DIR ?? path.join(os.tmpdir(), 'opencode-fusion-e2e')
export const LOG = path.join(DIR, 'fixture-log.jsonl')
export const HANG = path.join(DIR, 'worker-hang.flag')

try {
  fs.mkdirSync(DIR, { recursive: true })
} catch {}

export const log = (entry: Record<string, unknown>) => {
  try {
    fs.appendFileSync(LOG, JSON.stringify(entry) + '\n')
  } catch {}
}

export const TRIGGER = 'Fusion fixture assignment'
export const LEAD_OK = 'FUSION_E2E_LEAD_OK'
export const WORKER_OK = 'FUSION_E2E_WORKER_OK'

let callSeq = 0

export function textOf(message: unknown): string {
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

const collect = async (
  stream: ReadableStream<LanguageModelV3StreamPart>,
): Promise<{ content: LanguageModelV3Content[]; finishReason: LanguageModelV3FinishReason }> => {
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
  return { content, finishReason: finish }
}

export const workerModel = (modelID = 'worker'): LanguageModelV3 => ({
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
    const { content, finishReason } = await collect(stream)
    return { content, finishReason, usage: EMPTY_USAGE, warnings: [] }
  },
})

export const leadModel = (): LanguageModelV3 => ({
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
    const { content, finishReason } = await collect(stream)
    return { content, finishReason, usage: EMPTY_USAGE, warnings: [] }
  },
})

export const makeLanguageModel = (id: string): LanguageModelV3 =>
  id === 'lead' ? leadModel() : workerModel(id)
