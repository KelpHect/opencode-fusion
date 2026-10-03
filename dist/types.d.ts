import type { Plugin } from '@opencode/plugin';
export interface FusionOptions {
    maxDelegations: number;
    maxWorkerSteps: number;
    delegationTimeoutMs: number;
    maxReportCharacters: number;
    backgroundByDefault: boolean;
    sidekickMaxOutputTokens?: number;
}
export interface ModelReference {
    providerID: string;
    id: string;
    variant?: string;
}
export type JobStatus = 'running' | 'completed' | 'failed' | 'interrupted' | 'recovery-required';
export interface JobRecord {
    id: string;
    rootID: string;
    workerSessionID?: string;
    revision: number;
    createdAt: number;
    finishedAt?: number;
    status: JobStatus;
    background: boolean;
    task: string;
    callID: string;
    output?: string;
    truncated?: boolean;
    error?: string;
    delivered?: boolean;
}
export interface SessionState {
    version: 1;
    enabled: boolean;
    paused: boolean;
    revision: number;
    lead: ModelReference;
    partner: ModelReference;
    parentAgentID?: string;
    workerAgentID: string;
    workerSessionID?: string;
    delegations: number;
    activeJob?: string;
    lastJob?: string;
    jobs: Record<string, JobRecord>;
    options?: Partial<FusionOptions>;
}
export interface ToolContextLike {
    readonly sessionID: string;
    readonly agent: string;
    readonly messageID: string;
    readonly id: string;
    readonly signal: AbortSignal;
    readonly progress: (update: unknown) => Promise<void>;
}
export interface RunnerInput {
    agent: string;
    description: string;
    prompt: string;
    model: string;
    sessionID?: string;
    background: false;
}
export interface RunnerOutput {
    sessionID: string;
    status: string;
    output: string;
}
export interface RunnerResult {
    output?: RunnerOutput;
    content?: unknown;
    metadata?: Record<string, unknown>;
}
export type Runner = (input: RunnerInput, context: ToolContextLike) => Promise<RunnerResult>;
export interface StorageLike {
    get(key: string): Promise<unknown>;
    set(key: string, value: unknown): Promise<void>;
    remove(key: string): Promise<void>;
    scan(options: {
        prefix: string;
    }): Promise<unknown>;
}
export interface ControllerDeps {
    now?: () => number;
    uuid?: () => string;
    storage?: StorageLike;
    runner?: Runner;
    listModels?: () => Promise<readonly unknown[]>;
    leases?: {
        acquire(key: string, rootID: string, jobID: string): LeaseLike | undefined;
        get(key: string): LeaseLike | undefined;
        setOwner(lease: LeaseLike, childID: string): void;
        release(lease: LeaseLike): void;
    };
}
export interface LeaseLike {
    readonly key: string;
    readonly rootID: string;
    readonly jobID: string;
    ownerChildID?: string;
}
export type PluginContext = Plugin.Context;
export declare class FusionError extends Error {
    readonly code: string;
    constructor(code: string, message?: string);
}
