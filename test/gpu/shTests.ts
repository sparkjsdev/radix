import * as THREE from "three";
import type { WebGPURenderer } from "three/webgpu";
import {
  ArrayData, GpuArrays, GpuArrayWriter, GpuEncoding, GpuSh, GpuShPalette, GpuShReader, Sh, ShPalette, SplatCollection, SplatGenerator, Splats, TSL, defineBundle,
  loadSplatFile, loadSplats, writeSplats,
  type AnySplatObject, type ExtSplat, type ShCodecName, type ShDegree, type StoredSplats, type TslNode,
} from "@sparkjsdev/radix";
import { drawWith, makeCamera, makeSplats, meanAbsDiff, randomSplats, rng, splatData, type Check } from "./renderUtils";

const { exp2, float, floatBitsToUint, int, normalize, select, sin, cos, uint, uvec4, vec3, vec4 } = TSL;

const COUNT = 1500;

function coefficients(count: number, seed: number) {
  const random = rng(seed);
  return Array.from({ length: count }, (_, i) => Float32Array.from({ length: Sh.VALUES }, () => (random() - 0.5) * (i % 97 === 0 ? 6 : 0.5)));
}

// Splat i's direction, the same on the CPU and the GPU
const dirOf = (i: number) => new THREE.Vector3(Math.sin(i), Math.cos(i * 1.3), Math.sin(i * 0.7) + 0.2).normalize();
const dirNode = (index: TslNode) => {
  const i = float(index);
  return normalize(vec3(sin(i), cos(i.mul(1.3)), sin(i.mul(0.7)).add(0.2)));
};

const OUT = defineBundle({ rgb: "float32x4" });

// color() is given the origin and the direction as the center, so looks along it
async function gpuColors(renderer: WebGPURenderer, reader: GpuShReader, degree: number, count: number, path: "band" | "color" = "band") {
  GpuSh.maxDegree.value = Sh.MAX_DEGREE;
  const out = new GpuArrays({ renderer, bundles: { out: OUT }, capacity: count });
  const writer = new GpuArrayWriter({
    outputs: { out: OUT },
    write: (index, o) => {
      const color = path === "color"
        ? reader.color(index, vec3(0, 0, 0), dirNode(index))
        : GpuSh.evaluate(dirNode(index), degree, (band) => reader.band(index, band));
      o.out.rgb.assign(vec4(color, 0));
    },
  });
  try {
    out.write(writer, { count });
    return (await out.read()).bundles.out.channels.rgb.data as Float32Array;
  } finally {
    writer.dispose();
    out.dispose();
  }
}

function compareColors(gpu: Float32Array, count: number, degree: number, decode: (i: number, out: Float32Array) => ArrayLike<number>) {
  const coeffs = new Float32Array(Sh.VALUES);
  const cpu = [0, 0, 0];
  let worst = 0;
  for (let i = 0; i < count; i += 1) {
    Sh.evaluate(decode(i, coeffs), dirOf(i), degree, cpu);
    for (let c = 0; c < 3; c += 1) {
      worst = Math.max(worst, Math.abs(gpu[i * 4 + c] - cpu[c]) / (1 + Math.abs(cpu[c])));
    }
  }
  return worst;
}

function shData(splats: ExtSplat[], codec: ShCodecName, values: Float32Array[], degree: ShDegree = 3) {
  const data = splatData(splats);
  Sh.add(data, codec, degree);
  const encode = Sh.encoder(data);
  values.forEach((c, i) => encode(i, c));
  return data;
}

