import type { IndirectStorageBufferAttribute, WebGPURenderer } from "three/webgpu";
import { isWebGPUBackend } from "../gpu/backend";
import { TSL, type TslNode } from "../gpu/tsl";
import { SCAN_WORKGROUP, scanTier, threadRank, workgroupExclusiveScan } from "./workgroupScan";

const { Fn, globalId, instanceIndex, localId, numWorkgroups, workgroupId } = TSL;

// Compute builtins handed to a WgpuCompute body
export interface ComputeIds {
  globalId: TslNode;
  localId: TslNode;
  workgroupId: TslNode;
  numWorkgroups: TslNode;
  // Linear thread index: globalId.x, continued over the y rows three
  // splits large 1D dispatches into
  index: TslNode;
}

// Threads (a number), workgroups per dimension, or workgroup counts the GPU
// wrote to an indirect buffer (WgpuBuffer with `indirect`, 3 x uint32)
export type DispatchSize = number | [number, number?, number?] | IndirectStorageBufferAttribute;

export function requireWebGPU(renderer: WebGPURenderer, what: string) {
  if (!isWebGPUBackend(renderer)) {
    throw new Error(`${what} needs the WebGPU backend`);
  }
}

// A compute kernel built once from a TSL body and dispatched with a size per
// call (WebGPU backend only). Bodies bounds-check themselves: a thread count
// is rounded up to whole workgroups, and three adds no `index >= count`
// return.
export class WgpuCompute {
  // Workgroup-wide scans for kernel bodies (workgroupScan.ts): threads per
  // scan workgroup, the tier a device supports ("subgroup" or "portable"),
  // each thread's rank in scan order, and an exclusive prefix sum of one
  // uint per thread plus the total
  static readonly SCAN_WORKGROUP = SCAN_WORKGROUP;
  static readonly scanTier = scanTier;
  static readonly threadRank = threadRank;
  static readonly workgroupExclusiveScan = workgroupExclusiveScan;

  readonly workgroupSize: [number, number, number];
  private computeNode: TslNode;

  constructor({ workgroupSize = [64], body, label }: {
    workgroupSize?: [number] | [number, number] | [number, number, number];
    body: (ids: ComputeIds) => void;
    // Node name, shown by GPU profilers
    label?: string;
  }) {
    this.workgroupSize = [workgroupSize[0], workgroupSize[1] ?? 1, workgroupSize[2] ?? 1];
    this.computeNode = Fn(() => {
      body({ globalId, localId, workgroupId, numWorkgroups, index: instanceIndex });
    })().compute([1, 1, 1], this.workgroupSize);

    if (label) {
      this.computeNode.name = label;
    }
  }

  // A number is a thread count (three divides by the workgroup size); an
  // array is the workgroup count per dimension
  dispatch(renderer: WebGPURenderer, size: DispatchSize) {
    requireWebGPU(renderer, "WgpuCompute");
    if (typeof size === "number") {
      if (size > 0) {
        renderer.compute(this.computeNode, size);
      }
    } else {
      renderer.compute(this.computeNode, dispatchArgument(size));
    }
  }

  // The compute node with its dispatch size set, for WgpuComputeBatch
  prepare(size: DispatchSize): TslNode {
    this.computeNode.dispatchSize = typeof size === "number" ? size : dispatchArgument(size);
    return this.computeNode;
  }

  dispose() {
    this.computeNode.dispose?.();
  }
}

function dispatchArgument(size: Exclude<DispatchSize, number>) {
  return Array.isArray(size) ? [size[0], size[1] ?? 1, size[2] ?? 1] : size;
}

// Dispatches recorded into as few compute passes as possible: submit() hands
// them to renderer.compute() as one list, which three records into one pass
// in order (WebGPU makes each dispatch's storage writes visible to the next).
// A node has one dispatch size per pass, so a kernel queued again with a
// different size starts a new pass. Uniforms hold one value per pass too:
// set them before queueing and do not change them until submit. `split`
// dispatches one by one instead, so GPU profilers time each kernel.
export class WgpuComputeBatch {
  readonly renderer: WebGPURenderer;
  private queue: { kernel: WgpuCompute; size: DispatchSize }[] = [];

  constructor(renderer: WebGPURenderer) {
    requireWebGPU(renderer, "WgpuComputeBatch");
    this.renderer = renderer;
  }

  add(kernel: WgpuCompute, size: DispatchSize): this {
    const empty = typeof size === "number" ? size <= 0 : Array.isArray(size) && size[0] <= 0;
    if (!empty) {
      this.queue.push({ kernel, size });
    }
    return this;
  }

  submit({ split = false }: { split?: boolean } = {}) {
    const { renderer, queue } = this;
    this.queue = [];

    if (split) {
      for (const { kernel, size } of queue) {
        kernel.dispatch(renderer, size);
      }
      return;
    }

    let pass: { kernel: WgpuCompute; size: DispatchSize }[] = [];
    const sizes = new Map<WgpuCompute, string>();
    const flush = () => {
      if (pass.length > 0) {
        renderer.compute(pass.map(({ kernel, size }) => kernel.prepare(size)));
      }
      pass = [];
      sizes.clear();
    };

    for (const entry of queue) {
      const key = String(entry.size);
      const previous = sizes.get(entry.kernel);
      if (previous !== undefined && previous !== key) {
        flush();
      }
      sizes.set(entry.kernel, key);
      pass.push(entry);
    }
    flush();
  }
}
