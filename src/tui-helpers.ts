// Pure helpers for the opencode-fusion TUI surface (tui.ts).
// No solid-js / opentui imports so these run under plain node tests.

export interface ModelOptionLike {
  providerID: string
  id: string
  modelID?: string
  name?: string
  enabled?: boolean
  variants?: ReadonlyArray<{ id: string }>
}

export interface SelectOption<Value> {
  title: string
  value: Value
  description?: string
  category?: string
}

export interface Pairing {
  lead: string
  partner?: string
  composite?: string
}

/** `provider/model#variant` — variant omitted when absent. */
export function refOf(providerID: string, id: string, variant?: string): string {
  return variant && variant !== 'default' ? `${providerID}/${id}#${variant}` : `${providerID}/${id}`
}

/** Display-shortened ref: `model#variant` (provider hidden). */
export function shortRef(ref: string | undefined): string {
  if (!ref) return '?'
  const slash = ref.lastIndexOf('/')
  return slash >= 0 ? ref.slice(slash + 1) : ref
}

/** Provider segment of a ref (for grouping/composite detection). */
export function providerOf(ref: string): string {
  const slash = ref.indexOf('/')
  return slash >= 0 ? ref.slice(0, slash) : ref
}

const COMPOSITE_PREFIX = 'opencode-fusion-'

export function isCompositeRef(ref: string | undefined): boolean {
  return !!ref && providerOf(ref).startsWith(COMPOSITE_PREFIX)
}

/**
 * Flatten the model catalog into select options — one row per
 * (model, effort) pair so a single dialog covers model + effort choice.
 */
export function buildModelOptions(
  models: ReadonlyArray<ModelOptionLike>,
): SelectOption<string>[] {
  const out: SelectOption<string>[] = []
  for (const model of models) {
    if (model.enabled === false) continue
    if (providerOf(`${model.providerID}/x`).startsWith(COMPOSITE_PREFIX)) continue
    const base = refOf(model.providerID, model.id)
    const name = model.name ?? model.id
    const variants = model.variants ?? []
    if (variants.length === 0) {
      out.push({ title: name, value: base, description: base, category: model.providerID })
      continue
    }
    out.push({
      title: name,
      value: base,
      description: `${base} · default`,
      category: model.providerID,
    })
    for (const variant of variants) {
      out.push({
        title: name,
        value: `${base}#${variant.id}`,
        description: `${base} · effort ${variant.id}`,
        category: model.providerID,
      })
    }
  }
  return out.sort((a, b) =>
    `${a.category}/${a.title}/${a.value}`.localeCompare(`${b.category}/${b.title}/${b.value}`),
  )
}

interface MessageLike {
  type?: string
  text?: string
}

/**
 * Recover the pairing from the newest fusion status synthetic message.
 * Status text is a JSON blob carrying `lead`, `partner`, `composite`.
 */
export function pairingFromMessages(messages: ReadonlyArray<MessageLike>): Pairing | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    const text = typeof message.text === 'string' ? message.text : undefined
    if (!text || !text.includes('"lead"')) continue
    try {
      const data = JSON.parse(text) as Record<string, unknown>
      if (typeof data.lead !== 'string') continue
      const pairing: Pairing = { lead: data.lead }
      if (typeof data.partner === 'string') pairing.partner = data.partner
      if (typeof data.composite === 'string') pairing.composite = data.composite
      return pairing
    } catch {
      continue
    }
  }
  return undefined
}

/**
 * Derive the effective pairing for a session:
 *  1. remembered wizard choice (authoritative for this session)
 *  2. latest fusion status synthetic in the transcript
 *  3. session model — composite presets name the lead indirectly; a plain
 *     session model IS the lead (configure switches the session to it)
 *  4. partner falls back to the worker child's model when one exists
 */
export function derivePairing(input: {
  remembered?: Pairing
  messages: ReadonlyArray<MessageLike>
  sessionModel?: { providerID: string; id: string; variant?: string }
  childModel?: { providerID: string; id: string; variant?: string }
}): Pairing | undefined {
  if (input.remembered) return input.remembered
  const fromStatus = pairingFromMessages(input.messages)
  const sessionRef = input.sessionModel
    ? refOf(input.sessionModel.providerID, input.sessionModel.id, input.sessionModel.variant)
    : undefined
  const childRef = input.childModel
    ? refOf(input.childModel.providerID, input.childModel.id, input.childModel.variant)
    : undefined
  if (fromStatus) {
    return { ...fromStatus, partner: fromStatus.partner ?? childRef }
  }
  if (!sessionRef) return undefined
  const composite = isCompositeRef(sessionRef) ? sessionRef : undefined
  return { lead: composite ?? sessionRef, partner: childRef, composite }
}