// The SH color seen from eye, in world space, baked into rgb
function baked(data: ArrayData, matrix: THREE.Matrix4, eye: THREE.Vector3, degree = 3, palette?: { palette: ShPalette; labels: ArrayLike<number> }) {
  const out = splatData(Array.from({ length: data.count }, () => Splats.makeExtSplat()));
  const decode = Splats.decoder(Splats.get(data).bundle);
  const encode = Splats.encoder(Splats.get(out).bundle);
  const decodeSh = palette ? (i: number, c: Float32Array) => palette.palette.get(palette.labels[i], c) : Sh.decoder(data);
  const origin = eye.clone().applyMatrix4(matrix.clone().invert());
  const s = Splats.makeExtSplat();
  const coeffs = new Float32Array(Sh.VALUES);
  const color = [0, 0, 0];
  const dir = new THREE.Vector3();
  for (let i = 0; i < data.count; i += 1) {
    decode(i, s);
    dir.set(s.center.x, s.center.y, s.center.z).sub(origin).normalize();
    Sh.evaluate(decodeSh(i, coeffs), dir, degree, color);
    s.rgb.r = Math.max(0, s.rgb.r + color[0]);
    s.rgb.g = Math.max(0, s.rgb.g + color[1]);
    s.rgb.b = Math.max(0, s.rgb.b + color[2]);
    encode(i, s);
  }
  return out;
}

const turned = (angle: number, scale: number, x: number) => new THREE.Matrix4().compose(
  new THREE.Vector3(x, 0.1, -0.5), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0.3, 1, 0.2).normalize(), angle), new THREE.Vector3(scale, scale, scale));

async function drawObjects(renderer: WebGPURenderer, objects: AnySplatObject[], camera: THREE.PerspectiveCamera, objectParams = {}) {
  const splats = makeSplats(renderer, { collection: new SplatCollection(objects), objectParams });
  try {
    return await drawWith(renderer, splats, camera);
  } finally {
    splats.dispose();
  }
}

