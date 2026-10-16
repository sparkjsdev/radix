// Loading and writing splat files, on a worker or this thread. `worker`:
//   left out  the shared pool where a page can make workers, else this
//             thread (Node, code already in a worker)
//   true      the shared pool (an error where workers are unavailable)
//   false     this thread
//   a pool    one call on it
//   a lease   that worker; the caller keeps the lease
// Both paths run the same core functions, so they give the same results.
import { ArrayData } from "../core/ArrayData";
import type { CoordinateSystem } from "../core/axes";
import { SplatFiles, type SplatFormat, type SplatRequestInit, type SplatWriteOptions } from "../core/files";
import type { Progress } from "../core/progress";
import { ShPalette, type ShTarget } from "../core/sh";
import type { LoadedSplats, SplatData, SplatLayout, SplatTarget } from "../core/splats";
import { WorkerLease, WorkerPool } from "./WorkerPool";

export type WorkerChoice = boolean | WorkerPool | WorkerLease;

// A URL, a Blob / File or the file's bytes
export type SplatSource = string | URL | Blob | Uint8Array<ArrayBuffer> | ArrayBuffer;

// Where a call with this `worker` choice runs: a pool or lease, or this
// thread (undefined)
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

export type LoadSplatsOptions<L extends SplatLayout = "extSplats"> = SplatTarget<L> & {
  // For telling formats apart by extension (default: the URL or file name)
  name?: string;
  worker?: WorkerChoice;
  onProgress?: Progress;
  sh?: ShTarget;
  // SPZ: the axes to convert to (default: as stored, meta.coordinateSystem)
  coordinateSystem?: CoordinateSystem;
  // fetch options for a URL source: headers, credentials, mode, cache...
  request?: SplatRequestInit;
  // Aborts the download and decode: the promise rejects with signal.reason
  signal?: AbortSignal;
};

// A splat file as one table: splats in bundles[layout] (default
// extSplats), plus lodTree when the file has one, and its spherical
// harmonics in an SH bundle (`sh`: "ext" (default) or "packed"; false skips
// them; RDX keeps its stored codec unless `sh` is given). RAD's clustered SH
// is expanded to per-splat SH (loadSplatFile keeps its palette). Bytes
// given to a worker are transferred: the caller's buffer is detached.
export async function loadSplats<L extends SplatLayout = "extSplats">(source: SplatSource, options: LoadSplatsOptions<L> = {}): Promise<SplatData<L>> {
  return (await load(source, options, false)).splats;
}

// What a splat file holds: { splats, shPalette? }, the splats as
// loadSplats gives them except RAD's clustered SH, kept as bundle shLabel in
// the splats and shPalette, an ShPalette in the `sh` codec
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
    // Decoders report progress often: an abort stops them at the next report
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

// On a worker, data's arrays (and shPalette's) travel there and back: they
// must not be used until the promise settles, and are whole again after
// (resolved or not). No signal: an abort would leave them on the worker.
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
