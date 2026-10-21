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

/** Sorts projected splats back to front on the GPU, on the WebGPU backend only. */
export class WgpuSplatSorter {
  /** The splats per instance of the indirect draw. */
  static readonly QUADS_PER_INSTANCE = 1024;

  readonly renderer: WebGPURenderer;
  /** The sorted splat indices, in draw order. */
  readonly values: WgpuBuffer<"uint32">;
  /** The visible count, as a TSL node. */
  readonly count: TslNode;
  /** The drawIndexedIndirect arguments for the visible splats. */
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

  /**
   * Sorts the first count splats back to front.
   *
   * @param projected Arrays with a sortKeys bundle.
   */
  sort(projected: GpuArrays, count: number, bits: SortKeyBits) {
    this.keys.bind(projected, "sortKeys");
    this.compact.invalid.value = SortKeys.invalid(bits);

    this.compact.compact(count);
    this.radix.sortIndirect(this.compact.count, { bits });
    this.args.dispatch(this.renderer, [1]);
  }

  /** Reads back the visible count of the latest sort. */
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
