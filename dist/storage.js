export const STATE_PREFIX = 'session/';
export function stateKey(rootID) {
    return `${STATE_PREFIX}${rootID}`;
}
export class MutexMap {
    tails = new Map();
    run(key, fn) {
        const tail = this.tails.get(key) ?? Promise.resolve();
        const next = tail.then(fn, fn);
        this.tails.set(key, next.then(() => undefined, () => undefined));
        return next;
    }
}
export class FusionStore {
    storage;
    constructor(storage) {
        this.storage = storage;
    }
    async get(rootID) {
        const raw = await this.storage.get(stateKey(rootID));
        if (raw === undefined || raw === null)
            return undefined;
        const state = raw;
        if (state.version !== 1 || typeof state.workerAgentID !== 'string')
            return undefined;
        state.jobs = state.jobs ?? {};
        return state;
    }
    async set(rootID, state) {
        await this.storage.set(stateKey(rootID), state);
    }
    async remove(rootID) {
        await this.storage.remove(stateKey(rootID));
    }
    async scanAll() {
        const result = await this.storage.scan({ prefix: STATE_PREFIX });
        const entries = result && typeof result === 'object' && 'entries' in result
            ? (result.entries ?? [])
            : Array.isArray(result)
                ? result
                : [];
        const out = [];
        for (const entry of entries) {
            const key = typeof entry?.key === 'string' ? entry.key : '';
            const value = entry.value ?? entry;
            const state = value;
            if (!key.startsWith(STATE_PREFIX))
                continue;
            if (state && state.version === 1 && typeof state.workerAgentID === 'string') {
                state.jobs = state.jobs ?? {};
                out.push({ rootID: key.slice(STATE_PREFIX.length), state });
            }
        }
        return out;
    }
}
