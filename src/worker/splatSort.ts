import { TextureLayout } from "../core/layout";
import { SortKeys, type SortKeyBits } from "../core/sort";
import { workerTarget, type WorkerChoice } from "./splatFiles";

/** The result of sortSplatKeys. */
export interface SortedSplats {
  /** Splat indices back to front, of which the first visible have valid keys. */
  ordering: Uint32Array<ArrayBuffer>;
  /** The count of splats with valid keys. */
  visible: number;
  /** The keys, back from the worker for reuse. */
  keys: Uint32Array<ArrayBuffer>;
}

/**
 * Sorts splat keys back to front on a worker or on this thread.
 *
 * @param keys The splats' sort keys. They are transferred.
 * @param [options.ordering] The previous result's ordering, reused when it
 *   holds a whole capacity.
 * @param [options.worker] Where the sort runs, by default the shared pool where
 *   workers are available, else this thread.
 */
export async function sortSplatKeys(keys: Uint32Array<ArrayBuffer>, { bits, ordering, worker }: {
  bits: SortKeyBits;
  ordering?: Uint32Array<ArrayBuffer>;
  worker?: WorkerChoice;
}): Promise<SortedSplats> {
  const count = keys.length;
  // Reuse needs a whole capacity, which a table takes without a copy
  const reuse = ordering && ordering.length >= TextureLayout.alignCapacity(count) ? ordering : undefined;

  const target = workerTarget(worker);
  if (!target) {
    return { ...SortKeys.sort({ keys, count, bits, ordering: reuse }), keys };
  }
  return target.call("sortKeys", { keys, count, bits, ordering: reuse });
}
