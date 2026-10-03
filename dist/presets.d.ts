import { type Plugin } from '@opencode/plugin';
import type { FusionPreset, ModelReference } from './types.js';
/**
 * Composite `/models` presets. Each declared preset becomes a selectable model
 * under a `opencode-fusion-<leadProvider>` provider. The composite is backed by
 * the lead model's own aisdk package, so requests to it are served by the lead
 * model — choosing the entry in `/models` both selects the lead and enables
 * the pairing, mirroring Devin's composite Fusion model entries.
 */
export interface ResolvedPreset {
    providerID: string;
    modelID: string;
    name: string;
    lead: ModelReference;
    partner: string;
}
export interface PresetRegistration {
    presets: ResolvedPreset[];
    skipped: {
        preset: string;
        reason: string;
    }[];
}
interface ModelInfoLike {
    id?: string;
    modelID?: string;
    providerID?: string;
    name?: string;
    variants?: readonly {
        id: string;
        settings?: Record<string, unknown>;
    }[];
    limit?: unknown;
    capabilities?: unknown;
}
interface ProviderInfoLike {
    id: string;
    package?: string;
    settings?: Record<string, unknown>;
    headers?: Record<string, string>;
    body?: Record<string, unknown>;
}
type ProviderLister = () => Promise<readonly ProviderInfoLike[]>;
type ModelLister = () => Promise<readonly ModelInfoLike[]>;
export declare function registerPresets(ctx: Plugin.Context, presets: readonly FusionPreset[], registrations: {
    dispose: () => Promise<void>;
}[], deps?: {
    listProviders?: ProviderLister;
    listModels?: ModelLister;
    maxWaitMs?: number;
    delayMs?: number;
}): Promise<PresetRegistration>;
export {};
