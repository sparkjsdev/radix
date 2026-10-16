import * as THREE from "three";
import type { WebGPURenderer } from "three/webgpu";
import { ArrayData } from "../core/ArrayData";
import type { BundleDef, Schema } from "../core/bundles";
import { ArrayFormats, type ArrayFormat, type TypedArray } from "../core/formats";
import { TextureLayout } from "../core/layout";
import { isWebGPUBackend } from "./backend";
import type { ArrayWriter, WriteItem, WriteRange, WriterOutput } from "./GpuArrayWriter";
import { gpuFormatInfo } from "./gpuFormats";
import { copyTexels, readTexels, uploadTexels } from "./textureIo";

export interface GpuChannel {
  format: ArrayFormat;
  // One texel holds `packing` elements: "uint32" packed 4 is "uint32x4"
  texelFormat: ArrayFormat;
  texture: THREE.DataArrayTexture;
  // Compute shaders can write it (arrays made with storage: true, storable format)
  storage: boolean;
}

export interface GpuBundle<D extends BundleDef = BundleDef> {
  def: D;
  // ceil(capacity / packing) texels for every channel
  layout: TextureLayout;
  channels: { [K in keyof D["channels"]]: GpuChannel };
  meta: Record<string, unknown>;
}

export type GpuBundles<S extends Schema> = { [K in keyof S]: GpuBundle<S[K]> };

// The writers arrays accept: fragment writers always, compute writers
// (WgpuArrayWriter) only on arrays made with storage: true
export type WriterFor<Storage extends boolean> = [Storage] extends [true] ? ArrayWriter : ArrayWriter<Schema, false>;

let nextTextureVersion = 1;

// An array texture of `format` texels for `layout`, labeled `name` on the
// GPU. Without `internalFormat` three picks one from format / type, which
// only matches for 32-bit and float formats but has the right sampled type
// (enough for placeholders).
export function makeArrayTexture(name: string, format: ArrayFormat, layout: TextureLayout, internalFormat?: string) {
  const info = gpuFormatInfo(format);
  const texture = new THREE.DataArrayTexture(null, layout.width, layout.height, layout.layers);
  texture.name = name;
  texture.format = info.threeFormat;
  texture.type = info.threeType;
  texture.internalFormat = (internalFormat ?? null) as THREE.PixelFormatGPU;
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.colorSpace = THREE.NoColorSpace;

  texture.needsUpdate = true;
  // Three only rebuilds a bind group for a texture whose version differs from
  // the one bound, so a rebound reader would keep reading the old arrays if
  // versions could be equal
  texture.version = nextTextureVersion++;
  // Texels go in through uploadTexels, never through three
  texture.source.dataReady = false;
  return texture;
}

// The GPU copy of an ArrayData schema: one array texture per channel, on
// WebGPU or the WebGL2 backend. `count` elements are valid.
export class GpuArrays<S extends Schema = Schema, Storage extends boolean = boolean> {
  readonly renderer: WebGPURenderer;
  readonly schema: S;
  // Storable channels can also be written from compute (wgpu/,
  // WebGPU only)
  readonly storage: Storage;
  count = 0;
  // Elements the textures hold, including the layout's padding
  capacity = 0;
  // Grows whenever these arrays' methods change their contents (upload,
  // copyFrom, write, writeBatch, swap, a reallocation)
  version = 0;
  bundles: GpuBundles<S>;
  // Render targets over channel textures, per output set
  private targets = new Map<string, THREE.RenderTarget>();

  constructor({ renderer, bundles, capacity = 1, storage = false as Storage }: { renderer: WebGPURenderer; bundles: S; capacity?: number; storage?: Storage }) {
    if (storage && !isWebGPUBackend(renderer)) {
      throw new Error("GpuArrays with storage: true need the WebGPU backend");
    }
    this.renderer = renderer;
    this.schema = bundles;
    this.storage = storage;
    this.bundles = {} as GpuBundles<S>;
    this.allocate(capacity);
  }

  // Whether every channel of a bundle can live on the GPU
  static supports(def: BundleDef) {
    return Object.values(def.channels).every((format) => {
      const { scalar, components } = ArrayFormats.info(format);
      return ArrayFormats.info(ArrayFormats.make(scalar, components * def.packing)).gpu;
    });
  }

