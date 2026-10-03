# opencode-fusion

Fusion-style two-model coordination for [OpenCode](https://opencode.ai) v2 — with **your** models.

Inspired by Devin's Fusion mode: a strong *lead* model owns planning, decisions, and
final review, while a cheaper or specialized *partner* model executes bounded
implementation assignments in a persistent child session. You pick both models from
any providers you have configured in OpenCode — e.g. `opencode/*` Zen models,
a `devin/*` subscription model, `openai/*`, `anthropic/*`, or anything else — each
with its own thinking variant (`#max`, `#low`, ...).

```
/fusion configure openai/gpt-5.2#high devin/swe-2#max
```

## What it does

- **`fusion_delegate`** — the lead hands the partner a bounded assignment
  (`task` + `brief`) and gets back a structured report (output, files touched,
  verification run, blockers).
- **Persistent partner session** — the partner keeps one OpenCode child session
  across handoffs, so repository knowledge accumulates instead of being re-read
  every delegation.
- **Single-writer workspace guard** — only one active Fusion job may write at a
  time; concurrent or nested delegation is refused.
- **Foreground & background** — foreground delegation blocks the lead's tool call
  until the partner finishes; background delegation acknowledges immediately and
  posts the report as a synthetic message without waking the parent into a loop.
- **Safety rails** — partner agents cannot call `fusion_delegate`/`fusion_wait`,
  cannot spawn nested subagents, inherit the parent agent's permissions, and run
  under a step cap. Interruptions pause coordination instead of silently
  resubmitting.
- **Recovery** — on restart, in-flight jobs are probed and marked
  `recovery-required` rather than assumed complete; interrupted work is never
  auto-resubmitted.

## Install

Requires OpenCode **v2** (developed and tested against `2.0.21`) and Node >= 22.

### From a git clone (no build step needed)

```sh
git clone https://github.com/KelpHect/opencode-fusion
```

then add it to `~/.config/opencode/opencode.json` (global) or `opencode.json`
(project):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["C:/path/to/opencode-fusion"]
}
```

OpenCode resolves a directory plugin spec to the repo's `index.ts`, which loads
the TypeScript source directly. `npm install && npm run build` inside the clone
also produces `dist/` (used when the package is installed from npm).

### From npm

```json
{
  "plugin": ["opencode-fusion"]
}
```

## Configure

Inside a session:

```
/fusion configure <lead-model> <partner-model>[,<fallback>,...]
```

Model references use `provider/model` with an optional `#variant`, exactly like
OpenCode's own model picker:

```
/fusion configure opencode/fledge-alpha-free#max devin/swe-2#max
/fusion configure openai/gpt-5.2#high anthropic/claude-sonnet-4.6#max
```

A comma-separated partner list is an **escalation ladder** (preference order).
The harness advances to the next partner when a handoff *fails*, and when the
persistent partner's context is *compacted* — the same model-switching boundary
Devin's Fusion uses — while the partner conversation itself stays persistent:

```
/fusion configure openai/gpt-5.2#high devin/swe-2#max,openai/o3-mini#high
```

All models must already be available in your OpenCode model list
(`/fusion models` shows what the plugin can see). Configure validates the whole
pool before enabling and switches the session's model to the lead.

### `/models` presets (composite models)

