import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  FusionController,
  FusionError,
  LeaseRegistry,
  parseModelReference,
  resolveOptions,
  workerAgentIDFor,
} from '../src/index.ts'
import { DEFAULT_OPTIONS, NOTICE, LEAD_POLICY, WORKER_POLICY } from '../src/policy.ts'

const MODELS = [
  {
    id: 'lead',
    providerID: 'fakeA',
    name: 'Lead',
    variants: [{ id: 'max' }, { id: 'low' }],
    limit: { context: 200_000, output: 32_000 },
    capabilities: { tools: true, input: ['text'], output: ['text'] },
    status: 'active',
  },
  {
    id: 'worker',
    providerID: 'fakeB',
    name: 'Worker',
    variants: [{ id: 'max' }],
    limit: { context: 200_000, output: 16_000 },
    capabilities: { tools: true, input: ['text'], output: ['text'] },
    status: 'active',
  },
]

function memoryStorage() {
  const map = new Map()
  return {
    map,
    get: async (key) => map.get(key),
    set: async (key, value) => void map.set(key, structuredClone(value)),
    remove: async (key) => void map.delete(key),
    scan: async ({ prefix }) => ({
      entries: [...map.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, value]) => ({ key, value })),
    }),
  }
}

function makeCtx({ sessions = {}, agents = undefined, models = MODELS } = {}) {
  agents = agents ?? {
    build: { data: { id: 'build', name: 'build', permissions: [] } },
  }
  const calls = { synthetic: [], interrupt: [], wait: [], switchModel: [], toolList: 0 }
  const sessionMap = new Map(Object.entries(sessions))
  const agentMap = new Map(Object.entries(agents))
  const ctx = {
    location: { directory: process.cwd() },
    session: {
      get: async ({ sessionID }) => sessionMap.get(sessionID),
      wait: async (input) => void calls.wait.push(input),
      interrupt: async (input) => void calls.interrupt.push(input),
      synthetic: async (input) => void calls.synthetic.push(input),
      switchModel: async ({ sessionID, model }) => {
        calls.switchModel.push({ sessionID, model })
        const session = sessionMap.get(sessionID)
        if (session) session.model = model
      },
      context: async () => [],
    },
    agent: {
      get: async ({ agentID }) => agentMap.get(agentID),
      reload: async () => {},
    },
    model: { list: async () => ({ data: models }) },
    tool: {
      list: async () => {
        calls.toolList += 1
        return []
      },
    },
  }
  return { ctx, calls, sessionMap, agentMap }
}

function rootSession(overrides = {}) {
  return { id: 'root1', agent: 'build', model: undefined, ...overrides }
}

function makeController(ctx, { deps = {}, options } = {}) {
  return new FusionController(ctx, options, {
    storage: memoryStorage(),
    leases: new LeaseRegistry(),
    now: () => 1_000,
    ...deps,
  })
}

const TOOL_CTX = (sessionID = 'root1') => ({
  sessionID,
  agent: 'build',
  messageID: 'msg1',
  id: 'call1',
  signal: new AbortController().signal,
  progress: async () => {},
})

async function configured(deps = {}, options) {
  const { ctx, calls, sessionMap } = makeCtx({
    sessions: { root1: rootSession() },
    agents: {
      build: {
        data: {
          id: 'build',
          name: 'build',
          system: 'PARENT SYSTEM',
          steps: 42,
          permissions: [
            { action: 'shell', resource: '*', effect: 'ask' },
            { action: 'write', resource: '*.secret', effect: 'deny' },
          ],
        },
      },
    },
  })
  const controller = new FusionController(ctx, options, {
    storage: memoryStorage(),
    leases: new LeaseRegistry(),
    now: () => 1_000,
    ...deps,
  })
  await controller.configure('root1', 'fakeA/lead#max', 'fakeB/worker#max')
  return { ctx, calls, sessionMap, controller }
}

test('model references parse and validate exact provider/id/variant', async () => {
  assert.deepEqual(parseModelReference('fakeA/lead#max'), {
    providerID: 'fakeA',
    id: 'lead',
    variant: 'max',
  })
  assert.equal(parseModelReference('fakeA/lead').variant, undefined)
  const { controller } = await configured()
  const again = await controller.configure('root1', 'fakeA/lead#max', 'fakeB/worker#max')
  assert.equal(again.text, NOTICE.configured, 'idle reconfigure allowed')
})

