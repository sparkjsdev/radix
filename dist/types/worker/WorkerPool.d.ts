import type { Progress } from "../core/progress";
import type { WorkerHandlers } from "./coreWorker";
export type WorkerCall = keyof WorkerHandlers;
export type WorkerArgs<N extends WorkerCall> = Parameters<WorkerHandlers[N]>[0];
export type WorkerResult<N extends WorkerCall> = Awaited<ReturnType<WorkerHandlers[N]>>;
export interface CallOptions {
    onProgress?: Progress;
    signal?: AbortSignal;
}
declare class PooledWorker {
    readonly worker: Worker;
    dead?: Error;
    private pending;
    constructor(onDeath: (worker: PooledWorker) => void);
    call<N extends WorkerCall>(name: N, args: WorkerArgs<N>, { onProgress, signal }?: CallOptions): Promise<WorkerResult<N>>;
    terminate(reason?: Error): void;
}
export declare class WorkerLease {
    private worker?;
    private pool;
    constructor(worker: PooledWorker, pool: WorkerPool);
    call<N extends WorkerCall>(name: N, args: WorkerArgs<N>, options?: CallOptions): Promise<WorkerResult<N>>;
    release(): void;
}
export declare class WorkerPool {
    readonly size: number;
    private static shared?;
    private workers;
    private idle;
    private waiting;
    private disposed;
    constructor({ size }?: {
        size?: number;
    });
    static get default(): WorkerPool;
    static get coreUrl(): string;
    static get available(): boolean;
    get workerCount(): number;
    call<N extends WorkerCall>(name: N, args: WorkerArgs<N>, options?: CallOptions): Promise<WorkerResult<N>>;
    acquire({ signal }?: {
        signal?: AbortSignal;
    }): Promise<WorkerLease>;
    give(worker: PooledWorker): void;
    dispose(): void;
    private wait;
    private spawn;
    private remove;
}
export {};
