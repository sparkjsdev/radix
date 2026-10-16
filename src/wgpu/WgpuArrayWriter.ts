import type { Schema } from "../core/bundles";
import type { GpuArrays } from "../gpu/GpuArrays";
import {
  countWrites, writeItemTexels, writerChannels, writerVars,
  type ArrayWriter, type WriteItem, type WriterOutput, type WriterOutputs,
} from "../gpu/GpuArrayWriter";
import { gpuFormatInfo } from "../gpu/gpuFormats";
import { TSL, type TslNode } from "../gpu/tsl";
import { WgpuArrayStore } from "./WgpuArrayStore";
import { requireWebGPU, WgpuCompute } from "./WgpuCompute";

const { If, uint, uniform } = TSL;

// Storage textures one compute writer can write: WebGPU's
// maxStorageTexturesPerShaderStage default, which baseline devices keep
const MAX_COMPUTE_WRITER_CHANNELS = 4;

// The compute twin of GpuArrayWriter (WebGPU backend only), with the same
// outputs and write(index, out): GpuArrays.write / writeBatch run it as one
// dispatch per range, one thread per texel, writing the same texels with
// the same indices as the fragment pass. Outputs must be storable formats
// of GpuArrays made with storage: true. write() must not read the arrays
// it writes (a texture cannot be sampled and stored in one dispatch).
export class WgpuArrayWriter<O extends Schema = Schema> implements ArrayWriter<O, true> {
  // Output channels one compute writer may have
  static readonly MAX_CHANNELS = MAX_COMPUTE_WRITER_CHANNELS;

  readonly outputs: O;
  readonly packing: number;
  readonly channels: WriterOutput[];
  readonly storage = true;
  readonly run = runComputeWriters;
  readonly kernel: WgpuCompute;
  private stores: Record<string, WgpuArrayStore> = {};
  private range = { start: uniform(0, "uint"), count: uniform(0, "uint"), first: uniform(0, "uint") };

  constructor({ outputs, write, workgroupSize = 64, label }: {
    outputs: O;
    write: (index: TslNode, out: WriterOutputs<O>) => void;
    workgroupSize?: number;
    label?: string;
  }) {
    this.outputs = outputs;
    const { channels, packing } = writerChannels(outputs);
    this.channels = channels;
    this.packing = packing;

    for (const { bundle, channel, texelFormat } of channels) {
      if (!gpuFormatInfo(texelFormat).storable) {
        throw new Error(`Writer output ${bundle}.${channel}: ${texelFormat} cannot be a storage texture`);
      }
    }
    if (channels.length > MAX_COMPUTE_WRITER_CHANNELS) {
      throw new Error(`Compute writer writes ${channels.length} channels (at most ${MAX_COMPUTE_WRITER_CHANNELS})`);
    }
    for (const [bundle, def] of Object.entries(outputs)) {
      this.stores[bundle] = new WgpuArrayStore(def);
    }

    const { start, count, first } = this.range;
    this.kernel = new WgpuCompute({
      workgroupSize: [workgroupSize],
      label: label ?? `radix_write_${channels.map(({ bundle, channel }) => `${bundle}_${channel}`).join("_")}`,
      body: ({ index }) => {
        If(index.lessThan(count), () => {
          const { out, vars } = writerVars(channels);
          write(index.mul(uint(packing)).add(first), out as WriterOutputs<O>);
          const texel = index.add(start).toVar();
          channels.forEach(({ bundle, channel }, i) => this.stores[bundle].storeTexel(channel, texel, vars[i]));
        });
      },
    });
  }

  // Point the stores at `arrays` and set the range of one dispatch
  prepare(arrays: GpuArrays<Schema, true>, start: number, end: number, first: number) {
    for (const [bundle, store] of Object.entries(this.stores)) {
      store.bind(arrays, bundle);
    }
    this.range.start.value = start;
    this.range.count.value = end - start;
    this.range.first.value = first;
  }

  dispose() {
    this.kernel.dispose();
  }
}

// Run WgpuArrayWriter `items` into `arrays`, one dispatch each (a uniform
// holds one value per compute pass)
export function runComputeWriters(arrays: GpuArrays, items: WriteItem[]) {
  requireWebGPU(arrays.renderer, "WgpuArrayWriter");
  for (const item of items) {
    if (item.count <= 0) {
      continue;
    }
    const writer = item.writer as unknown as WgpuArrayWriter;
    const { start, end } = writeItemTexels(arrays, item);
    writer.prepare(arrays as GpuArrays<Schema, true>, start, end, item.first ?? 0);
    writer.kernel.dispatch(arrays.renderer, end - start);
  }
  countWrites(arrays, items);
}