test('configure rejects unknown models, wrong variants, malformed refs', async () => {
  const { ctx } = makeCtx({ sessions: { root1: rootSession() } })
  const controller = makeController(ctx)
  await assert.rejects(
    () => controller.configure('root1', 'nope/x', 'fakeB/worker'),
    (e) => e.code === 'model_unavailable',
  )
  await assert.rejects(
    () => controller.configure('root1', 'not a ref!!', 'fakeB/worker'),
    (e) => e.code === 'invalid_model_reference',
  )
  await assert.rejects(
    () => controller.configure('root1', 'fakeA/unknown', 'fakeB/worker'),
    (e) => e.code === 'model_unavailable',
  )
  await assert.rejects(
    () => controller.configure('root1', 'fakeA/lead#wrong', 'fakeB/worker'),
    (e) => e.code === 'variant_unavailable',
  )
  await assert.rejects(
    () => controller.configure('root1', 'fakeA/lead#max', 'fakeB/missing'),
    (e) => e.code === 'model_unavailable',
  )
  assert.throws(() => parseModelReference('fakeA/"lead x"'))
  assert.throws(() => parseModelReference('not-a-ref'))
})

test('options resolve to policy defaults and enforce ranges', () => {
  assert.deepEqual(resolveOptions({}), { ...DEFAULT_OPTIONS })
  assert.equal(resolveOptions({ maxDelegations: 5 }).maxDelegations, 5)
  assert.throws(() => resolveOptions({ maxDelegations: 0 }), (e) => e.code === 'invalid_option')
  assert.throws(() => resolveOptions({ maxDelegations: 101 }), (e) => e.code === 'invalid_option')
  assert.throws(() => resolveOptions({ sidekickMaxOutputTokens: 100 }), (e) => e.code === 'invalid_option')
  assert.equal(resolveOptions({ sidekickMaxOutputTokens: 4096 }).sidekickMaxOutputTokens, 4096)
  assert.throws(() => resolveOptions({ delegationTimeoutMs: 500 }), (e) => e.code === 'invalid_option')
})

test('configure validates models before state and switches root model', async () => {
  const { ctx, calls, sessionMap } = makeCtx({ sessions: { root1: rootSession() } })
  const controller = makeController(ctx)
  await assert.rejects(() =>
    controller.configure('root1', 'fakeA/lead#max', 'fakeB/missing'),
  )
  assert.equal(calls.switchModel.length, 0, 'no model switch on failed validation')
  await controller.configure('root1', 'fakeA/lead#max', 'fakeB/worker#max')
  assert.equal(calls.switchModel.length, 1)
  assert.deepEqual(calls.switchModel[0].model, {
    id: 'lead',
    providerID: 'fakeA',
    variant: 'max',
  })
  assert.equal(sessionMap.get('root1').model.id, 'lead')
  const status = await controller.status('root1')
  assert.equal(status.data.lead, 'fakeA/lead#max')
  assert.equal(status.data.partner, 'fakeB/worker#max')
})

test('worker definition clones parent permissions/system/steps and appends denials', async () => {
  const runner = async () => ({ output: { sessionID: 'child1', status: 'completed', output: 'ok' } })
  const { controller } = await configured({ runner })
  await controller.delegate({ task: 't', brief: 'b' }, TOOL_CTX())
  const workerID = workerAgentIDFor('root1')
  const def = controller.workerDefinitions.get(workerID)
  assert.equal(def.mode, 'subagent')
  assert.equal(def.hidden, true)
  assert.ok(def.system.includes('PARENT SYSTEM'))
  assert.ok(def.system.endsWith(WORKER_POLICY))
  assert.equal(def.steps, 30, 'steps capped at maxWorkerSteps')
  assert.deepEqual(def.permissions.slice(0, 2), [
    { action: 'shell', resource: '*', effect: 'ask' },
    { action: 'write', resource: '*.secret', effect: 'deny' },
  ])
  const denials = def.permissions.slice(-3)
  assert.deepEqual(denials, [
    { action: 'subagent', resource: '*', effect: 'deny' },
    { action: 'tool', resource: 'fusion_delegate', effect: 'deny' },
    { action: 'tool', resource: 'fusion_wait', effect: 'deny' },
  ])
  assert.notEqual(workerAgentIDFor('root1'), workerAgentIDFor('root2'))
})

