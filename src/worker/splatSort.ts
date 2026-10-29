import { TextureLayout } from "../core/layout";
import { SortKeys, type SortKeyBits } from "../core/sort";
import { workerTarget, type WorkerChoice } from "./splatFiles";

export interface SortedSplats {
  // Splat indices back to front, the first `visible` with valid keys
  ordering: Uint32Array<ArrayBuffer>;
  visible: number;
  // The keys, back from the worker for reuse
  keys: Uint32Array<ArrayBuffer>;
}

// Sort splat keys (read back from a projection's sortKeys) on a worker or this thread
// (`worker` as in loadSplats). The arrays travel to the worker and back:
// pass the previous result's `ordering` to reuse it. Its length is a whole
// capacity, so SplatRenderer.setOrder uploads it without a copy.
export async function sortSplatKeys(keys: Uint32Array<ArrayBuffer>, { bits, ordering, worker }: {
  bits: SortKeyBits;
  ordering?: Uint32Array<ArrayBuffer>;
  worker?: WorkerChoice;
}): Promise<SortedSplats> {
  const count = keys.length;
  const reuse = ordering && ordering.length >= TextureLayout.alignCapacity(count) ? ordering : undefined;

  const target = workerTarget(worker);
  if (!target) {
    return { ...SortKeys.sort({ keys, count, bits, ordering: reuse }), keys };
  }
  return target.call("sortKeys", { keys, count, bits, ordering: reuse });
}
