import type { WebGPURenderer } from "three/webgpu";
import { SortKeys, type SortKeyBits } from "../core/sort";
import { GpuArrayReader } from "../gpu/GpuArrayReader";
import type { GpuArrays } from "../gpu/GpuArrays";
import { GpuSortKeys } from "../gpu/sortKey.tsl";
import { TSL, type TslNode } from "../gpu/tsl";
import { WgpuBuffer } from "./WgpuBuffer";
import { WgpuCompact } from "./WgpuCompact";
import { WgpuCompute, requireWebGPU } from "./WgpuCompute";
import { WgpuRadixSort } from "./WgpuRadixSort";

const { uint } = TSL;

// The draw order of projected splats, sorted on the GPU in the same frame
// (WebGPU backend only): compaction drops the invalid keys of the
// projection's `sortKeys` bundle, a radix sort orders the rest back to front, and
// a one-thread kernel writes the drawIndexedIndirect arguments. Nothing is
// read back.
export class WgpuSplatSorter {
  // Splats per instance of the indirect draw: SplatRenderer's quads
  static readonly QUADS_PER_INSTANCE = 1024;

  readonly renderer: WebGPURenderer;
  // Sorted splat indices: values.element(i) is the i-th splat drawn
  readonly values: WgpuBuffer<"uint32">;
  // The number of them (a TSL node, the sort's visible count)
  readonly count: TslNode;
  // drawIndexedIndirect arguments: the indices of QUADS_PER_INSTANCE
  // quads, enough instances for the visible count, first index, base
  // vertex and first instance 0
  readonly indirect: WgpuBuffer<"uint32">;

  private keys = new GpuArrayReader(SortKeys.KEYS);
  private compact: WgpuCompact;
  private radix: WgpuRadixSort;
  private args: WgpuCompute;

  constructor(renderer: WebGPURenderer) {
    requireWebGPU(renderer, "WgpuSplatSorter");
    this.renderer = renderer;
    this.compact = new WgpuCompact({ renderer, key: (i) => GpuSortKeys.unpack(this.keys.load("key", i)) });
    this.radix = new WgpuRadixSort({ renderer, keys: this.compact.keys, values: this.compact.values });
    this.values = this.compact.values;

    const indirect = this.indirect = new WgpuBuffer({ renderer, format: "uint32", count: 5, indirect: true, label: "radix_splatDrawArgs" });
    const count = this.count = this.compact.count.element(uint(0));
    const quads = WgpuSplatSorter.QUADS_PER_INSTANCE;
    this.args = new WgpuCompute({
      label: "radix_splatDrawArgs",
      workgroupSize: [1],
      body: () => {
        indirect.element(uint(0)).assign(uint(quads * 6));
        indirect.element(uint(1)).assign(count.add(uint(quads - 1)).div(uint(quads)));
        indirect.element(uint(2)).assign(uint(0));
        indirect.element(uint(3)).assign(uint(0));
        indirect.element(uint(4)).assign(uint(0));
      },
    });
  }

  // Sort the first `count` splats of `projected` (arrays with a sortKeys
  // bundle of SortKeys.KEYS, as a SplatRenderer's projected arrays) by their keys of
  // width `bits`
  sort(projected: GpuArrays, count: number, bits: SortKeyBits) {
    this.keys.bind(projected, "sortKeys");
    this.compact.invalid.value = SortKeys.invalid(bits);

    this.compact.compact(count);
    this.radix.sortIndirect(this.compact.count, { bits });
    this.args.dispatch(this.renderer, [1]);
  }

  // The visible count of the latest sort (a readback, for tests and stats)
  async readCount(): Promise<number> {
    return (await this.compact.count.read(0, 1))[0];
  }

  dispose() {
    this.compact.dispose();
    this.radix.dispose();
    this.args.dispose();
    this.indirect.dispose();
  }
}