test('two foreground handoffs reuse the same child session', async () => {
  const seen = []
  const runner = async (input) => {
    seen.push(input)
    return { output: { sessionID: 'child1', status: 'completed', output: 'ok' } }
  }
  const { controller, sessionMap } = await configured({ runner })
  sessionMap.set('child1', { id: 'child1', parentID: 'root1', outcome: 'succeeded' })
  const first = await controller.delegate({ task: 'a', brief: 'b' }, TOOL_CTX())
  const second = await controller.delegate({ task: 'a2', brief: 'b2' }, TOOL_CTX())
  assert.equal(seen.length, 2)
  assert.equal(seen[1].sessionID, 'child1', 'second handoff resumes persisted child')
  assert.equal(seen[0].background, false)
  assert.equal(seen[0].model, 'fakeB/worker#max')
  assert.ok(first.content.includes('"completed"'))
  assert.ok(second.content.includes('"completed"'))
  const status = await controller.status('root1')
  assert.equal(status.data.delegations.used, 2)
})

test('two concurrent handoffs: one succeeds, one returns busy', async () => {
  let release
  const gate = new Promise((r) => (release = r))
  const runner = async () => {
    await gate
    return { output: { sessionID: 'child1', status: 'completed', output: 'ok' } }
  }
  const { controller, sessionMap } = await configured({ runner })
  sessionMap.set('child1', { id: 'child1', parentID: 'root1' })
  const first = controller.delegate({ task: 'a', brief: 'b' }, TOOL_CTX())
  await new Promise((r) => setImmediate(r))
  await assert.rejects(
    () => controller.delegate({ task: 'b', brief: 'b' }, TOOL_CTX()),
    (e) => e.code === 'busy',
  )
  release()
  const result = await first
  assert.ok(result.content.includes('"completed"'))
})

test('workspace writer lease blocks root mutation but allows reads and owner child', async () => {
  let release
  const gate = new Promise((r) => (release = r))
  const leases = new LeaseRegistry()
  const runner = async (input, context) => {
    await context.progress({ sessionID: 'child1' })
    await gate
    return { output: { sessionID: 'child1', status: 'completed', output: 'ok' } }
  }
  const { controller, sessionMap } = await configured({ runner, leases })
  sessionMap.set('child1', { id: 'child1', parentID: 'root1' })
  const job = controller.delegate({ task: 'a', brief: 'b', background: true }, TOOL_CTX())
  await new Promise((r) => setImmediate(r))
  await job
  await assert.rejects(
    () => controller.guardToolCall({ tool: 'write', sessionID: 'root1' }),
    (e) => e.code === 'blocked_write' && e.message === NOTICE.blockedWrite,
  )
  await controller.guardToolCall({ tool: 'read', sessionID: 'root1' })
  await controller.guardToolCall({ tool: 'write', sessionID: 'child1' })
  await controller.guardToolCall({ tool: 'write', sessionID: 'stranger' })
  await assert.rejects(
    () => controller.guardToolCall({ tool: 'subagent', sessionID: 'root1' }),
    (e) => e.code === 'nested',
  )
  release()
})

test('native permission deny fails the job with no child created', async () => {
  const runner = async () => {
    throw new Error('Tool.Error: Subagent denied: fusion-worker-x')
  }
  const { controller } = await configured({ runner })
  const result = await controller.delegate({ task: 'a', brief: 'b' }, TOOL_CTX())
  assert.ok(result.content.includes('"failed"'))
  const status = await controller.status('root1')
  assert.equal(status.data.workerSessionID, undefined)
  assert.equal(status.data.delegations.used, 1, 'failed attempt still consumes budget')
})

