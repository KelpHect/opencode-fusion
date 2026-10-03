import { Model } from '@opencode/plugin';
import { FusionError } from './types.js';
export function parseModelReference(input) {
    let ref;
    try {
        ref = Model.Ref.parse(input);
    }
    catch {
        throw new FusionError('invalid_model_reference', input);
    }
    const bad = /[\s"'`\\]/;
    if (bad.test(ref.providerID) ||
        bad.test(ref.id) ||
        (ref.variant !== undefined && bad.test(ref.variant))) {
        throw new FusionError('invalid_model_reference', input);
    }
    return { providerID: ref.providerID, id: ref.id, variant: ref.variant };
}
export function canonicalRef(ref) {
    return `${ref.providerID}/${ref.id}${ref.variant ? `#${ref.variant}` : ''}`;
}
export function sameRef(a, b) {
    if (!a || !b)
        return false;
    return a.providerID === b.providerID && a.id === b.id && (a.variant ?? 'default') === (b.variant ?? 'default');
}
export function findAvailable(list, ref) {
    return list.find((m) => m.providerID === ref.providerID && m.id === ref.id);
}
export function requireAvailable(list, ref) {
    const model = findAvailable(list, ref);
    if (!model) {
        throw new FusionError('model_unavailable', canonicalRef(ref));
    }
    if (model.status === 'deprecated' || model.status === 'disabled' || model.enabled === false) {
        throw new FusionError('model_unavailable', canonicalRef(ref));
    }
    if (ref.variant !== undefined) {
        const variants = model.variants ?? [];
        if (!variants.some((v) => v.id === ref.variant)) {
            throw new FusionError('variant_unavailable', canonicalRef(ref));
        }
    }
    return model;
}
export function safeModelListing(model) {
    return {
        ref: `${model.providerID}/${model.id}`,
        name: model.name,
        variants: (model.variants ?? []).map((v) => v.id),
        limit: model.limit,
        capabilities: model.capabilities,
    };
}
