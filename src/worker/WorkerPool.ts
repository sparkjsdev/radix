import { ArrayData } from "../core/ArrayData";
import type { Progress, ProgressStage } from "../core/progress";
import coreModule from "./coreModule?module&inline";
import type { WorkerHandlers } from "./coreWorker";

let coreUrl: string | undefined;
let shimUrl: string | undefined;

const blobUrl = (code: string) => URL.createObjectURL(new Blob([code], { type: "text/javascript" }));

/** The name of a handler that the pool's workers run. */
export type WorkerCall = keyof WorkerHandlers;
/** The argument of handler N. */
export type WorkerArgs<N extends WorkerCall> = Parameters<WorkerHandlers[N]>[0];
/** The result of handler N. */
export type WorkerResult<N extends WorkerCall> = Awaited<ReturnType<WorkerHandlers[N]>>;

/** Options of a call on a worker. */
export interface CallOptions {
  /**
   * Called with the handler's progress at most every 50 ms, and when the stage
   * changes or the handler finishes.
   */
  onProgress?: Progress;
  /** Aborting rejects the call at once and stops the handler at its next progress report. */
  signal?: AbortSignal;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  onProgress?: Progress;
}

let nextId = 1;

class PooledWorker {
  readonly worker = new Worker((shimUrl ??= blobUrl(`import { serveWorker } from ${JSON.stringify(WorkerPool.coreUrl)}; serveWorker();`)), { type: "module" });
  // Set once the worker failed or was terminated
  dead?: Error;
  private pending = new Map<number, Pending>();

  constructor(onDeath: (worker: PooledWorker) => void) {
    this.worker.onmessage = (event: MessageEvent<{ id: number; result?: unknown; error?: string; progress?: [number, ProgressStage] }>) => {
      const { id, result, error, progress } = event.data;
      const entry = this.pending.get(id);
      if (progress) {
        entry?.onProgress?.(progress[0], progress[1]);
        return;
      }
      this.pending.delete(id);
      if (error !== undefined) {
        entry?.reject(new Error(error));
      } else {
        entry?.resolve(result);
      }
    };
    this.worker.onerror = (event) => {
      event.preventDefault();
      this.terminate(new Error(`Worker failed: ${event.message || "uncaught error"}`));
      onDeath(this);
    };
    this.worker.onmessageerror = () => {
      this.terminate(new Error("Worker message could not be deserialized"));
      onDeath(this);
    };
  }

  call<N extends WorkerCall>(name: N, args: WorkerArgs<N>, { onProgress, signal }: CallOptions = {}): Promise<WorkerResult<N>> {
    if (this.dead) {
      return Promise.reject(this.dead);
    }
    if (signal?.aborted) {
      return Promise.reject(signal.reason);
    }
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const abort = () => {
        this.pending.delete(id);
        this.worker.postMessage({ id, cancel: true });
        reject(signal!.reason);
      };
      const settle = <T>(finish: (value: T) => void) => (value: T) => {
        signal?.removeEventListener("abort", abort);
        finish(value);
      };
      signal?.addEventListener("abort", abort, { once: true });
      this.pending.set(id, { resolve: settle(resolve as (value: unknown) => void), reject: settle(reject), onProgress });
      this.worker.postMessage({ id, name, args }, { transfer: ArrayData.transferables(args) });
    });
  }

  terminate(reason = new Error("Worker terminated")) {
    this.dead ??= reason;
    this.worker.terminate();
    this.pending.forEach(({ reject }) => reject(reason));
    this.pending.clear();
  }
}

/** One worker of a pool, held until release. */
export class WorkerLease {
  private worker?: PooledWorker;
  private pool: WorkerPool;

  /** Leases a worker, made by WorkerPool.acquire. */
  constructor(worker: PooledWorker, pool: WorkerPool) {
    this.worker = worker;
    this.pool = pool;
  }

  /**
   * Runs a handler on the leased worker. It throws after release.
   *
   * @param args The handler's argument. Its arrays are transferred.
   */
  call<N extends WorkerCall>(name: N, args: WorkerArgs<N>, options?: CallOptions): Promise<WorkerResult<N>> {
    if (!this.worker) {
      throw new Error("WorkerLease already released");
    }
    return this.worker.call(name, args, options);
  }