test('foreground abort marks job interrupted without false completion', async () => {
  const runner = async (input, context) => {
    await new Promise((r) => setTimeout(r, 50))
    if (context.signal.aborted) throw new Error('interrupted')
    return { output: { sessionID: 'child1', status: 'completed', output: 'late' } }
  }
  const { controller, sessionMap } = await configured({ runner })
  sessionMap.set('child1', { id: 'child1', parentID: 'root1' })
  const ac = new AbortController()
  const promise = controller.delegate(
    { task: 'a', brief: 'b' },
    { ...TOOL_CTX(), signal: ac.signal },
  )
  ac.abort(new Error('stop'))
  const result = await promise
  assert.ok(result.content.includes('"interrupted"'), result.content)
})

test('delegation timeout interrupts the child and never completes', async () => {
  const runner = async (input, context) => {
    await new Promise((r) => setTimeout(r, 200))
    if (context.signal.aborted) throw new Error('interrupted')
    return { output: { sessionID: 'child1', status: 'completed', output: 'late' } }
  }
  const { ctx, sessionMap } = makeCtx({ sessions: { root1: rootSession() } })
  const controller = new FusionController(
    ctx,
    { delegationTimeoutMs: 50 },
    { storage: memoryStorage(), leases: new LeaseRegistry(), runner },
  )
  await controller.configure('root1', 'fakeA/lead#max', 'fakeB/worker#max')
  sessionMap.set('child1', { id: 'child1', parentID: 'root1' })
  const result = await controller.delegate({ task: 'a', brief: 'b' }, TOOL_CTX())
  assert.ok(!result.content.includes('"completed"'), result.content)
})

test('background job delivers exactly one deterministic synthetic report', async () => {
  let resolveRun
  const runner = async (input, context) => {
    await context.progress({ sessionID: 'child1' })
    await new Promise((r) => (resolveRun = r))
    return { output: { sessionID: 'child1', status: 'completed', output: 'done' } }
  }
  const { controller, calls, sessionMap } = await configured({ runner })
  sessionMap.set('child1', { id: 'child1', parentID: 'root1' })
  sessionMap.get('root1').model = { id: 'lead', providerID: 'fakeA', variant: 'max' }
  const ack = await controller.delegate(
    { task: 'a', brief: 'b', background: true },
    TOOL_CTX(),
  )
  assert.ok(ack.content.includes('"running"'), ack.content)
  assert.equal(calls.synthetic.length, 0)
  resolveRun()
  for (let i = 0; i < 50 && calls.synthetic.length === 0; i++) {
    await new Promise((r) => setTimeout(r, 5))
  }
  assert.equal(calls.synthetic.length, 1, 'exactly one completion delivery')
  assert.match(calls.synthetic[0].id, /^msg_[0-9a-f]{24}$/)
  assert.equal(calls.synthetic[0].resume, false, 'completion never auto-wakes the parent')
})

test('pause during background cancels work and delivers with resume:false (no wake)', async () => {
  const runner = async (input, context) => {
    await context.progress({ sessionID: 'child1' })
    await new Promise((r) => setTimeout(r, 200))
    if (context.signal.aborted) throw new Error('interrupted')
    return { output: { sessionID: 'child1', status: 'completed', output: 'done' } }
  }
  const { controller, calls, sessionMap } = await configured({ runner })
  sessionMap.set('child1', { id: 'child1', parentID: 'root1' })
  sessionMap.get('root1').model = { id: 'lead', providerID: 'fakeA', variant: 'max' }
  const ack = await controller.delegate({ task: 'a', brief: 'b', background: true }, TOOL_CTX())
  assert.ok(ack.content.includes('"running"'))
  await controller.pause('root1')
  await new Promise((r) => setTimeout(r, 25))
  assert.equal(calls.synthetic.length, 1, 'report delivered once')
  assert.equal(calls.synthetic[0].resume, false, 'paused root is never woken')
  const status = await controller.status('root1')
  assert.equal(status.data.lastJob.status, 'interrupted')
  await assert.rejects(
    () => controller.delegate({ task: 'a', brief: 'b' }, TOOL_CTX()),
    (e) => e.code === 'disabled',
  )
})