  // GPU copy of `data` (its GPU-capable bundles, or `bundles`), uploaded
  static fromData<S extends Schema, Storage extends boolean = false>(renderer: WebGPURenderer, data: ArrayData<S>, { bundles, storage }: {
    bundles?: string[];
    storage?: Storage;
  } = {}): GpuArrays<S, Storage> {
    const names = bundles ?? Object.keys(data.bundles).filter((name) => GpuArrays.supports(data.bundles[name].def));
    const schema = Object.fromEntries(names.map((name) => [name, data.bundles[name].def])) as unknown as S;
    const arrays = new GpuArrays<S, Storage>({ renderer, bundles: schema, capacity: data.capacity, storage });
    arrays.upload(data as unknown as ArrayData);
    return arrays;
  }

  // Elements [srcStart, srcStart + count) of `data` to dstStart. With no
  // range, all of data (growing; count = data.count). A range starting on a
  // texture row is rounded up to whole rows, from data's spare capacity.
  // Packed bundles need starts that are multiples of the packing.
  upload(data: ArrayData, { bundles, srcStart = 0, dstStart = 0, count }: {
    bundles?: string[];
    srcStart?: number;
    dstStart?: number;
    count?: number;
  } = {}) {
    const full = count === undefined && srcStart === 0 && dstStart === 0;
    const n = count ?? data.count - srcStart;
    if (full) {
      this.ensureCapacity(n);
    } else if (dstStart + n > this.capacity) {
      throw new Error(`Upload of ${n} elements at ${dstStart} exceeds capacity ${this.capacity}`);
    }

    for (const name of bundles ?? Object.keys(this.bundles).filter((name) => name in data.bundles)) {
      const bundle = this.bundle(name);
      const source = data.bundles[name];
      if (!source) {
        throw new Error(`Bundle ${name} missing from the uploaded data`);
      }
      bundle.meta = { ...source.meta };

      const packing = bundle.def.packing;
      if (srcStart % packing !== 0 || dstStart % packing !== 0) {
        throw new Error(`Bundle ${name}: starts must be multiples of the packing ${packing}`);
      }
      const src = srcStart / packing;
      const dst = dstStart / packing;
      let texels = Math.ceil(n / packing);

      const { width } = bundle.layout;
      if (src % width === 0 && dst % width === 0) {
        const available = Math.ceil(data.capacity / packing) - src;
        texels = Math.max(texels, Math.min(Math.ceil(texels / width) * width, bundle.layout.texels - dst, available));
      }

      const spans = bundle.layout.spans(dst, texels);
      for (const [label, channel] of Object.entries(bundle.channels)) {
        const values = source.channels[label];
        if (values?.format !== channel.format) {
          throw new Error(`Channel ${name}.${label} missing or of another format`);
        }
        const texelComponents = ArrayFormats.info(channel.texelFormat).components;
        uploadTexels(this.renderer, channel.texture, channel.texelFormat, spans, padded(values.data, src * texelComponents, texels * texelComponents));
      }
    }

    this.count = full ? n : Math.max(this.count, dstStart + n);
    this.version += 1;
  }

  // Elements [start, start + count) as an ArrayData of count elements (into
  // `into` when given), every channel in its own typed array
  async read({ bundles, start = 0, count = this.count - start, into }: {
    bundles?: string[];
    start?: number;
    count?: number;
    into?: ArrayData;
  } = {}): Promise<ArrayData> {
    const out = into ?? new ArrayData({ count });
    out.ensureCapacity(count);
    out.count = count;

    const reads: Promise<void>[] = [];
    for (const name of bundles ?? Object.keys(this.bundles)) {
      const bundle = this.bundle(name);
      if (!(name in out.bundles)) {
        out.addBundle(name, bundle.def);
      }
      out.bundles[name].meta = { ...bundle.meta };

      const packing = bundle.def.packing;
      if (start % packing !== 0) {
        throw new Error(`Bundle ${name}: start must be a multiple of the packing ${packing}`);
      }

      const spans = bundle.layout.spans(start / packing, Math.ceil(count / packing));
      for (const [label, channel] of Object.entries(bundle.channels)) {
        const components = ArrayFormats.info(channel.format).components;
        const dest = out.bundles[name].channels[label].data.subarray(0, count * components) as TypedArray;
        reads.push(readTexels(this.renderer, channel.texture, channel.texelFormat, spans, dest));
      }
    }

    await Promise.all(reads);
    return out;
  }

