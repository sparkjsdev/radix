import { ArrayData } from "../core/ArrayData";
import type { CoordinateSystem } from "../core/axes";
import { SplatFiles, type SplatFormat, type SplatRequestInit, type SplatWriteOptions } from "../core/files";
import type { Progress } from "../core/progress";
import { ShPalette, type ShTarget } from "../core/sh";
import type { LoadedSplats, SplatData, SplatLayout, SplatTarget } from "../core/splats";
import { WorkerLease, WorkerPool } from "./WorkerPool";

/** Where a call runs: true for the shared pool, false for this thread, or a pool or a lease. */
export type WorkerChoice = boolean | WorkerPool | WorkerLease;

/** A URL, a Blob or a file's bytes. */
export type SplatSource = string | URL | Blob | Uint8Array<ArrayBuffer> | ArrayBuffer;

// undefined runs on this thread
export function workerTarget(worker: WorkerChoice | undefined): WorkerPool | WorkerLease | undefined {
  if (worker === false || (worker === undefined && !WorkerPool.available)) {
    return undefined;
  }
  if (worker === true || worker === undefined) {
    if (!WorkerPool.available) {
      throw new Error("Workers are unavailable here");
    }
    return WorkerPool.default;
  }
  return worker;
}

/** Options of loadSplats and loadSplatFile. */
export type LoadSplatsOptions<L extends SplatLayout = "extSplats"> = SplatTarget<L> & {
  /**
   * The name whose extension tells formats apart.
   *
   * @default the URL's or the File's name
   */
  name?: string;
  /**
   * Where the load runs.
   *
   * @default the shared pool where workers are available, else this thread
   */
  worker?: WorkerChoice;
  onProgress?: Progress;
  /**
   * The SH codec, or false to skip SH.
   *
   * @default "ext", or an RDX file's stored codec
   */
  sh?: ShTarget;
  /**
   * The axes SPZ files convert to.
   *
   * @default the axes as stored
   */
  coordinateSystem?: CoordinateSystem;
  /** fetch options for a URL source. */
  request?: SplatRequestInit;
  /** Aborts the download and decode, and rejects the promise. */
  signal?: AbortSignal;
};

/** Loads a splat file as one table, with SH per splat. Bytes given to a worker are transferred. */
export async function loadSplats<L extends SplatLayout = "extSplats">(source: SplatSource, options: LoadSplatsOptions<L> = {}): Promise<SplatData<L>> {
  return (await load(source, options, false)).splats;
}

/** Loads a splat file, keeping RAD's clustered SH as a palette. */
export async function loadSplatFile<L extends SplatLayout = "extSplats">(source: SplatSource, options: LoadSplatsOptions<L> = {}): Promise<LoadedSplats<L>> {
  return load(source, options, true);
}

async function load<L extends SplatLayout>(source: SplatSource, {
  name, worker, onProgress, layout = "extSplats" as L, encoding, sh, coordinateSystem, request, signal,
}: LoadSplatsOptions<L>, palette: boolean): Promise<LoadedSplats<L>> {
  signal?.throwIfAborted();
  const target = workerTarget(worker);
  let url: string | undefined;
  let bytes: Uint8Array<ArrayBuffer> | undefined;
  if (typeof source === "string" || source instanceof URL) {
    url = typeof location !== "undefined" ? new URL(source, location.href).href : String(source);
  } else if (source instanceof Blob) {
    bytes = new Uint8Array(await source.arrayBuffer());
    name ??= (source as File).name;
  } else {
    bytes = source instanceof ArrayBuffer ? new Uint8Array(source) : source;
  }

  if (!target) {
    // Decoders report progress often, so aborts stop there
    const progress: Progress | undefined = signal ? (fraction, stage) => {
      signal.throwIfAborted();
      onProgress?.(fraction, stage);
    } : onProgress;
    const into = { layout, encoding, sh, coordinateSystem, progress };
    const loaded = bytes ? await SplatFiles.decode(bytes, { ...into, name }) : await SplatFiles.fetch(url!, { ...into, init: { ...request, signal } });
    signal?.throwIfAborted();
    return palette || !loaded.shPalette ? loaded : { splats: loaded.shPalette.expanded(loaded.splats as unknown as ArrayData) as unknown as SplatData<L> };
  }
  // A Headers object cannot be cloned to a worker
  const sent = request?.headers ? { ...request, headers: Object.fromEntries(new Headers(request.headers)) } : request;
  const result = await target.call("loadSplats", { url, bytes, name, layout, encoding, sh, coordinateSystem, palette, request: sent }, { onProgress, signal });
  return {
    splats: ArrayData.fromTransferable(result.splats) as unknown as SplatData<L>,
    shPalette: result.shPalette && new ShPalette(ArrayData.fromTransferable(result.shPalette)),
  };
}

/**
 * Writes splats as a file's bytes. On a worker, their arrays are detached until
 * the promise settles.
 *
 * @param [options.worker] Where the write runs, by default the shared pool
 *   where workers are available, else this thread.
 */
export async function writeSplats(data: ArrayData, format: SplatFormat, { worker, onProgress, shPalette, ...options }: SplatWriteOptions & {
  worker?: WorkerChoice;
  onProgress?: Progress;
} = {}): Promise<Uint8Array<ArrayBuffer>> {
  const target = workerTarget(worker);
  if (!target) {
    return SplatFiles.encode(data, format, { ...options, shPalette, progress: onProgress });
  }
  const result = await target.call("writeSplats", { data: data.toTransferable(), shPalette: shPalette?.data.toTransferable(), format, options }, { onProgress });
  data.setFromTransferable(result.data);
  if (shPalette && result.shPalette) {
    shPalette.data.setFromTransferable(result.shPalette);
  }
  if (result.error !== undefined) {
    throw new Error(result.error);
  }
  return result.bytes!;
}
