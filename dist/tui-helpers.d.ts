export interface ModelOptionLike {
    providerID: string;
    id: string;
    modelID?: string;
    name?: string;
    enabled?: boolean;
    variants?: ReadonlyArray<{
        id: string;
    }>;
}
export interface SelectOption<Value> {
    title: string;
    value: Value;
    description?: string;
    category?: string;
}
export interface Pairing {
    lead: string;
    partner?: string;
    composite?: string;
}
/** `provider/model#variant` — variant omitted when absent. */
export declare function refOf(providerID: string, id: string, variant?: string): string;
/** Display-shortened ref: `model#variant` (provider hidden). */
export declare function shortRef(ref: string | undefined): string;
/** Provider segment of a ref (for grouping/composite detection). */
export declare function providerOf(ref: string): string;
export declare function isCompositeRef(ref: string | undefined): boolean;
/**
 * Flatten the model catalog into select options — one row per
 * (model, effort) pair so a single dialog covers model + effort choice.
 */
export declare function buildModelOptions(models: ReadonlyArray<ModelOptionLike>): SelectOption<string>[];
interface MessageLike {
    type?: string;
    text?: string;
}
/**
 * Recover the pairing from the newest fusion status synthetic message.
 * Status text is a JSON blob carrying `lead`, `partner`, `composite`.
 */
export declare function pairingFromMessages(messages: ReadonlyArray<MessageLike>): Pairing | undefined;
/**
 * Derive the effective pairing for a session:
 *  1. remembered wizard choice (authoritative for this session)
 *  2. latest fusion status synthetic in the transcript
 *  3. session model — composite presets name the lead indirectly; a plain
 *     session model IS the lead (configure switches the session to it)
 *  4. partner falls back to the worker child's model when one exists
 */
export declare function derivePairing(input: {
    remembered?: Pairing;
    messages: ReadonlyArray<MessageLike>;
    sessionModel?: {
        providerID: string;
        id: string;
        variant?: string;
    };
    childModel?: {
        providerID: string;
        id: string;
        variant?: string;
    };
}): Pairing | undefined;
export {};
