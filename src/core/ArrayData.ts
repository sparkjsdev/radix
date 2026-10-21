import { defineBundle, type BundleDef, type Schema } from "./bundles";
import { ArrayFormats, type ArrayFormat, type ArrayOf, type TypedArray } from "./formats";
import { TextureLayout } from "./layout";

// Distributive, so a typed ArrayData fits where ArrayData is expected
/** A typed-array column of capacity * components scalars. */
export type ArrayChannel<F extends ArrayFormat = ArrayFormat> = F extends ArrayFormat ? { format: F; data: ArrayOf<F> } : never;

/** A bundle of an ArrayData. */
export interface ArrayBundle<D extends BundleDef = BundleDef> {
  def: D;
  channels: { [K in keyof D["channels"]]: ArrayChannel<D["channels"][K]> };
  meta: Record<string, unknown>;
}

/** The bundles of an ArrayData, by name. */
export type ArrayBundles<S extends Schema> = { [K in keyof S]: ArrayBundle<S[K]> };

/** An ArrayData as a plain object, for postMessage. */
export interface TransferableArrayData {
  count: number;
  capacity: number;
  meta: Record<string, unknown>;
  bundles: Record<string, { def: BundleDef; meta: Record<string, unknown>; channels: Record<string, TypedArray> }>;
}

/**
 * A table of elements, stored as typed-array channels in named bundles.
 *
 * Every bundle has count valid rows out of capacity.
 */
export class ArrayData<S extends Schema = Schema> {
  /** The bundle of element index lists, such as draw orders and subsets. */
  static readonly INDICES = defineBundle({ index: "uint32" }, { packing: 4 });

  /** The number of valid rows. */
  count: number;
  /** The number of allocated rows. */
  capacity: number;
  bundles: ArrayBundles<S>;
  /** The table's own metadata, which RDX files save. */
  meta: Record<string, unknown>;

  /**
   * Makes a table.
   *
   * @param [options.count=0] The number of valid rows.
   * @param [options.capacity=TextureLayout.alignCapacity(count)] The number of
   *   allocated rows.
   * @param [options.meta={}] The table's metadata.
   */
  constructor({ bundles, count = 0, capacity, meta = {} }: {
    bundles?: S;
    count?: number;
    capacity?: number;
    meta?: Record<string, unknown>;
  } = {}) {
    this.count = count;
    this.capacity = capacity ?? TextureLayout.alignCapacity(count);
    if (this.capacity < count) {
      throw new Error(`Capacity ${this.capacity} is below count ${count}`);
    }

    this.bundles = {} as ArrayBundles<S>;
    this.meta = meta;
    for (const [name, def] of Object.entries(bundles ?? {})) {
      this.addBundle(name, def);
    }
  }

  /**
   * Adds a bundle.
   *
   * @param [init.data] Arrays by channel name. Arrays that hold capacity
   *   elements are used as given, and shorter ones are copied.
   * @return This table, typed with the new bundle.
   */
  addBundle<N extends string, D extends BundleDef>(name: N, def: D, init: {
    data?: Partial<Record<keyof D["channels"], TypedArray>>;
    meta?: Record<string, unknown>;
  } = {}): ArrayData<S & Record<N, D>> {
    const channels: Record<string, ArrayChannel> = {};
    for (const [label, format] of Object.entries(def.channels)) {
      const info = ArrayFormats.info(format);
      const length = this.capacity * info.components;

      let data = init.data?.[label as keyof D["channels"]];
      if (data && data.constructor !== info.array) {
        throw new Error(`Channel ${name}.${label}: ${data.constructor.name} does not hold ${format}`);
      }

      if (!data || data.length < length) {
        const sized = new info.array(length);
        if (data) {
          sized.set(data);
        }
        data = sized;
      }
      channels[label] = { format, data } as ArrayChannel;
    }

    this.anyBundles[name] = { def, channels, meta: { ...init.meta } };
    return this as unknown as ArrayData<S & Record<N, D>>;
  }

  /**
   * Removes a bundle.
   *
   * @return Whether the bundle was there.
   */
  removeBundle(name: string) {
    if (!(name in this.bundles)) {
      return false;
    }
    delete this.anyBundles[name];
    return true;
  }

  /**
   * Resizes every channel, keeping its contents, and clamps count.
   *
   * @return Whether the capacity changed.
   */
  setCapacity(capacity: number) {
    if (capacity === this.capacity) {
      return false;
    }

    for (const bundle of Object.values(this.anyBundles)) {
      for (const channel of Object.values(bundle.channels)) {
        const info = ArrayFormats.info(channel.format);
        const data = new info.array(capacity * info.components);
        data.set(channel.data.subarray(0, data.length) as never);
        channel.data = data;
      }
    }

    this.capacity = capacity;
    this.count = Math.min(this.count, capacity);
    return true;
  }

  /**
   * Grows every channel to hold a number of rows, at least doubling.
   *
   * @return Whether it grew.
   */
  ensureCapacity(capacity: number) {
    if (capacity <= this.capacity) {
      return false;
    }
    return this.setCapacity(TextureLayout.alignCapacity(Math.max(capacity, this.capacity * 2)));
  }

