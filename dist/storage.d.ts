import type { SessionState, StorageLike } from './types.js';
export declare const STATE_PREFIX = "session/";
export declare function stateKey(rootID: string): string;
export declare class MutexMap {
    private readonly tails;
    run<T>(key: string, fn: () => Promise<T>): Promise<T>;
}
export declare class FusionStore {
    private readonly storage;
    constructor(storage: StorageLike);
    get(rootID: string): Promise<SessionState | undefined>;
    set(rootID: string, state: SessionState): Promise<void>;
    remove(rootID: string): Promise<void>;
    scanAll(): Promise<{
        rootID: string;
        state: SessionState;
    }[]>;
}
