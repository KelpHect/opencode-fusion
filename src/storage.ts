import type { SessionState, StorageLike } from './types.js'

export const STATE_PREFIX = 'session/'

export function stateKey(rootID: string): string {
  return `${STATE_PREFIX}${rootID}`
}

export class MutexMap {
  private readonly tails = new Map<string, Promise<void>>()

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const tail = this.tails.get(key) ?? Promise.resolve()
    const next = tail.then(fn, fn)
    this.tails.set(
      key,
      next.then(
        () => undefined,
        () => undefined,
      ),
    )
    return next
  }
}

export class FusionStore {
  constructor(private readonly storage: StorageLike) {}

  async get(rootID: string): Promise<SessionState | undefined> {
    const raw = await this.storage.get(stateKey(rootID))
    if (raw === undefined || raw === null) return undefined
    const state = raw as SessionState
    if (state.version !== 1 || typeof state.workerAgentID !== 'string') return undefined
    state.jobs = state.jobs ?? {}
    return state
  }

  async set(rootID: string, state: SessionState): Promise<void> {
    await this.storage.set(stateKey(rootID), state as never)
  }

  async remove(rootID: string): Promise<void> {
    await this.storage.remove(stateKey(rootID))
  }

  async scanAll(): Promise<{ rootID: string; state: SessionState }[]> {
    const result = await this.storage.scan({ prefix: STATE_PREFIX })
    const entries =
      result && typeof result === 'object' && 'entries' in (result as Record<string, unknown>)
        ? ((result as { entries: { key: string; value: unknown }[] }).entries ?? [])
        : Array.isArray(result)
          ? (result as { key: string; value: unknown }[])
          : []
    const out: { rootID: string; state: SessionState }[] = []
    for (const entry of entries) {
      const key = typeof entry?.key === 'string' ? entry.key : ''
      const value = (entry as { value?: unknown }).value ?? entry
      const state = value as SessionState
      if (!key.startsWith(STATE_PREFIX)) continue
      if (state && state.version === 1 && typeof state.workerAgentID === 'string') {
        state.jobs = state.jobs ?? {}
        out.push({ rootID: key.slice(STATE_PREFIX.length), state })
      }
    }
    return out
  }
}
