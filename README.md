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
/fusion configure <lead-model> <partner-model>
```

Model references use `provider/model` with an optional `#variant`, exactly like
OpenCode's own model picker:

```
/fusion configure opencode/fledge-alpha-free#max devin/swe-2#max
/fusion configure openai/gpt-5.2#high anthropic/claude-sonnet-4.6#max
```

Both models must already be available in your OpenCode model list
(`/fusion models` shows what the plugin can see). Configure validates the pair
before enabling and switches the session's model to the lead.

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

- **Fixed pairing, not a router.** You choose the two models; there is no
  adaptive per-task model switching yet.
- Delegation results must not contain multiple `undefined`-valued metadata keys
  — this plugin sanitizes its own results, but be aware OpenCode 2.0.x has a
  silent tool-result drop in that case.
- Partner persistence is per root session; `/fusion reset` starts a fresh
  partner context.

## Development

```sh
npm install
npm run build      # tsc -> dist/
npm test           # unit tests (node --test + tsx)
npm run test:e2e   # full engine test (needs a running sandbox server)
```

The e2e driver (`tests/e2e/run.mjs`) exercises foreground delegation, child
session linkage and reuse, `#variant` propagation onto the wire, background
delivery without loops, and interrupt/pause/resume — 16 checks against a fixture
model provider (`tests/e2e/fixture`).

## License

Apache-2.0
