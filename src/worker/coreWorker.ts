// The worker's RPC handlers over core/, served by serveWorker() (the
// pool's workers import it with core from coreModule.ts). Messages are
// { id, name, args } in and { id, result } or { id, error } out, plus
// { id, progress: [fraction, stage] } while a handler reports progress (at
// most every 50 ms). { id, cancel: true } aborts that call's signal: its
// fetch stops, and its decode at its next progress report. ArrayBuffers in
// args and results are transferred.
import { ArrayData, type TransferableArrayData } from "../core/ArrayData";
import type { CoordinateSystem } from "../core/axes";
import { SplatFiles, type SplatFormat, type SplatRequestInit, type SplatWriteOptions } from "../core/files";
import type { Progress, ProgressStage } from "../core/progress";
import { SortKeys, type SortKeyBits } from "../core/sort";
import { ShPalette, type ShTarget } from "../core/sh";
import type { SplatTarget } from "../core/splats";

interface Context {
  // Throws once the call is cancelled
  progress: Progress;
  signal: AbortSignal;
}

const handlers = {
  // A splat file from a URL (fetched with `request`) or its bytes
  // (SplatFiles), and its palette, or without `palette` its SH expanded per
  // splat
  async loadSplats({ url, bytes, name, layout, encoding, sh, coordinateSystem, palette = true, request }: SplatTarget & {
    url?: string;
    bytes?: Uint8Array<ArrayBuffer>;
    name?: string;
    sh?: ShTarget;
    coordinateSystem?: CoordinateSystem;
    palette?: boolean;
    request?: SplatRequestInit;
  }, { progress, signal }: Context) {
    const options = { progress, layout, encoding, sh, coordinateSystem };
    const { splats, shPalette } = bytes ? await SplatFiles.decode(bytes, { ...options, name }) : await SplatFiles.fetch(url!, { ...options, init: { ...request, signal } });
    if (shPalette && !palette) {
      return { splats: shPalette.expanded(splats).toTransferable() };
    }
    return { splats: splats.toTransferable(), shPalette: shPalette?.data.toTransferable() };
  },

  // The file's bytes, and the data's (and palette's) arrays back even when
  // encoding fails
  async writeSplats({ data, shPalette, format, options }: {
    data: TransferableArrayData;
    shPalette?: TransferableArrayData;
    format: SplatFormat;
    options?: SplatWriteOptions;
  }, { progress }: Context) {
    const arrays = ArrayData.fromTransferable(data);
    const palette = shPalette && new ShPalette(ArrayData.fromTransferable(shPalette));
    const back = () => ({ data: arrays.toTransferable(), shPalette: palette?.data.toTransferable() });
    try {
      const bytes = await SplatFiles.encode(arrays, format, { ...options, shPalette: palette, progress });
      return { bytes, error: undefined, ...back() };
    } catch (error) {
      return { bytes: undefined, error: error instanceof Error ? error.message : String(error), ...back() };
    }
  },

  // Splat keys sorted back to front (SortKeys.sort), the keys sent back
  sortKeys({ keys, count, bits, ordering }: { keys: Uint32Array<ArrayBuffer>; count: number; bits: SortKeyBits; ordering?: Uint32Array<ArrayBuffer> }) {
    return { ...SortKeys.sort({ keys, count, bits, ordering }), keys };
  },
};

export type WorkerHandlers = typeof handlers;

// A handler's progress as posted: never lower than before, at most every
// 50 ms unless the stage changes or it is done
function throttled(id: number): Progress {
  let last = 0;
  let lastStage: ProgressStage | undefined;
  let highest = 0;
  return (fraction, stage) => {
    highest = Math.max(highest, fraction);
    const now = performance.now();
    if (now - last >= 50 || stage !== lastStage || highest >= 1) {
      last = now;
      lastStage = stage;
      self.postMessage({ id, progress: [highest, stage] });
    }
  };
}

// Serve the handlers in this worker: the pool's workers call it; a worker of
// the app's that imports the core module (WorkerPool.coreUrl) does not
export function serveWorker() {
  // The calls under way, to cancel by id
  const calls = new Map<number, AbortController>();

  self.onmessage = async (event: MessageEvent<{ id: number; name: keyof WorkerHandlers; args: unknown; cancel?: boolean }>) => {
    const { id, name, args, cancel } = event.data;
    if (cancel) {
      calls.get(id)?.abort();
      return;
    }
    const controller = new AbortController();
    calls.set(id, controller);
    const post = throttled(id);
    const progress: Progress = (fraction, stage) => {
      controller.signal.throwIfAborted();
      post(fraction, stage);
    };
    try {
      const handler = handlers[name] as (args: unknown, context: Context) => unknown;
      if (!handler) {
        throw new Error(`Unknown worker call ${name}`);
      }
      const result = await handler(args, { progress, signal: controller.signal });
      self.postMessage({ id, result }, { transfer: ArrayData.transferables(result) });
    } catch (error) {
      self.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
    } finally {
      calls.delete(id);
    }
  };
}
