import { Model, Provider } from '@opencode/plugin';
import { parseModelReference } from './models.js';
const unwrapList = (value) => {
    if (value && typeof value === 'object' && 'data' in value) {
        const data = value.data;
        return Array.isArray(data) ? data : [];
    }
    return Array.isArray(value) ? value : [];
};
const sanitizeID = (value) => value.replace(/[^a-zA-Z0-9-_]/g, '-');
const displayName = (preset, lead, partnerCount) => {
    if (preset.name)
        return preset.name;
    const first = preset.partner.split(',')[0]?.trim() ?? '';
    const partnerID = first.split('/').at(-1)?.split('#')[0] ?? first;
    const extra = partnerCount > 1 ? ` (+${partnerCount - 1})` : '';
    return `Fusion: ${lead.id}${lead.variant ? `#${lead.variant}` : ''} + ${partnerID}${extra}`;
};
export async function registerPresets(ctx, presets, registrations, deps = {}) {
    const listProviders = deps.listProviders ?? (async () => unwrapList(await ctx.provider.list()));
    const listModels = deps.listModels ?? (async () => unwrapList(await ctx.model.list()));
    const delayMs = deps.delayMs ?? 400;
    const maxWaitMs = deps.maxWaitMs ?? 20_000;
    const result = { presets: [], skipped: [] };
    const skip = (preset, reason) => {
        result.skipped.push({ preset: preset.name ?? preset.lead, reason });
    };
    // Capture each aisdk provider's instantiated SDK — and the finished language
    // model other hooks produced — so composites can mint a lead language model
    // with the lead provider's own credentials even when its SDK factory is
    // inert or needs provider-scoped options.
    const sdkByProvider = new Map();
    const languageByModel = new Map();
    registrations.push(await ctx.aisdk.hook('language', (event) => {
        const model = event.model;
        const providerID = String(model.providerID ?? '');
        const modelID = String(model.id ?? '');
        const sdk = event.sdk;
        if (providerID && sdk && typeof sdk.languageModel === 'function') {
            sdkByProvider.set(providerID, sdk);
        }
        // Read event.language after sibling hooks have settled it.
        queueMicrotask(() => {
            if (providerID && modelID && event.language) {
                languageByModel.set(`${providerID}/${modelID}`, event.language);
            }
        });
    }, {}));
    const resolve = (preset, providers, catalog) => {
        let lead;
        try {
            lead = parseModelReference(preset.lead);
        }
        catch {
            return { ok: false, reason: 'invalid_lead_ref', retry: false };
        }
        try {
            for (const ref of preset.partner.split(',').map((r) => r.trim()).filter(Boolean)) {
                parseModelReference(ref);
            }
        }
        catch {
            return { ok: false, reason: 'invalid_partner_ref', retry: false };
        }
        const record = providers.find((p) => String(p.id) === lead.providerID);
        if (!record?.package)
            return { ok: false, reason: 'lead_provider_unavailable', retry: true };
        const leadInfo = catalog.find((model) => String(model.providerID) === lead.providerID && String(model.id) === lead.id);
        if (!leadInfo)
            return { ok: false, reason: 'lead_model_unavailable', retry: true };
        return { ok: true, lead, pkg: String(record.package), leadInfo, provider: record };
    };
    const groups = new Map();
    const deadline = Date.now() + maxWaitMs;
    const unresolved = new Map(presets.map((p, i) => [i, p]));
    for (;;) {
        let providers = [];
        let catalog = [];
        try {
            providers = await listProviders();
            catalog = await listModels();
        }
        catch { }
        for (const [index, preset] of [...unresolved]) {
            const outcome = resolve(preset, providers, catalog);
            if (!outcome.ok) {
                if (!outcome.retry) {
                    skip(preset, outcome.reason);
                    unresolved.delete(index);
                }
                else if (Date.now() >= deadline) {
                    skip(preset, outcome.reason);
                    unresolved.delete(index);
                }
                continue;
            }
            unresolved.delete(index);
            const { lead, pkg, leadInfo, provider } = outcome;
            const partnerRefs = preset.partner
                .split(',')
                .map((ref) => ref.trim())
                .filter(Boolean);
            const providerID = `opencode-fusion-${sanitizeID(lead.providerID)}`;
            let group = groups.get(providerID);
            if (!group) {
                group = { providerID, pkg, source: provider, pending: [] };
                groups.set(providerID, group);
            }
            const resolved = {
                providerID,
                modelID: `preset-${index}`,
                name: displayName(preset, lead, partnerRefs.length),
                lead,
                partner: partnerRefs.join(','),
                leadWireID: String(leadInfo.modelID ?? leadInfo.id ?? lead.id),
                leadInfo,
            };
            group.pending.push(resolved);
            result.presets.push(resolved);
        }
        if (unresolved.size === 0 || Date.now() >= deadline)
            break;
        await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    for (const group of groups.values()) {
        const leadByModel = new Map(group.pending.map((pending) => [pending.modelID, pending]));
        registrations.push(await ctx.provider.transform((editor) => {
            editor.add({
                info: {
                    ...Provider.Info.empty(Provider.ID.make(group.providerID)),
                    name: `Fusion (${group.providerID.replace('opencode-fusion-', '')})`,
                    activation: 'enabled',
                    package: group.pkg,
                    settings: group.source.settings,
                    headers: group.source.headers,
                    body: group.source.body,
                },
                models: group.pending.map((pending) => Model.Info.make({
                    ...Model.Info.default(Provider.ID.make(group.providerID), Model.ID.make(pending.modelID)),
                    name: pending.name,
                    modelID: Model.ID.make(pending.leadWireID),
                    capabilities: pending.leadInfo.capabilities,
                    limit: pending.leadInfo.limit,
                    cost: [],
                    variants: (pending.leadInfo.variants ?? []),
                })),
            });
        }));
        registrations.push(await ctx.aisdk.hook('language', (event) => {
            const modelID = String(event.model.id ?? '');
            const pending = leadByModel.get(modelID);
            if (!pending)
                return;
            // Prefer the finished language model the lead provider's own hooks
            // produced (covers inert SDK factories like plugin-backed providers).
            const captured = languageByModel.get(`${pending.lead.providerID}/${pending.lead.id}`);
            if (captured) {
                event.language = captured;
                return;
            }
            const own = event.sdk;
            const cached = sdkByProvider.get(pending.lead.providerID);
            const sdk = cached ?? own;
            if (sdk && typeof sdk.languageModel === 'function') {
                try {
                    const language = sdk.languageModel(pending.leadWireID, event.options);
                    if (language)
                        event.language = language;
                }
                catch {
                    // Leave event.language unset — the engine falls back to the
                    // package's own languageModel for this model.
                }
            }
        }, { providerID: group.providerID }));
    }
    return result;
}
