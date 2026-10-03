import { type ModelReference } from './types.js';
export declare function parseModelReference(input: string): ModelReference;
export declare function canonicalRef(ref: ModelReference): string;
export declare function sameRef(a: ModelReference | undefined, b: ModelReference | undefined): boolean;
export interface AvailableModel {
    id: string;
    modelID?: string;
    providerID: string;
    name?: string;
    variants?: readonly {
        id: string;
    }[];
    limit?: {
        context?: number;
        output?: number;
    };
    capabilities?: {
        tools?: boolean;
        input?: string[];
        output?: string[];
    };
    status?: string;
    enabled?: boolean;
}
export declare function findAvailable(list: readonly AvailableModel[], ref: ModelReference): AvailableModel | undefined;
export declare function requireAvailable(list: readonly AvailableModel[], ref: ModelReference): AvailableModel;
export declare function safeModelListing(model: AvailableModel): {
    ref: string;
    name: string | undefined;
    variants: string[];
    limit: {
        context?: number;
        output?: number;
    } | undefined;
    capabilities: {
        tools?: boolean;
        input?: string[];
        output?: string[];
    } | undefined;
};