  // GPU copy of elements from `src`, whose bundles must match
  copyFrom(src: GpuArrays, { bundles, srcStart = 0, dstStart = 0, count }: {
    bundles?: string[];
    srcStart?: number;
    dstStart?: number;
    count?: number;
  } = {}) {
    const n = count ?? src.count - srcStart;
    if (dstStart + n > this.capacity || srcStart + n > src.capacity) {
      throw new Error(`Copy of ${n} elements from ${srcStart} to ${dstStart} is out of range`);
    }

    for (const name of bundles ?? Object.keys(this.bundles).filter((name) => name in src.bundles)) {
      const to = this.bundle(name);
      const from = src.bundle(name);
      const packing = to.def.packing;
      if (from.def.packing !== packing || srcStart % packing !== 0 || dstStart % packing !== 0) {
        throw new Error(`Bundle ${name}: packings differ or starts are not multiples of ${packing}`);
      }

      const spans = TextureLayout.copySpans(from.layout, srcStart / packing, to.layout, dstStart / packing, Math.ceil(n / packing));
      for (const [label, channel] of Object.entries(to.channels)) {
        const source = from.channels[label];
        if (source?.format !== channel.format) {
          throw new Error(`Channel ${name}.${label} missing or of another format`);
        }
        copyTexels(this.renderer, source.texture, channel.texture, spans);
      }
      to.meta = { ...from.meta };
    }

    this.count = Math.max(this.count, dstStart + n);
    this.version += 1;
  }

  // Reallocate every texture: contents are discarded and count reset.
  // Nothing happens when the layouts would stay the same.
  setCapacity(capacity: number) {
    const unchanged = Object.values(this.anyBundles).every((bundle) =>
      TextureLayout.for(Math.ceil(capacity / bundle.def.packing)).texels === bundle.layout.texels);
    if (unchanged && this.capacity > 0) {
      return false;
    }

    this.allocate(capacity);
    this.count = 0;
    this.version += 1;
    return true;
  }

  ensureCapacity(capacity: number) {
    if (capacity <= this.capacity) {
      return false;
    }
    return this.setCapacity(Math.max(capacity, this.capacity * 2));
  }

  // Whether compute can write these arrays (made with storage: true);
  // narrows the type so compute writers are accepted
  hasStorage(): this is GpuArrays<S, true> {
    return this.storage === true;
  }

  // Run a writer (fragment GpuArrayWriter, or compute WgpuArrayWriter on
  // storage arrays) over elements [at, at + count): count = max(count, end)
  write(writer: WriterFor<Storage>, range: WriteRange) {
    writer.run(this as unknown as GpuArrays, [{ writer, ...range }]);
    this.version += 1;
  }

  // Several writers or ranges, each kind run together: fragment items
  // overlapping a layer are drawn in that layer's single pass. Ranges
  // should not overlap.
  writeBatch(items: (WriteRange & { writer: WriterFor<Storage> })[]) {
    const kinds = new Map<ArrayWriter["run"], WriteItem[]>();
    for (const item of items) {
      kinds.set(item.writer.run, [...(kinds.get(item.writer.run) ?? []), item]);
    }
    for (const [run, group] of kinds) {
      run(this as unknown as GpuArrays, group);
    }
    this.version += 1;
  }

  // Swap contents with `other` (same renderer). Readers bound to either
  // must be bound again.
  swap(other: GpuArrays<S, Storage>) {
    if (other.renderer !== this.renderer || other.storage !== this.storage) {
      throw new Error("Cannot swap arrays of different renderers or storage settings");
    }
    [this.bundles, other.bundles] = [other.bundles, this.bundles];
    [this.count, other.count] = [other.count, this.count];
    [this.capacity, other.capacity] = [other.capacity, this.capacity];
    [this.targets, other.targets] = [other.targets, this.targets];
    this.version += 1;
    other.version += 1;
  }