test('off cancels owned work and blocks new delegation', async () => {
  let resolveRun
  const runner = async (input, context) => {
    await context.progress({ sessionID: 'child1' })
    await new Promise((r) => (resolveRun = r))
    if (context.signal.aborted) throw new Error('interrupted')
    return { output: { sessionID: 'child1', status: 'completed', output: 'late' } }
  }
  const { controller, calls, sessionMap } = await configured({ runner })
  sessionMap.set('child1', { id: 'child1', parentID: 'root1' })
  const ack = await controller.delegate(
    { task: 'a', brief: 'b', background: true },
    TOOL_CTX(),
  )
  assert.ok(ack.content.includes('"running"'))
  const off = controller.disable('root1')
  resolveRun()
  await off
  assert.ok(calls.interrupt.some((c) => c.sessionID === 'child1'), 'child interrupted on off')
  await assert.rejects(
    () => controller.delegate({ task: 'a', brief: 'b' }, TOOL_CTX()),
    (e) => e.code === 'disabled',
  )
  const status = await controller.status('root1')
  assert.equal(status.data.enabled, false)
})

test('manual model change pauses coordination and prevents wake resume', async () => {
  const { controller, sessionMap } = await configured({
    runner: async () => ({ output: { sessionID: 'c', status: 'completed', output: 'x' } }),
  })
  sessionMap.set('c', { id: 'c', parentID: 'root1' })
  await controller.onModelSelected('root1', { id: 'other', providerID: 'fakeA' })
  const status = await controller.status('root1')
  assert.equal(status.data.paused, true)
  await assert.rejects(
    () => controller.delegate({ task: 'a', brief: 'b' }, TOOL_CTX()),
    (e) => e.code === 'disabled',
  )
})

test('reset retires worker mapping while idle and keeps history', async () => {
  const runner = async () => ({ output: { sessionID: 'child1', status: 'completed', output: 'ok' } })
  const { controller, sessionMap } = await configured({ runner })
  sessionMap.set('child1', { id: 'child1', parentID: 'root1' })
  await controller.delegate({ task: 'a', brief: 'b' }, TOOL_CTX())
  await controller.reset('root1')
  const status = await controller.status('root1')
  assert.equal(status.data.workerSessionID, undefined)
  assert.equal(status.data.delegations.used, 1, 'budget survives reset')
  assert.equal(status.data.lastJob.status, 'completed', 'job history survives reset')
})

test('worker context cannot delegate or spawn nested subagents', async () => {
  const { controller } = await configured()
  const child = 'child9'
  controller['childToRoot'].set(child, 'root1')
  await assert.rejects(
    () => controller.guardToolCall({ tool: 'fusion_delegate', sessionID: child }),
    (e) => e.code === 'nested' && e.message === NOTICE.nested,
  )
  await assert.rejects(
    () => controller.guardToolCall({ tool: 'subagent', sessionID: child }),
    (e) => e.code === 'nested',
  )
})

test('context hook injects LEAD_POLICY once and hides tools appropriately', async () => {
  const { controller } = await configured()
  const input = {
    sessionID: 'root1',
    agent: 'build',
    system: [{ type: 'text', text: 'base' }],
    tools: { read: {}, write: {}, subagent: {}, fusion_delegate: {}, fusion_status: {} },
    options: {},
  }
  await controller.applyContext(input)
  const policies = input.system.filter((p) => p.text === LEAD_POLICY)
  assert.equal(policies.length, 1)
  await controller.applyContext(input)
  assert.equal(input.system.filter((p) => p.text === LEAD_POLICY).length, 1, 'stable once')
  assert.equal(input.tools.subagent, undefined, 'direct subagent removed on fused root')
  assert.ok(input.tools.fusion_delegate)
  const stranger = { sessionID: 'other', agent: 'build', system: [], tools: { fusion_delegate: {}, read: {} }, options: {} }
  await controller.applyContext(stranger)
  assert.equal(stranger.tools.fusion_delegate, undefined, 'fusion tools hidden elsewhere')
  assert.equal(stranger.system.length, 0)
  const workerID = workerAgentIDFor('root1')
  const workerInput = {
    sessionID: 'child9',
    agent: workerID,
    system: [],
    tools: { fusion_delegate: {}, fusion_wait: {}, subagent: {}, read: {} },
    options: {},
  }
  await controller.applyContext(workerInput)
  assert.equal(workerInput.tools.fusion_delegate, undefined)
  assert.equal(workerInput.tools.fusion_wait, undefined)
  assert.equal(workerInput.tools.subagent, undefined)
  assert.ok(workerInput.tools.read)
})

