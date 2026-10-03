import { Model, Provider, type Plugin } from '@opencode/plugin'
import { canonicalRef, parseModelReference } from './models.js'
import type { FusionPreset, ModelReference } from './types.js'

/**
 * Composite `/models` presets. Each declared preset becomes a selectable model
 * under a `opencode-fusion-<leadProvider>` provider. The composite is backed by
 * the lead model's own aisdk package, so requests to it are served by the lead
 * model — choosing the entry in `/models` both selects the lead and enables
 * the pairing, mirroring Devin's composite Fusion model entries.
 */
export interface ResolvedPreset {
  providerID: string
  modelID: string
  name: string
  lead: ModelReference
  partner: string
}

export interface PresetRegistration {
  presets: ResolvedPreset[]
  skipped: { preset: string; reason: string }[]
}

interface ModelInfoLike {
  id?: string
  modelID?: string
  providerID?: string
  name?: string
  variants?: readonly { id: string; settings?: Record<string, unknown> }[]
  limit?: unknown
  capabilities?: unknown
}

interface ProviderInfoLike {
  id: string
  package?: string
  settings?: Record<string, unknown>
  headers?: Record<string, string>
  body?: Record<string, unknown>
}

type ProviderLister = () => Promise<readonly ProviderInfoLike[]>
type ModelLister = () => Promise<readonly ModelInfoLike[]>

const unwrapList = <T>(value: unknown): readonly T[] => {
  if (value && typeof value === 'object' && 'data' in (value as Record<string, unknown>)) {
    const data = (value as { data: unknown }).data
    return Array.isArray(data) ? (data as T[]) : []
  }
  return Array.isArray(value) ? (value as T[]) : []
}

const sanitizeID = (value: string): string => value.replace(/[^a-zA-Z0-9-_]/g, '-')

const displayName = (preset: FusionPreset, lead: ModelReference, partnerCount: number): string => {
  if (preset.name) return preset.name
  const first = preset.partner.split(',')[0]?.trim() ?? ''
  const partnerID = first.split('/').at(-1)?.split('#')[0] ?? first
  const extra = partnerCount > 1 ? ` (+${partnerCount - 1})` : ''
  return `Fusion: ${lead.id}${lead.variant ? `#${lead.variant}` : ''} + ${partnerID}${extra}`
}