export async function runShTests(renderer: WebGPURenderer, check: Check) {
  const values = coefficients(COUNT, 7);
  const splats = randomSplats(COUNT, 11);

  for (const codec of ["ext", "packed"] as const) {
    for (const degree of [4, 3, 2, 1] as ShDegree[]) {
      await check(`SH: ${codec} per splat at degree ${degree} (of a degree-4 bundle) decodes as on the CPU`, async () => {
        const data = shData(splats, codec, values, 4);
        const arrays = GpuArrays.fromData(renderer, data);
        const reader = new GpuShReader({ codec, degree }).bind(arrays);
        try {
          for (const path of ["band", "color"] as const) {
            const worst = compareColors(await gpuColors(renderer, reader, degree, COUNT, path), COUNT, degree, Sh.decoder(data));
            if (worst >= 1e-3) {
              return `${path}(): relative difference ${worst}`;
            }
          }
          return undefined;
        } finally {
          arrays.dispose();
        }
      });
    }

    await check(`SH: ${codec} palette (degree 3 at strides 4 and ${codec === "ext" ? 4 : 3}, degree 4 at 8 and ${codec === "ext" ? 6 : 5}) decodes as on the CPU`, async () => {
      const size = 300;
      const cases: [ShDegree, number | undefined][] = [[3, undefined], [3, codec === "ext" ? 4 : 3], [4, undefined], [4, codec === "ext" ? 6 : 5]];
      for (const [degree, stride] of cases) {
        const palette = ShPalette.create({ codec, degree, size, stride });
        values.slice(0, size).forEach((c, n) => palette.set(n, c));
        const data = splatData(splats);
        const labels = data.addBundle("shLabel", Sh.LABEL).bundles.shLabel.channels.label.data;
        for (let i = 0; i < COUNT; i += 1) {
          labels[i] = (i * 7) % size;
        }
        const arrays = GpuArrays.fromData(renderer, data);
        const entries = GpuShPalette.upload(renderer, palette);
        const reader = new GpuShReader({ codec, degree, palette: true }).bind(arrays, entries);
        try {
          for (const path of ["band", "color"] as const) {
            const worst = compareColors(await gpuColors(renderer, reader, degree, COUNT, path), COUNT, degree, (i, out) => palette.get(labels[i], out));
            if (worst >= 1e-3) {
              return `degree ${degree}, stride ${palette.stride}, ${path}(): relative difference ${worst}`;
            }
          }
        } finally {
          arrays.dispose();
          entries.dispose();
        }
      }
      return undefined;
    });

    await check(`SH: a degree-4 ${codec} reader bound to degree 3, 2 and 1 data reads what they have`, async () => {
      for (const degree of [3, 2, 1] as ShDegree[]) {
        const data = splatData(splats);
        Sh.add(data, codec, degree);
        const encode = Sh.encoder(data);
        values.forEach((c, i) => encode(i, c));
        const arrays = GpuArrays.fromData(renderer, data);
        const reader = new GpuShReader({ codec, degree: 4 }).bind(arrays);
        try {
          const worst = compareColors(await gpuColors(renderer, reader, 4, COUNT, "color"), COUNT, degree, Sh.decoder(data));
          if (worst >= 1e-3) {
            return `degree ${degree}: relative difference ${worst}`;
          }
        } finally {
          arrays.dispose();
        }
      }
      return undefined;
    });
  }

  await check("SH: ext / packed decoders equal their earlier formulas bit for bit", async () => {
    const BITS = defineBundle({ v: "uint32x4" });
    const outputs = { ext: BITS, packed: BITS };
    const count = 65536;
    const out = new GpuArrays({ renderer, bundles: outputs, capacity: count });
    const bits = (v: TslNode) => floatBitsToUint(v);
    const differs = (a: TslNode, b: TslNode) => select(bits(a).equal(bits(b)), uint(0), uint(1));
    // Byte 0 lowest
    const wordOf = (b: TslNode[]) => b[0].bitOr(b[1].shiftLeft(uint(8))).bitOr(b[2].shiftLeft(uint(16))).bitOr(b[3].shiftLeft(uint(24)));
    const writer = new GpuArrayWriter({
      outputs,
      write: (index, o) => {
        // ext: every exponent, sign set and byte value
        const byte = index.bitAnd(uint(255)).toVar();
        const word = byte.bitOr(byte.bitXor(uint(0x5a)).shiftLeft(uint(8))).bitOr(uint(255).sub(byte).shiftLeft(uint(16)))
          .bitOr(index.shiftRight(uint(8)).bitAnd(uint(7)).bitOr(index.shiftRight(uint(11)).bitAnd(uint(31)).shiftLeft(uint(3))).shiftLeft(uint(24))).toVar();
        const fresh = GpuEncoding.decodeExtRgb(word).toVar();
        const unit = exp2(float(int(word.shiftRight(uint(27)).bitAnd(uint(0x1f))).sub(int(15)))).div(255.0).toVar();
        const channel = (shift: number, signBit: number) => {
          const value = float(word.shiftRight(uint(shift)).bitAnd(uint(0xff))).mul(unit);
          return select(word.bitAnd(uint(signBit)).notEqual(uint(0)), value.negate(), value);
        };
        const earlier = vec3(channel(0, 0x1000000), channel(8, 0x2000000), channel(16, 0x4000000)).toVar();
        o.ext.v.assign(uvec4(differs(fresh.x, earlier.x).add(differs(fresh.y, earlier.y)).add(differs(fresh.z, earlier.z)), bits(fresh.x), bits(earlier.x), word));

        // packed band 1: every scale code with values in every byte lane
        const code = index.shiftRight(uint(8)).toVar();
        const v = (k: number) => byte.add(uint(k * 37)).bitAnd(uint(255));
        const texel = uvec4(wordOf([code, v(0), v(1), v(2)]), wordOf([v(3), v(4), v(5), v(6)]), wordOf([v(7), v(8), uint(0), uint(0)]), uint(0)).toVar();
        const decoded = GpuSh.codec("packed").decodeBand(1, () => texel);
        const scale = select(code.equal(uint(0)), float(0), exp2(float(code).sub(192).div(16))).div(127).toVar();
        let mismatches: TslNode = uint(0);
        for (let k = 0; k < 9; k += 1) {
          const f = float(v(k));
          const previous = select(f.greaterThanEqual(128), f.sub(256), f).mul(scale);
          mismatches = mismatches.add(differs(decoded[Math.floor(k / 3)][["x", "y", "z"][k % 3]], previous));
        }
        o.packed.v.assign(uvec4(mismatches, bits(decoded[0].x), code, byte));
      },
    });
    try {
      out.write(writer, { count });
      const read = (await out.read()).bundles;
      const ext = read.ext.channels.v.data as Uint32Array;
      const packed = read.packed.channels.v.data as Uint32Array;
      for (let i = 0; i < count; i += 1) {
        if (ext[i * 4] !== 0) {
          return `ext word ${ext[i * 4 + 3].toString(16)}: ${ext[i * 4]} channels differ (${ext[i * 4 + 1].toString(16)} vs ${ext[i * 4 + 2].toString(16)})`;
        }
        if (packed[i * 4] !== 0) {
          return `packed scale code ${packed[i * 4 + 2]}, byte ${packed[i * 4 + 3]}: ${packed[i * 4]} values differ`;
        }
      }
      return undefined;
    } finally {
      writer.dispose();
      out.dispose();
    }
  });

  const camera = makeCamera(renderer, [0.2, 0.3, 1]);
  const eye = camera.position.clone();
  const a = new THREE.Matrix4();
  const b = turned(0.7, 0.6, 0.8);

  await check("SH: the projection adds each object's SH seen from its view origin (two placements)", async () => {
    const data = shData(splats, "ext", values);
    const arrays = GpuArrays.fromData(renderer, data);
    const refA = GpuArrays.fromData(renderer, baked(data, a, eye));
    const refB = GpuArrays.fromData(renderer, baked(data, b, eye));
    try {
      const pixels = await drawObjects(renderer, [SplatCollection.arrays(arrays, { matrixWorld: a }), SplatCollection.arrays(arrays, { matrixWorld: b })], camera);
      const reference = await drawObjects(renderer, [SplatCollection.arrays(refA, { matrixWorld: a }), SplatCollection.arrays(refB, { matrixWorld: b })], camera);
      const plain = await drawObjects(renderer, [SplatCollection.arrays(arrays, { matrixWorld: a, sh: false }), SplatCollection.arrays(arrays, { matrixWorld: b, sh: false })], camera);
      const diff = meanAbsDiff(pixels, reference);
      const effect = meanAbsDiff(plain, reference);
      return diff < 0.5 && effect > 2 ? undefined : `mean difference ${diff.toFixed(3)} from baked (SH changes ${effect.toFixed(2)})`;
    } finally {
      [arrays, refA, refB].forEach((x) => x.dispose());
    }
  });

  await check("SH: objectParams.maxShDegree caps the drawn bands", async () => {
    const data = shData(splats, "ext", values);
    const arrays = GpuArrays.fromData(renderer, data);
    const ref1 = GpuArrays.fromData(renderer, baked(data, a, eye, 1));
    const plain = GpuArrays.fromData(renderer, splatData(splats));
    try {
      const capped = await drawObjects(renderer, [SplatCollection.arrays(arrays)], camera, { maxShDegree: 1 });
      const reference = await drawObjects(renderer, [SplatCollection.arrays(ref1)], camera);
      const off = await drawObjects(renderer, [SplatCollection.arrays(arrays)], camera, { maxShDegree: 0 });
      const none = await drawObjects(renderer, [SplatCollection.arrays(plain)], camera);
      const d1 = meanAbsDiff(capped, reference);
      const d0 = meanAbsDiff(off, none);
      return d1 < 0.5 && d0 < 0.01 ? undefined : `degree 1: ${d1.toFixed(3)}, degree 0: ${d0.toFixed(3)}`;
    } finally {
      [arrays, ref1, plain].forEach((x) => x.dispose());
    }
  });

  await check("SH: degree 4 per splat (ext and packed) drawn as baked, and maxShDegree 3 draws its degree-3 prefix", async () => {
    for (const codec of ["ext", "packed"] as const) {
      const data = shData(splats, codec, values, 4);
      const arrays = GpuArrays.fromData(renderer, data);
      const [ref4, ref3] = [GpuArrays.fromData(renderer, baked(data, b, eye, 4)), GpuArrays.fromData(renderer, baked(data, b, eye, 3))];
      try {
        const full = await drawObjects(renderer, [SplatCollection.arrays(arrays, { matrixWorld: b })], camera);
        const capped = await drawObjects(renderer, [SplatCollection.arrays(arrays, { matrixWorld: b })], camera, { maxShDegree: 3 });
        const [want4, want3] = [
          await drawObjects(renderer, [SplatCollection.arrays(ref4, { matrixWorld: b })], camera),
          await drawObjects(renderer, [SplatCollection.arrays(ref3, { matrixWorld: b })], camera),
        ];
        const [d4, d3, band4] = [meanAbsDiff(full, want4), meanAbsDiff(capped, want3), meanAbsDiff(want4, want3)];
        if (d4 >= 0.5 || d3 >= 0.5 || band4 <= 0.5) {
          return `${codec}: degree 4 ${d4.toFixed(3)}, capped at 3 ${d3.toFixed(3)} from baked (band 4 changes ${band4.toFixed(2)})`;
        }
      } finally {
        [arrays, ref4, ref3].forEach((x) => x.dispose());
      }
    }
    return undefined;
  });

  await check("SH: palettes of both codecs in one collection", async () => {
    const size = 200;
    const palettes = (["ext", "packed"] as const).map((codec) => {
      const palette = ShPalette.create({ codec, degree: 3, size });
      values.slice(0, size).forEach((c, n) => palette.set(n, c));
      return palette;
    });
    const data = splatData(splats);
    const labels = data.addBundle("shLabel", Sh.LABEL).bundles.shLabel.channels.label.data;
    for (let i = 0; i < COUNT; i += 1) {
      labels[i] = (i * 13) % size;
    }
    const arrays = GpuArrays.fromData(renderer, data);
    const entries = palettes.map((palette) => GpuShPalette.upload(renderer, palette));
    const refs = palettes.map((palette, k) => GpuArrays.fromData(renderer, baked(data, k ? b : a, eye, 3, { palette, labels })));
    try {
      const pixels = await drawObjects(renderer, [
        SplatCollection.arrays(arrays, { matrixWorld: a, shPalette: entries[0] }), SplatCollection.arrays(arrays, { matrixWorld: b, shPalette: entries[1] }),
      ], camera);
      const reference = await drawObjects(renderer, [SplatCollection.arrays(refs[0], { matrixWorld: a }), SplatCollection.arrays(refs[1], { matrixWorld: b })], camera);
      const diff = meanAbsDiff(pixels, reference);
      return diff < 0.5 ? undefined : `mean difference ${diff.toFixed(3)} from baked`;
    } finally {
      [arrays, ...entries, ...refs].forEach((x) => x.dispose());
    }
  });

  await check("SH: RAD clustered SH through workers: the palette written there and back, loaded there as here, and expanded per splat by loadSplats", async () => {
    const size = 100;
    const palette = ShPalette.create({ codec: "ext", degree: 3, size });
    values.slice(0, size).forEach((c, n) => palette.set(n, c));
    const data = splatData(splats);
    data.addBundle("shLabel", Sh.LABEL).bundles.shLabel.channels.label.data.forEach((_, i, l) => (l[i] = (i * 3) % size));
    const entries = (p?: ShPalette) => p?.data.bundles.shPalette.channels.shEntries.data.subarray(0, p.data.count * 4);
    const words = entries(palette)!.slice();
    const rad = await writeSplats(data, "rad", { worker: true, shPalette: palette, radSh: "f32" });
    if (entries(palette)!.some((w, i) => w !== words[i])) {
      return "the palette did not come back from the worker";
    }
    const [there, here] = [await loadSplatFile(rad.slice(), { name: "x.rad", worker: true }), await loadSplatFile(rad.slice(), { name: "x.rad", worker: false })];
    // The same words there and here, and the source's values, as ext may pick another exponent
    const [a, b] = [entries(there.shPalette), entries(here.shPalette)];
    if (!a || !b || a.length !== b.length || a.some((w, i) => w !== b[i])) {
      return `palettes: ${a?.length} words there, ${b?.length} here`;
    }
    for (let n = 0; n < size; n += 1) {
      const [x, y] = [there.shPalette!.get(n), palette.get(n)];
      if (x.some((v, k) => v !== y[k])) {
        return `entry ${n} differs from the source`;
      }
    }
    // data's arrays came back from the worker as new ones
    const sent = data.bundles.shLabel.channels.label.data;
    const [la, lb] = [(there.splats as ArrayData).bundles.shLabel?.channels.label.data, (here.splats as ArrayData).bundles.shLabel?.channels.label.data];
    if (!la || !lb || !la.every((l, i) => l === lb[i] && (i >= COUNT || l === sent[i]))) {
      return "labels differ";
    }
    // Within ext's steps of the entry, as the expansion encodes it again
    const [ea, eb]: ArrayData[] = [await loadSplats(rad.slice(), { name: "x.rad", worker: true }), await loadSplats(rad.slice(), { name: "x.rad", worker: false })];
    const found = Sh.find(ea.bundles);
    if (ea.bundles.shLabel || found?.codec !== "ext" || found.degree !== 3) {
      return `loadSplats: shLabel ${Boolean(ea.bundles.shLabel)}, SH ${found?.codec} ${found?.degree}`;
    }
    const [da, db] = [Sh.decoder(ea), Sh.decoder(eb)];
    const [x, y, z] = [new Float32Array(Sh.VALUES), new Float32Array(Sh.VALUES), new Float32Array(Sh.VALUES)];
    for (let i = 0; i < ea.count; i += 1) {
      da(i, x);
      db(i, y);
      there.shPalette!.get(la[i], z);
      if (x.some((v, k) => v !== y[k] || Math.abs(v - z[k]) > 0.01 * Math.max(1, Math.abs(z[k])))) {
        return `loadSplats: splat ${i} differs from its palette entry`;
      }
    }
    return undefined;
  });

  await check("SH: a GpuShReader in a generator of one's own matches fromSplats", async () => {
    const data = shData(splats, "packed", values);
    const arrays = GpuArrays.fromData(renderer, data);
    const base = SplatGenerator.fromSplats();
    const sh = new GpuShReader({ codec: "packed", degree: 3 });
    const own: SplatGenerator<StoredSplats> = {
      generateSplat(i, context = SplatGenerator.context) {
        const stored = arrays.count - 1;
        const index = TSL.uint(stored).sub(i).toVar();
        return sh.apply(base.generateSplat!(index, context), index, context.viewOrigin);
      },
      bind(d, context) {
        base.bind!(d, context);
        sh.bind(d.splats);
      },
    };
    try {
      const pixels = await drawObjects(renderer, [{ generator: own, data: { splats: arrays }, count: arrays.count, matrixWorld: b }], camera);
      const reference = await drawObjects(renderer, [SplatCollection.arrays(arrays, { matrixWorld: b })], camera);
      const diff = meanAbsDiff(pixels, reference);
      return diff < 0.5 ? undefined : `mean difference ${diff.toFixed(3)}`;
    } finally {
      arrays.dispose();
    }
  });
}