test('compaction appends renderCompactionState with profile and job data', async () => {
  const runner = async () => ({ output: { sessionID: 'c', status: 'completed', output: 'ok' } })
  const { controller, sessionMap } = await configured({ runner })
  sessionMap.set('c', { id: 'c', parentID: 'root1' })
  await controller.delegate({ task: 'a', brief: 'b' }, TOOL_CTX())
  const input = { sessionID: 'root1', system: [] }
  controller.applyCompaction(input)
  assert.equal(input.system.length, 1)
  assert.ok(input.system[0].text.includes('Preserve this Fusion coordination state'))
  assert.ok(input.system[0].text.includes('"fakeA"') && input.system[0].text.includes('"lead"'))
  assert.ok(input.system[0].text.includes('"workerSessionID"'))
  const other = { sessionID: 'stranger', system: [] }
  controller.applyCompaction(other)
  assert.equal(other.system.length, 0)
})

test('lease is released only after child confirmed idle', async () => {
  let releaseWait
  const waitGate = new Promise((r) => (releaseWait = r))
  const leases = new LeaseRegistry()
  const runner = async (input, context) => {
    await context.progress({ sessionID: 'child1' })
    return { output: { sessionID: 'child1', status: 'completed', output: 'ok' } }
  }
  const { ctx, sessionMap } = makeCtx({ sessions: { root1: rootSession() } })
  const baseWait = ctx.session.wait
  ctx.session.wait = async (i) => {
    await baseWait(i)
    if (i.sessionID === 'child1') await waitGate
  }
  const controller = new FusionController(ctx, undefined, {
    storage: memoryStorage(),
    leases,
    runner,
  })
  await controller.configure('root1', 'fakeA/lead#max', 'fakeB/worker#max')
  sessionMap.set('child1', { id: 'child1', parentID: 'root1' })
  const done = controller.delegate({ task: 'a', brief: 'b' }, TOOL_CTX())
  await new Promise((r) => setTimeout(r, 10))
  const key = [...leases['leases'].keys()][0]
  assert.ok(leases.get(key), 'lease held while child not confirmed idle')
  releaseWait()
  await done
  assert.equal(leases.get(key), undefined, 'lease released after idle confirmation')
})

test('restart recovery resumes tracking without resubmitting', async () => {
  const storage = memoryStorage()
  const state = {
    version: 1,
    enabled: true,
    paused: false,
    revision: 1,
    lead: { providerID: 'fakeA', id: 'lead', variant: 'max' },
    partner: { providerID: 'fakeB', id: 'worker', variant: 'max' },
    workerAgentID: workerAgentIDFor('root1'),
    workerSessionID: 'child1',
    delegations: 1,
    activeJob: 'job1',
    jobs: {
      job1: {
        id: 'job1',
        rootID: 'root1',
        workerSessionID: 'child1',
        revision: 1,
        createdAt: 100,
        status: 'running',
        background: true,
        task: 'a',
        callID: 'c',
      },
    },
  }
  await storage.set('session/root1', state)
  const runner = async () => {
    throw new Error('runner must not be called during recovery')
  }
  const { ctx, sessionMap, calls } = makeCtx({
    sessions: {
      root1: rootSession(),
      child1: {
        id: 'child1',
        parentID: 'root1',
        outcome: 'interrupted',
        time: { created: 50, updated: 150, idle: 150 },
      },
    },
  })
  const controller = new FusionController(ctx, undefined, {
    storage,
    leases: new LeaseRegistry(),
    runner,
  })
  await controller.recover()
  await new Promise((r) => setTimeout(r, 20))
  const status = await controller.status('root1')
  assert.equal(status.data.activeJob, undefined)
  assert.equal(status.data.lastJob.status, 'interrupted', 'stale running record resolved by child outcome')
  assert.equal(calls.synthetic.filter((s) => s.text.includes('partner result')).length, 1)
})

