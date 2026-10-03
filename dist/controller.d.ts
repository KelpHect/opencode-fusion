import { type ControllerDeps, type FusionOptions, type ModelReference, type PluginContext, type ToolContextLike } from './types.js';
export interface WorkerDefinition {
    mode: 'subagent';
    hidden: true;
    name: string;
    description: string;
    system?: string;
    steps?: number;
    permissions: readonly {
        action: string;
        resource: string;
        effect: 'allow' | 'deny' | 'ask';
    }[];
}
export interface CommandOutput {
    text?: string;
    data?: unknown;
}
/**
 * OpenCode's plugin RPC drops tool results whose metadata contains two or more
 * `undefined`-valued keys (the part is left `running` and later swept to
 * `aborted`). Strip `undefined` values — recursively — from anything we return
 * in `metadata`.
 */
export declare function stripUndefined<T>(value: T): T;
export declare class FusionController {
    private readonly ctx;
    private readonly opts;
    private readonly store;
    private readonly mutex;
    private readonly now;
    private readonly uuid;
    private readonly leases;
    private readonly leaseKey;
    private readonly states;
    private readonly jobs;
    private readonly childToRoot;
    private readonly runnerOverride?;
    private readonly listModelsOverride?;
    readonly workerDefinitions: Map<string, WorkerDefinition>;
    private disposed;
    constructor(ctx: PluginContext, options?: Partial<FusionOptions>, deps?: ControllerDeps);
    configure(rootID: string, leadReference: string, partnerReference: string): Promise<CommandOutput>;
    status(rootID: string): Promise<CommandOutput>;
    pause(rootID: string): Promise<CommandOutput>;
    resume(rootID: string): Promise<CommandOutput>;
    disable(rootID: string): Promise<CommandOutput>;
    reset(rootID: string): Promise<CommandOutput>;
    models(): Promise<CommandOutput>;
    wait(rootID: string, signal?: AbortSignal): Promise<CommandOutput>;
    delegate(input: {
        task: string;
        brief: string;
        background?: boolean;
    }, toolContext: ToolContextLike): Promise<{
        content: string;
        metadata: Record<string, unknown>;
    }>;
    guardToolCall(call: {
        tool: string;
        sessionID: string;
        agent?: string;
    }): Promise<void>;
    applyContext(input: {
        sessionID: string;
        agent: string;
        system: unknown[];
        tools: Record<string, unknown>;
        options: Record<string, unknown>;
    }): Promise<void>;
    applyCompaction(input: {
        sessionID: string;
        system: unknown[];
    }): void;
    onSessionInterrupted(sessionID: string, reason?: string): Promise<void>;
    onModelSelected(sessionID: string, model: ModelReference): Promise<void>;
    recover(): Promise<void>;
    dispose(): Promise<void>;
    isConfigured(rootID: string): boolean;
    private isBusy;
    private leaseForRoot;
    private recoverJob;
    private waitForChildIdle;
    private releaseLeaseIfOwned;
    private sendNotice;
    private newRuntime;
    private executeJob;
    private confirmIdle;
    private deliverReport;
    private cancelJob;
    private buildWorkerDefinition;
    private validateChild;
    private getSession;
    private getSessionResult;
    private childOutcome;
    private latestAssistantOutput;
    private participation;
    private workerRootFor;
    private isWorkerContext;
    private runner;
    private availableModels;
    private effectiveOptions;
    private load;
    private requireState;
    private setBoundedOutput;
    private jobOrUndef;
    private jobData;
    private statusData;
    private raceAbort;
}
export declare function workerAgentIDFor(rootID: string): string;
