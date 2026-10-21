// Checks of GpuArrays and GpuArrayReader, then those of every other test file
import * as THREE from "three";
import { NodeMaterial, type WebGPURenderer } from "three/webgpu";
import {
  ArrayData, ArrayFormats, Encoding, GpuArrayReader, GpuArrays, Splats, TSL, defineBundle,
  getGpuCaps, type ArrayFormat, type BundleDef, type ExtSplat,
  type Pbr, type ScalarType, type Splat, type TslNode, type TypedArray,
} from "@sparkjsdev/radix";
import { runControlsTests } from "./controlsTests";
import { runRenderTests } from "./renderTests";
import { runSceneTests } from "./sceneTests";
import { runShTests } from "./shTests";
import { runSplatTests } from "./splatTests";
import { runWgpuTests } from "./wgpuTests";

const { Fn, float, positionGeometry, uint, uv, vec4 } = TSL;

export interface TestResult {
  name: string;
  ok: boolean;
  skipped?: boolean;
  detail?: string;
}

const SCALARS: ScalarType[] = ["uint8", "sint8", "unorm8", "snorm8", "uint16", "sint16", "float16", "uint32", "sint32", "float32"];
const COUNT = 5000; // a partial last row

// Half-float bits of a small non-negative integer (exact below 2048)
function halfBits(value: number) {
  if (value === 0) {
    return 0;
  }
  const exponent = Math.floor(Math.log2(value));
  return ((exponent + 15) << 10) | Math.round((value / 2 ** exponent - 1) * 1024);
}

function pattern(scalar: ScalarType, i: number, c: number) {
  const k = i * 3 + c;
  switch (scalar) {
    case "uint8": case "unorm8": return k & 0xff;
    case "sint8": case "snorm8": return (k & 0xff) - 128;
    case "uint16": return k & 0xffff;
    case "sint16": return (k & 0xffff) - 32768;
    case "float16": return halfBits(k & 1023);
    case "uint32": return (i * 2654435761 + c) >>> 0;
    case "sint32": return (i * 7 + c - 50000) | 0;
    case "float32": return k * 0.25;
  }
}

function filled(format: ArrayFormat, count: number, value: (i: number, c: number) => number): TypedArray {
  const { components, array } = ArrayFormats.info(format);
  const data = new array(count * components);
  for (let i = 0; i < count; i += 1) {
    for (let c = 0; c < components; c += 1) {
      data[i * components + c] = value(i, c);
    }
  }
  return data as TypedArray;
}

function compare(actual: ArrayLike<number>, expected: ArrayLike<number>) {
  for (let i = 0; i < expected.length; i += 1) {
    if (actual[i] !== expected[i]) {
      return `value ${i}: got ${actual[i]}, expected ${expected[i]}`;
    }
  }
  return undefined;
}

function dataOf(def: BundleDef, count: number, offset = 0) {
  const data = new ArrayData({ bundles: { b: def }, count });
  for (const [label, format] of Object.entries(def.channels)) {
    data.bundles.b.channels[label].data.set(filled(format, count, (i, c) => pattern(ArrayFormats.info(format).scalar, i + offset, c)) as never);
  }
  return data;
}

function channelOf(data: ArrayData, count: number) {
  const { format, data: values } = data.bundles.b.channels.v;
  return values.subarray(0, count * ArrayFormats.info(format).components);
}

