import fs from 'node:fs'
import path from 'node:path'
import { READ_ONLY_TOOLS } from './policy.js'
import { TOOL_NAMES } from './policy.js'

export interface Lease {
  readonly key: string
  readonly rootID: string
  readonly jobID: string
  ownerChildID?: string
}

export class LeaseRegistry {
  private readonly leases = new Map<string, Lease>()

  acquire(key: string, rootID: string, jobID: string): Lease | undefined {
    if (this.leases.has(key)) return undefined
    const lease: Lease = { key, rootID, jobID }
    this.leases.set(key, lease)
    return lease
  }

  get(key: string): Lease | undefined {
    return this.leases.get(key)
  }

  setOwner(lease: Lease, childID: string): void {
    lease.ownerChildID = childID
  }

  release(lease: Lease): void {
    if (this.leases.get(lease.key) === lease) this.leases.delete(lease.key)
  }
}

export const workspaceLeases = new LeaseRegistry()

export function canonicalDirectory(directory: string): string {
  let resolved = directory
  try {
    resolved = fs.realpathSync.native(directory)
  } catch {
    try {
      resolved = path.resolve(directory)
    } catch {}
  }
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

export function isReadOnlyTool(name: string): boolean {
  return (
    (READ_ONLY_TOOLS as readonly string[]).includes(name) ||
    name === TOOL_NAMES.status ||
    name === TOOL_NAMES.wait
  )
}
