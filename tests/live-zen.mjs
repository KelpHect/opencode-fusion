// Live end-to-end check against a real OpenCode server + OpenCode Zen free
// models. Requires a running server (opencode serve or the app's service) with
// opencode-fusion installed and a composite preset whose lead is a zen model.
//
//   FUSION_LIVE_URL=http://127.0.0.1:49374 \
//   FUSION_LIVE_AUTH=opencode:<service.json password> \
//   FUSION_LIVE_COMPOSITE=opencode-fusion-opencode/preset-3 \
//   node tests/live-zen.mjs
//
// What it proves (all real, no fixtures):
//   1. the composite model appears in /api/model
//   2. selecting it configures the pairing (lead + partner + pool)
//   3. a real LLM lead (zen free model) calls fusion_delegate
//   4. a real LLM partner (zen big-pickle) executes in a persistent child
//      session linked to the root
//   5. the composite stays recorded in /fusion status

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const BASE = process.env.FUSION_LIVE_URL ?? 'http://127.0.0.1:49374'
let AUTH = process.env.FUSION_LIVE_AUTH
if (!AUTH) {
  try {
    AUTH = `opencode:${JSON.parse(
      fs.readFileSync(path.join(os.homedir(), '.config/opencode/service.json'), 'utf8'),
    ).password}`
  } catch {
    AUTH = 'opencode:'
  }
}
const DIR =
  process.env.FUSION_LIVE_DIR ??
  path.join(os.tmpdir(), 'opencode-fusion-live-zen')
const COMPOSITE = (
  process.env.FUSION_LIVE_COMPOSITE ?? 'opencode-fusion-opencode/preset-3'
).split('/')

const results = []
const record = (name, ok, detail) => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`)
}

async function api(method, route, body) {
  const url = `${BASE}${route}${route.includes('?') ? '&' : '?'}directory=${encodeURIComponent(DIR)}`
  const res = await fetch(url, {
    method,
    headers: {
      authorization: `Basic ${Buffer.from(AUTH).toString('base64')}`,
      'content-type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  try {
    return { status: res.status, json: JSON.parse(text) }
  } catch {
    return { status: res.status, json: text }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const waitIdle = async (sid, timeoutMs = 240_000) => {
  const start = Date.now()
  for (;;) {
    const r = await api('POST', `/api/experimental/session/${sid}/wait`)
    if (r.status < 400) return true
    if (Date.now() - start > timeoutMs) return false
    await sleep(1000)
  }
}
const messages = async (sid) => (await api('GET', `/api/session/${sid}/message`)).json
const textsOf = (msgs) =>
  (Array.isArray(msgs) ? msgs : (msgs?.data ?? [])).flatMap((m) => [
    // Synthetic messages (fusion status, reports) carry text at message level.
    ...(typeof m.text === 'string' && m.text ? [m.text] : []),
    ...(m.parts ?? m.content ?? [])
      .filter((p) => p.type === 'text' && p.text)
      .map((p) => p.text),
  ])
const delegateParts = (msgs) =>
  (Array.isArray(msgs) ? msgs : (msgs?.data ?? [])).flatMap((m) =>
    (m.parts ?? m.content ?? []).filter(
      (p) => p?.type === 'tool' && (p.name === 'fusion_delegate' || p.tool === 'fusion_delegate'),
    ),
  )

fs.mkdirSync(DIR, { recursive: true })

async function main() {
  // Warm lazy location registry until the composite appears.
  let models = (await api('GET', '/api/model')).json
  const ids = (m) => (m?.data ?? m ?? []).map((x) => `${x.providerID}/${x.id ?? x.modelID}`)
  const want = COMPOSITE.join('/')
  for (let i = 0; i < 30 && !ids(models).includes(want); i++) {
    await sleep(500)
    models = (await api('GET', '/api/model')).json
  }
  record('composite preset registered', ids(models).includes(want), want)

  const created = await api('POST', '/api/session', { title: 'fusion-zen-live' })
  const root = created.json?.data?.id ?? created.json?.id
  record('session created', !!root, String(root))
  if (!root) return results

  const sel = await api('POST', `/api/session/${root}/model`, {
    model: { providerID: COMPOSITE[0], id: COMPOSITE[1], variant: 'max' },
  })
  record('composite selected in session', sel.status < 400, `status=${sel.status}`)
  await sleep(2_000)

  // Real LLM lead must choose to call fusion_delegate — prompt explicitly.
  const t0 = Date.now()
  await api('POST', `/api/session/${root}/prompt`, {
    text: 'Use the fusion_delegate tool exactly once to delegate this task to your partner: "Compute the sum of the first 20 prime numbers and report the result." When the partner reports back, repeat its answer.',
  })
  const idle = await waitIdle(root)
  record('turn settled', idle, `${Date.now() - t0}ms`)

  const msgs = await messages(root)
  fs.writeFileSync(path.join(DIR, 'live-zen-messages.json'), JSON.stringify(msgs, null, 2))

  const parts = delegateParts(msgs)
  const completed = parts.find((p) => p.state?.status === 'completed')
  record(
    'real LLM called fusion_delegate',
    parts.length > 0,
    `parts=${parts.length} states=${parts.map((p) => p.state?.status).join(',')}`,
  )
  record('delegation completed', !!completed)

  const childID =
    parts.map((p) => p.state?.metadata?.sessionID).filter(Boolean).at(-1) ??
    completed?.state?.metadata?.sessionID
  if (childID) {
    const child = await api('GET', `/api/session/${childID}`)
    const rec = child.json?.data ?? child.json
    record(
      'persistent child linked + zen partner model',
      rec?.parentID === root &&
        rec?.model?.providerID === 'opencode' &&
        typeof rec?.model?.id === 'string',
      JSON.stringify({ parentID: rec?.parentID, model: rec?.model }),
    )
    const childMsgs = await messages(childID)
    const cTexts = textsOf(childMsgs)
    record(
      'partner produced a real answer',
      cTexts.some((t) => /\d/.test(t)),
      (cTexts.at(-1) ?? '').slice(0, 160),
    )
  } else {
    record('persistent child linked + zen partner model', false, 'no sessionID in delegate metadata')
    record('partner produced a real answer', false, 'no child')
  }

  await api('POST', `/api/session/${root}/command`, { name: 'fusion', text: 'status' })
  await api('POST', `/api/session/${root}/prompt`, { text: 'Ack.' })
  await waitIdle(root, 60_000)
  const statusTexts = textsOf(await messages(root))
  const status = statusTexts.filter((t) => t.includes('"composite"') && t.includes('"paused"')).at(0) ?? ''
  record(
    'status reports composite + pairing',
    /"enabled":\s*true/.test(status) && status.includes(want),
    status.slice(0, 240),
  )

  const finalTexts = textsOf(msgs)
  record(
    'lead reported partner result',
    finalTexts.some((t) => /\b639\b/.test(t)),
    (finalTexts.at(-1) ?? '').slice(0, 160),
  )
  return results
}

main()
  .then((r) => {
    const failed = r.filter((x) => !x.ok)
    console.log(`live-zen: ${r.length - failed.length}/${r.length} passed`)
    process.exit(failed.length ? 1 : 0)
  })
  .catch((e) => {
    console.error('live-zen driver error', e)
    process.exit(2)
  })