  // A render target whose attachments are these channel textures (cached)
  renderTarget(outputs: WriterOutput[]): THREE.RenderTarget {
    const key = outputs.map(({ bundle, channel }) => `${bundle}.${channel}`).join(",");
    let target = this.targets.get(key);
    if (!target) {
      const layout = this.bundle(outputs[0].bundle).layout;
      const textures = outputs.map(({ bundle, channel }) => {
        if (this.bundle(bundle).layout.texels !== layout.texels) {
          throw new Error("Writer outputs must share one texel layout (same packing)");
        }
        return this.bundle(bundle).channels[channel].texture;
      });
      target = new THREE.RenderTarget(layout.width, layout.height, { depth: layout.layers, depthBuffer: false, count: outputs.length });
      target.textures = textures;
      if (this.storage) {
        // On a target's first use three sees its size change from nothing
        // and flags the attachments for update, which recreates storage
        // textures (losing their texels), so record the size it compares
        const textureData = (this.renderer as unknown as { _textures: { get(object: object): Record<string, unknown> } })._textures.get(target);
        Object.assign(textureData, { width: layout.width, height: layout.height, sampleCount: 1 });
      }
      this.targets.set(key, target);
    }
    return target;
  }

  bundle(name: string): GpuBundle {
    const bundle = this.anyBundles[name];
    if (!bundle) {
      throw new Error(`Bundle ${name} not in these GpuArrays`);
    }
    return bundle;
  }

  dispose() {
    this.releaseTextures();
    this.bundles = {} as GpuBundles<S>;
    this.count = 0;
    this.capacity = 0;
  }

  private allocate(capacity: number) {
    this.releaseTextures();
    const webgpu = isWebGPUBackend(this.renderer);
    const bundles: Record<string, GpuBundle> = {};
    let allocated = Number.POSITIVE_INFINITY;

    for (const [name, def] of Object.entries(this.schema)) {
      if (!GpuArrays.supports(def)) {
        throw new Error(`Bundle ${name} has CPU-only formats`);
      }
      const layout = TextureLayout.for(Math.ceil(capacity / def.packing));
      allocated = Math.min(allocated, layout.texels * def.packing);

      const channels: Record<string, GpuChannel> = {};
      for (const [label, format] of Object.entries(def.channels)) {
        const { scalar, components } = ArrayFormats.info(format);
        const texelFormat = ArrayFormats.make(scalar, components * def.packing);
        const info = gpuFormatInfo(texelFormat);
        const texture = makeArrayTexture(`radix_${name}_${label}`, texelFormat, layout, webgpu ? info.webgpu : info.gl);
        const storage = this.storage && info.storable;
        if (storage) {
          // STORAGE_BINDING usage; isArrayTexture makes the WGSL builder
          // declare texture_storage_2d_array
          Object.assign(texture, { isStorageTexture: true, isArrayTexture: true });
        }
        this.renderer.initTexture(texture);
        channels[label] = { format, texelFormat, texture, storage };
      }

      bundles[name] = { def, layout, channels, meta: { ...this.anyBundles[name]?.meta } };
    }

    this.bundles = bundles as unknown as GpuBundles<S>;
    this.capacity = Number.isFinite(allocated) ? allocated : capacity;
  }

  private releaseTextures() {
    for (const target of this.targets.values()) {
      target.dispose();
    }
    this.targets.clear();
    for (const bundle of Object.values(this.anyBundles)) {
      for (const channel of Object.values(bundle.channels)) {
        channel.texture.dispose();
      }
    }
  }

  private get anyBundles() {
    return this.bundles as unknown as Record<string, GpuBundle>;
  }
}

// values[start, start + length), zero-padded when the array ends early
function padded(values: TypedArray, start: number, length: number): TypedArray {
  if (start + length <= values.length) {
    return values.subarray(start, start + length) as TypedArray;
  }

  const out = new (values.constructor as new (n: number) => TypedArray)(length);
  out.set(values.subarray(start) as never);
  return out;
}