test('recovered ambiguous output becomes recovery-required, never completed', async () => {
  const storage = memoryStorage()
  const state = {
    version: 1,
    enabled: true,
    paused: false,
    revision: 1,
    lead: { providerID: 'fakeA', id: 'lead', variant: 'max' },
    partner: { providerID: 'fakeB', id: 'worker', variant: 'max' },
    workerAgentID: workerAgentIDFor('root1'),
    workerSessionID: 'child1',
    delegations: 1,
    activeJob: 'job1',
    jobs: {
      job1: {
        id: 'job1',
        rootID: 'root1',
        workerSessionID: 'child1',
        revision: 1,
        createdAt: 100,
        status: 'running',
        background: false,
        task: 'a',
        callID: 'c',
      },
    },
  }
  await storage.set('session/root1', state)
  const { ctx, sessionMap, calls } = makeCtx({
    sessions: {
      root1: rootSession(),
      child1: { id: 'child1', parentID: 'root1' },
    },
  })
  const controller = new FusionController(ctx, undefined, {
    storage,
    leases: new LeaseRegistry(),
    runner: async () => ({ output: { status: 'completed', output: 'x' } }),
  })
  await controller.recover()
  await new Promise((r) => setTimeout(r, 20))
  const status = await controller.status('root1')
  assert.equal(status.data.lastJob.status, 'recovery-required')
  assert.ok(
    calls.synthetic.some((s) => s.text === NOTICE.recovery),
    'recovery notice emitted',
  )
})

test('unknown provider errors stop the handoff without fallback', async () => {
  const runner = async () => {
    throw new Error('Model unavailable: fakeB/worker')
  }
  const { controller, calls } = await configured({ runner })
  const result = await controller.delegate({ task: 'a', brief: 'b' }, TOOL_CTX())
  assert.ok(result.content.includes('"failed"'))
  assert.equal(calls.switchModel.length, 1, 'only the configure-time switch happened')
})

test('delegation disabled and paused states refuse without a model call', async () => {
  let runs = 0
  const runner = async () => {
    runs += 1
    return { output: { sessionID: 'c', status: 'completed', output: 'x' } }
  }
  const { controller } = await configured({ runner })
  await controller.pause('root1')
  await assert.rejects(
    () => controller.delegate({ task: 'a', brief: 'b' }, TOOL_CTX()),
    (e) => e.code === 'disabled' && e.message === NOTICE.disabled,
  )
  assert.equal(runs, 0)
  await controller.resume('root1')
  await controller.delegate({ task: 'a', brief: 'b' }, TOOL_CTX())
  assert.equal(runs, 1, 'resume re-enables delegation without resubmitting old work')
})

test('budget exhaustion stops handoffs with policy notice', async () => {
  const runner = async () => ({ output: { sessionID: 'c', status: 'completed', output: 'x' } })
  const { ctx, sessionMap } = makeCtx({ sessions: { root1: rootSession() } })
  sessionMap.set('c', { id: 'c', parentID: 'root1' })
  const controller = new FusionController(
    ctx,
    { maxDelegations: 1 },
    { storage: memoryStorage(), leases: new LeaseRegistry(), runner },
  )
  await controller.configure('root1', 'fakeA/lead#max', 'fakeB/worker#max')
  await controller.delegate({ task: 'a', brief: 'b' }, TOOL_CTX())
  await assert.rejects(
    () => controller.delegate({ task: 'a', brief: 'b' }, TOOL_CTX()),
    (e) => e.code === 'budget' && e.message === NOTICE.budget,
  )
})

test('truncated report bounds output to maxReportCharacters', async () => {
  const long = 'x'.repeat(50_000)
  const runner = async () => ({ output: { sessionID: 'c', status: 'completed', output: long } })
  const { controller, sessionMap } = await configured({ runner })
  sessionMap.set('c', { id: 'c', parentID: 'root1' })
  const result = await controller.delegate({ task: 'a', brief: 'b' }, TOOL_CTX())
  assert.ok(result.content.includes('"truncated":true'))
  const status = await controller.status('root1')
  assert.equal(status.data.lastJob.output.length, 32_000)
})

test('FusionError carries code', () => {
  const e = new FusionError('x', 'y')
  assert.equal(e.code, 'x')
  assert.equal(e.message, 'y')
})
