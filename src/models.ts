import { Model } from '@opencode/plugin'
import { FusionError, type ModelReference } from './types.js'

export function parseModelReference(input: string): ModelReference {
  let ref: { id: string; providerID: string; variant?: string }
  try {
    ref = Model.Ref.parse(input)
  } catch {
    throw new FusionError('invalid_model_reference', input)
  }
  const bad = /[\s"'`\\]/
  if (
    bad.test(ref.providerID) ||
    bad.test(ref.id) ||
    (ref.variant !== undefined && bad.test(ref.variant))
  ) {
    throw new FusionError('invalid_model_reference', input)
  }
  return { providerID: ref.providerID, id: ref.id, variant: ref.variant }
}

export function canonicalRef(ref: ModelReference): string {
  return `${ref.providerID}/${ref.id}${ref.variant ? `#${ref.variant}` : ''}`
}

export function sameRef(a: ModelReference | undefined, b: ModelReference | undefined): boolean {
  if (!a || !b) return false
  return a.providerID === b.providerID && a.id === b.id && (a.variant ?? 'default') === (b.variant ?? 'default')
}

export interface AvailableModel {
  id: string
  modelID?: string
  providerID: string
  name?: string
  variants?: readonly { id: string }[]
  limit?: { context?: number; output?: number }
  capabilities?: { tools?: boolean; input?: string[]; output?: string[] }
  status?: string
  enabled?: boolean
}

export function findAvailable(
  list: readonly AvailableModel[],
  ref: ModelReference,
): AvailableModel | undefined {
  return list.find((m) => m.providerID === ref.providerID && m.id === ref.id)
}

export function requireAvailable(
  list: readonly AvailableModel[],
  ref: ModelReference,
): AvailableModel {
  const model = findAvailable(list, ref)
  if (!model) {
    throw new FusionError('model_unavailable', canonicalRef(ref))
  }
  if (model.status === 'deprecated' || model.status === 'disabled' || model.enabled === false) {
    throw new FusionError('model_unavailable', canonicalRef(ref))
  }
  if (ref.variant !== undefined) {
    const variants = model.variants ?? []
    if (!variants.some((v) => v.id === ref.variant)) {
      throw new FusionError('variant_unavailable', canonicalRef(ref))
    }
  }
  return model
}

export function safeModelListing(model: AvailableModel) {
  return {
    ref: `${model.providerID}/${model.id}`,
    name: model.name,
    variants: (model.variants ?? []).map((v) => v.id),
    limit: model.limit,
    capabilities: model.capabilities,
  }
}