export async function registerPresets(
  ctx: Plugin.Context,
  presets: readonly FusionPreset[],
  registrations: { dispose: () => Promise<void> }[],
  deps: {
    listProviders?: ProviderLister
    listModels?: ModelLister
    maxWaitMs?: number
    delayMs?: number
  } = {},
): Promise<PresetRegistration> {
  const listProviders: ProviderLister =
    deps.listProviders ?? (async () => unwrapList<ProviderInfoLike>(await ctx.provider.list()))
  const listModels: ModelLister =
    deps.listModels ?? (async () => unwrapList<ModelInfoLike>(await ctx.model.list()))
  const delayMs = deps.delayMs ?? 400
  const maxWaitMs = deps.maxWaitMs ?? 20_000

  const result: PresetRegistration = { presets: [], skipped: [] }
  const skip = (preset: FusionPreset, reason: string) => {
    result.skipped.push({ preset: preset.name ?? preset.lead, reason })
  }

  // Capture each aisdk provider's instantiated SDK — and the finished language
  // model other hooks produced — so composites can mint a lead language model
  // with the lead provider's own credentials even when its SDK factory is
  // inert or needs provider-scoped options.
  const sdkByProvider = new Map<string, { languageModel?: (id: string, options?: unknown) => unknown }>()
  const languageByModel = new Map<string, unknown>()
  registrations.push(
    await ctx.aisdk.hook(
      'language',
      (event) => {
        const model = event.model as { providerID?: unknown; id?: unknown }
        const providerID = String(model.providerID ?? '')
        const modelID = String(model.id ?? '')
        const sdk = event.sdk as { languageModel?: (id: string, options?: unknown) => unknown }
        if (providerID && sdk && typeof sdk.languageModel === 'function') {
          sdkByProvider.set(providerID, sdk)
        }
        // Read event.language after sibling hooks have settled it.
        queueMicrotask(() => {
          if (providerID && modelID && event.language) {
            languageByModel.set(`${providerID}/${modelID}`, event.language)
          }
        })
      },
      {},
    ),
  )

  interface Pending extends ResolvedPreset {
    leadWireID: string
    leadInfo: ModelInfoLike
  }

  // Plugin load order is arbitrary — a preset's lead provider may be registered
  // by a plugin that sets up after us. Resolution is retried until every preset
  // resolves, all remaining failures are permanent, or the deadline passes.
  type Resolution =
    | {
        ok: true
        lead: ModelReference
        pkg: string
        leadInfo: ModelInfoLike
        provider: ProviderInfoLike
      }
    | { ok: false; reason: string; retry: boolean }

  const resolve = (
    preset: FusionPreset,
    providers: readonly ProviderInfoLike[],
    catalog: readonly ModelInfoLike[],
  ): Resolution => {
    let lead: ModelReference
    try {
      lead = parseModelReference(preset.lead)
    } catch {
      return { ok: false, reason: 'invalid_lead_ref', retry: false }
    }
    try {
      for (const ref of preset.partner.split(',').map((r) => r.trim()).filter(Boolean)) {
        parseModelReference(ref)
      }
    } catch {
      return { ok: false, reason: 'invalid_partner_ref', retry: false }
    }
    const record = providers.find((p) => String(p.id) === lead.providerID)
    if (!record?.package) return { ok: false, reason: 'lead_provider_unavailable', retry: true }
    const leadInfo = catalog.find(
      (model) => String(model.providerID) === lead.providerID && String(model.id) === lead.id,
    )
    if (!leadInfo) return { ok: false, reason: 'lead_model_unavailable', retry: true }
    return { ok: true, lead, pkg: String(record.package), leadInfo, provider: record }
  }

  const groups = new Map<
    string,
    { providerID: string; pkg: string; source: ProviderInfoLike; pending: Pending[] }
  >()
  const deadline = Date.now() + maxWaitMs
  const unresolved = new Map<number, FusionPreset>(presets.map((p, i) => [i, p]))
  for (;;) {
    let providers: readonly ProviderInfoLike[] = []
    let catalog: readonly ModelInfoLike[] = []
    try {
      providers = await listProviders()
      catalog = await listModels()
    } catch {}
    for (const [index, preset] of [...unresolved]) {
      const outcome = resolve(preset, providers, catalog)
      if (!outcome.ok) {
        if (!outcome.retry) {
          skip(preset, outcome.reason)
          unresolved.delete(index)
        } else if (Date.now() >= deadline) {
          skip(preset, outcome.reason)
          unresolved.delete(index)
        }
        continue
      }
      unresolved.delete(index)
      const { lead, pkg, leadInfo, provider } = outcome
      const partnerRefs = preset.partner
        .split(',')
        .map((ref) => ref.trim())
        .filter(Boolean)
      const providerID = `opencode-fusion-${sanitizeID(lead.providerID)}`
      let group = groups.get(providerID)
      if (!group) {
        group = { providerID, pkg, source: provider, pending: [] }
        groups.set(providerID, group)
      }
      const resolved: Pending = {
        providerID,
        modelID: `preset-${index}`,
        name: displayName(preset, lead, partnerRefs.length),
        lead,
        partner: partnerRefs.join(','),
        leadWireID: String(leadInfo.modelID ?? leadInfo.id ?? lead.id),
        leadInfo,
      }
      group.pending.push(resolved)
      result.presets.push(resolved)
    }
    if (unresolved.size === 0 || Date.now() >= deadline) break
    await new Promise((resolve) => setTimeout(resolve, delayMs))
  }

  for (const group of groups.values()) {
    const leadByModel = new Map(
      group.pending.map((pending) => [pending.modelID, pending] as const),
    )
    registrations.push(
      await ctx.provider.transform((editor) => {
        editor.add({
          info: {
            ...Provider.Info.empty(Provider.ID.make(group.providerID)),
            name: `Fusion (${group.providerID.replace('opencode-fusion-', '')})`,
            activation: 'enabled',
            package: group.pkg,
            settings: group.source.settings,
            headers: group.source.headers,
            body: group.source.body,
          } as never,
          models: group.pending.map((pending) =>
            Model.Info.make({
              ...Model.Info.default(
                Provider.ID.make(group.providerID),
                Model.ID.make(pending.modelID),
              ),
              name: pending.name,
              modelID: Model.ID.make(pending.leadWireID),
              capabilities: pending.leadInfo.capabilities as never,
              limit: pending.leadInfo.limit as never,
              cost: [],
              variants: (pending.leadInfo.variants ?? []) as never,
            }),
          ),
        } as never)
      }),
    )
    registrations.push(
      await ctx.aisdk.hook(
        'language',
        (event) => {
          const modelID = String((event.model as { id?: unknown }).id ?? '')
          const pending = leadByModel.get(modelID)
          if (!pending) return
          // Prefer the finished language model the lead provider's own hooks
          // produced (covers inert SDK factories like plugin-backed providers).
          const captured = languageByModel.get(`${pending.lead.providerID}/${pending.lead.id}`)
          if (captured) {
            event.language = captured as never
            return
          }
          const own = event.sdk as { languageModel?: (id: string, options?: unknown) => unknown }
          const cached = sdkByProvider.get(pending.lead.providerID)
          const sdk = cached ?? own
          if (sdk && typeof sdk.languageModel === 'function') {
            try {
              const language = sdk.languageModel(pending.leadWireID, event.options)
              if (language) event.language = language as never
            } catch {
              // Leave event.language unset — the engine falls back to the
              // package's own languageModel for this model.
            }
          }
        },
        { providerID: group.providerID },
      ),
    )
  }
  return result
}
