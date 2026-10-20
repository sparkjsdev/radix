// Checks of src/core in Node: npm run check:core
import {
  ArrayData, Axes, CompressedPlyFile, Compression, Encoding, PlyFile, RadFile, RdxFile, Sh, ShPalette, SortKeys, SplatFiles, SplatMath, Splats, SpzFile, Zstd,
  defineBundle,
  type ArrayBundle, type CovSplat, type ExtSplat, type PackedEncoding, type Quat, type ShCodecName, type ShDegree, type SortKeyBits, type SplatBundle, type SplatFormat,
  type Vec3,
} from "../src/core";

const failures: string[] = [];

// The core config has no Node types: the zstd calls the zstd check compares with
type NodeZlib = { zstdCompressSync(bytes: Uint8Array): Uint8Array; zstdDecompressSync(bytes: Uint8Array): Uint8Array };
const NODE_ZLIB: string = "node:zlib";

async function check(name: string, fn: () => string | undefined | Promise<string | undefined>) {
  let detail: string | undefined;
  try {
    detail = await fn();
  } catch (error) {
    detail = String(error instanceof Error ? error.message : error);
  }
  console.log(`${detail === undefined ? "ok  " : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (detail !== undefined) {
    failures.push(name);
  }
}

// First mismatch of two arrays, or undefined
function compare(actual: ArrayLike<number>, expected: ArrayLike<number>) {
  if (actual.length !== expected.length) {
    return `length ${actual.length}, expected ${expected.length}`;
  }
  for (let i = 0; i < expected.length; i += 1) {
    if (actual[i] !== expected[i]) {
      return `value ${i}: got ${actual[i]}, expected ${expected[i]}`;
    }
  }
  return undefined;
}

// Deterministic random numbers (mulberry32)
let seed = 12345;
function random() {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function randomUnit(): Vec3 {
  while (true) {
    const v = { x: random() * 2 - 1, y: random() * 2 - 1, z: random() * 2 - 1 };
    const length = Math.hypot(v.x, v.y, v.z);
    if (length > 0.1 && length <= 1) {
      return { x: v.x / length, y: v.y / length, z: v.z / length };
    }
  }
}

function randomQuat(): Quat {
  const axis = randomUnit();
  const angle = random() * Math.PI * 2;
  const s = Math.sin(angle / 2);
  return { x: axis.x * s, y: axis.y * s, z: axis.z * s, w: Math.cos(angle / 2) };
}

function randomSplat(): ExtSplat {
  return {
    center: { x: (random() - 0.5) * 200, y: (random() - 0.5) * 200, z: (random() - 0.5) * 200 },
    scales: { x: Math.exp(random() * 9 - 6), y: Math.exp(random() * 9 - 6), z: Math.exp(random() * 9 - 6) },
    quaternion: randomQuat(),
    rgb: { r: random() * 4 - 1, g: random() * 4 - 1, b: random() * 4 - 1 },
    opacity: random() * (255 / 128),
    normal: randomUnit(),
    roughness: random(),
    metallic: random(),
  };
}

const degrees = (radians: number) => (radians * 180) / Math.PI;
const vecAngle = (a: Vec3, b: Vec3) => Math.acos(Math.max(-1, Math.min(1, a.x * b.x + a.y * b.y + a.z * b.z)));
// Angle of the rotation between two unit quaternions (q and -q are one rotation)
const quatAngle = (a: Quat, b: Quat) => 2 * Math.acos(Math.min(1, Math.abs(a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w)));
const lnError = (actual: number, expected: number) => Math.abs(Math.log(actual) - Math.log(expected));
// Half-float rounding of ln(v): 2^-11 relative, 2^-25 absolute below the normal range
const lnHalfBound = (v: number) => Math.max(Math.abs(Math.log(v)) * 2 ** -11, 2 ** -25) + 1e-12;
// Worst rounded 12 + 12 octahedral error over random directions: about 0.057 degrees
const OCT24_DEGREES = 0.06;

// --- ArrayData ---

const POINTS = defineBundle({ position: "float32x4", rgba: "unorm8x4" });
const INDICES = defineBundle({ index: "uint32" }, { packing: 4 });

await check("addBundle types and sizes", () => {
  const data = new ArrayData({ bundles: { points: POINTS }, count: 1000 }).addBundle("order", INDICES);
  const position: Float32Array = data.bundles.points.channels.position.data;
  const index: Uint32Array = data.bundles.order.channels.index.data;
  // @ts-expect-error: no such channel
  void data.bundles.points.channels.missing;
  return data.capacity === 4096 && position.length === 4096 * 4 && index.length === 4096 ? undefined : `capacity ${data.capacity}`;
});

await check("addBundle adopts long enough arrays and copies short ones", () => {
  const data = new ArrayData({ count: 10 });
  const long = new Float32Array(4096 * 4);
  const short = new Uint8Array(8).fill(7);
  data.addBundle("points", POINTS, { data: { position: long, rgba: short } });
  const { position, rgba } = data.bundles.points.channels;
  if (position.data !== long || rgba.data === short || rgba.data.length !== 4096 * 4 || rgba.data[7] !== 7) {
    return "wrong adoption";
  }
  try {
    data.addBundle("bad", POINTS, { data: { position: new Uint32Array(4096 * 4) } });
    return "accepted a Uint32Array for float32x4";
  } catch {
    return undefined;
  }
});

await check("defineBundle rejects packings the formats cannot take", () => {
  try {
    defineBundle({ v: "uint32x2" }, { packing: 4 });
    return "uint32x2 packed 4 accepted";
  } catch {
    return undefined;
  }
});

await check("capacity grows by doubling and keeps contents", () => {
  const data = new ArrayData({ bundles: { order: INDICES }, count: 4096 });
  data.bundles.order.channels.index.data.forEach((_, i, a) => (a[i] = i));
  data.ensureCapacity(5000);
  const first = data.capacity;
  data.ensureCapacity(9000);
  const second = data.capacity;
  const kept = data.bundles.order.channels.index.data[4095] === 4095;
  data.setCapacity(4096 * 8);
  return first === 8192 && second === 16384 && kept && data.count === 4096 ? undefined : `capacities ${first}, ${second}, kept ${kept}`;
});

await check("copyFrom and clone", () => {
  const src = new ArrayData({ bundles: { order: INDICES }, count: 100 });
  src.bundles.order.channels.index.data.forEach((_, i, a) => (a[i] = i * 3));
  const dst = new ArrayData({ bundles: { order: INDICES } });
  dst.copyFrom(src, { srcStart: 10, dstStart: 5000, count: 50 });
  const copied = dst.count === 5050 && dst.bundles.order.channels.index.data[5000] === 30 && dst.bundles.order.channels.index.data[5049] === 177;

  const copy = src.clone();
  copy.bundles.order.channels.index.data[0] = 99;
  return copied && src.bundles.order.channels.index.data[0] === 0 && copy.count === 100 ? undefined : "copy or clone wrong";
});

await check("transfer round trip", () => {
  const data = new ArrayData({ bundles: { points: POINTS }, count: 3, meta: { name: "t" } });
  data.bundles.points.channels.position.data.set([1, 2, 3, 4]);
  data.bundles.points.meta.note = "kept";
  const t = data.toTransferable();
  const received = ArrayData.fromTransferable(structuredClone(t, { transfer: ArrayData.transferables(t) }));
  const position = received.bundles.points.channels.position.data;
  if (data.bundles.points.channels.position.data.length !== 0) {
    return "the sender's arrays were not transferred";
  }
  return received.count === 3 && received.meta.name === "t" && received.bundles.points.meta.note === "kept" && position[3] === 4
    && received.bundles.points.def.channels.rgba === "unorm8x4" ? undefined : "lost data";
});

// --- RDX ---

const CHUNK = 4096 * 4;
const COUNT = 70000; // 5 chunks of CHUNK, the last one partial

function rdxSource(meta: Record<string, unknown> = { name: "test" }) {
  const data = new ArrayData({
    bundles: {
      extSplats: Splats.EXT,
      order: INDICES,
      wide: defineBundle({ v: "uint32x5" }),
      half: defineBundle({ h: "float16x2" }, { packing: 2 }),
      derived: defineBundle({ d: "float32" }, { serialize: false }),
    },
    count: COUNT,
    meta,
  });
  data.bundles.extSplats.channels.extA.data.forEach((_, i, a) => (a[i] = i * 7));
  data.bundles.extSplats.channels.extB.data.forEach((_, i, a) => (a[i] = i ^ 0x5555));
  data.bundles.order.channels.index.data.forEach((_, i, a) => (a[i] = COUNT - i));
  data.bundles.wide.channels.v.data.forEach((_, i, a) => (a[i] = i % 1000));
  data.bundles.half.channels.h.data.forEach((_, i, a) => (a[i] = i & 0x3bff));
  data.bundles.order.meta.note = "packed";
  return data;
}

function rdxMatches(source: ArrayData, decoded: ArrayData) {
  if (decoded.count !== COUNT || "derived" in decoded.bundles || decoded.meta.name !== source.meta.name) {
    return `count ${decoded.count}, bundles ${Object.keys(decoded.bundles)}`;
  }
  if (decoded.bundles.order.def.packing !== 4 || decoded.bundles.order.meta.note !== "packed") {
    return "packing or meta lost";
  }
  for (const name of ["extSplats", "order", "wide", "half"]) {
    for (const [label, channel] of Object.entries(source.bundles[name].channels)) {
      const length = COUNT * Number(channel.format.split("x")[1] ?? 1);
      const mismatch = compare(decoded.bundles[name].channels[label].data.subarray(0, length), channel.data.subarray(0, length));
      if (mismatch) {
        return `${name}.${label} ${mismatch}`;
      }
    }
  }
  return undefined;
}

await check("rdx whole file", async () => {
  const source = rdxSource();
  return rdxMatches(source, await RdxFile.decode(await RdxFile.encode(source, { chunkSize: CHUNK })));
});

await check("rdx chunked, decoded out of order", async () => {
  const source = rdxSource();
  const { header: headerBytes, chunks } = await RdxFile.encodeChunks(source, { chunkSize: CHUNK });
  const { header } = RdxFile.decodeHeader(headerBytes);
  const target = RdxFile.makeData(header);
  for (const chunk of [...chunks].reverse()) {
    await RdxFile.decodeChunk(header, chunk, target);
  }
  return chunks.length === 5 ? rdxMatches(source, target) : `${chunks.length} chunks`;
});

await check("rdx default chunk size and bad sizes", async () => {
  const { header } = RdxFile.decodeHeader((await RdxFile.encodeChunks(rdxSource())).header);
  try {
    await RdxFile.encodeChunks(rdxSource(), { chunkSize: 5000 });
    return "chunk size 5000 accepted";
  } catch {
    return header.chunkSize === RdxFile.CHUNK_SIZE && header.chunks.length === 2 ? undefined : `header ${header.chunkSize}`;
  }
});

await check("openRdx reads every chunk, a header over 64 KB in two reads", async () => {
  const source = rdxSource({ name: "big", padding: "x".repeat(100_000) });
  const file = await RdxFile.encode(source, { chunkSize: CHUNK });
  const reads: [number, number][] = [];
  const rdx = await RdxFile.open(async (start, end) => {
    reads.push([start, end]);
    return file.subarray(start, end);
  });
  const target = RdxFile.makeData(rdx.header);
  for (let chunk = 0; chunk < rdx.header.chunks.length; chunk += 1) {
    await rdx.readChunk(chunk, target);
  }
  return reads.length === 2 + 5 ? rdxMatches(source, target) : `${reads.length} reads`;
});

await check("loadRdx over Range requests, and from a server ignoring Range", async () => {
  const source = rdxSource();
  const file = await RdxFile.encode(source, { chunkSize: CHUNK });
  const realFetch = globalThis.fetch;
  try {
    for (const honorRange of [true, false]) {
      let requests = 0;
      globalThis.fetch = async (_url, init) => {
        requests += 1;
        const range = new Headers(init?.headers).get("Range")!.match(/bytes=(\d+)-(\d+)/)!;
        return honorRange
          ? new Response(file.slice(Number(range[1]), Number(range[2]) + 1), { status: 206 })
          : new Response(file.slice(), { status: 200 });
      };
      const rdx = await RdxFile.load("scene.rdx");
      const target = RdxFile.makeData(rdx.header);
      for (let chunk = 0; chunk < rdx.header.chunks.length; chunk += 1) {
        await rdx.readChunk(chunk, target);
      }
      const mismatch = rdxMatches(source, target);
      if (mismatch || requests !== (honorRange ? 6 : 1)) {
        return `${honorRange ? "206" : "200"}: ${mismatch ?? `${requests} requests`}`;
      }
    }
    return undefined;
  } finally {
    globalThis.fetch = realFetch;
  }
});

await check("chunked files: encodeRdxFiles names, loadRdx with chunked", async () => {
  const source = rdxSource();
  const files = await RdxFile.encodeFiles(source, "data/scene.rdx", { chunkSize: CHUNK });
  const names = Object.keys(files).join(" ");
  if (names !== "data/scene.rdx data/scene-0.rdx data/scene-1.rdx data/scene-2.rdx data/scene-3.rdx data/scene-4.rdx") {
    return names;
  }
  if (RdxFile.chunkName("scene.rdx?v=2", 3) !== "scene-3.rdx?v=2") {
    return RdxFile.chunkName("scene.rdx?v=2", 3);
  }

  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url) => {
      const file = files[String(url)];
      return file ? new Response(file.slice(), { status: 200 }) : new Response(null, { status: 404 });
    };
    const rdx = await RdxFile.load("data/scene.rdx", { chunked: true });
    const target = RdxFile.makeData(rdx.header);
    for (const chunk of [4, 2, 0, 1, 3]) {
      await rdx.readChunk(chunk, target);
    }
    return rdxMatches(source, target);
  } finally {
    globalThis.fetch = realFetch;
  }
});

await check("errors show a URL's file name only", async () => {
  const loads: [() => unknown, string][] = [
    [() => SplatFiles.fetch("https://cdn.example/token=SECRET/missing.ply?sig=SECRET#a"), "Failed to load missing.ply: 403"],
    [() => SplatFiles.fetch("https://cdn.example/token=SECRET/scene.bin?sig=SECRET#a"), "Unknown splat file format: scene.bin"],
    [() => RdxFile.load("https://cdn.example/token=SECRET/missing.rdx?sig=SECRET#a"), "Failed to load missing.rdx: 403"],
    [() => RdxFile.chunkName("https://cdn.example/token=SECRET/scene.bin?sig=SECRET#a", 0), "scene.bin does not end in .rdx"],
    [() => SplatFiles.fetch("https://cdn.example/token=SECRET/missing/?sig=SECRET#a"), "Failed to load missing: 403"],
    [() => SplatFiles.fetch("https://missing.example?sig=SECRET#a"), "Failed to load missing.example: 403"],
  ];
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url) => String(url).includes("missing") ? new Response(null, { status: 403 }) : new Response("not a splat file", { status: 200 });
    for (const [load, expected] of loads) {
      try {
        await load();
        return `no error, expected "${expected}"`;
      } catch (error) {
        if ((error as Error).message !== expected) {
          return (error as Error).message;
        }
      }
    }
    return undefined;
  } finally {
    globalThis.fetch = realFetch;
  }
});

// --- Splat codecs ---

const N = 20000;

await check("octahedral normals within the 12 + 12 bit budget; generic and fixed-size codecs agree", () => {
  let worst = 0;
  const decoded = { x: 0, y: 0, z: 0 };
  for (let i = 0; i < N; i += 1) {
    const v = randomUnit();
    const code = Encoding.encodeOct24(v);
    if (code !== Encoding.encodeOct(v, 12)) {
      return `encodeOct24 ${code} vs encodeOct ${Encoding.encodeOct(v, 12)}`;
    }
    worst = Math.max(worst, vecAngle(Encoding.decodeOct24(code, decoded), v));
  }
  return degrees(worst) <= OCT24_DEGREES ? undefined : `max error ${degrees(worst)} degrees`;
});

await check("no normal and -Z normal round-trip", () => {
  const out = { x: 1, y: 1, z: 1 };
  Encoding.decodeOct24(Encoding.encodeOct24({ x: 0, y: 0, z: 0 }), out);
  if (out.x !== 0 || out.y !== 0 || out.z !== 0) {
    return "zero normal decoded as a direction";
  }
  const code = Encoding.encodeOct24({ x: 0, y: 0, z: -1 });
  Encoding.decodeOct24(code, out);
  return code !== 0 && Math.abs(out.z + 1) < 1e-9 ? undefined : `-Z decoded as ${JSON.stringify(out)}`;
});

await check("ext splats within their bit budgets", () => {
  const data = new ArrayData({ bundles: { extSplats: Splats.EXT }, count: N });
  const inputs = Array.from({ length: N }, randomSplat);
  inputs.forEach((s, i) => Splats.encodeExt(data.bundles.extSplats, i, s));
  const out = Splats.makeExtSplat();

  let rotation = 0;
  let normal = 0;
  for (let i = 0; i < N; i += 1) {
    const s = inputs[i];
    Splats.decodeExt(data.bundles.extSplats, i, out);
    if (out.center.x !== Math.fround(s.center.x) || out.center.z !== Math.fround(s.center.z)) {
      return `center ${i}`;
    }
    if (Math.abs(out.opacity - s.opacity) > 1 / 256 + 1e-12) {
      return `opacity ${s.opacity} -> ${out.opacity}`;
    }
    for (const axis of ["x", "y", "z"] as const) {
      if (lnError(out.scales[axis], s.scales[axis]) > lnHalfBound(s.scales[axis])) {
        return `scale ${s.scales[axis]} -> ${out.scales[axis]}`;
      }
    }
    const maxAbs = Math.max(Math.abs(s.rgb.r), Math.abs(s.rgb.g), Math.abs(s.rgb.b));
    if (Math.max(Math.abs(out.rgb.r - s.rgb.r), Math.abs(out.rgb.g - s.rgb.g), Math.abs(out.rgb.b - s.rgb.b)) > maxAbs / 255 + 1e-9) {
      return `rgb ${JSON.stringify(s.rgb)} -> ${JSON.stringify(out.rgb)}`;
    }
    if (Math.abs(out.roughness - s.roughness) > 1 / 510 + 1e-12 || Math.abs(out.metallic - s.metallic) > 1 / 510 + 1e-12) {
      return `roughness / metallic ${s.roughness}, ${s.metallic}`;
    }
    normal = Math.max(normal, vecAngle(out.normal, s.normal));
    rotation = Math.max(rotation, quatAngle(out.quaternion, s.quaternion));
  }
  // Angle step pi / 4095 (at most 0.022 degrees off), plus the rounded
  // 10-bit axis error (about 0.2 degrees) times 2 sin(angle / 2)
  return degrees(normal) <= OCT24_DEGREES && degrees(rotation) <= 0.45 ? undefined : `normal ${degrees(normal)}, rotation ${degrees(rotation)} degrees`;
});

await check("small turns from identity keep the 12-bit angle's precision", () => {
  const data = new ArrayData({ bundles: { extSplats: Splats.EXT }, count: 1 });
  const s = Splats.makeExtSplat();
  const out = Splats.makeExtSplat();
  let worst = 0;
  for (let i = 0; i < N; i += 1) {
    const axis = randomUnit();
    const half = ((random() * 2 * Math.PI) / 180) / 2;
    s.quaternion = { x: axis.x * Math.sin(half), y: axis.y * Math.sin(half), z: axis.z * Math.sin(half), w: Math.cos(half) };
    Splats.encodeExt(data.bundles.extSplats, 0, s);
    worst = Math.max(worst, quatAngle(Splats.decodeExt(data.bundles.extSplats, 0, out).quaternion, s.quaternion));
  }
  // Turns of up to 2 degrees: the axis error is scaled by 2 sin(1 degree)
  return degrees(worst) <= 0.03 ? undefined : `${degrees(worst)} degrees`;
});

await check("identity and zero quaternions", () => {
  const out = { x: 1, y: 1, z: 1, w: 0 };
  const data = new ArrayData({ bundles: { extSplats: Splats.EXT }, count: 1 });
  Splats.encodeExt(data.bundles.extSplats, 0, Splats.makeExtSplat());
  Encoding.decodeQuatOct32(data.bundles.extSplats.channels.extB.data[3], out);
  return out.x === 0 && out.y === 0 && out.z === 0 && out.w === 1 ? undefined : JSON.stringify(out);
});

await check("cov splats: encoding, and splatFromCov / covFromSplat back to itself", () => {
  const data = new ArrayData({ bundles: { covSplats: Splats.COV }, count: N });
  const covs: CovSplat[] = [];
  for (let i = 0; i < N; i += 1) {
    const c = Splats.toCov(randomSplat(), Splats.makeCovSplat());
    covs.push(c);
    Splats.encodeCov(data.bundles.covSplats, i, c);
  }

  const out = Splats.makeCovSplat();
  const splat = Splats.makeSplat();
  const back = Splats.makeCovSplat();
  for (let i = 0; i < N; i += 1) {
    const c = covs[i].cov;
    Splats.decodeCov(data.bundles.covSplats, i, out);
    for (const [key, a, b] of [["xy", c.xx, c.yy], ["xz", c.xx, c.zz], ["yz", c.yy, c.zz]] as const) {
      // The correlation's own half rounding (at most |c ln c| 2^-11 < 2e-4), plus the diagonal's
      const correlation = Math.abs(c[key]) / Math.sqrt(a * b);
      const bound = Math.sqrt(a * b) * (2e-4 + correlation * (lnHalfBound(a) + lnHalfBound(b)) / 2);
      if (Math.abs(out.cov[key] - c[key]) > bound) {
        return `cov ${key} ${c[key]} -> ${out.cov[key]}`;
      }
    }
    if (lnError(out.cov.xx, c.xx) > lnHalfBound(c.xx)) {
      return `cov xx ${c.xx} -> ${out.cov.xx}`;
    }

    Splats.toCov(Splats.fromCov(covs[i], splat), back);
    const scale = Math.max(c.xx, c.yy, c.zz);
    for (const key of ["xx", "yy", "zz", "xy", "xz", "yz"] as const) {
      if (Math.abs(back.cov[key] - c[key]) > scale * 1e-6) {
        return `round trip ${key} ${c[key]} -> ${back.cov[key]}`;
      }
    }
  }
  return undefined;
});

await check("packed splats within their encoding ranges", () => {
  const data = new ArrayData({ bundles: { packedSplats: Splats.PACKED }, count: N });
  const bundle = data.bundles.packedSplats;
  const { rgbMin, rgbMax, lnScaleMin, lnScaleMax } = Splats.packedEncodingOf(bundle);
  const inputs = Array.from({ length: N }, () => {
    const s = randomSplat();
    s.rgb = { r: random(), g: random(), b: random() };
    s.opacity = random();
    s.center = { x: (random() - 0.5) * 20, y: (random() - 0.5) * 20, z: (random() - 0.5) * 20 };
    return s;
  });
  inputs.forEach((s, i) => Splats.encodePacked(bundle, i, s));

  const out = Splats.makeSplat();
  let rotation = 0;
  for (let i = 0; i < N; i += 1) {
    const s = inputs[i];
    Splats.decodePacked(bundle, i, out);
    if (Math.abs(out.rgb.g - s.rgb.g) > (rgbMax - rgbMin) / 510 + 1e-9 || Math.abs(out.opacity - s.opacity) > 1 / 510 + 1e-9) {
      return `rgb / opacity ${i}`;
    }
    if (Math.abs(out.center.y - s.center.y) > Math.abs(s.center.y) * 2 ** -11 + 2 ** -25) {
      return `center ${s.center.y} -> ${out.center.y}`;
    }
    if (lnError(out.scales.x, s.scales.x) > (lnScaleMax - lnScaleMin) / 254 / 2 + 1e-9) {
      return `scale ${s.scales.x} -> ${out.scales.x}`;
    }
    rotation = Math.max(rotation, quatAngle(out.quaternion, s.quaternion));
  }
  // Angle step pi / 255 (at most 0.35 degrees off), plus the rounded 8-bit axis
  return degrees(rotation) <= 2 ? undefined : `rotation ${degrees(rotation)} degrees`;
});

await check("getSplats / findSplats: by name, then standard names, then channel names and formats", () => {
  const data = new ArrayData({ bundles: { order: INDICES, fake: defineBundle({ extA: "uint32x2", extB: "uint32x4" }), scan: Splats.COV }, count: 1 });
  const found = Splats.get(data);
  if (found.name !== "scan" || found.layout !== "covSplats" || !Splats.isCov(found.bundle) || Splats.isExt(found.bundle)) {
    return `${found.name} ${found.layout}`;
  }
  const both = new ArrayData({ bundles: { other: Splats.EXT, packedSplats: Splats.PACKED }, count: 1 });
  if (Splats.get(both).name !== "packedSplats" || Splats.get(both, "other").layout !== "extSplats" || Splats.find(both, "nope") !== undefined) {
    return "standard name or explicit name not preferred";
  }
  const none = new ArrayData({ bundles: { order: INDICES }, count: 1 });
  try {
    Splats.get(none);
    return "getSplats without splats did not throw";
  } catch {
    return Splats.find(none) === undefined ? undefined : "findSplats found splats in none";
  }
});

// --- Splat access by bundle type ---

// Splats of every layout from the same random inputs
function layouts(count: number) {
  const data = new ArrayData({ bundles: { ext: Splats.EXT, cov: Splats.COV, packed: Splats.PACKED }, count });
  const inputs = Array.from({ length: count }, () => {
    const s = randomSplat();
    s.rgb = { r: random(), g: random(), b: random() };
    s.opacity = random();
    s.center = { x: (random() - 0.5) * 20, y: (random() - 0.5) * 20, z: (random() - 0.5) * 20 };
    return s;
  });
  inputs.forEach((s, i) => {
    Splats.encodeExt(data.bundles.ext, i, s);
    Splats.encodeCov(data.bundles.cov, i, { ...Splats.toCov(s, Splats.makeCovSplat()), normal: s.normal });
    Splats.encodePacked(data.bundles.packed, i, s);
  });
  return { data, inputs };
}

await check("loadCenter agrees with loadSplat for every layout", () => {
  const { data } = layouts(1000);
  const s = Splats.makeSplat();
  const center = { x: 0, y: 0, z: 0 };
  for (const [layout, bundle] of Object.entries(data.bundles) as [string, SplatBundle][]) {
    for (let i = 0; i < 1000; i += 1) {
      Splats.load(bundle, i, s);
      Splats.loadCenter(bundle, i, center);
      if (center.x !== s.center.x || center.z !== s.center.z) {
        return `${layout} center ${i}`;
      }
    }
  }
  return undefined;
});

await check("storeSplat and storePbr keep each other's bits; together they match encodeExtSplat", () => {
  const { data, inputs } = layouts(N);
  const bundle = data.bundles.ext;
  const split = new ArrayData({ bundles: { ext: Splats.EXT }, count: N }).bundles.ext;
  const reversed = new ArrayData({ bundles: { ext: Splats.EXT }, count: N }).bundles.ext;
  inputs.forEach((s, i) => {
    Splats.store(split, i, s);
    Splats.storePbr(split, i, s);
    Splats.storePbr(reversed, i, s);
    Splats.store(reversed, i, s);
  });
  for (const label of ["extA", "extB"] as const) {
    const mismatch = compare(split.channels[label].data, bundle.channels[label].data) ?? compare(reversed.channels[label].data, bundle.channels[label].data);
    if (mismatch) {
      return `${label} ${mismatch}`;
    }
  }

  // Overwriting one half leaves the other
  const p = Splats.makePbr();
  const s = Splats.makeSplat();
  Splats.store(split, 0, inputs[1]);
  Splats.loadPbr(split, 0, p);
  const pbrKept = Math.abs(p.metallic - inputs[0].metallic) <= 1 / 510 && vecAngle(p.normal, inputs[0].normal) < 0.001;
  Splats.storePbr(reversed, 0, inputs[1]);
  Splats.load(reversed, 0, s);
  const splatKept = s.center.x === Math.fround(inputs[0].center.x) && Math.abs(s.opacity - inputs[0].opacity) <= 1 / 256;
  return pbrKept && splatKept ? undefined : `pbr kept ${pbrKept}, splat kept ${splatKept}`;
});

await check("storeSplat matches the low-level encoders for cov and packed", () => {
  const { data, inputs } = layouts(2000);
  const cov = new ArrayData({ bundles: { cov: Splats.COV }, count: 2000 }).bundles.cov;
  const packed = new ArrayData({ bundles: { packed: Splats.PACKED }, count: 2000 }).bundles.packed;
  inputs.forEach((s, i) => {
    Splats.store(packed, i, s);
    // storeSplat keeps the normal bits: write them first, as encodeCovSplat does
    Splats.encodeCov(cov, i, { ...Splats.makeCovSplat(), normal: s.normal });
    Splats.store(cov, i, s);
  });
  return compare(packed.channels.packed.data, data.bundles.packed.channels.packed.data)
    ?? compare(cov.channels.covA.data, data.bundles.cov.channels.covA.data)
    ?? compare(cov.channels.covB.data, data.bundles.cov.channels.covB.data);
});

await check("splat access is typed by the bundle", () => {
  const { data } = layouts(1);
  const pbr = Splats.makePbr();
  const s = Splats.makeSplat();
  Splats.loadPbr(data.bundles.ext, 0, pbr);
  // @ts-expect-error packed splats have no PBR
  void (() => Splats.loadPbr(data.bundles.packed, 0, pbr));
  // @ts-expect-error cov splats have no PBR
  void (() => Splats.storePbr(data.bundles.cov, 0, pbr));
  const untyped: ArrayData = data;
  // @ts-expect-error an untyped bundle could be any layout
  void (() => Splats.load(untyped.bundles.ext, 0, s));

  const { bundle } = Splats.get(untyped);
  Splats.load(bundle, 0, s);
  // @ts-expect-error not narrowed yet
  void (() => Splats.loadPbr(bundle, 0, pbr));
  if (Splats.isExt(bundle)) {
    Splats.loadPbr(bundle, 0, pbr);
  }
  const packedData = Splats.make(1, { layout: "packedSplats" });
  Splats.load(packedData.bundles.packedSplats, 0, s);
  // @ts-expect-error the data's splats are packed
  void (() => packedData.bundles.extSplats.channels);
  const plain: ArrayBundle = untyped.bundles.packed;
  return Splats.isPacked(plain) && !Splats.isExt(plain) ? undefined : "guards wrong";
});

// --- Double buffering ---

await check("swap and setFromTransferable keep bundle and channel objects", () => {
  const a = new ArrayData({ bundles: { extSplats: Splats.EXT }, count: 10, meta: { name: "a" } });
  const b = new ArrayData({ bundles: { extSplats: Splats.EXT }, count: 20, meta: { name: "b" } });
  a.bundles.extSplats.channels.extA.data[0] = 1;
  b.bundles.extSplats.channels.extA.data[0] = 2;
  a.swap(b);
  if (a.count !== 20 || a.meta.name !== "b" || a.bundles.extSplats.channels.extA.data[0] !== 2 || b.bundles.extSplats.channels.extA.data[0] !== 1) {
    return "swap";
  }

  const bundle = a.bundles.extSplats;
  const channel = bundle.channels.extA;
  const t = a.toTransferable();
  const back = structuredClone(t, { transfer: ArrayData.transferables(t) });
  if (channel.data.length !== 0) {
    return "not transferred";
  }
  back.bundles.extra = { def: Splats.LOD_TREE, meta: {}, channels: { node: new Uint32Array(4096 * 2) } };
  a.setFromTransferable(back);
  return a.bundles.extSplats === bundle && a.bundles.extSplats.channels.extA === channel && channel.data[0] === 2 && a.count === 20
    && (a.bundles as Record<string, ArrayBundle>).extra.channels.node.data.length === 8192 ? undefined : "objects or data lost";
});

// --- Splat files ---

// Decoded splats agree within `bounds` (scales and rotation in ln / degrees)
function closeSplats(a: ArrayData, b: ArrayData, bounds: { center: number; ln: number; rgb: number; opacity: number; degrees: number; pbr?: number }) {
  if (a.count !== b.count) {
    return `count ${a.count} vs ${b.count}`;
  }
  const [fa, fb] = [Splats.get(a).bundle, Splats.get(b).bundle];
  const [sa, sb] = [Splats.makeSplat(), Splats.makeSplat()];
  const [pa, pb] = [Splats.makePbr(), Splats.makePbr()];
  for (let i = 0; i < a.count; i += 1) {
    Splats.load(fa, i, sa);
    Splats.load(fb, i, sb);
    const centerError = Math.max(Math.abs(sa.center.x - sb.center.x), Math.abs(sa.center.y - sb.center.y), Math.abs(sa.center.z - sb.center.z));
    const lnScale = Math.max(...(["x", "y", "z"] as const).map((k) => lnError(sa.scales[k], sb.scales[k])));
    const rgb = Math.max(Math.abs(sa.rgb.r - sb.rgb.r), Math.abs(sa.rgb.g - sb.rgb.g), Math.abs(sa.rgb.b - sb.rgb.b));
    const rotation = degrees(quatAngle(sa.quaternion, sb.quaternion));
    if (centerError > bounds.center || lnScale > bounds.ln || rgb > bounds.rgb || Math.abs(sa.opacity - sb.opacity) > bounds.opacity || rotation > bounds.degrees) {
      return `splat ${i}: center ${centerError}, ln scale ${lnScale}, rgb ${rgb}, opacity ${sa.opacity} vs ${sb.opacity}, rotation ${rotation}`;
    }
    if (bounds.pbr !== undefined && Splats.isExt(fa) && Splats.isExt(fb)) {
      Splats.loadPbr(fa, i, pa);
      Splats.loadPbr(fb, i, pb);
      if (Math.abs(pa.metallic - pb.metallic) > bounds.pbr || (pa.normal.z !== 0 && vecAngle(pa.normal, pb.normal) > bounds.pbr * 4)) {
        return `pbr ${i}: metallic ${pa.metallic} vs ${pb.metallic}, normal ${JSON.stringify(pa.normal)} vs ${JSON.stringify(pb.normal)}`;
      }
    }
  }
  return undefined;
}

function fileSource(count: number, withTree: boolean) {
  const data = new ArrayData({ bundles: { extSplats: Splats.EXT }, count, meta: {} });
  for (let i = 0; i < count; i += 1) {
    const s = randomSplat();
    s.rgb = { r: random(), g: random(), b: random() };
    s.opacity = random();
    s.scales = { x: Math.exp(random() * 8 - 6), y: Math.exp(random() * 8 - 6), z: Math.exp(random() * 8 - 6) };
    Splats.encodeExt(data.bundles.extSplats, i, s);
  }
  if (withTree) {
    const nodes = data.addBundle("lodTree", Splats.LOD_TREE).bundles.lodTree.channels.node.data;
    for (let i = 0; i < count; i += 1) {
      nodes[i * 2] = i % 7;
      nodes[i * 2 + 1] = (i * 13) % count;
    }
  }
  return data;
}

function sameTree(a: ArrayData, b: ArrayData) {
  const [ta, tb] = [Splats.findLodTree(a), Splats.findLodTree(b)];
  if (!ta || !tb) {
    return `tree ${!!ta} ${!!tb}`;
  }
  return compare(tb.channels.node.data.subarray(0, a.count * 2), ta.channels.node.data.subarray(0, a.count * 2));
}

await check("PLY round trip, with and without PBR", async () => {
  const source = fileSource(3000, false);
  const { splats: plain } = await PlyFile.read(PlyFile.write(source));
  const { splats: pbr } = await PlyFile.read(PlyFile.write(source, { pbr: true }));
  // f32 floats of the decoded values: one code off at most
  const bounds = { center: 1e-4, ln: 2 ** -9, rgb: 2 / 255, opacity: 1 / 128, degrees: 0.1, pbr: 1 / 255 };
  return closeSplats(source, plain, { ...bounds, pbr: undefined }) ?? closeSplats(source, pbr, bounds)
    ?? (pbr.meta.format === "ply" && plain.meta.ignoredShDegree === 0 ? undefined : "meta");
});

await check("PLY point clouds and SH degree", async () => {
  const header = "ply\nformat binary_little_endian 1.0\nelement vertex 2\nproperty float x\nproperty float y\nproperty float z\n"
    + "property uchar red\nproperty uchar green\nproperty uchar blue\nend_header\n";
  const bytes = new Uint8Array(header.length + 2 * 15);
  bytes.set(new TextEncoder().encode(header));
  const view = new DataView(bytes.buffer, header.length);
  view.setFloat32(15, 2, true);
  view.setUint8(15 + 12, 255);
  const { splats: cloud } = await PlyFile.read(bytes);
  const s = Splats.makeSplat();
  Splats.load(cloud.bundles.extSplats, 1, s);
  if (s.center.x !== 2 || Math.abs(s.rgb.r - 1) > 1 / 255 || s.rgb.g !== 0 || Math.abs(s.scales.x - 0.001) > 1e-5) {
    return `point ${JSON.stringify(s)}`;
  }

  const names = ["x", "y", "z", "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3", "opacity", "f_dc_0", "f_dc_1", "f_dc_2",
    ...Array.from({ length: 24 }, (_, k) => `f_rest_${k}`)];
  const shHeader = `ply\nformat binary_little_endian 1.0\nelement vertex 1\n${names.map((n) => `property float ${n}`).join("\n")}\nend_header\n`;
  const sh = new Uint8Array(shHeader.length + names.length * 4);
  sh.set(new TextEncoder().encode(shHeader));
  const { splats: read } = await PlyFile.read(sh);
  const { splats: skipped } = await PlyFile.read(sh, { sh: false });
  return Sh.find(read.bundles)?.degree === 2 && read.meta.ignoredShDegree === 0 && !Sh.find(skipped.bundles) && skipped.meta.ignoredShDegree === 2
    ? undefined : "SH degree";
});

// A compressed PLY's quantization of fileSource splats in table order
// (centers within +-100: 10-bit y over a 200-wide chunk; ln scales over 8;
// 8-bit colors and opacity over 1; 10-bit smallest-three rotations), plus
// the ext splats' own rounding
const COMPRESSED_BOUNDS = { center: 200 / 1023 / 2 + 1e-3, ln: 8 / 1023 / 2 + 2 ** -9, rgb: 1 / 510 + 2 / 255, opacity: 1 / 510 + 1 / 128, degrees: 0.3 };

await check("compressed PLY round trip in table order", async () => {
  const source = fileSource(3000, false);
  const bytes = CompressedPlyFile.write(source, { sort: false });
  const { splats: loaded } = await PlyFile.read(bytes);
  const headerLength = new TextDecoder().decode(bytes.subarray(0, 4096)).indexOf("end_header\n") + "end_header\n".length;
  if (bytes.byteLength !== headerLength + Math.ceil(3000 / 256) * 18 * 4 + 3000 * 16) {
    return `size ${bytes.byteLength}`;
  }
  return closeSplats(source, loaded, COMPRESSED_BOUNDS)
    ?? (loaded.meta.format === "ply" && loaded.meta.compressed === true && loaded.meta.ignoredShDegree === 0 ? undefined : "meta");
});

await check("compressed PLY in Morton order: the same splats, in smaller chunks", async () => {
  const source = fileSource(3000, false);
  const { splats: sorted } = await PlyFile.read(CompressedPlyFile.write(source));
  const { splats: unsorted } = await PlyFile.read(CompressedPlyFile.write(source, { sort: false }));
  const [from, inSorted, inUnsorted] = [source.bundles.extSplats, sorted.bundles.extSplats, unsorted.bundles.extSplats];

  // Each sorted splat's source: the nearest center, used once
  const centers = Array.from({ length: source.count }, (_, j) => Splats.loadCenter(from, j, { x: 0, y: 0, z: 0 }));
  const reordered = new ArrayData({ bundles: { extSplats: Splats.EXT }, count: source.count, meta: {} });
  const used = new Uint8Array(source.count);
  const [s, c] = [Splats.makeExtSplat(), { x: 0, y: 0, z: 0 }];
  const error = (a: Vec3, b: Vec3) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.z - b.z));
  let [sortedError, unsortedError] = [0, 0];
  for (let i = 0; i < source.count; i += 1) {
    Splats.loadCenter(inSorted, i, c);
    let nearest = 0;
    for (let j = 1; j < source.count; j += 1) {
      nearest = error(centers[j], c) < error(centers[nearest], c) ? j : nearest;
    }
    if (used[nearest]) {
      return `source splat ${nearest} written twice`;
    }
    used[nearest] = 1;
    sortedError += error(centers[nearest], c);
    unsortedError += error(centers[i], Splats.loadCenter(inUnsorted, i, c));
    Splats.encodeExt(reordered.bundles.extSplats, i, Splats.decodeExt(from, nearest, s));
  }
  // The mean (chunks across octant boundaries still span the whole scene),
  // of 12 chunks of uniformly scattered splats: about 0.6 of the unsorted
  return sortedError < unsortedError * 0.75 ? closeSplats(reordered, sorted, COMPRESSED_BOUNDS)
    : `mean center errors ${sortedError / source.count} sorted, ${unsortedError / source.count} not`;
});

await check("compressed PLY of older SuperSplat files: no color ranges, an sh element", async () => {
  const header = [
    "ply", "format binary_little_endian 1.0", "element chunk 1",
    ...["min_x", "min_y", "min_z", "max_x", "max_y", "max_z", "min_scale_x", "min_scale_y", "min_scale_z", "max_scale_x", "max_scale_y", "max_scale_z"]
      .map((name) => `property float ${name}`),
    "element vertex 2", ...["packed_position", "packed_rotation", "packed_scale", "packed_color"].map((name) => `property uint ${name}`),
    "element sh 2", ...Array.from({ length: 9 }, (_, k) => `property uchar f_rest_${k}`),
    "end_header", "",
  ].join("\n");
  const bytes = new Uint8Array(header.length + 12 * 4 + 2 * 16 + 2 * 9);
  bytes.set(new TextEncoder().encode(header));
  const view = new DataView(bytes.buffer, header.length);
  [0, 0, 0, 2, 4, 6, -1, -1, -1, 1, 1, 1].forEach((value, k) => view.setFloat32(k * 4, value, true));
  const words = [
    // (2, 4, 0); 90 degrees about x (x largest, w code 1023); ln scales -1, 1, 1; rgb (1, 0, 0.2), opacity 1
    2047 * 2 ** 21 + 1023 * 2 ** 11, 2 ** 30 + 1023 * 2 ** 20 + 512 * 2 ** 10 + 512, 1023 * 2 ** 11 + 2047, 255 * 2 ** 24 + 51 * 2 ** 8 + 255,
    // (0, 0, 6); about identity (w largest); ln scales about 0; rgb (0, 1, 0), opacity 128 / 255
    2047, 512 * 2 ** 20 + 512 * 2 ** 10 + 512, 1023 * 2 ** 21 + 512 * 2 ** 11 + 1023, 255 * 2 ** 16 + 128,
  ];
  words.forEach((word, k) => view.setUint32(48 + k * 4, word, true));
  const { splats: loaded } = await PlyFile.read(bytes);

  const expected = new ArrayData({ bundles: { extSplats: Splats.EXT }, count: 2, meta: {} });
  const e = Splats.makeExtSplat();
  Object.assign(e, { center: { x: 2, y: 4, z: 0 }, scales: { x: Math.exp(-1), y: Math.E, z: Math.E }, quaternion: { x: Math.SQRT1_2, y: 0, z: 0, w: Math.SQRT1_2 },
    rgb: { r: 1, g: 0, b: 0.2 }, opacity: 1 });
  Splats.encodeExt(expected.bundles.extSplats, 0, e);
  Object.assign(e, { center: { x: 0, y: 0, z: 6 }, scales: { x: 1, y: 1, z: 1 }, quaternion: { x: 0, y: 0, z: 0, w: 1 }, rgb: { r: 0, g: 1, b: 0 }, opacity: 128 / 255 });
  Splats.encodeExt(expected.bundles.extSplats, 1, e);
  return closeSplats(expected, loaded, { center: 1e-3, ln: 2 ** -8, rgb: 2 / 255, opacity: 1 / 128, degrees: 0.2 })
    ?? (loaded.meta.compressed === true && Sh.find(loaded.bundles)?.degree === 1 ? undefined : "meta");
});

// PBR is stored as ext holds it (Oct24 normal, unorm8 roughness and
// metallic): the same roughness and metallic bits back, and the same
// normal (Oct24 has duplicate codes on its fold, x = -1, where either code
// of a pair may come back)
function samePbr(a: ArrayData, b: ArrayData) {
  const [ea, eb] = [Splats.get(a).bundle, Splats.get(b).bundle];
  if (!Splats.isExt(ea) || !Splats.isExt(eb)) {
    return "not ext";
  }
  const [na, nb] = [{ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }];
  for (let i = 0; i < a.count; i += 1) {
    Encoding.decodeOct24(ea.channels.extA.data[i * 4 + 3] & 0xffffff, na);
    Encoding.decodeOct24(eb.channels.extA.data[i * 4 + 3] & 0xffffff, nb);
    const [ra, rb] = [ea.channels.extB.data[i * 4 + 2] >>> 16, eb.channels.extB.data[i * 4 + 2] >>> 16];
    if (Math.max(Math.abs(na.x - nb.x), Math.abs(na.y - nb.y), Math.abs(na.z - nb.z)) > 1e-6 || ra !== rb) {
      return `pbr ${i}: normal ${JSON.stringify(na)} vs ${JSON.stringify(nb)}, roughness | metallic ${ra} vs ${rb}`;
    }
  }
  return undefined;
}

await check("SPZ round trips with PBR and the LoD tree: v3 (gzip) and v4 (NGSP, RX records)", async () => {
  const source = fileSource(3000, true);
  // Some splats without a normal (0)
  for (let i = 0; i < source.count; i += 5) {
    Splats.storePbr(source.bundles.extSplats, i, { normal: { x: 0, y: 0, z: 0 }, roughness: random(), metallic: random() });
  }
  for (const version of [3, 4] as const) {
    const { splats: loaded } = await SpzFile.read(await SpzFile.write(source, { version, pbr: true }));
    // 12 fractional bits, 8-bit colors (COLOR_SCALE / 255), 1/16 ln steps, smallest-three rotation
    const error = closeSplats(source, loaded, { center: 2 ** -12, ln: 1 / 32 + 2 ** -9, rgb: 0.006, opacity: 1 / 128, degrees: 0.6 })
      ?? samePbr(source, loaded) ?? sameTree(source, loaded)
      ?? (loaded.meta.container === (version === 4 ? "ngsp" : "gzip") ? undefined : `container ${String(loaded.meta.container)}`);
    if (error) {
      return `v${version}: ${error}`;
    }
  }
  return undefined;
});

await check("SPZ version 2 round trip (3-byte rotations)", async () => {
  const source = fileSource(3000, true);
  const { splats: loaded } = await SpzFile.read(await SpzFile.write(source, { version: 2, pbr: true }));
  // As v3, but x, y, z rotation bytes of 1 / 127.5 each: w = sqrt(1 - |xyz|^2)
  // loses precision for turns near 180 degrees (a true w of 0.08 can decode
  // as 0: about 9 degrees), which is why SPZ v3 changed the encoding
  return loaded.meta.version !== 2 ? `version ${String(loaded.meta.version)}`
    : closeSplats(source, loaded, { center: 2 ** -12, ln: 1 / 32 + 2 ** -9, rgb: 0.006, opacity: 1 / 128, degrees: 15 }) ?? samePbr(source, loaded) ?? sameTree(source, loaded);
});

// A written SPZ's inner bytes (header then columns) changed by `edit`, gzipped again
async function editSpz(file: Uint8Array<ArrayBuffer>, edit: (bytes: Uint8Array<ArrayBuffer>) => Uint8Array<ArrayBuffer>) {
  return Compression.gzip(edit(new Uint8Array(await Compression.gunzip(file))));
}

// [u32 type][u32 byteLength][payload]
function spzRecord(type: number, payload: Uint8Array) {
  const out = new Uint8Array(8 + payload.byteLength);
  new DataView(out.buffer).setUint32(0, type, true);
  new DataView(out.buffer).setUint32(4, payload.byteLength, true);
  out.set(payload, 8);
  return out;
}

await check("SPZ in gzip with version 4 (v3's layout, SH degree 4) and extension records after the SH (flag 0x02)", async () => {
  const source = fileSource(500, false);
  Sh.add(source, "ext", 4);
  const encode = Sh.encoder(source);
  shValues(500, 4).forEach((c, i) => encode(i, c));
  const v3 = await SpzFile.write(source);
  const v4 = await editSpz(v3, (bytes) => {
    new DataView(bytes.buffer, bytes.byteOffset).setUint32(4, 4, true);
    return bytes;
  });
  const [{ splats: a }, { splats: b }] = [await SpzFile.read(v3), await SpzFile.read(v4)];
  if (b.meta.version !== 4 || Sh.find(b.bundles)?.degree !== 4) {
    return `gzip version 4: version ${String(b.meta.version)}, SH degree ${Sh.find(b.bundles)?.degree}`;
  }
  const same = compare(b.bundles.extSplats.channels.extA.data, a.bundles.extSplats.channels.extA.data)
    ?? compare(b.bundles.extSplats.channels.extB.data, a.bundles.extSplats.channels.extB.data)
    ?? compare((b as ArrayData).bundles.extSh.channels.extShF.data, (a as ArrayData).bundles.extSh.channels.extShF.data);
  if (same) {
    return `gzip version 4 differs from v3: ${same}`;
  }
  // Safe orbit, coordinate system (RDF) and an unknown record after the SH
  const records = [
    spzRecord(0xadbe0002, new Uint8Array(Float32Array.of(0.25, 1.5, 3).buffer)),
    spzRecord(0xadbe0003, new Uint8Array(Uint32Array.of(6).buffer)),
    spzRecord(0x12340001, new Uint8Array(5)),
  ];
  const withRecords = await editSpz(v3, (bytes) => {
    const out = new Uint8Array(bytes.byteLength + records.reduce((n, r) => n + r.byteLength, 0));
    out.set(bytes);
    out[14] |= 0x02;
    let at = bytes.byteLength;
    for (const r of records) {
      out.set(r, at);
      at += r.byteLength;
    }
    return out;
  });
  const { splats: c } = await SpzFile.read(withRecords);
  const orbit = c.meta.safeOrbitCamera as { elevationMin: number; elevationMax: number; radiusMin: number } | undefined;
  if (orbit?.elevationMin !== 0.25 || orbit.elevationMax !== 1.5 || orbit.radiusMin !== 3 || c.meta.coordinateSystem !== "RDF"
    || JSON.stringify(c.meta.skippedExtensions) !== JSON.stringify([0x12340001]) || a.meta.coordinateSystem !== "RUB") {
    return `records: ${JSON.stringify(c.meta)}`;
  }
  // Asked for RUB: y and z flip (RDF -> RUB)
  const { splats: d } = await SpzFile.read(withRecords, { coordinateSystem: "RUB" });
  const [sc, sd] = [Splats.makeSplat(), Splats.makeSplat()];
  Splats.load(c.bundles.extSplats, 7, sc);
  Splats.load(d.bundles.extSplats, 7, sd);
  return d.meta.coordinateSystem === "RUB" && sd.center.x === sc.center.x && sd.center.y === -sc.center.y && sd.center.z === -sc.center.z ? undefined
    : `converted: ${JSON.stringify(sc.center)} -> ${JSON.stringify(sd.center)}, ${String(d.meta.coordinateSystem)}`;
});

await check("zstd: our encoder read by fzstd and Node, Node's frames read by fzstd (random, skewed, RLE; block edges)", async () => {
  const zlib = (await import(NODE_ZLIB)) as NodeZlib;
  const kinds: Record<string, (n: number) => Uint8Array> = {
    random: (n) => Uint8Array.from({ length: n }, () => (random() * 256) | 0),
    skewed: (n) => Uint8Array.from({ length: n }, () => Math.min(255, Math.floor(-Math.log(1 - random()) * 6))),
    rle: (n) => new Uint8Array(n).fill(9),
    blocks: (n) => Uint8Array.from({ length: n }, (_, i) => ((i >> 17) % 2 === 0 ? (random() < 0.9 ? 3 : 200) : (random() * 256) | 0)),
  };
  for (const [kind, make] of Object.entries(kinds)) {
    for (const n of [0, 1, 63, 64, 1023, 1024, 16384, 131071, 131072, 131073, 300000]) {
      const bytes = make(n);
      const ours = await Zstd.compress(bytes, { native: false });
      const error = compare(await Zstd.decompress(ours, n, { native: false }), bytes) ?? compare(zlib.zstdDecompressSync(ours), bytes)
        ?? compare(await Zstd.decompress(zlib.zstdCompressSync(bytes), n, { native: false }), bytes);
      if (error) {
        return `${kind} ${n}: ${error}`;
      }
    }
  }
  try {
    await Zstd.decompress(await Zstd.compress(new Uint8Array(10)), 11);
    return "wrong size accepted";
  } catch {
    return undefined;
  }
});

// An SPZ 4 file's header and table of contents: [header, extensions, toc
// entries, streams]
function ngspParts(file: Uint8Array) {
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const toc = view.getUint32(16, true);
  return { view, toc, streams: file[15], data: toc + file[15] * 16 };
}

await check("SPZ 4: degrees 0 and 4, records, v3 and v4 alike, NGSP detected", async () => {
  for (const degree of [0, 4] as const) {
    const source = fileSource(700, true);
    source.meta.safeOrbitCamera = { elevationMin: 0.5, elevationMax: 1, radiusMin: 2 };
    source.meta.coordinateSystem = "LUF";
    if (degree === 4) {
      Sh.add(source, "ext", degree);
      const encode = Sh.encoder(source);
      shValues(700, degree).forEach((c, i) => encode(i, c));
    }
    const v4 = await SpzFile.write(source, { version: 4, pbr: true });
    const { streams } = ngspParts(v4);
    if (SplatFiles.detectFormat(v4) !== "spz" || streams !== (degree > 0 ? 6 : 5) || (v4[14] & 0xc0) !== 0 || (v4[14] & 0x02) === 0) {
      return `degree ${degree}: detected ${SplatFiles.detectFormat(v4)}, ${streams} streams, flags ${v4[14]}`;
    }
    const [u3, u4] = [await SpzFile.unpack(await SpzFile.write(source, { pbr: true })), await SpzFile.unpack(v4)];
    for (const key of ["centers", "alphas", "colors", "scales", "rotations", "sh", "lodTree", "pbr"] as const) {
      const error = compare(u4[key] ?? [], u3[key] ?? []);
      if (error) {
        return `degree ${degree}, ${key}: ${error}`;
      }
    }
    const { splats: back } = await SplatFiles.decode(v4);
    if (back.meta.coordinateSystem !== "LUF" || JSON.stringify(back.meta.safeOrbitCamera) !== JSON.stringify(source.meta.safeOrbitCamera)
      || (Sh.find(back.bundles)?.degree ?? 0) !== degree || back.meta.skippedExtensions !== undefined) {
      return `degree ${degree}: meta ${JSON.stringify(back.meta)}`;
    }
  }
  return undefined;
});

await check("SPZ unpack from streams in chunks of 1, 7 and random bytes; early ends rejected; sh: false stops before the SH stream", async () => {
  const source = fileSource(400, true);
  Sh.add(source, "ext", 3);
  const encode = Sh.encoder(source);
  shValues(400, 3).forEach((c, i) => encode(i, c));
  const stream = (bytes: Uint8Array, size: () => number, pulled = { bytes: 0 }) => new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled.bytes >= bytes.byteLength) {
        controller.close();
        return;
      }
      const n = Math.max(1, size());
      controller.enqueue(bytes.slice(pulled.bytes, pulled.bytes + n));
      pulled.bytes += n;
    },
  });
  for (const version of [2, 3, 4] as const) {
    const file = await SpzFile.write(source, { version, pbr: true });
    const whole = await SpzFile.unpack(file);
    for (const size of [() => 1, () => 7, () => 1 + Math.floor(random() * 3000)]) {
      const parts = await SpzFile.unpack(stream(file, size));
      for (const key of ["centers", "rotations", "sh", "lodTree", "pbr"] as const) {
        const error = compare(parts[key] ?? [], whole[key] ?? []);
        if (error) {
          return `v${version}, ${key}: ${error}`;
        }
      }
    }
    try {
      await SpzFile.unpack(stream(file.subarray(0, file.byteLength - 3), () => 100));
      return `v${version}: a truncated stream read`;
    } catch {
      // expected
    }
  }
  const v4 = await SpzFile.write(source, { version: 4 });
  const pulled = { bytes: 0 };
  const noSh = await SpzFile.unpack(stream(v4, () => 16, pulled), { sh: false });
  const { view, toc } = ngspParts(v4);
  const shFrame = view.getUint32(toc + 5 * 16, true);
  // Within the chunk holding the SH frame's start, plus the one chunk the
  // stream pulls ahead into its queue
  return noSh.sh === undefined && pulled.bytes <= v4.byteLength - shFrame + 32 ? undefined
    : `sh: false read ${pulled.bytes} of ${v4.byteLength} bytes, SH frame ${shFrame}, sh ${noSh.sh?.byteLength}`;
});

await check("SPZ 4 rejects tampered files: TOC, stream counts and sizes, trailing bytes, point counts, truncation", async () => {
  const source = fileSource(300, false);
  const file = await SpzFile.write(source, { version: 4 });
  const { toc, data } = ngspParts(file);
  const edits: [string, (bytes: Uint8Array<ArrayBuffer>) => Uint8Array<ArrayBuffer>][] = [
    ["toc inside the header", (b) => (new DataView(b.buffer).setUint32(16, 20, true), b)],
    ["stream count", (b) => ((b[15] = 6), b)],
    ["uncompressed size", (b) => (new DataView(b.buffer).setUint32(toc + 8, 300 * 9 + 1, true), b)],
    ["compressed size past the end", (b) => (new DataView(b.buffer).setUint32(toc + 4 * 16, 1e6, true), b)],
    ["high size word", (b) => (new DataView(b.buffer).setUint32(toc + 4, 1 << 22, true), b)],
    ["trailing bytes", (b) => { const out = new Uint8Array(b.byteLength + 1); out.set(b); return out; }],
    ["point count", (b) => (new DataView(b.buffer).setUint32(8, 2_000_000_000, true), b)],
    ["version", (b) => (new DataView(b.buffer).setUint32(4, 5, true), b)],
    ["truncated", (b) => b.slice(0, data + 5)],
    ["corrupt stream", (b) => { b.fill(0x55, data, data + 20); return b; }],
  ];
  for (const [name, edit] of edits) {
    try {
      await SpzFile.read(edit(file.slice()));
      return `${name}: read`;
    } catch {
      // expected
    }
  }
  return undefined;
});

await check("SPZ without the tree and with lod forced on a treeless file", async () => {
  const source = fileSource(100, true);
  const { splats: loaded } = await SpzFile.read(await SpzFile.write(source, { lod: false }));
  if (Splats.findLodTree(loaded)) {
    return "tree written";
  }
  try {
    await SpzFile.write(fileSource(10, false), { lod: true });
    return "lod without a tree accepted";
  } catch {
    return undefined;
  }
});

await check("RAD round trip in several chunks, with the LoD tree", async () => {
  const source = fileSource(70000, true);
  const file = await RadFile.write(source, { chunkSize: 30000 });
  const { splats: loaded } = await RadFile.read(file);
  return closeSplats(source, loaded, { center: 1e-4, ln: 2 ** -9, rgb: 2 / 255, opacity: 1 / 128, degrees: 0.1 }) ?? sameTree(source, loaded);
});

await check("format detection and encodeSplats / decodeSplats", async () => {
  const source = fileSource(500, true);
  for (const format of ["ply", "compressed-ply", "spz", "rad", "rdx"] as SplatFormat[]) {
    // sort: false keeps compressed PLY in table order (others ignore it)
    const bytes = await SplatFiles.encode(source, format, { sort: false });
    const detected = format === "compressed-ply" ? "ply" : format;
    if (SplatFiles.detectFormat(bytes) !== detected) {
      return `${format} detected as ${SplatFiles.detectFormat(bytes)}`;
    }
    const { splats: loaded } = await SplatFiles.decode(bytes);
    const mismatch = closeSplats(source, loaded, format === "compressed-ply" ? COMPRESSED_BOUNDS
      : { center: 2 ** -12, ln: 1 / 32 + 2 ** -9, rgb: 0.006, opacity: 1 / 128, degrees: 0.6 });
    if (mismatch) {
      return `${format}: ${mismatch}`;
    }
    if (detected !== "ply" && sameTree(source, loaded)) {
      return `${format} tree`;
    }
  }
  try {
    SplatFiles.detectFormat(new Uint8Array([1, 2, 3, 4]), "scene.xyz");
    return "unknown format accepted";
  } catch {
    return SplatFiles.detectFormat(new Uint8Array([1, 2, 3, 4]), "scene.SPZ?v=1") === "spz" ? undefined : "extension";
  }
});

// Covariances of two loads of the same splats agree to `relative` of the largest variance
function closeCovs(a: ArrayData, b: ArrayData, relative: number) {
  const [fa, fb] = [Splats.get(a).bundle, Splats.get(b).bundle];
  const [sa, sb] = [Splats.makeSplat(), Splats.makeSplat()];
  const [ca, cb] = [Splats.makeCovSplat(), Splats.makeCovSplat()];
  for (let i = 0; i < a.count; i += 1) {
    Splats.toCov(Splats.load(fa, i, sa), ca);
    Splats.toCov(Splats.load(fb, i, sb), cb);
    const scale = Math.max(ca.cov.xx, ca.cov.yy, ca.cov.zz);
    for (const key of ["xx", "yy", "zz", "xy", "xz", "yz"] as const) {
      if (Math.abs(ca.cov[key] - cb.cov[key]) > scale * relative) {
        return `splat ${i} cov ${key}: ${ca.cov[key]} vs ${cb.cov[key]}`;
      }
    }
  }
  return undefined;
}

await check("decodeSplats into packedSplats (with an encoding) and covSplats, for every format", async () => {
  const source = fileSource(500, true);
  const encoding = { rgbMin: -0.25, rgbMax: 1.25, lnScaleMin: -8, lnScaleMax: 4 };
  for (const format of ["ply", "compressed-ply", "spz", "rad", "rdx"] as SplatFormat[]) {
    const bytes = await SplatFiles.encode(source, format, { sort: false });
    const { splats: packed } = await SplatFiles.decode(bytes, { layout: "packedSplats", encoding });
    if (!Splats.isPacked(packed.bundles.packedSplats) || JSON.stringify(Splats.packedEncodingOf(packed.bundles.packedSplats)) !== JSON.stringify(encoding)) {
      return `${format}: packed bundle or encoding`;
    }
    // Half centers (within +-100), colors in 1.5 / 255 steps, log scales in
    // 12 / 254 steps, 8-bit rotations; plus SPZ's and compressed PLY's own steps
    const mismatch = closeSplats(source, packed, {
      center: format === "compressed-ply" ? COMPRESSED_BOUNDS.center + 0.04 : 0.04, ln: 6 / 254 + 1 / 32 + 1e-9, rgb: 0.75 / 255 + 0.006, opacity: 1 / 255 + 1 / 128, degrees: 2.6,
    });
    if (mismatch) {
      return `${format} packed: ${mismatch}`;
    }
    if (!format.endsWith("ply") && sameTree(source, packed)) {
      return `${format} tree`;
    }
    // The same file as ext and as cov: the codecs' own rounding apart
    const covMismatch = closeCovs((await SplatFiles.decode(bytes)).splats, (await SplatFiles.decode(bytes, { layout: "covSplats" })).splats, 0.01);
    if (covMismatch) {
      return `${format} cov: ${covMismatch}`;
    }
  }
  return undefined;
});

await check("packedSplats encoding is optional: defaults, partial fields, the file's own", async () => {
  const source = fileSource(200, false);
  const same = (a: PackedEncoding, b: PackedEncoding) => JSON.stringify(a) === JSON.stringify(b);
  const { splats: plain } = await SplatFiles.decode(await SplatFiles.encode(source, "spz"), { layout: "packedSplats" });
  if (!same(Splats.packedEncodingOf(plain.bundles.packedSplats), Splats.DEFAULT_PACKED_ENCODING)) {
    return `no encoding: ${JSON.stringify(plain.bundles.packedSplats.meta.encoding)}`;
  }
  const { splats: partial } = await SplatFiles.decode(await SplatFiles.encode(source, "ply"), { layout: "packedSplats", encoding: { rgbMax: 2 } });
  if (!same(Splats.packedEncodingOf(partial.bundles.packedSplats), { ...Splats.DEFAULT_PACKED_ENCODING, rgbMax: 2 })) {
    return `partial: ${JSON.stringify(partial.bundles.packedSplats.meta.encoding)}`;
  }
  // An RDX of packed splats keeps its encoding unless one is given
  const custom = { rgbMin: -1, rgbMax: 3, lnScaleMin: -9, lnScaleMax: 5 };
  const rdx = await SplatFiles.encode(Splats.convert(source, { layout: "packedSplats", encoding: custom }), "rdx");
  const { splats: kept } = await SplatFiles.decode(rdx, { layout: "packedSplats" });
  const { splats: overridden } = await SplatFiles.decode(rdx, { layout: "packedSplats", encoding: { rgbMin: 0 } });
  return same(Splats.packedEncodingOf(kept.bundles.packedSplats), custom) && same(Splats.packedEncodingOf(overridden.bundles.packedSplats), { ...custom, rgbMin: 0 })
    ? undefined : `rdx: ${JSON.stringify(kept.bundles.packedSplats.meta.encoding)}, ${JSON.stringify(overridden.bundles.packedSplats.meta.encoding)}`;
});

await check("convertSplats: unchanged when in the layout, converted otherwise, other bundles shared", () => {
  const source = fileSource(1000, true);
  if (Splats.convert(source, { layout: "extSplats" }) !== source) {
    return "data already in the layout was converted";
  }
  const packed = Splats.convert(source, { layout: "packedSplats", encoding: { rgbMin: -0.5, rgbMax: 1.5 } });
  const encoding = Splats.packedEncodingOf(packed.bundles.packedSplats);
  if (encoding.rgbMin !== -0.5 || encoding.lnScaleMin !== Splats.DEFAULT_PACKED_ENCODING.lnScaleMin || Splats.findLodTree(packed)?.channels.node.data !== Splats.findLodTree(source)?.channels.node.data) {
    return "encoding, or the tree not shared";
  }
  // Packed to ext keeps what packed holds: ext's codes are finer
  const lost = closeSplats(packed, Splats.convert(packed, { layout: "extSplats" }), { center: 1e-6, ln: 0.01, rgb: 2 / 255, opacity: 1 / 128, degrees: 0.5 });
  if (lost) {
    return `packed to ext: ${lost}`;
  }
  const named = new ArrayData({ bundles: { scan: Splats.EXT }, count: 10 });
  const renamed = Splats.convert(named, { layout: "extSplats" });
  return renamed.bundles.extSplats.channels.extA.data === named.bundles.scan.channels.extA.data ? undefined : "renaming copied the arrays";
});

await check("sort keys: monotonic back to front, invalid last, every width", () => {
  const distances = [0, 1e-12, 1e-6, 0.001, 0.5, 1, 1.0001, 2, 100, 1e6, 1e12, 3e38];
  for (const bits of [16, 24, 32] as SortKeyBits[]) {
    const keys = distances.map((d) => SortKeys.compute(d, bits));
    for (let i = 1; i < keys.length; i += 1) {
      if (keys[i] > keys[i - 1]) {
        return `${bits} bits: key of ${distances[i]} above the key of ${distances[i - 1]}`;
      }
    }
    if (keys.some((key) => key >= SortKeys.validMax(bits) + 1) || [Infinity, NaN, -Infinity].some((d) => SortKeys.compute(d, bits) !== SortKeys.invalid(bits))) {
      return `${bits} bits: valid keys must stay below the invalid digit, non-finite give the mask`;
    }
  }
  return SortKeys.compute(1, 32) !== (0xffffffff ^ 0x3f800000) >>> 0 ? "32-bit key of 1" : undefined;
});

await check("sortKeys: stable, invalid last, the same order at every width", () => {
  const count = 20000;
  const distances = Array.from({ length: count }, (_, i) => (i % 97 === 0 ? Infinity : Math.round(random() * 1000) / 10));
  const expected = distances.map((d, i) => ({ d, i })).filter(({ d }) => Number.isFinite(d)).sort((a, b) => b.d - a.d || a.i - b.i).map(({ i }) => i);
  for (const bits of [16, 24, 32] as SortKeyBits[]) {
    const keys = new Uint32Array(distances.map((d) => SortKeys.compute(d, bits)));
    const { ordering, visible } = SortKeys.sort({ keys, count, bits });
    if (visible !== expected.length) {
      return `${bits} bits: ${visible} visible, expected ${expected.length}`;
    }
    const mismatch = compare(ordering.subarray(0, visible), expected);
    if (mismatch) {
      return `${bits} bits: ${mismatch}`;
    }
    if (!ordering.subarray(visible).every((i) => !Number.isFinite(distances[i]))) {
      return `${bits} bits: a valid splat after the invalid ones`;
    }
  }
  return ArrayData.INDICES.packing === 4 && ArrayData.INDICES.channels.index === "uint32" ? undefined : "ArrayData.INDICES";
});

// --- Spherical harmonics ---

// Coefficients like real scans' (|c| mostly below 0.5) with a few outliers
// up to +-5, and splats to carry them
function shValues(count: number, degree: ShDegree = 3) {
  return Array.from({ length: count }, (_, i) => Float32Array.from({ length: Sh.COEFFICIENTS[degree] * 3 }, () => (random() - 0.5) * (i % 211 === 0 ? 10 : 0.4 * random())));
}

function shSource(count: number, codec: ShCodecName = "ext", degree: ShDegree = 3) {
  const data = fileSource(count, false);
  Sh.add(data, codec, degree);
  const encode = Sh.encoder(data);
  const values = shValues(count, degree);
  values.forEach((c, i) => encode(i, c));
  return { data, values };
}

// RMS color error over all directions (orthonormal basis: sqrt(sum e^2 / 4pi)),
// in 8-bit steps, of `data`'s SH against `values`, and the largest |error|
function shError(data: ArrayData, values: Float32Array[], degree = 3) {
  const decode = Sh.decoder(data);
  const out = new Float32Array(Sh.VALUES);
  let sum = 0;
  let worst = 0;
  for (let i = 0; i < data.count; i += 1) {
    decode(i, out);
    for (let v = 0; v < Sh.COEFFICIENTS[degree] * 3; v += 1) {
      sum += (out[v] - values[i][v]) ** 2;
      worst = Math.max(worst, Math.abs(out[v] - values[i][v]));
    }
  }
  return { rms: Math.sqrt(sum / data.count / 3 / (4 * Math.PI)) * 255, worst };
}

await check("SH codecs: round trips within their budgets, a lower degree reads a prefix", () => {
  const { data, values } = shSource(4000, "ext", 4);
  const budgets: [ShCodecName, number][] = [["ext", 0.2], ["packed", 0.4]];
  for (const [codec, budget] of budgets) {
    for (const degree of [4, 3, 2, 1] as ShDegree[]) {
      const converted = Sh.convert(data, codec, { degree });
      const found = Sh.find(converted.bundles);
      if (found?.codec !== codec || found.degree !== degree || found.name !== `${codec}Sh`) {
        return `${codec} degree ${degree}: found ${found?.codec} ${found?.degree} in ${found?.name}`;
      }
      const { rms } = shError(converted, values, degree);
      if (rms > budget) {
        return `${codec} degree ${degree}: RMS ${rms.toFixed(3)} / 255`;
      }
    }
  }
  // Degree 4 words read at degree 1 to 3: the same values as a lower-degree encode
  for (const codec of ["ext", "packed"]) {
    const c = Sh.codec(codec);
    const words = new Uint32Array(24);
    const low = new Uint32Array(24);
    c.encode(values[5], 4, words, 0);
    for (const degree of [1, 2, 3] as ShDegree[]) {
      c.encode(values[5], degree, low, 0);
      const [a, b] = [c.decode(words, 0, degree, new Float32Array(Sh.VALUES)), c.decode(low, 0, degree, new Float32Array(Sh.VALUES))];
      if (packedDiffers(codec, a, b, degree)) {
        return `${codec}: degree ${degree} prefix of a degree-4 entry differs`;
      }
    }
  }
  return undefined;
});

// Packed scales are per band, so a prefix decodes the same as a lower-degree encode
function packedDiffers(codec: string, a: Float32Array, b: Float32Array, degree: ShDegree) {
  for (let v = 0; v < Sh.COEFFICIENTS[degree] * 3; v += 1) {
    if (a[v] !== b[v]) {
      return `${codec} value ${v}`;
    }
  }
  return undefined;
}

await check("SH channel names: the codec and the texel (A, B, ...); other names are not SH", () => {
  const names = (codec: ShCodecName, degree: ShDegree) => Object.keys(Sh.bundle(codec, degree).channels).join(",");
  const got = [names("ext", 1), names("ext", 2), names("ext", 3), names("ext", 4), names("packed", 1), names("packed", 2), names("packed", 3), names("packed", 4)];
  const want = [
    "extShA", "extShA,extShB", "extShA,extShB,extShC,extShD", "extShA,extShB,extShC,extShD,extShE,extShF",
    "packedShA", "packedShA,packedShB", "packedShA,packedShB,packedShC", "packedShA,packedShB,packedShC,packedShD,packedShE",
  ];
  if (got.join("|") !== want.join("|")) {
    return got.join(" | ");
  }
  for (const codec of ["ext", "packed"] as ShCodecName[]) {
    for (const degree of [1, 2, 3, 4] as ShDegree[]) {
      const found = Sh.find(new ArrayData({ count: 1 }).addBundle(`${codec}Sh`, Sh.bundle(codec, degree)).bundles);
      if (found?.codec !== codec || found.degree !== degree) {
        return `${codec} degree ${degree} found as ${found?.codec} ${found?.degree}`;
      }
    }
  }
  const partial = new ArrayData({ count: 1 }).addBundle("extSh", defineBundle({ extShA: "uint32x4", extShB: "uint32x4", extShC: "uint32x4", extShD: "uint32x4", extShE: "uint32x4" }));
  if (Sh.find(partial.bundles)) {
    return "ext A..E (no degree) found as SH";
  }
  const old = new ArrayData({ count: 1 }).addBundle("extSh", defineBundle({ extSh1: "uint32x4", extSh2: "uint32x4" }));
  return Sh.find(old.bundles) ? "old channel names found as SH" : undefined;
});

await check("SH palettes: power-of-two strides by default, entries side by side, convert and expand", () => {
  const values = shValues(64);
  for (const [codec, degree, stride] of [["ext", 4, 8], ["packed", 4, 8], ["ext", 3, 4], ["packed", 3, 4], ["packed", 2, 2], ["packed", 1, 1], ["ext", 1, 1]] as [ShCodecName, ShDegree, number][]) {
    const palette = ShPalette.create({ codec, degree, size: 64 });
    if (palette.stride !== stride || palette.data.count !== 64 * stride) {
      return `${codec} degree ${degree}: stride ${palette.stride}`;
    }
  }
  const palette = ShPalette.create({ codec: "packed", degree: 3, size: 64, stride: 3 });
  values.forEach((c, n) => palette.set(n, c));
  const words = palette.data.bundles.shPalette.channels.shEntries.data;
  const direct = new Uint32Array(12);
  Sh.codec("packed").encode(values[9], 3, direct, 0);
  if (compare(words.subarray(9 * 12, 10 * 12), direct)) {
    return "entry 9 is not at elements 27..29";
  }
  const ext = palette.convert("ext");
  const data = fileSource(100, false);
  const labels = Array.from({ length: 100 }, (_, i) => (i * 5) % 64);
  palette.expand(data, labels, "ext");
  const decode = Sh.decoder(data);
  for (let i = 0; i < 100; i += 1) {
    const a = decode(i, new Float32Array(Sh.VALUES));
    const b = ext.get(labels[i]);
    if (a.some((v, k) => Math.abs(v - b[k]) > 1e-6)) {
      return `expanded splat ${i}`;
    }
  }
  return undefined;
});

await check("SH through every writer and reader (PLY exact, the others within their formats)", async () => {
  const { data, values } = shSource(3000);
  const extError = shError(data, values);
  // [format, options, RMS budget, largest error budget]
  const cases: [SplatFormat, object, number, number][] = [
    ["ply", {}, extError.rms + 1e-9, extError.worst + 1e-9],
    ["rdx", {}, extError.rms + 1e-9, extError.worst + 1e-9],
    ["rad", { radSh: "f32" }, extError.rms + 1e-9, extError.worst + 1e-9],
    ["rad", { radSh: "f16" }, extError.rms + 0.05, extError.worst + 0.004],
    // s8 over the chunk's largest |value| (outliers of 5: steps of 5 / 127)
    ["rad", {}, 4, 0.05],
    ["compressed-ply", { sort: false }, 40, 1.1],
    ["spz", {}, 60, 4.1],
  ];
  for (const [format, options, rms, worst] of cases) {
    const bytes = await SplatFiles.encode(data, format, options);
    const { splats: back } = await SplatFiles.decode(bytes, { name: `x.${format}` });
    const found = Sh.find(back.bundles);
    if (found?.codec !== "ext" || found.degree !== 3) {
      return `${format}: ${found?.codec} degree ${found?.degree}`;
    }
    const error = shError(back, values);
    if (error.rms > rms || error.worst > worst) {
      return `${format} ${JSON.stringify(options)}: RMS ${error.rms.toFixed(3)}, largest ${error.worst.toFixed(4)}`;
    }
    const { splats: off } = await SplatFiles.decode(bytes, { name: `x.${format}`, sh: false });
    if (Sh.find(off.bundles) || off.meta.ignoredShDegree !== 3) {
      return `${format}: sh false kept SH (ignoredShDegree ${String(off.meta.ignoredShDegree)})`;
    }
  }
  return undefined;
});

await check("SH degree 4: PLY (72 f_rest), SPZ and RDX keep it, compressed PLY and RAD write its first 3 bands, palettes too", async () => {
  const { data, values } = shSource(3000, "ext", 4);
  const extError = shError(data, values, 4);
  // [format, options, degree read back, RMS budget, largest error budget]
  const cases: [SplatFormat, object, ShDegree, number, number][] = [
    ["ply", {}, 4, extError.rms + 1e-9, extError.worst + 1e-9],
    ["rdx", {}, 4, extError.rms + 1e-9, extError.worst + 1e-9],
    ["spz", {}, 4, 60, 4.1],
    ["rad", { radSh: "f32" }, 3, extError.rms + 1e-9, extError.worst + 1e-9],
    ["compressed-ply", { sort: false }, 3, 40, 1.1],
  ];
  for (const [format, options, degree, rms, worst] of cases) {
    const bytes = await SplatFiles.encode(data, format, options);
    if (format === "ply" && !new TextDecoder().decode(bytes.subarray(0, 4096)).includes("property float f_rest_71\n")) {
      return "PLY header lacks f_rest_71";
    }
    const { splats: back } = await SplatFiles.decode(bytes, { name: `x.${format}` });
    const found = Sh.find(back.bundles);
    if (found?.codec !== "ext" || found.degree !== degree) {
      return `${format}: ${found?.codec} degree ${found?.degree}, expected ${degree}`;
    }
    const error = shError(back, values, degree);
    if (error.rms > rms || error.worst > worst) {
      return `${format} ${JSON.stringify(options)}: RMS ${error.rms.toFixed(3)}, largest ${error.worst.toFixed(4)}`;
    }
    const { splats: off } = await SplatFiles.decode(bytes, { name: `x.${format}`, sh: false });
    if (off.meta.ignoredShDegree !== degree) {
      return `${format}: ignoredShDegree ${String(off.meta.ignoredShDegree)}`;
    }
  }
  const palette = ShPalette.create({ codec: "packed", degree: 4, size: 300 });
  const entries = shValues(300, 4);
  entries.forEach((c, n) => palette.set(n, c));
  if (paletteError(palette, entries) > 0.05 || paletteError(palette.convert("ext"), entries) > 0.06) {
    return `degree-4 palette: largest error ${paletteError(palette, entries)}`;
  }
  const labeled = fileSource(300, false) as ArrayData;
  labeled.addBundle("shLabel", Sh.LABEL);
  labeled.bundles.shLabel.channels.label.data.set(Array.from({ length: 300 }, (_, i) => (i * 7) % 300));
  const { splats: rad, shPalette: radPalette } = await RadFile.read(await RadFile.write(labeled, { shPalette: palette, radSh: "f32" }));
  if (!radPalette || radPalette.degree !== 3 || !(rad as ArrayData).bundles.shLabel || paletteError(radPalette, entries, 3) > 0.06) {
    return `RAD clustered degree 4: palette degree ${radPalette?.degree}`;
  }
  return undefined;
});

await check("SH loading: default ext, a codec asked for, RDX keeps its codec unless asked", async () => {
  const { data } = shSource(500, "packed");
  const ply = await SplatFiles.encode(data, "ply");
  const rdx = await SplatFiles.encode(data, "rdx");
  const name = ({ splats }: { splats: ArrayData }) => Sh.find(splats.bundles)?.codec;
  const got = [
    name(await SplatFiles.decode(ply, { name: "a.ply" })),
    name(await SplatFiles.decode(ply, { name: "a.ply", sh: "packed" })),
    name(await SplatFiles.decode(rdx, { name: "a.rdx" })),
    name(await SplatFiles.decode(rdx, { name: "a.rdx", sh: "ext" })),
    name(await SplatFiles.decode(rdx, { name: "a.rdx", layout: "packedSplats" })),
  ];
  return compare(got.map((g) => ["ext", "packed"].indexOf(g ?? "")), [0, 1, 1, 0, 1]) && `codecs ${got.join(", ")}`;
});

const labelsOf = (data: ArrayData) => data.bundles.shLabel?.channels.label.data.subarray(0, data.count);

// Largest difference of palette entries from `values` (coefficient-major,
// through `degree`)
function paletteError(palette: ShPalette, values: Float32Array[], degree: ShDegree = palette.degree) {
  const out = new Float32Array(Sh.VALUES);
  let worst = 0;
  for (let n = 0; n < values.length; n += 1) {
    palette.get(n, out);
    for (let v = 0; v < Sh.COEFFICIENTS[degree] * 3; v += 1) {
      worst = Math.max(worst, Math.abs(out[v] - values[n][v]));
    }
  }
  return worst;
}

await check("RAD clustered SH: palettes written and read back; the other writers expand them", async () => {
  const values = shValues(300);
  const palette = ShPalette.create({ codec: "ext", degree: 3, size: 300 });
  values.forEach((c, n) => palette.set(n, c));
  const exact = Array.from({ length: 300 }, (_, n) => palette.get(n));
  const data = fileSource(5000, false);
  const labels = data.addBundle("shLabel", Sh.LABEL).bundles.shLabel.channels.label.data.subarray(0, data.count);
  labels.forEach((_, i, a) => (a[i] = (i * 7) % 300));
  // [radSh, largest error against the written entries]: f32 re-encodes
  // ext values exactly; f16 and s8 (over the palette's largest |value|,
  // outliers of 5) add their steps, then ext's (2^3 / 255 at 5)
  for (const [radSh, budget] of [["f32", 0], ["f16", 0.004 + 0.016], ["s8", 5 / 254 + 0.016]] as const) {
    const bytes = await SplatFiles.encode(data, "rad", { shPalette: palette, radSh, chunkSize: 2000 });
    const back = await SplatFiles.decode(bytes);
    const p = back.shPalette;
    if (!p || p.codec !== "ext" || p.degree !== 3 || p.size !== 300 || Sh.find(back.splats.bundles)) {
      return `${radSh}: palette ${p?.codec} ${p?.degree} ${p?.size}, per-splat ${Sh.find(back.splats.bundles)?.name}`;
    }
    const mismatch = compare(labelsOf(back.splats) ?? [], labels);
    if (mismatch) {
      return `${radSh} labels: ${mismatch}`;
    }
    const error = paletteError(p, exact);
    if (error > budget + 1e-6) {
      return `${radSh}: largest error ${error.toFixed(4)}`;
    }
  }
  const bytes = await SplatFiles.encode(data, "rad", { shPalette: palette, radSh: "f32" });
  const packed = await SplatFiles.decode(bytes, { sh: "packed" });
  const off = await SplatFiles.decode(bytes, { sh: false });
  if (packed.shPalette?.codec !== "packed" || off.shPalette || labelsOf(off.splats) || off.splats.meta.ignoredShDegree !== 3) {
    return `sh "packed": ${packed.shPalette?.codec}; sh false: ${off.shPalette ? "a palette" : "none"}, ignoredShDegree ${String(off.splats.meta.ignoredShDegree)}`;
  }
  // PLY and RDX: per-splat SH, each splat its entry
  for (const format of ["ply", "rdx"] as SplatFormat[]) {
    const { splats, shPalette } = await SplatFiles.decode(await SplatFiles.encode(data, format, { shPalette: palette }), { name: `x.${format}` });
    if (shPalette || labelsOf(splats) || !Sh.find(splats.bundles)) {
      return `${format}: not expanded`;
    }
    const decode = Sh.decoder(splats);
    for (let i = 0; i < splats.count; i += 1) {
      const m = compare(decode(i, new Float32Array(Sh.VALUES)), exact[labels[i]]);
      if (m) {
        return `${format} splat ${i}: ${m}`;
      }
    }
  }
  return undefined;
});

// A RAD file built by hand, uncompressed columns: Spark's build-lod layout
// of clustered SH, which the writer's own output above does not cover
function handRad(header: Record<string, unknown>, chunks: { base: number; count: number; columns: [string, string, Uint8Array, { min?: number; max?: number }?][] }[]) {
  const encoder = new TextEncoder();
  const pad8 = (n: number) => (n + 7) & ~7;
  const parts = chunks.map(({ base, count, columns }) => {
    let payloadBytes = 0;
    const properties = columns.map(([property, encoding, bytes, range]) => {
      const p = { offset: payloadBytes, bytes: bytes.byteLength, property, encoding, ...range };
      payloadBytes += pad8(bytes.byteLength);
      return p;
    });
    const meta = encoder.encode(JSON.stringify({ version: 1, base, count, payloadBytes, properties }));
    const out = new Uint8Array(8 + pad8(meta.byteLength) + 8 + payloadBytes);
    const view = new DataView(out.buffer);
    view.setUint32(0, 0x43444152, true);
    view.setUint32(4, meta.byteLength, true);
    out.set(meta, 8);
    const at = 8 + pad8(meta.byteLength);
    view.setUint32(at, payloadBytes, true);
    columns.forEach(([, , bytes], c) => out.set(bytes, at + 8 + properties[c].offset));
    return out;
  });
  let offset = 0;
  const ranges = parts.map((part) => {
    const range = { offset, bytes: part.byteLength };
    offset += part.byteLength;
    return range;
  });
  const head = encoder.encode(JSON.stringify({ version: 1, type: "gsplat", ...header, chunks: ranges }));
  const file = new Uint8Array(8 + pad8(head.byteLength) + offset);
  const view = new DataView(file.buffer);
  view.setUint32(0, 0x30444152, true);
  view.setUint32(4, head.byteLength, true);
  file.set(head, 8);
  let at = 8 + pad8(head.byteLength);
  for (const part of parts) {
    file.set(part, at);
    at += part.byteLength;
  }
  return file;
}

// A chunk's splat columns (f32, dimension-planar): centers along x
function handSplats(base: number, count: number): [string, string, Uint8Array][] {
  const column = (dims: number, value: (i: number, d: number) => number) => {
    const values = new Float32Array(dims * count);
    for (let d = 0; d < dims; d += 1) {
      for (let i = 0; i < count; i += 1) {
        values[d * count + i] = value(i, d);
      }
    }
    return new Uint8Array(values.buffer);
  };
  return [
    ["center", "f32", column(3, (i, d) => (d === 0 ? base + i : 0))], ["alpha", "f32", column(1, () => 1)], ["rgb", "f32", column(3, () => 0.5)],
    ["scales", "f32", column(3, () => 0.01)], ["orientation", "f32", column(3, () => 0)],
  ];
}

// Codes of `values` (entries x 45, coefficient-major) as band columns
// sh1_code .. sh<degree>_code, dimension-planar: s8 over each band's
// largest |value| (and the values they decode to), or f32
function handCodes(values: Float32Array[], degree: ShDegree, encoding: "s8" | "f32") {
  const n = values.length;
  const decoded = values.map(() => new Float32Array(45));
  const columns: [string, string, Uint8Array, { min?: number; max?: number }?][] = [];
  let first = 0;
  for (const [band, dims] of ([[1, 9], [2, 15], [3, 21]] as const).slice(0, degree)) {
    let max = 0;
    values.forEach((c) => c.subarray(first, first + dims).forEach((v) => (max = Math.max(max, Math.abs(v)))));
    const out = encoding === "s8" ? new Uint8Array(dims * n) : new Float32Array(dims * n);
    for (let d = 0; d < dims; d += 1) {
      for (let e = 0; e < n; e += 1) {
        const v = values[e][first + d];
        const code = Math.max(-127, Math.min(127, Math.round((v / max) * 127)));
        out[d * n + e] = encoding === "s8" ? code & 0xff : v;
        decoded[e][first + d] = encoding === "s8" ? (code / 127) * max : v;
      }
    }
    columns.push([`sh${band}_code`, encoding, new Uint8Array(out.buffer), encoding === "s8" ? { min: -max, max } : undefined]);
    first += dims;
  }
  return { columns, decoded };
}

await check("RAD clustered SH from a hand-built file: codes in chunk 0, u16 and u32 labels, past 65,536 entries per splat", async () => {
  // 500 entries at degree 3; two chunks, labels u16 then u32
  const values = shValues(500);
  const { columns, decoded } = handCodes(values, 3, "s8");
  const labels = Uint32Array.from({ length: 1500 }, (_, i) => (i * 13) % 500);
  const file = handRad({ count: 1500, maxSh: 3, shCodeCount: 500 }, [
    { base: 0, count: 1000, columns: [...handSplats(0, 1000), ...columns, ["sh_label", "u16", new Uint8Array(Uint16Array.from(labels.subarray(0, 1000)).buffer)]] },
    { base: 1000, count: 500, columns: [...handSplats(1000, 500), ["sh_label", "u32", new Uint8Array(labels.slice(1000).buffer)]] },
  ]);
  const { splats, shPalette } = await RadFile.read(file);
  if (!shPalette || shPalette.size !== 500 || shPalette.degree !== 3 || shPalette.codec !== "ext") {
    return `palette ${shPalette?.size} ${shPalette?.degree} ${shPalette?.codec}`;
  }
  const mismatch = compare(labelsOf(splats) ?? [], labels);
  if (mismatch) {
    return `labels: ${mismatch}`;
  }
  // The codes' values in ext: the same words as ext of the decoded codes
  const expected = ShPalette.create({ codec: "ext", degree: 3, size: 500 });
  decoded.forEach((c, n) => expected.set(n, c));
  const words = compare(shPalette.data.bundles.shPalette.channels.shEntries.data, expected.data.bundles.shPalette.channels.shEntries.data);
  if (words) {
    return `entries: ${words}`;
  }
  // Within s8 and ext steps of the source coefficients
  const error = paletteError(shPalette, values);
  if (error > 5 / 254 + 0.016) {
    return `largest error against the source ${error.toFixed(4)}`;
  }

  // 70,000 entries at degree 1: labels past uint16, expanded into extSh
  const many = Array.from({ length: 70000 }, (_, n) => Float32Array.from({ length: 45 }, (_, v) => (v < 9 ? Math.sin(n * 0.37 + v) : 0)));
  const big = handCodes(many, 1, "f32");
  const pick = Uint32Array.from([69999, 0, 65536, 12345, 65535]);
  const bigFile = handRad({ count: pick.length, maxSh: 1, shCodeCount: 70000 }, [
    { base: 0, count: pick.length, columns: [...handSplats(0, pick.length), ...big.columns, ["sh_label", "u32", new Uint8Array(pick.buffer)]] },
  ]);
  const expanded = await RadFile.read(bigFile);
  const found = Sh.find(expanded.splats.bundles);
  if (expanded.shPalette || labelsOf(expanded.splats) || found?.codec !== "ext" || found.degree !== 1) {
    return `past 65,536: palette ${expanded.shPalette ? "kept" : "none"}, per-splat ${found?.codec} ${found?.degree}`;
  }
  const decode = Sh.decoder(expanded.splats);
  const ext = Sh.codec("ext");
  const words16 = new Uint32Array(16);
  for (let i = 0; i < pick.length; i += 1) {
    ext.encode(many[pick[i]], 1, words16, 0);
    const m = compare(decode(i, new Float32Array(Sh.VALUES)).subarray(0, 9), ext.decode(words16, 0, 1, new Float32Array(Sh.VALUES)).subarray(0, 9));
    if (m) {
      return `expanded splat ${i}: ${m}`;
    }
  }
  return undefined;
});

await check("SH evaluate: the 3DGS basis (band 1 along the axes)", () => {
  const c = new Float32Array(Sh.VALUES);
  c[0] = 1;
  c[4] = 2;
  c[8] = 3;
  const [ry] = [Sh.evaluate(c, { x: 0, y: 1, z: 0 }, 1)];
  const [, gz] = [0, Sh.evaluate(c, { x: 0, y: 0, z: 1 }, 1)];
  const bx = Sh.evaluate(c, { x: 1, y: 0, z: 0 }, 1);
  const k = 0.4886025;
  return Math.abs(ry[0] + k) < 1e-9 && Math.abs(gz[1] - 2 * k) < 1e-9 && Math.abs(bx[2] + 3 * k) < 1e-9 ? undefined : `${ry} ${gz} ${bx}`;
});

// Real SH Y_l^m from associated Legendre polynomials (Condon-Shortley
// phase), m = -l .. l in coefficient order: the 3DGS basis
function realSh(l: number, m: number, dir: Vec3) {
  const am = Math.abs(m);
  const x = dir.z;
  let pmm = 1;
  for (let i = 1; i <= am; i += 1) {
    pmm *= -(2 * i - 1) * Math.sqrt(1 - x * x);
  }
  let p = pmm;
  if (l > am) {
    let low = pmm;
    p = x * (2 * am + 1) * pmm;
    for (let n = am + 2; n <= l; n += 1) {
      [low, p] = [p, ((2 * n - 1) * x * p - (n + am - 1) * low) / (n - am)];
    }
  }
  let ratio = 1;
  for (let i = l - am + 1; i <= l + am; i += 1) {
    ratio /= i;
  }
  const k = Math.sqrt(((2 * l + 1) / (4 * Math.PI)) * ratio);
  const phi = Math.atan2(dir.y, dir.x);
  return m === 0 ? k * p : m > 0 ? Math.SQRT2 * k * Math.cos(m * phi) * p : Math.SQRT2 * k * Math.sin(am * phi) * p;
}

await check("SH evaluate: bands 1-4 match real SH from associated Legendre polynomials", () => {
  const c = new Float32Array(Sh.VALUES);
  let worst = 0;
  for (let n = 0; n < 200; n += 1) {
    const dir = randomUnit();
    for (let l = 1; l <= 4; l += 1) {
      for (let m = -l; m <= l; m += 1) {
        const k = l * l - 1 + m + l;
        c.fill(0);
        c[k * 3 + 1] = 1;
        worst = Math.max(worst, Math.abs(Sh.evaluate(c, dir, 4)[1] - realSh(l, m, dir)));
        if (Sh.evaluate(c, dir, l - 1)[1] !== 0) {
          return `band ${l} drawn at degree ${l - 1}`;
        }
      }
    }
  }
  return worst < 2e-6 ? undefined : `largest difference ${worst}`;
});

await check("Axes: all 16 x 16 systems: round trips, SH seen from the converted direction, quaternion and scales against M S M^T", () => {
  const cov = (scales: Vec3, q: Quat) => SplatMath.covFromScaleQuat(scales, q, { xx: 0, yy: 0, zz: 0, xy: 0, xz: 0, yz: 0 });
  for (const from of Axes.SYSTEMS) {
    for (const to of Axes.SYSTEMS) {
      const [c, back] = [Axes.converter(from, to), Axes.converter(to, from)];
      for (let t = 0; t < 4; t += 1) {
        const values = Float32Array.from({ length: Sh.VALUES }, () => random() - 0.5);
        const converted = c.sh(Float32Array.from(values), 4);
        const dir = randomUnit();
        const [seen, seenAfter] = [Sh.evaluate(values, dir, 4), Sh.evaluate(converted, c.vec({ ...dir }), 4)];
        const roundTrip = back.sh(Float32Array.from(converted), 4);
        const q = randomQuat();
        const scales = { x: 0.5 + random(), y: 1 + random(), z: 2 + random() };
        const [expected, actual] = [c.cov(cov(scales, q)), cov(c.scales({ ...scales }), c.quat({ ...q }))];
        const covError = Math.max(...(["xx", "yy", "zz", "xy", "xz", "yz"] as const).map((k) => Math.abs(expected[k] - actual[k])));
        const shError = Math.max(...seen.map((v, k) => Math.abs(v - seenAfter[k])), ...roundTrip.map((v, k) => Math.abs(v - values[k])));
        if (shError > 1e-6 || covError > 1e-9) {
          return `${from} -> ${to}: SH ${shError}, covariance ${covError}`;
        }
      }
    }
  }
  // Flips change signs only: coefficients copy exactly
  const flipped = Axes.converter("RUB", "RDF").sh(Float32Array.from({ length: Sh.VALUES }, (_, v) => v + 1), 4);
  return flipped.every((v, k) => Math.abs(v) === k + 1) ? undefined : "RUB -> RDF changed magnitudes";
});

await check("Axes.convert on ext, cov and packed tables (per-splat SH, a palette) agrees with converting splats one at a time", () => {
  for (const layout of ["extSplats", "covSplats", "packedSplats"] as const) {
    const source = fileSource(200, false);
    Sh.add(source, "ext", 3);
    const encode = Sh.encoder(source);
    shValues(200, 3).forEach((c, i) => encode(i, c));
    const data = Splats.convert(source, { layout });
    data.meta.coordinateSystem = "RUB";
    const before = data.clone();
    const palette = ShPalette.create({ codec: "packed", degree: 2, size: 8 });
    shValues(8, 2).forEach((c, n) => palette.set(n, c));
    const entries = Array.from({ length: 8 }, (_, n) => palette.get(n));
    Axes.convert(data, "RFU", { shPalette: palette });
    const c = Axes.converter("RUB", "RFU");
    const [bundle, beforeBundle] = [Splats.get(data).bundle, Splats.get(before).bundle];
    // One splat at a time into a copy, word for word against the table's
    const one = before.clone();
    const oneBundle = Splats.get(one).bundle;
    const [decodeOne, encodeOne] = [Splats.decoder(beforeBundle), Splats.encoder(oneBundle)];
    const [shAfter, shBefore] = [Sh.decoder(data), Sh.decoder(before)];
    const [a, b, coeffs] = [new Float32Array(Sh.VALUES), new Float32Array(Sh.VALUES), new Float32Array(Sh.VALUES)];
    for (let i = 0; i < data.count; i += 1) {
      if (Splats.isCov(bundle)) {
        const [x, y] = [Splats.decodeCov(bundle, i, Splats.makeCovSplat()), Splats.decodeCov(beforeBundle as typeof bundle, i, Splats.makeCovSplat())];
        c.vec(y.center);
        c.cov(y.cov);
        if (JSON.stringify(x.center) !== JSON.stringify(y.center) || Math.abs(x.cov.xy - y.cov.xy) > 1e-3 * Math.max(x.cov.xx, x.cov.yy, x.cov.zz)) {
          return `${layout} ${i}: ${JSON.stringify(x)} vs ${JSON.stringify(y)}`;
        }
      } else {
        encodeOne(i, c.splat(decodeOne(i, Splats.makeExtSplat())));
        const [channels, oneChannels] = [bundle.channels as Record<string, { data: Uint32Array }>, oneBundle.channels as Record<string, { data: Uint32Array }>];
        for (const label of Object.keys(channels)) {
          const error = compare(channels[label].data.subarray(i * 4, i * 4 + 4), oneChannels[label].data.subarray(i * 4, i * 4 + 4));
          if (error) {
            return `${layout} ${i} ${label}: ${error}`;
          }
        }
      }
      shAfter(i, a);
      const expected = c.sh(shBefore(i, b), 3);
      // ext's shared exponent: within 2^-8 of each coefficient's largest channel
      const largest = (k: number) => Math.max(...[0, 1, 2].map((ch) => Math.abs(expected[Math.floor(k / 3) * 3 + ch])));
      const bad = a.findIndex((v, k) => k < 45 && Math.abs(v - expected[k]) > 2 ** -8 * largest(k) + 2 ** -14);
      if (bad >= 0) {
        return `${layout} ${i}: SH value ${bad}: ${a[bad]} vs ${expected[bad]}`;
      }
    }
    for (let n = 0; n < 8; n += 1) {
      const expected = c.sh(entries[n], 2);
      palette.get(n, coeffs);
      // packed: sint8 codes over each band's scale (rounded up a 16th of an octave)
      const largest = Math.max(...expected.slice(0, 24).map(Math.abs));
      if (coeffs.slice(0, 24).some((v, k) => Math.abs(v - expected[k]) > largest / 100 + 1e-4)) {
        return `${layout}: palette entry ${n}`;
      }
    }
    if (data.meta.coordinateSystem !== "RFU") {
      return `${layout}: meta ${String(data.meta.coordinateSystem)}`;
    }
  }
  return undefined;
});

if (failures.length > 0) {
  throw new Error(`${failures.length} check(s) failed: ${failures.join(", ")}`);
}
console.log("all checks passed");
