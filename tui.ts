// opencode-fusion TUI surface — interactive pairing wizard + status segment.
// Loaded automatically by the OpenCode TUI from this file next to index.ts.
//
//   /fusion            → lead select → effort inline per row → partner select
//   /fusion <args>     → forwarded to the server-side /fusion command
//   prompt footer      → "●lead + ○partner" — the active side lights up

import type { Plugin } from '@opencode/plugin/tui'
import { jsx } from '@opentui/solid/jsx-runtime'
import { createMemo } from 'solid-js'
import {
  buildModelOptions,
  derivePairing,
  isCompositeRef,
  shortRef,
  type Pairing,
} from './src/tui-helpers.js'

type Ctx = Plugin.Context
type Pairings = Record<string, Pairing>

function routeSession(ctx: Ctx): string | undefined {
  const route = ctx.ui.router.current()
  return route.type === 'session' ? route.sessionID : undefined
}

async function pickPairing(ctx: Ctx, sessionID: string, pairings: Pairings) {
  const listed = await ctx.client.model.list({}).catch(() => undefined)
  const models = (Array.isArray(listed) ? listed : (listed as any)?.data) ?? []
  const options = buildModelOptions(models)
  if (options.length === 0) {
    ctx.ui.toast.show({ variant: 'error', title: 'Fusion', message: 'No models available.' })
    return
  }
  const current = pairings[sessionID]
  const lead = await ctx.ui.dialog.select<string>({
    title: 'Fusion — lead model (plans, reviews, decides)',
    placeholder: 'search models or efforts…',
    current: current?.lead,
    options,
  })
  if (!lead) return
  const partner = await ctx.ui.dialog.select<string>({
    title: `Fusion — partner model (implements, verifies) · lead: ${shortRef(lead)}`,
    placeholder: 'search models or efforts…',
    current: current?.partner,
    options,
  })
  if (!partner) return
  try {
    await ctx.client.session.command({
      sessionID,
      name: 'fusion',
      text: `configure ${lead} ${partner}`,
    })
    ctx.ui.toast.show({
      variant: 'success',
      title: 'Fusion',
      message: `lead ${shortRef(lead)} + partner ${shortRef(partner)}`,
      sessionID,
    })
  } catch (error) {
    ctx.ui.toast.show({
      variant: 'error',
      title: 'Fusion configure failed',
      message: String(error),
    })
  }
}

function StatusLine(props: { ctx: Ctx; input: { sessionID?: string }; pairings: Pairings }) {
  const { ctx } = props
  const sessionID = createMemo(() => props.input.sessionID ?? routeSession(ctx))
  const session = createMemo(() => {
    const id = sessionID()
    return id ? ctx.data.session.get(id) : undefined
  })
  const messages = createMemo(() => {
    const id = sessionID()
    return id ? (ctx.data.session.message.list(id) ?? []) : []
  })
  const child = createMemo(() => {
    const id = sessionID()
    if (!id) return undefined
    for (const member of ctx.data.session.family(id) ?? []) {
      if (member === id) continue
      const info = ctx.data.session.get(member)
      if (info?.parentID === id) return info
    }
    return undefined
  })
  const pairing = createMemo(() => {
    const id = sessionID()
    if (!id) return undefined
    return derivePairing({
      remembered: props.pairings[id],
      messages: messages() as { type?: string; text?: string }[],
      sessionModel: session()?.model,
      childModel: child()?.model,
    })
  })
  const partnerBusy = createMemo(() => {
    const id = sessionID()
    if (!id) return false
    return (ctx.data.session.family(id) ?? []).some(
      (member) => member !== id && ctx.data.session.status(member) === 'running',
    )
  })
  const leadBusy = createMemo(() => {
    const id = sessionID()
    return !!id && ctx.data.session.status(id) === 'running' && !partnerBusy()
  })

  // Solid components mount once — every dynamic value must live behind a
  // getter so the reconciler re-reads it when the stores change.
  const idle = ctx.theme.text.muted
  const active = ctx.theme.text.feedback.success.base
  return jsx('box', {
    flexDirection: 'row',
    get children() {
      const pair = pairing()
      if (!pair) return [jsx('text', {})]
      const leadOn = leadBusy()
      const partnerOn = partnerBusy()
      const leadLabel = isCompositeRef(pair.composite ?? '')
        ? shortRef(pair.composite)
        : shortRef(pair.lead)
      return [
        jsx('text', { fg: idle, children: ' fusion ' }),
        jsx('text', {
          fg: leadOn ? active : idle,
          children: `${leadOn ? '●' : '○'} ${leadLabel}`,
        }),
        jsx('text', { fg: idle, children: ' + ' }),
        jsx('text', {
          fg: partnerOn ? active : idle,
          children: `${partnerOn ? '●' : '○'} ${shortRef(pair.partner)}`,
        }),
      ]
    },
  })
}

export default {
  id: 'opencode.fusion.tui',
  setup(ctx: Ctx) {
    const [pairings, setPairings] = ctx.storage.store<Pairings>('fusion-pairings', {
      initial: {},
    })

    ctx.keymap.layer(() => ({
      commands: [
        {
          id: 'fusion.pair',
          title: 'Fusion: choose lead + partner',
          description: 'Pick the Fusion lead and partner models for this session',
          group: 'Fusion',
          palette: true,
          slash: { name: 'fusion', arguments: true },
          run(input) {
            const sessionID = routeSession(ctx)
            if (!sessionID) {
              ctx.ui.toast.show({
                variant: 'warning',
                title: 'Fusion',
                message: 'Open a session first.',
              })
              return
            }
            const args = (input ?? '').trim()
            if (args.length > 0) {
              // Keep /fusion <subcommand> working: forward to the server plugin.
              void ctx.client.session
                .command({ sessionID, name: 'fusion', text: args })
                .then(async () => {
                  if (args.startsWith('configure')) {
                    const [lead, partner] = args.slice('configure'.length).trim().split(/\s+/)
                    if (lead && partner) {
                      await setPairings((draft) => {
                        draft[sessionID] = { lead, partner }
                      })
                    }
                  }
                })
                .catch(() => {})
              return
            }
            void pickPairing(ctx, sessionID, pairings)
          },
        },
      ],
    }))

    const unclaim = ctx.ui.slot({
      append: 'prompt.footer.status',
      render: (input) =>
        jsx(StatusLine as unknown as (p: Record<string, unknown>) => unknown, {
          ctx,
          input,
          pairings,
        }),
    })

    return () => {
      unclaim()
    }
  },
} satisfies Plugin.Definition
