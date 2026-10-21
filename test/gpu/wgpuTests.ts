import type { IndirectStorageBufferAttribute, WebGPURenderer } from "three/webgpu";
import {
  ArrayData, ArrayFormats, GpuArrayReader, GpuArrays, GpuArrayWriter, TSL, WgpuArrayStore, WgpuArrayWriter, WgpuBuffer, WgpuCompute, WgpuComputeBatch,
  defineBundle, getGpuCaps, type ScalarType, type TslNode, type TypedArray,
} from "@sparkjsdev/radix";
import { gpuFormatInfo } from "../../src/gpu/gpuFormats";

const { If, atomicAdd, uint, uniform, uvec4 } = TSL;

type Check = (name: string, fn: () => Promise<string | undefined | "skip">) => Promise<void>;

// Half-float bits of a small non-negative integer (exact below 2048)
function halfBits(value: number) {
  if (value === 0) {
    return 0;
  }
  const exponent = Math.floor(Math.log2(value));
  return ((exponent + 15) << 10) | Math.round((value / 2 ** exponent - 1) * 1024);
}

// Kept exactly by a shader load and store: snorm8 skips -128 (loads -1, stores -127)
function storedValue(scalar: ScalarType, k: number) {
  switch (scalar) {
    case "unorm8": return k % 256;
    case "snorm8": return (k % 255) - 127;
    case "float16": return halfBits(k % 1024);
    case "uint32": return (k * 2654435761) >>> 0;
    case "sint32": return (k * 7 - 50000) | 0;
    case "float32": return k * 0.25;
    default: throw new Error(`${scalar} is not storable`);
  }
}

// 32-bit scalars in every shape, 8 and 16-bit ones only as 4 components per texel
const STORABLE: [ScalarType, number, 1 | 2 | 4][] = [
  ...(["uint32", "sint32", "float32"] as const).flatMap((scalar) =>
    ([[1, 1], [2, 1], [4, 1], [1, 2], [1, 4], [2, 2]] as const).map(([c, p]) => [scalar, c, p] as [ScalarType, number, 1 | 2 | 4])),
  ...(["unorm8", "snorm8", "float16"] as const).flatMap((scalar) =>
    ([[4, 1], [2, 2], [1, 4]] as const).map(([c, p]) => [scalar, c, p] as [ScalarType, number, 1 | 2 | 4])),
];

const CAPACITY = 10000;