export async function runTests(renderer: WebGPURenderer, log: (result: TestResult) => void): Promise<TestResult[]> {
  const webgpu = getGpuCaps(renderer).backend === "webgpu";
  const results: TestResult[] = [];
  const check = async (name: string, fn: () => Promise<string | undefined | "skip">) => {
    let result: TestResult;
    try {
      const detail = await fn();
      result = detail === "skip" ? { name, ok: true, skipped: true } : { name, ok: detail === undefined, detail };
    } catch (error) {
      result = { name, ok: false, detail: String(error instanceof Error ? error.message : error) };
    }
    results.push(result);
    log(result);
  };

  // The patch covers partial rows at both ends
  for (const scalar of SCALARS) {
    for (const [components, packing] of [[1, 1], [2, 1], [4, 1], [1, 2], [1, 4], [2, 2]] as const) {
      const format = ArrayFormats.make(scalar, components);
      await check(`upload/read ${format}${packing > 1 ? ` packed ${packing}` : ""}`, async () => {
        if (scalar === "snorm8" && !webgpu) {
          return "skip"; // not renderable on WebGL2, so not readable
        }
        const def = defineBundle({ v: format }, { packing });
        const data = dataOf(def, COUNT);
        const gpu = GpuArrays.fromData(renderer, data);
        try {
          const full = compare(channelOf(await gpu.read(), COUNT), channelOf(data, COUNT));
          if (full) {
            return `full: ${full}`;
          }
          const patch = dataOf(def, 700, 11);
          gpu.upload(patch, { dstStart: 1300, count: 700 });
          const range = await gpu.read({ start: 1300, count: 700 });
          return compare(channelOf(range, 700), channelOf(patch, 700)) ?? (gpu.count === COUNT ? undefined : `count ${gpu.count}`);
        } finally {
          gpu.dispose();
        }
      });
    }
  }

  for (const def of [defineBundle({ v: "uint32x4" }), defineBundle({ v: "uint32" }, { packing: 4 })]) {
    await check(`range upload and read mid-row (packing ${def.packing})`, async () => {
      const data = dataOf(def, COUNT);
      const gpu = GpuArrays.fromData(renderer, data);
      const source = dataOf(def, COUNT, 100000);
      try {
        gpu.upload(source, { srcStart: 1032, dstStart: 2056, count: 2000 });
        const moved = channelOf(source, 3032).slice(channelOf(source, 1032).length);
        const range = compare(channelOf(await gpu.read({ start: 2056, count: 2000 }), 2000), moved);
        const before = compare(channelOf(await gpu.read({ start: 0, count: 2056 }), 2056), channelOf(data, 2056));
        return range ?? (before && `before the range: ${before}`) ?? undefined;
      } finally {
        gpu.dispose();
      }
    });
  }

  // Growing discards the contents
  await check("copyFrom and ensureCapacity", async () => {
    const def = defineBundle({ v: "float32x2" });
    const data = dataOf(def, COUNT);
    const a = GpuArrays.fromData(renderer, data);
    const b = new GpuArrays({ renderer, bundles: { b: def }, capacity: 10000 });
    try {
      b.copyFrom(a, { srcStart: 100, dstStart: 5000, count: 3000 });
      const copied = compare(channelOf(await b.read({ start: 5000, count: 3000 }), 3000), channelOf(data, 3100).slice(200))
        ?? (b.count === 8000 ? undefined : `count ${b.count}`);
      if (copied) {
        return copied;
      }
      const grew = b.ensureCapacity(50000);
      if (!grew || b.count !== 0 || b.capacity < 50000) {
        return `grew ${grew}, count ${b.count}, capacity ${b.capacity}`;
      }
      b.upload(data);
      return compare(channelOf(await b.read(), COUNT), channelOf(data, COUNT));
    } finally {
      a.dispose();
      b.dispose();
    }
  });

  const readerCases: { name: string; def: BundleDef; value: (i: number) => [number, number]; output: (reader: GpuArrayReader, index: TslNode) => TslNode[] }[] = [
    {
      name: "float32x2",
      def: defineBundle({ v: "float32x2" }),
      value: (i) => [pattern("float32", i, 0), pattern("float32", i, 1)],
      output: (reader, index) => [reader.load("v", index).x, reader.load("v", index).y],
    },
    {
      name: "uint32 packed 4",
      def: defineBundle({ v: "uint32" }, { packing: 4 }),
      value: (i) => [(i * 5 + 1) & 0xffffff, 0],
      output: (reader, index) => [float(reader.load("v", index)), float(0)],
    },
    {
      name: "float16x2 packed 2",
      def: defineBundle({ v: "float16x2" }, { packing: 2 }),
      value: (i) => [Encoding.decodeHalf(pattern("float16", i, 0)), Encoding.decodeHalf(pattern("float16", i, 1))],
      output: (reader, index) => [reader.load("v", index).x, reader.load("v", index).y],
    },
    {
      name: "unorm8x4",
      def: defineBundle({ v: "unorm8x4" }),
      value: (i) => [pattern("unorm8", i, 0) / 255, pattern("unorm8", i, 3) / 255],
      output: (reader, index) => [reader.load("v", index).x, reader.load("v", index).w],
    },
  ];
  for (const { name, def, value, output } of readerCases) {
    await check(`GpuArrayReader ${name} in a shader`, async () => {
      const count = 3001;
      const data = dataOf(def, count);
      if (name.startsWith("uint32")) {
        data.bundles.b.channels.v.data.forEach((_, i, a) => (a[i] = value(i)[0]));
      }
      const gpu = GpuArrays.fromData(renderer, data);
      const reader = new GpuArrayReader(def).bind(gpu, "b");
      try {
        const pixels = await renderIndexed(renderer, (index) => output(reader, index));
        const seen = new Set<number>();
        for (let p = 0; p < pixels.length; p += 4) {
          const index = pixels[p + 2];
          seen.add(index);
          const expected = index < count ? value(index) : [0, 0];
          if (Math.abs(pixels[p] - expected[0]) > 1e-6 || Math.abs(pixels[p + 1] - expected[1]) > 1e-6) {
            return `element ${index}: got ${pixels[p]}, ${pixels[p + 1]}, expected ${expected}`;
          }
        }
        return seen.size === SIZE * SIZE ? undefined : `${seen.size} distinct indices`;
      } finally {
        gpu.dispose();
      }
    });
  }

  await check("splat access with THREE.Vector3 / Quaternion / Color", async () => {
    const data = new ArrayData({ bundles: { extSplats: Splats.EXT }, count: 1 });
    const source: ExtSplat = {
      ...Splats.makeExtSplat(),
      center: { x: 1.5, y: -2, z: 3.25 },
      quaternion: { x: 0, y: Math.sin(0.3), z: 0, w: Math.cos(0.3) },
      rgb: { r: 0.2, g: 0.5, b: 1.5 },
      normal: { x: 0, y: 1, z: 0 },
    };
    Splats.encodeExt(data.bundles.extSplats, 0, source);

    const plain = Splats.decodeExt(data.bundles.extSplats, 0, Splats.makeExtSplat());
    const three: Splat = { ...Splats.makeSplat(), center: new THREE.Vector3(), scales: new THREE.Vector3(), quaternion: new THREE.Quaternion(), rgb: new THREE.Color() };
    const pbr: Pbr = { ...Splats.makePbr(), normal: new THREE.Vector3() };
    Splats.load(data.bundles.extSplats, 0, three);
    Splats.loadPbr(data.bundles.extSplats, 0, pbr);
    const center = three.center as THREE.Vector3;
    const rgb = three.rgb as THREE.Color;
    return center.equals(new THREE.Vector3(1.5, -2, 3.25)) && rgb.g === plain.rgb.g && three.quaternion.y === plain.quaternion.y
      && (pbr.normal as THREE.Vector3).y > 0.999 ? undefined : `${center.toArray()} ${rgb.toArray()}`;
  });

  await runSplatTests(renderer, check);
  await runShTests(renderer, check);
  await runWgpuTests(renderer, check);
  await runRenderTests(renderer, check);
  await runSceneTests(renderer, check);
  await runControlsTests(check);
  return results;
}

const SIZE = 64;
const target = new THREE.RenderTarget(SIZE, SIZE, { type: THREE.FloatType, depthBuffer: false });
const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

async function renderIndexed(renderer: WebGPURenderer, values: (index: TslNode) => TslNode[]) {
  const material = new NodeMaterial();
  material.vertexNode = vec4(positionGeometry.xy, 0, 1);
  material.fragmentNode = Fn(() => {
    const index = uint(uv().x.mul(SIZE)).add(uint(uv().y.mul(SIZE)).mul(SIZE)).toVar();
    const [a, b] = values(index);
    return vec4(a, b, float(index), 1);
  })();
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  quad.frustumCulled = false;
  const scene = new THREE.Scene().add(quad);

  try {
    renderer.setRenderTarget(target);
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);
    return await renderer.readRenderTargetPixelsAsync(target, 0, 0, SIZE, SIZE) as Float32Array;
  } finally {
    quad.geometry.dispose();
    material.dispose();
  }
}
