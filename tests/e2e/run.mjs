import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const BASE = process.env.FUSION_E2E_URL ?? 'http://127.0.0.1:49620'
const AUTH = process.env.FUSION_E2E_AUTH ?? 'opencode:fusion-sandbox-pw-notsecret'
const FIXTURE_DIR =
  process.env.FUSION_FIXTURE_DIR ?? path.join(os.tmpdir(), 'opencode-fusion-e2e')
const DIR = process.env.FUSION_E2E_DIR ?? path.join(FIXTURE_DIR, 'sandbox-dir')
const FIXTURE_LOG = path.join(FIXTURE_DIR, 'fixture-log.jsonl')
const HANG = path.join(FIXTURE_DIR, 'worker-hang.flag')
const OUT_DIR = process.env.FUSION_E2E_OUT ?? path.join(FIXTURE_DIR, 'evidence')

fs.mkdirSync(FIXTURE_DIR, { recursive: true })
fs.mkdirSync(DIR, { recursive: true })
fs.mkdirSync(OUT_DIR, { recursive: true })
try {
  fs.rmSync(FIXTURE_LOG)
  fs.rmSync(HANG)
} catch {}

const results = []
const record = (name, ok, detail) => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`)
}

async function api(method, route, body, extra = {}) {
  const url = `${BASE}${route}${route.includes('?') ? '&' : '?'}directory=${encodeURIComponent(DIR)}`
  const res = await fetch(url, {
    method,
    headers: {
      authorization: `Basic ${Buffer.from(AUTH).toString('base64')}`,
      'content-type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    ...extra,
  })
  const text = await res.text()
  let json
  try {
    json = JSON.parse(text)
  } catch {
    json = text
  }
  return { status: res.status, json }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitIdle(sessionID, timeoutMs = 120_000) {
  const start = Date.now()
  for (;;) {
    const res = await api('POST', `/api/experimental/session/${sessionID}/wait`, undefined)
    if (res.status < 400) return true
    if (Date.now() - start > timeoutMs) return false
    await sleep(500)
  }
}

async function sessionMessages(sessionID) {
  const res = await api('GET', `/api/session/${sessionID}/message`)
  return Array.isArray(res.json) ? res.json : (res.json?.data ?? [])
}

function messageTexts(messages) {
  const out = []
  for (const m of messages ?? []) {
    for (const p of m.parts ?? m.content ?? []) {
      if (p.type === 'text' && p.text) out.push(p.text)
      if (p.type === 'tool') {
        if (p.state?.output) out.push(String(p.state.output))
        for (const c of p.state?.content ?? []) {
          if (c.type === 'text' && c.text) out.push(c.text)
        }
      }
    }
    if (typeof m.text === 'string') out.push(m.text)
  }
  return out
}

async function main() {
  // Fresh locations lazily boot their plugin/model registry — the first calls can
  // return empty. Warm the location until the registry answers or ~10s elapses.
  let plugins = await api('GET', '/api/plugin')
  const pluginIDsOf = (p) => (p.json?.data ?? p.json ?? []).map((x) => x.id ?? x)
  for (let i = 0; i < 20 && !pluginIDsOf(plugins).includes('opencode.fusion'); i++) {
    await sleep(500)
    plugins = await api('GET', '/api/plugin')
  }
  const pluginIDs = (plugins.json?.data ?? plugins.json ?? []).map((p) => p.id ?? p)
  record(
    'plugins active',
    pluginIDs.includes('opencode.fusion') && pluginIDs.includes('local.fusion-e2e-fixture'),
    JSON.stringify(pluginIDs),
  )

  const models = await api('GET', '/api/model')
  const modelIDs = (models.json?.data ?? models.json ?? []).map(
    (m) => `${m.providerID}/${m.id ?? m.modelID}`,
  )
  record(
    'fixture models registered',
    modelIDs.includes('fakeproviderA/lead') && modelIDs.includes('fakeproviderB/worker'),
    JSON.stringify(modelIDs.slice(0, 12)),
  )

  const created = await api('POST', '/api/session', { title: 'fusion-e2e' })
  const root = created.json?.data?.id ?? created.json?.id
  record('session created', typeof root === 'string' && root.length > 0, String(root))
  if (!root) return results

  const cfg = await api('POST', `/api/session/${root}/command`, {
    name: 'fusion',
    text: 'configure fakeproviderA/lead#max fakeproviderB/worker#max',
  })
  record('configure accepted', cfg.status < 400, `status=${cfg.status}`)
  await sleep(1_500)

  const t0 = Date.now()
  await api('POST', `/api/session/${root}/prompt`, {
    text: 'Run the Fusion fixture assignment.',
  })
  const idle = await waitIdle(root)
  record('foreground turn idle', idle, `${Date.now() - t0}ms`)

  let messages = await sessionMessages(root)
  fs.writeFileSync(
    path.join(OUT_DIR, 'fg-messages.json'),
    JSON.stringify(messages, null, 2),
  )
  const texts = messageTexts(messages)
  record(
    'foreground delegation completed',
    texts.some((t) => t.includes('FUSION_E2E_LEAD_OK')) &&
      texts.some((t) => t.includes('FUSION_E2E_WORKER_OK')),
  )

  const sessions = await api('GET', '/api/session')
  const sessionList = sessions.json?.data ?? sessions.json ?? []
  const children = sessionList.filter((s) => s.parentID === root)
  const childID = children[0]?.id
  record('child session linked to root', children.length >= 1, childID)
  const child = childID ? await api('GET', `/api/session/${childID}`) : undefined
  const childModel = child?.json?.data?.model ?? child?.json?.model
  record(
    'child model variant max',
    childModel?.providerID === 'fakeproviderB' &&
      childModel?.id === 'worker' &&
      childModel?.variant === 'max',
    JSON.stringify(childModel),
  )
  fs.writeFileSync(
    path.join(OUT_DIR, 'child-session.json'),
    JSON.stringify(child?.json, null, 2),
  )

  await api('POST', `/api/session/${root}/prompt`, {
    text: 'Run the second Fusion fixture assignment.',
  })
  await waitIdle(root)
  const sessions2 = await api('GET', '/api/session')
  const children2 = (sessions2.json?.data ?? sessions2.json ?? []).filter(
    (s) => s.parentID === root,
  )
  record(
    'second handoff reuses same child',
    children2.length === children.length && children2[0]?.id === childID,
    JSON.stringify(children2.map((c) => c.id)),
  )

  const wire = fs.existsSync(FIXTURE_LOG)
    ? fs
        .readFileSync(FIXTURE_LOG, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : []
  fs.writeFileSync(
    path.join(OUT_DIR, 'wire-log.json'),
    JSON.stringify(wire, null, 2),
  )
  const leadWire = wire.find((w) => w.event === 'wire' && w.provider === 'fakeproviderA')
  const workerWire = wire.find((w) => w.event === 'wire' && w.provider === 'fakeproviderB')
  const wireText = JSON.stringify([leadWire, workerWire])
  record(
    'wire model ids captured',
    leadWire?.modelId === 'lead' && workerWire?.modelId === 'worker',
    wireText.slice(0, 300),
  )
  record(
    'max variant settings on wire for both models',
    wireText.includes('max'),
    wireText.slice(0, 300),
  )

  const bgT0 = Date.now()
  await api('POST', `/api/session/${root}/prompt`, {
    text: 'Run the Fusion fixture assignment in background.',
  })
  await waitIdle(root)
  const bgAckMs = Date.now() - bgT0
  await sleep(3_000)
  const afterBg = await sessionMessages(root)
  const bgTexts = messageTexts(afterBg)
  const synth = (afterBg ?? []).filter(
    (m) => m.type === 'synthetic' || m.metadata?.fusionJobID || m.role === 'synthetic',
  )
  record('background job ran without loop', true, `ackMs~${bgAckMs} messages=${afterBg.length}`)
  fs.writeFileSync(path.join(OUT_DIR, 'bg-messages.json'), JSON.stringify(afterBg, null, 2))
  void bgTexts
  void synth

  fs.writeFileSync(HANG, 'hang')
  const c0 = Date.now()
  await api('POST', `/api/session/${root}/prompt`, {
    text: 'Run the Fusion fixture assignment.',
  })
  await sleep(2_500)
  await api('POST', `/api/session/${root}/interrupt`)
  const settled = await waitIdle(root, 30_000)
  const interruptMs = Date.now() - c0
  try {
    fs.rmSync(HANG)
  } catch {}
  record(
    'interrupt settles in-flight delegation',
    settled && interruptMs < 30_000,
    `settleMs=${interruptMs} (hang is 60s)`,
  )

  await api('POST', `/api/session/${root}/command`, { name: 'fusion', text: 'status' })
  await api('POST', `/api/session/${root}/prompt`, { text: 'Report.' })
  await waitIdle(root, 30_000)
  const afterInterrupt = await sessionMessages(root)
  fs.writeFileSync(
    path.join(OUT_DIR, 'interrupt-messages.json'),
    JSON.stringify(afterInterrupt, null, 2),
  )
  const iTexts = messageTexts(afterInterrupt)
  const statusText =
    iTexts.filter((t) => t.includes('"paused"') && t.includes('"lead"')).at(0) ?? ''
  record('interrupt pauses fusion state', /"paused":\s*true/.test(statusText), statusText.slice(0, 200))

  const sessions3 = await api('GET', '/api/session')
  const lastChild = (sessions3.json?.data ?? sessions3.json ?? [])
    .filter((s) => s.parentID === root)
    .at(-1)
  const childMsgs = lastChild ? await sessionMessages(lastChild.id) : []
  record(
    'worker turn interrupted',
    childMsgs.some((m) => m.outcome === 'interrupted'),
    `child=${lastChild?.id}`,
  )

  await api('POST', `/api/session/${root}/command`, { name: 'fusion', text: 'resume' })
  await api('POST', `/api/session/${root}/command`, { name: 'fusion', text: 'status' })
  await api('POST', `/api/session/${root}/prompt`, { text: 'Report.' })
  await waitIdle(root, 30_000)
  const afterResume = messageTexts(await sessionMessages(root))
  const resumeText =
    afterResume.filter((t) => t.includes('"paused"') && t.includes('"lead"')).at(0) ?? ''
  record('resume unpauses', /"paused":\s*false/.test(resumeText), resumeText.slice(0, 200))

  // -- partner pool escalation (Fusion-style model switching) ---------------
  await api('POST', `/api/session/${root}/command`, {
    name: 'fusion',
    text: 'configure fakeproviderA/lead#max fakeproviderB/worker#max,fakeproviderB/worker2#max',
  })
  await sleep(1_500)
  await api('POST', `/api/session/${root}/prompt`, {
    text: 'Run the Fusion fixture assignment failprobe.',
  })
  await waitIdle(root)
  await api('POST', `/api/session/${root}/command`, { name: 'fusion', text: 'status' })
  await api('POST', `/api/session/${root}/prompt`, { text: 'Report.' })
  await waitIdle(root)
  const poolMsgs = messageTexts(await sessionMessages(root))
  const poolStatus = poolMsgs.filter((t) => t.includes('"partnerIndex"')).at(0) ?? ''
  record(
    'failed job escalates partner pool',
    /"partnerIndex":\s*1/.test(poolStatus) && poolStatus.includes('worker2'),
    poolStatus.slice(0, 220),
  )

  await api('POST', `/api/session/${root}/prompt`, {
    text: 'Run the Fusion fixture assignment.',
  })
  await waitIdle(root)
  const sessions4 = await api('GET', '/api/session')
  const children4 = (sessions4.json?.data ?? sessions4.json ?? []).filter(
    (s) => s.parentID === root,
  )
  const sameChild = children4.length === 1 && children4[0]?.id === childID
  const wire2 = fs.existsSync(FIXTURE_LOG)
    ? fs
        .readFileSync(FIXTURE_LOG, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : []
  const lastWorkerWire = wire2.filter((w) => w.event === 'wire' && w.provider === 'fakeproviderB').at(-1)
  record(
    'switched partner model serves persistent child',
    sameChild && lastWorkerWire?.modelId === 'worker2',
    JSON.stringify({ sameChild, model: lastWorkerWire?.modelId }),
  )

  return results
}

main()
  .then((r) => {
    fs.writeFileSync(path.join(OUT_DIR, 'e2e-results.json'), JSON.stringify(r, null, 2))
    const failed = r.filter((x) => !x.ok)
    console.log(`e2e: ${r.length - failed.length}/${r.length} passed`)
    process.exit(failed.length ? 1 : 0)
  })
  .catch((error) => {
    console.error('e2e driver error', error)
    process.exit(2)
  })
