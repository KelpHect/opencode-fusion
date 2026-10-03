export interface Lease {
    readonly key: string;
    readonly rootID: string;
    readonly jobID: string;
    ownerChildID?: string;
}
export declare class LeaseRegistry {
    private readonly leases;
    acquire(key: string, rootID: string, jobID: string): Lease | undefined;
    get(key: string): Lease | undefined;
    setOwner(lease: Lease, childID: string): void;
    release(lease: Lease): void;
}
export declare const workspaceLeases: LeaseRegistry;
export declare function canonicalDirectory(directory: string): string;
export declare function isReadOnlyTool(name: string): boolean;
