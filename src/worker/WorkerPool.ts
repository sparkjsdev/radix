// Up to `size` workers running core/ (worker/coreWorker.ts), each
// made only when a call needs one: a pool that is never used costs nothing.
// call() runs on the next free worker (callers queue FIFO); acquire() takes
// one worker exclusively until release(). ArrayBuffers in args are
// transferred, so the caller's arrays are detached until the result hands
// them back. A worker that fails outside a handler (an uncaught error, a
// message that cannot be read) rejects its pending calls and is replaced.
// Workers import the one core module in the bundle (WorkerPool.coreUrl),
// which an app's own workers can import too.
import { ArrayData } from "../core/ArrayData";
import type { Progress, ProgressStage } from "../core/progress";
import coreModule from "./coreModule?module&inline";
import type { WorkerHandlers } from "./coreWorker";

let coreUrl: string | undefined;
let shimUrl: string | undefined;

const blobUrl = (code: string) => URL.createObjectURL(new Blob([code], { type: "text/javascript" }));

export type WorkerCall = keyof WorkerHandlers;
export type WorkerArgs<N extends WorkerCall> = Parameters<WorkerHandlers[N]>[0];
export type WorkerResult<N extends WorkerCall> = Awaited<ReturnType<WorkerHandlers[N]>>;

export interface CallOptions {
  // The handler's progress (throttled by the worker)
  onProgress?: Progress;
  // Rejects the call with signal.reason at once and asks the worker to stop
  // (handlers that take a signal stop at their next progress report); the
  // worker stays
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
  // Set once the worker failed or was terminated; calls then reject
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

// One worker, held until release()
export class WorkerLease {
  private worker?: PooledWorker;
  private pool: WorkerPool;

  constructor(worker: PooledWorker, pool: WorkerPool) {
    this.worker = worker;
    this.pool = pool;
  }

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

export class WorkerPool {
  readonly size: number;
  private static shared?: WorkerPool;

  private workers: PooledWorker[] = [];
  private idle: PooledWorker[] = [];
  private waiting: { resolve: (worker: PooledWorker) => void; reject: (error: Error) => void }[] = [];
  private disposed = false;

  constructor({ size = 4 }: { size?: number } = {}) {
    this.size = size;
  }

  // The shared pool, made on first use (still without workers)
  static get default(): WorkerPool {
    return (WorkerPool.shared ??= new WorkerPool());
  }

  // A blob URL of core/ as one ES module (made on first use), for
  // an app's own module workers to `await import(url)`: the copy the pool's
  // workers run, so no second file is needed
  static get coreUrl(): string {
    return (coreUrl ??= blobUrl(coreModule));
  }

  // Whether this context can make workers (a page; not Node, not a worker)
  static get available(): boolean {
    return typeof Worker !== "undefined" && typeof window !== "undefined";
  }

  // Workers made so far (alive)
  get workerCount() {
    return this.workers.length;
  }

  async call<N extends WorkerCall>(name: N, args: WorkerArgs<N>, options?: CallOptions): Promise<WorkerResult<N>> {
    const lease = await this.acquire({ signal: options?.signal });
    try {
      return await lease.call(name, args, options);
    } finally {
      lease.release();
    }
  }

  // A worker for the caller alone, once one is free; `signal` stops waiting.
  // A disposed pool makes no more workers: it rejects.
  async acquire({ signal }: { signal?: AbortSignal } = {}): Promise<WorkerLease> {
    if (this.disposed) {
      throw new Error("WorkerPool disposed");
    }
    signal?.throwIfAborted();
    const worker = this.idle.pop() ?? this.spawn() ?? await this.wait(signal);
    return new WorkerLease(worker, this);
  }

  // Back from a lease: to the longest waiting caller, else idle. A dead
  // worker is dropped; a waiter then gets a new one.
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

  // Terminates the workers (their pending calls reject) and rejects the
  // queued acquire() and call() waiters
  dispose() {
    this.disposed = true;
    this.workers.forEach((worker) => worker.terminate(new Error("WorkerPool disposed")));
    this.workers = [];
    this.idle = [];
    this.waiting.splice(0).forEach(({ reject }) => reject(new Error("WorkerPool disposed")));
  }

  // In line for the next worker given back; an abort leaves the line
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

  // A worker died: forget it (a leased one is replaced when given back)
  private remove(worker: PooledWorker) {
    this.workers = this.workers.filter((w) => w !== worker);
    this.idle = this.idle.filter((w) => w !== worker);
  }
}
