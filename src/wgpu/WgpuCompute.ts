import type { IndirectStorageBufferAttribute, WebGPURenderer } from "three/webgpu";
import { isWebGPUBackend } from "../gpu/backend";
import { TSL, type TslNode } from "../gpu/tsl";
import { SCAN_WORKGROUP, scanTier, threadRank, workgroupExclusiveScan } from "./workgroupScan";

const { Fn, globalId, instanceIndex, localId, numWorkgroups, workgroupId } = TSL;

/** The builtins a WgpuCompute body gets. */
export interface ComputeIds {
  globalId: TslNode;
  localId: TslNode;
  workgroupId: TslNode;
  numWorkgroups: TslNode;
  /** The linear thread index, which stays linear when three splits a large dispatch into rows. */
  index: TslNode;
}

/** A thread count, workgroups per dimension, or an indirect buffer of 3 uint32 workgroup counts. */
export type DispatchSize = number | [number, number?, number?] | IndirectStorageBufferAttribute;

export function requireWebGPU(renderer: WebGPURenderer, what: string) {
  if (!isWebGPUBackend(renderer)) {
    throw new Error(`${what} needs the WebGPU backend`);
  }
}

/**
 * A compute kernel built from a TSL body, on the WebGPU backend only. The body
 * checks its own bounds.
 */
export class WgpuCompute {
  /** The threads in a workgroup of the scan helpers. */
  static readonly SCAN_WORKGROUP = SCAN_WORKGROUP;
  /**
   * Picks the scan tier for a device.
   *
   * @param [tier="auto"] The tier, where "auto" picks "subgroup" if the device
   *   has subgroups.
   */
  static readonly scanTier = scanTier;
  /** Each thread's rank in scan order, which in the subgroup tier can differ from its local id. */
  static readonly threadRank = threadRank;
  /**
   * An exclusive prefix sum of one uint per thread across the workgroup, in
   * rank order.
   *
   * @param scratch A workgroup array of SCAN_WORKGROUP uints, reusable after
   *   the call.
   * @param rank The thread's rank from threadRank.
   * @return The thread's exclusive sum and the workgroup's total.
   */
  static readonly workgroupExclusiveScan = workgroupExclusiveScan;

  /** The threads per workgroup in x, y and z. */
  readonly workgroupSize: [number, number, number];
  private computeNode: TslNode;

  /**
   * Builds the kernel.
   *
   * @param [options.workgroupSize=[64]] The threads per workgroup, in 1 to 3
   *   dimensions.
   * @param options.body Writes the kernel in TSL, given the builtins.
   * @param [options.label] The kernel's name in GPU profilers.
   */
  constructor({ workgroupSize = [64], body, label }: {
    workgroupSize?: [number] | [number, number] | [number, number, number];
    body: (ids: ComputeIds) => void;
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

  /** Runs the kernel now. */
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

  /** Sets the dispatch size, called by WgpuComputeBatch before it dispatches. */
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

/**
 * Dispatches kernels in order, in as few compute passes as possible. A uniform
 * holds one value per pass, so set uniforms before add and keep them until
 * submit.
 */
export class WgpuComputeBatch {
  readonly renderer: WebGPURenderer;
  private queue: { kernel: WgpuCompute; size: DispatchSize }[] = [];

  constructor(renderer: WebGPURenderer) {
    requireWebGPU(renderer, "WgpuComputeBatch");
    this.renderer = renderer;
  }

  /** Queues a dispatch of a kernel. */
  add(kernel: WgpuCompute, size: DispatchSize): this {
    const empty = typeof size === "number" ? size <= 0 : Array.isArray(size) && size[0] <= 0;
    if (!empty) {
      this.queue.push({ kernel, size });
    }
    return this;
  }

  /**
   * Dispatches the queue and empties it.
   *
   * @param [options.split=false] Dispatches one kernel at a time, so GPU
   *   profilers time each.
   */
  submit({ split = false }: { split?: boolean } = {}) {
    const { renderer, queue } = this;
    this.queue = [];

    if (split) {
      for (const { kernel, size } of queue) {
        kernel.dispatch(renderer, size);
      }
      return;
    }

    // A node has one dispatch size per pass
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