  /**
   * Copies rows of another table, growing this one as needed.
   *
   * @param [options.bundles] The bundles to copy. By default every bundle both
   *   tables have.
   * @param [options.srcStart=0] The first row to copy.
   * @param [options.dstStart=0] The row to copy to.
   * @param [options.count=src.count - srcStart] The number of rows.
   */
  copyFrom(src: ArrayData, { bundles, srcStart = 0, dstStart = 0, count = src.count - srcStart }: {
    bundles?: string[];
    srcStart?: number;
    dstStart?: number;
    count?: number;
  } = {}) {
    if (srcStart < 0 || count < 0 || srcStart + count > src.capacity) {
      throw new Error(`Copy of ${count} elements from ${srcStart} exceeds the source capacity ${src.capacity}`);
    }
    this.ensureCapacity(dstStart + count);

    const names = bundles ?? Object.keys(this.bundles).filter((name) => name in src.bundles);
    for (const name of names) {
      const from = src.anyBundles[name];
      const to = this.anyBundles[name];
      if (!from || !to) {
        throw new Error(`Bundle ${name} missing`);
      }

      for (const [label, channel] of Object.entries(to.channels)) {
        const source = from.channels[label];
        if (source?.format !== channel.format) {
          throw new Error(`Channel ${name}.${label} missing or of another format`);
        }

        const components = ArrayFormats.info(channel.format).components;
        const values = source.data.subarray(srcStart * components, (srcStart + count) * components);
        channel.data.set(values as never, dstStart * components);
      }
    }

    this.count = Math.max(this.count, dstStart + count);
  }

  /** Makes a deep copy. */
  clone(): ArrayData<S> {
    const copy = new ArrayData<S>({ count: this.count, capacity: this.capacity, meta: structuredClone(this.meta) });
    for (const [name, bundle] of Object.entries(this.anyBundles)) {
      const data = Object.fromEntries(Object.entries(bundle.channels).map(([label, channel]) => [label, channel.data.slice()]));
      copy.addBundle(name, bundle.def, { data, meta: structuredClone(bundle.meta) });
    }
    return copy;
  }

  /** Swaps contents with another table, for double buffering. */
  swap(other: ArrayData<S>) {
    [this.count, other.count] = [other.count, this.count];
    [this.capacity, other.capacity] = [other.capacity, this.capacity];
    [this.bundles, other.bundles] = [other.bundles, this.bundles];
    [this.meta, other.meta] = [other.meta, this.meta];
  }

  /**
   * Returns the table as a plain object holding the same arrays. Once
   * postMessage transfers them, this table is unusable until
   * setFromTransferable.
   */
  toTransferable(): TransferableArrayData {
    const bundles: TransferableArrayData["bundles"] = {};
    for (const [name, bundle] of Object.entries(this.anyBundles)) {
      const channels = Object.fromEntries(Object.entries(bundle.channels).map(([label, channel]) => [label, channel.data]));
      bundles[name] = { def: bundle.def, meta: bundle.meta, channels };
    }
    return { count: this.count, capacity: this.capacity, meta: this.meta, bundles };
  }

  /**
   * Takes over a plain object in place, keeping the bundle and channel objects
   * whose names and formats match.
   */
  setFromTransferable(t: TransferableArrayData): this {
    this.count = t.count;
    this.capacity = t.capacity;
    this.meta = t.meta;

    const bundles: Record<string, ArrayBundle> = {};
    for (const [name, value] of Object.entries(t.bundles)) {
      const existing = this.anyBundles[name];
      const labels = Object.keys(value.def.channels);
      const same = existing && existing.def.packing === value.def.packing && labels.length === Object.keys(existing.channels).length &&
        labels.every((label) => existing.channels[label]?.format === value.def.channels[label]);

      if (same) {
        for (const label of labels) {
          existing.channels[label].data = value.channels[label] as never;
        }
        existing.def = value.def;
        existing.meta = value.meta;
        bundles[name] = existing;
      } else {
        const channels = Object.fromEntries(labels.map((label) => [label, { format: value.def.channels[label], data: value.channels[label] } as ArrayChannel]));
        bundles[name] = { def: value.def, channels, meta: value.meta };
      }
    }

    this.bundles = bundles as unknown as ArrayBundles<S>;
    return this;
  }

  /** Makes a table from a plain object. */
  static fromTransferable(t: TransferableArrayData): ArrayData {
    return new ArrayData().setFromTransferable(t);
  }

  /** Collects the ArrayBuffers inside any value, for postMessage's transfer list. */
  static transferables(value: unknown): ArrayBuffer[] {
    const buffers = new Set<ArrayBuffer>();
    const seen = new Set<unknown>();
    const visit = (item: unknown) => {
      if (!item || typeof item !== "object" || seen.has(item)) {
        return;
      }
      seen.add(item);
      if (item instanceof ArrayBuffer) {
        buffers.add(item);
      } else if (ArrayBuffer.isView(item)) {
        if (item.buffer instanceof ArrayBuffer) {
          buffers.add(item.buffer);
        }
      } else {
        Object.values(item).forEach(visit);
      }
    };
    visit(value);
    return [...buffers];
  }

  private get anyBundles() {
    return this.bundles as unknown as Record<string, ArrayBundle>;
  }
}