Instead of running `/fusion configure` inside a session, you can declare named
pairings up front — each one appears in OpenCode's `/models` picker as a
composite `Fusion` model, mirroring Devin's picker entries:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "C:/path/to/opencode-fusion",
      "options": {
        "presets": [
          {
            "name": "GPT-5.2 + SWE-2",
            "lead": "openai/gpt-5.2#high",
            "partner": "devin/swe-2#max,openai/o3-mini#high"
          },
          { "lead": "opencode/big-pickle", "partner": "devin/swe-2#max" }
        ]
      }
    }
  ]
}
```

- Each preset becomes a model under a `Fusion (<lead-provider>)` provider —
  e.g. `opencode-fusion-openai/preset-0`. Selecting it in `/models` configures
  and enables the pairing automatically; no `/fusion configure` needed.
- The composite is **backed by the lead model's own package**, so requests to
  it are served by the lead — the picker entry is a real model, not a macro.
  `/fusion status` reports the selected composite under `composite`.
- `partner` still accepts the comma-separated escalation ladder; `name` is
  optional (a `Fusion: <lead> + <partner>` label is generated).
- **Important:** plugin entries with `options` must use the `plugins` array key
  (plural). The `plugin` singular key accepts only plain string specs and
  silently drops `{package, options}` objects (observed on 2.0.2x).
- If a preset's lead provider/model isn't available at load time (e.g. its
  plugin loads later), registration retries briefly and reports unresolved
  presets under `skippedPresets` in `/fusion status`.
- The composite provider clones the lead provider's `settings`, `headers`,
  and `body` (e.g. `baseURL`, API keys) so its SDK instance is configured
  exactly like the lead's. As a second layer, the finished language model is
  also captured whenever any lead model is instantiated, so providers whose
  SDK factory is inert (e.g. `aisdk:` plugins that mint models in a language
  hook instead) work once that provider has served one request.

### Interactive picker + status line (TUI)

The package also ships a TUI component (`tui.ts`) that the OpenCode TUI loads
automatically:

- **`/fusion` with no arguments** opens the pairing wizard: a select dialog
  for the lead (every model × effort variant as searchable rows), then a
  second dialog for the partner. Picking both runs `configure` for you.
  `/fusion <args>` still forwards to the command surface below.
- **Prompt footer segment** shows `fusion ●lead + ○partner` for the active
  session. The side that is currently doing work lights up green —
  `●` while the lead is generating and `●` on the partner while a delegated
  handoff is running in its child session. Pairings are remembered per
  session and also recovered from `/fusion status` output, so the line stays
  correct across restarts and for sessions configured via text commands or
  composite presets.

## Commands

| Command | Effect |
| --- | --- |
| `/fusion configure <lead> <partner>` | Set the pairing and enable |
| `/fusion status` | Pairing, budget, active/last job |
| `/fusion models` | Available provider/model refs |
| `/fusion pause` | Cancel active job, refuse new delegation |
| `/fusion resume` | Re-enable (revalidates models) |
| `/fusion off` | Cancel active job and disable |
| `/fusion wait` | Wait for the active job's report |
| `/fusion reset` | Retire the persistent partner session (keeps history) |

## Options

All options are optional; these are the defaults:

| Option | Default | Notes |
| --- | --- | --- |
| `maxDelegations` | `12` | Hard budget per session |
| `maxWorkerSteps` | `30` | Partner agent step cap |
| `delegationTimeoutMs` | `1800000` | 30 min per handoff |
| `maxReportCharacters` | `32000` | Report is truncated above this |
| `backgroundByDefault` | `false` | `background: true` input overrides |
| `sidekickMaxOutputTokens` | unset | Cap partner output tokens |

## How it works

- Delegation runs on OpenCode's **native subagent tool**, so permission checks,
  approvals, and parent/child session linkage behave exactly like built-in
  subagents. The child session id is persisted and reused on the next handoff.
- **Model switching at boundaries** — a comma-separated partner pool acts as an
  escalation ladder. A failed handoff advances to the next partner; a partner
  context compaction advances too. The child session persists across the switch
  (the same conversation is served by a different model), mirroring Devin
  Fusion's compaction-boundary switching. Escalation clamps at the pool's end
  and resets on `/fusion configure` or `/fusion reset`.
- **Lead context mirroring** — each handoff automatically carries a bounded
  tail of the lead's latest reasoning (`leadContext`), so the partner sees the
  plan, not just a bare task string.
- The partner runs under a generated agent (`fusion-worker-<hash>`) that inherits
  the parent agent's system prompt and permissions, plus Fusion restrictions:
  no `subagent`, no `fusion_delegate`, no `fusion_wait`, step cap.
- The lead gets a coordination policy injected into its system prompt while
  Fusion is enabled and unpaused: delegate bounded work, review partner output
  before trusting it, don't treat partner claims as verified without inspection.
- Interrupting a session (or switching its model) cancels the active partner job
  and pauses Fusion — nothing is resubmitted automatically; `/fusion resume`
  re-enables.
- Background reports are injected as queued synthetic messages with
  `resume: false`, so completion never wakes the parent into a re-delegation
  loop.

## Limitations

- **Escalation-only switching.** The pool advances on failure or partner
  compaction and clamps at the end — it does not de-escalate mid-session or
  pick partners per-task like a full router.
- Delegation results must not contain multiple `undefined`-valued metadata keys
  — this plugin sanitizes its own results, but be aware OpenCode 2.0.x has a
  silent tool-result drop in that case.
- Partner persistence is per root session; `/fusion reset` starts a fresh
  partner context and resets the index.

## Development

```sh
npm install
npm run build      # tsc -> dist/
npm test           # unit tests (node --test + tsx)
npm run test:e2e   # full engine test (needs a running sandbox server)
```

The e2e driver (`tests/e2e/run.mjs`) exercises foreground delegation, child
session linkage and reuse, `#variant` propagation onto the wire, background
delivery without loops, interrupt/pause/resume, composite `/models` selection,
and partner-pool escalation — 20 checks against a fixture model provider
(`tests/e2e/fixture`).

`tests/live-zen.mjs` is an optional live check against a real OpenCode
server with a composite preset backed by OpenCode Zen free models (no
fixture): it proves a real LLM lead calls `fusion_delegate`, a real partner
executes in a persistent linked child, and `/fusion status` reports the
composite. Point it at your server:

```sh
FUSION_LIVE_URL=http://127.0.0.1:49374 \
FUSION_LIVE_COMPOSITE=opencode-fusion-opencode/preset-0 \
node tests/live-zen.mjs
```

## License

Apache-2.0