  release() {
    if (this.worker) {
      this.pool.give(this.worker);
      this.worker = undefined;
    }
  }
}

/**
 * A pool of up to size workers, each made when a call first needs it. Arrays in
 * arguments are transferred, so the caller's are detached until the result
 * returns them.
 */
export class WorkerPool {
  /**
   * The most workers the pool makes.
   *
   * @default 4
   */
  readonly size: number;
  private static shared?: WorkerPool;

  private workers: PooledWorker[] = [];
  private idle: PooledWorker[] = [];
  private waiting: { resolve: (worker: PooledWorker) => void; reject: (error: Error) => void }[] = [];
  private disposed = false;

  /**
   * Makes a pool without workers.
   *
   * @param [options.size=4] The most workers.
   */
  constructor({ size = 4 }: { size?: number } = {}) {
    this.size = size;
  }

  /** The shared pool, made on first use. */
  static get default(): WorkerPool {
    return (WorkerPool.shared ??= new WorkerPool());
  }

  /**
   * A blob URL of the core module the workers run, made on first use, for an
   * app's own module workers to import.
   */
  static get coreUrl(): string {
    return (coreUrl ??= blobUrl(coreModule));
  }

  /** Whether this context can make workers, which a page can and Node and workers cannot. */
  static get available(): boolean {
    return typeof Worker !== "undefined" && typeof window !== "undefined";
  }

  /** The workers made so far that are alive. */
  get workerCount() {
    return this.workers.length;
  }

  /**
   * Runs a handler on the next free worker, in the order of the calls.
   *
   * @param args The handler's argument. Its arrays are transferred.
   */
  async call<N extends WorkerCall>(name: N, args: WorkerArgs<N>, options?: CallOptions): Promise<WorkerResult<N>> {
    const lease = await this.acquire({ signal: options?.signal });
    try {
      return await lease.call(name, args, options);
    } finally {
      lease.release();
    }
  }

  /**
   * Leases a worker once one is free. A disposed pool rejects.
   *
   * @param [options.signal] Stops the wait.
   */
  async acquire({ signal }: { signal?: AbortSignal } = {}): Promise<WorkerLease> {
    if (this.disposed) {
      throw new Error("WorkerPool disposed");
    }
    signal?.throwIfAborted();
    const worker = this.idle.pop() ?? this.spawn() ?? await this.wait(signal);
    return new WorkerLease(worker, this);
  }

  /** Takes a worker back, called by WorkerLease.release. */
  give(worker: PooledWorker) {
    if (this.disposed) {
      worker.terminate(new Error("WorkerPool disposed"));
      return;
    }
    if (worker.dead) {
      const replacement = this.waiting.length > 0 ? this.spawn() : undefined;
      if (replacement) {
        this.waiting.shift()!.resolve(replacement);
      }
      return;
    }
    const waiter = this.waiting.shift();
    if (waiter) {
      waiter.resolve(worker);
    } else {
      this.idle.push(worker);
    }
  }

  /** Terminates the workers, and rejects their pending calls and the calls waiting for one. */
  dispose() {
    this.disposed = true;
    this.workers.forEach((worker) => worker.terminate(new Error("WorkerPool disposed")));
    this.workers = [];
    this.idle = [];
    this.waiting.splice(0).forEach(({ reject }) => reject(new Error("WorkerPool disposed")));
  }

  private wait(signal?: AbortSignal) {
    return new Promise<PooledWorker>((resolve, reject) => {
      const abort = () => {
        this.waiting = this.waiting.filter((w) => w !== waiter);
        reject(signal!.reason);
      };
      const waiter = {
        resolve: (worker: PooledWorker) => {
          signal?.removeEventListener("abort", abort);
          resolve(worker);
        },
        reject: (error: Error) => {
          signal?.removeEventListener("abort", abort);
          reject(error);
        },
      };
      signal?.addEventListener("abort", abort, { once: true });
      this.waiting.push(waiter);
    });
  }

  private spawn() {
    if (this.workers.length >= this.size) {
      return undefined;
    }
    const worker = new PooledWorker((dead) => this.remove(dead));
    this.workers.push(worker);
    return worker;
  }

  // A leased worker is replaced when it is given back
  private remove(worker: PooledWorker) {
    this.workers = this.workers.filter((w) => w !== worker);
    this.idle = this.idle.filter((w) => w !== worker);
  }
}
