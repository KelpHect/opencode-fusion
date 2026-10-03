import fs from 'node:fs';
import path from 'node:path';
import { READ_ONLY_TOOLS } from './policy.js';
import { TOOL_NAMES } from './policy.js';
export class LeaseRegistry {
    leases = new Map();
    acquire(key, rootID, jobID) {
        if (this.leases.has(key))
            return undefined;
        const lease = { key, rootID, jobID };
        this.leases.set(key, lease);
        return lease;
    }
    get(key) {
        return this.leases.get(key);
    }
    setOwner(lease, childID) {
        lease.ownerChildID = childID;
    }
    release(lease) {
        if (this.leases.get(lease.key) === lease)
            this.leases.delete(lease.key);
    }
}
export const workspaceLeases = new LeaseRegistry();
export function canonicalDirectory(directory) {
    let resolved = directory;
    try {
        resolved = fs.realpathSync.native(directory);
    }
    catch {
        try {
            resolved = path.resolve(directory);
        }
        catch { }
    }
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}
export function isReadOnlyTool(name) {
    return (READ_ONLY_TOOLS.includes(name) ||
        name === TOOL_NAMES.status ||
        name === TOOL_NAMES.wait);
}