export async function runWgpuTests(renderer: WebGPURenderer, check: Check) {
  const webgpu = getGpuCaps(renderer).backend === "webgpu";
  const onWebGPU = (fn: () => Promise<string | undefined>) => async () => (webgpu ? fn() : "skip" as const);

  await check("GpuArrays storage: true needs WebGPU", async () => {
    if (webgpu) {
      return "skip";
    }
    try {
      new GpuArrays({ renderer, bundles: { b: defineBundle({ v: "uint32" }) }, storage: true });
      return "accepted on WebGL2";
    } catch {
      return undefined;
    }
  });

  await check("WgpuBuffer upload, read, clear, copyFrom, growing with keep", onWebGPU(async () => {
    const buffer = new WgpuBuffer({ renderer, format: "float32x4", count: 1000 });
    const other = new WgpuBuffer({ renderer, format: "float32x4", count: 500 });
    try {
      const values = Float32Array.from({ length: 4000 }, (_, i) => i * 0.5);
      buffer.upload(values);
      const read = await buffer.read();
      if (read.some((v, i) => v !== values[i])) {
        return "read differs from upload";
      }
      buffer.clear(100, 50);
      values.fill(0, 400, 600);
      other.copyFrom(buffer, { srcStart: 200, dstStart: 10, count: 300 });
      const copied = await other.read(10, 300);
      if (copied.some((v, i) => v !== values[800 + i])) {
        return "copyFrom differs";
      }
      buffer.setCapacity(3000, { keep: true });
      const kept = await buffer.read(0, 1000);
      return buffer.capacity === 3000 && kept.every((v, i) => v === values[i]) ? undefined : "contents lost growing";
    } finally {
      buffer.dispose();
      other.dispose();
    }
  }));

  await check("WgpuBuffer atomic counter", onWebGPU(async () => {
    const counter = new WgpuBuffer({ renderer, format: "uint32", count: 1, atomic: true });
    const kernel = new WgpuCompute({
      body: ({ index }) => {
        If(index.lessThan(uint(100000)), () => {
          atomicAdd(counter.element(0), uint(1));
        });
      },
    });
    try {
      counter.clear();
      kernel.dispatch(renderer, 100000);
      const [total] = await counter.read();
      return total === 100000 ? undefined : `counted ${total}`;
    } finally {
      kernel.dispose();
      counter.dispose();
    }
  }));

  // 5M threads take more than 65535 workgroups, the most in one dimension
  await check("WgpuCompute dispatch by thread count, 2D workgroups and indirect", onWebGPU(async () => {
    const limit = uniform(0, "uint");
    const out = new WgpuBuffer({ renderer, format: "uint32", count: 5_000_000 });
    const indirect = new WgpuBuffer({ renderer, format: "uint32", count: 3, indirect: true });
    const kernel = new WgpuCompute({
      body: ({ index }) => {
        If(index.lessThan(limit), () => {
          out.element(index).assign(index.mul(uint(3)).add(uint(1)));
        });
      },
    });
    try {
      indirect.upload(new Uint32Array([50, 1, 1]));
      const cases: [string, number | [number, number] | IndirectStorageBufferAttribute, number][] = [
        ["5M threads", 5_000_000, 5_000_000],
        ["[100, 3] workgroups", [100, 3], 100 * 3 * 64],
        ["indirect [50, 1, 1]", indirect.attribute as IndirectStorageBufferAttribute, 50 * 64],
      ];
      for (const [name, size, threads] of cases) {
        out.clear();
        limit.value = typeof size === "number" ? size : 1 << 30;
        kernel.dispatch(renderer, size);
        const values = await out.read(0, Math.min(threads + 1, out.capacity));
        for (let i = 0; i < threads; i += 1) {
          if (values[i] !== ((i * 3 + 1) >>> 0)) {
            return `${name}: element ${i} is ${values[i]}`;
          }
        }
        if (threads < out.capacity && values[threads] !== 0) {
          return `${name}: wrote past ${threads} threads`;
        }
      }
      return undefined;
    } finally {
      kernel.dispose();
      out.dispose();
      indirect.dispose();
    }
  }));

  await check("WgpuComputeBatch in one pass and split give the same results", onWebGPU(async () => {
    const a = new WgpuBuffer({ renderer, format: "uint32", count: 10000 });
    const b = new WgpuBuffer({ renderer, format: "uint32", count: 10000 });
    const fill = new WgpuCompute({
      body: ({ index }) => {
        If(index.lessThan(uint(10000)), () => {
          a.element(index).assign(index.mul(uint(7)));
        });
      },
    });
    const next = new WgpuCompute({
      body: ({ index }) => {
        If(index.lessThan(uint(10000)), () => {
          b.element(index).assign(a.element(index).add(uint(1)));
        });
      },
    });
    try {
      for (const split of [false, true]) {
        a.clear();
        b.clear();
        new WgpuComputeBatch(renderer).add(fill, 10000).add(next, 10000).submit({ split });
        const values = await b.read();
        const wrong = values.findIndex((v, i) => v !== i * 7 + 1);
        if (wrong >= 0) {
          return `split ${split}: element ${wrong} is ${values[wrong]}`;
        }
      }
      return undefined;
    } finally {
      fill.dispose();
      next.dispose();
      a.dispose();
      b.dispose();
    }
  }));

  for (const [scalar, components, packing] of STORABLE) {
    const format = ArrayFormats.make(scalar, components);
    const texelFormat = ArrayFormats.make(scalar, components * packing);
    await check(`WgpuArrayWriter ${format}${packing > 1 ? ` packed ${packing}` : ""}: same texels as the fragment writer`, onWebGPU(async () => {
      if (!gpuFormatInfo(texelFormat).storable) {
        return `${texelFormat} not storable`;
      }
      const def = defineBundle({ v: format }, { packing });
      // Whole texels, so element e's values sit where the packed bundle keeps them
      const sourceDef = defineBundle({ v: texelFormat });
      const sourceData = new ArrayData({ bundles: { s: sourceDef }, count: CAPACITY / packing });
      const src = sourceData.bundles.s.channels.v.data;
      src.forEach((_, k, values) => (values[k] = storedValue(scalar, k)));
      const source = GpuArrays.fromData(renderer, sourceData);
      const reader = new GpuArrayReader(sourceDef).bind(source, "s");
      const write = (index: TslNode, o: { b: { v: TslNode } }) => o.b.v.assign(reader.load("v", index.div(uint(packing))));

      const compute = new WgpuArrayWriter({ outputs: { b: def }, write });
      // snorm8 is not renderable: compute only
      const fragment = scalar === "snorm8" ? undefined : new GpuArrayWriter({ outputs: { b: def }, write });
      const arrays = new GpuArrays({ renderer, bundles: { b: def }, capacity: CAPACITY, storage: true });
      const reference = fragment && new GpuArrays({ renderer, bundles: { b: def }, capacity: CAPACITY });
      try {
        if (arrays.bundle("b").layout.layers < 3) {
          return `only ${arrays.bundle("b").layout.layers} layers`;
        }
        arrays.write(compute, { at: 1500, count: 6000, first: 100 });
        arrays.writeBatch([{ writer: compute, at: 0, count: 1000 }, { writer: fragment ?? compute, at: 8000, count: 1996 }]);
        if (arrays.count !== 9996) {
          return `count ${arrays.count}`;
        }

        const values = (await arrays.read({ count: CAPACITY })).bundles.b.channels.v.data;
        for (const [at, count, first] of [[1500, 6000, 100], [0, 1000, 0], [8000, 1996, 0]]) {
          for (let e = at; e < at + count; e += 1) {
            for (let c = 0; c < components; c += 1) {
              const expected = src[(e - at + first) * components + c];
              if (values[e * components + c] !== expected) {
                return `element ${e}.${c}: got ${values[e * components + c]}, expected ${expected}`;
              }
            }
          }
        }

        if (fragment && reference) {
          reference.write(fragment, { at: 1500, count: 6000, first: 100 });
          reference.writeBatch([{ writer: fragment, at: 0, count: 1000 }, { writer: fragment, at: 8000, count: 1996 }]);
          const expected = (await reference.read({ count: CAPACITY })).bundles.b.channels.v.data;
          const k = (values as TypedArray).findIndex((v, i) => v !== expected[i]);
          if (k >= 0) {
            return `differs from the fragment writer at value ${k}: ${values[k]} vs ${expected[k]}`;
          }
        }
        return undefined;
      } finally {
        compute.dispose();
        fragment?.dispose();
        arrays.dispose();
        reference?.dispose();
        source.dispose();
      }
    }));
  }

  await check("WgpuArrayWriter limits: storage arrays, formats, channels, packing", onWebGPU(async () => {
    const attempts: [string, () => unknown][] = [
      ["uint8x4", () => new WgpuArrayWriter({ outputs: { a: defineBundle({ v: "uint8x4" }) }, write: () => {} })],
      ["float16x2", () => new WgpuArrayWriter({ outputs: { a: defineBundle({ v: "float16x2" }) }, write: () => {} })],
      ["5 channels", () => new WgpuArrayWriter({ outputs: { a: defineBundle({ a: "uint32", b: "uint32", c: "uint32", d: "uint32", e: "uint32" }) }, write: () => {} })],
      ["mixed packing", () => new WgpuArrayWriter({ outputs: { a: defineBundle({ v: "uint32" }), b: defineBundle({ v: "uint32" }, { packing: 4 }) }, write: () => {} })],
    ];
    for (const [name, attempt] of attempts) {
      try {
        attempt();
        return `${name} accepted`;
      } catch {
        // expected
      }
    }
    const def = defineBundle({ v: "uint32x4" });
    const arrays = new GpuArrays({ renderer, bundles: { b: def }, capacity: 100 });
    const writer = new WgpuArrayWriter({ outputs: { b: def }, write: (index, o) => o.b.v.assign(uvec4(index)) });
    try {
      // @ts-expect-error a compute writer needs arrays made with storage: true
      arrays.write(writer, { count: 10 });
      return "arrays without storage accepted";
    } catch {
      return undefined;
    } finally {
      writer.dispose();
      arrays.dispose();
    }
  }));

  await check("WgpuArrayStore scatter: reversed order, packed texels, rebinding after swap", onWebGPU(async () => {
    const def = defineBundle({ v: "uint32x4" });
    const packed = defineBundle({ v: "uint32" }, { packing: 4 });
    const a = new GpuArrays({ renderer, bundles: { b: def }, capacity: 5000, storage: true });
    const b = new GpuArrays({ renderer, bundles: { b: def }, capacity: 5000, storage: true });
    const p = new GpuArrays({ renderer, bundles: { b: packed }, capacity: 5000, storage: true });
    const store = new WgpuArrayStore(def).bind(a, "b");
    const packedStore = new WgpuArrayStore(packed).bind(p, "b");
    const value = uniform(0, "uint");
    const reverse = new WgpuCompute({
      body: ({ index }) => {
        If(index.lessThan(uint(5000)), () => {
          store.store("v", uint(4999).sub(index), uvec4(index, index.mul(uint(3)), value, uint(9)));
        });
      },
    });
    const texels = new WgpuCompute({
      body: ({ index }) => {
        If(index.lessThan(uint(1250)), () => {
          const e = index.mul(uint(4));
          packedStore.storeTexel("v", index, uvec4(e, e.add(uint(1)), e.add(uint(2)), e.add(uint(3))));
        });
      },
    });
    try {
      try {
        packedStore.store("v", uint(0), uint(0));
        return "store() on a packed bundle accepted";
      } catch {
        // expected
      }

      value.value = 7;
      reverse.dispatch(renderer, 5000);
      a.count = 5000;
      const values = (await a.read()).bundles.b.channels.v.data;
      for (let e = 0; e < 5000; e += 1) {
        const i = 4999 - e;
        if (values[e * 4] !== i || values[e * 4 + 1] !== i * 3 || values[e * 4 + 2] !== 7 || values[e * 4 + 3] !== 9) {
          return `element ${e}: ${Array.from(values.subarray(e * 4, e * 4 + 4))}`;
        }
      }

      texels.dispatch(renderer, 1250);
      p.count = 5000;
      const elements = (await p.read()).bundles.b.channels.v.data.subarray(0, 5000);
      const wrong = elements.findIndex((v, e) => v !== e);
      if (wrong >= 0) {
        return `packed element ${wrong} is ${elements[wrong]}`;
      }

      // After the swap a holds b's empty textures, which the rebound store writes
      a.swap(b);
      store.bind(a, "b");
      value.value = 42;
      reverse.dispatch(renderer, 5000);
      a.count = 5000;
      const [now, before] = [(await a.read()).bundles.b.channels.v.data, (await b.read()).bundles.b.channels.v.data];
      return now[2] === 42 && before[2] === 7 ? undefined : `after the swap: ${now[2]}, ${before[2]}`;
    } finally {
      reverse.dispose();
      texels.dispose();
      a.dispose();
      b.dispose();
      p.dispose();
    }
  }));

  await check("storage arrays: upload, read, copyFrom, swap, readers in fragment and compute", onWebGPU(async () => {
    const def = defineBundle({ v: "float32x4" });
    const data = new ArrayData({ bundles: { b: def }, count: 3000 });
    data.bundles.b.channels.v.data.forEach((_, i, values) => (values[i] = i * 0.25));
    const expected = data.bundles.b.channels.v.data;
    const s = GpuArrays.fromData(renderer, data, { storage: true });
    const t = new GpuArrays({ renderer, bundles: { b: def }, capacity: 3000, storage: true });
    const plain = new GpuArrays({ renderer, bundles: { b: def }, capacity: 3000 });
    const reader = new GpuArrayReader(def).bind(s, "b");
    const copy = (index: TslNode, o: { b: { v: TslNode } }) => o.b.v.assign(reader.load("v", index));
    const fragment = new GpuArrayWriter({ outputs: { b: def }, write: copy });
    const compute = new WgpuArrayWriter({ outputs: { b: def }, write: copy });
    const same = async (arrays: GpuArrays, name: string) => {
      const values = (await arrays.read({ count: 3000 })).bundles.b.channels.v.data.subarray(0, 3000 * 4);
      const k = values.findIndex((v, i) => v !== expected[i]);
      return k >= 0 ? `${name}: value ${k} is ${values[k]}, expected ${expected[k]}` : undefined;
    };
    try {
      if (!s.storage || !s.bundle("b").channels.v.storage || plain.bundle("b").channels.v.storage) {
        return "channels not storage";
      }
      const read = await same(s, "read");
      if (read) {
        return read;
      }
      const patch = new ArrayData({ bundles: { b: def }, count: 500 });
      patch.bundles.b.channels.v.data.forEach((_, i, values) => (values[i] = -1.5 * i));
      s.upload(patch, { dstStart: 1000, count: 500 });
      expected.set(patch.bundles.b.channels.v.data.subarray(0, 2000), 4000);
      const uploaded = await same(s, "range upload");
      if (uploaded) {
        return uploaded;
      }

      t.copyFrom(s);
      const copied = await same(t, "copyFrom");
      if (copied) {
        return copied;
      }

      plain.write(fragment, { count: 3000 });
      const drawn = await same(plain, "fragment reader of storage arrays");
      if (drawn) {
        return drawn;
      }
      const fresh = new GpuArrays({ renderer, bundles: { b: def }, capacity: 3000, storage: true });
      try {
        fresh.write(compute, { count: 3000 });
        const computed = await same(fresh, "compute reader of storage arrays");
        if (computed) {
          return computed;
        }
      } finally {
        fresh.dispose();
      }

      s.swap(t);
      try {
        // @ts-expect-error storage and plain arrays are different types
        s.swap(plain);
        return "swap of storage and plain arrays accepted";
      } catch {
        return undefined;
      }
    } finally {
      fragment.dispose();
      compute.dispose();
      s.dispose();
      t.dispose();
      plain.dispose();
    }
  }));
}
