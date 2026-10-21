/*!
 * The PlayCanvas engine, https://github.com/playcanvas/engine
 *
 * MIT License
 *
 * Copyright (c) 2011-2026 PlayCanvas Ltd.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 */
import * as THREE from "three";
import type { WebGPURenderer } from "three/webgpu";
import {
  ArrayData, GpuArrayReader, GpuArrayWriter, GpuArrays, GpuEncoding, GpuShPalette, GpuSplats, ShPalette, Splats, TSL, defineBundle,
  type Schema, type ShDegree, type TslNode,
} from "@sparkjsdev/radix";
import type { SogArrays } from "./sh.js";
import { LABEL_BUNDLE, SH_COEFFICIENTS, alphaTable, colorTables, paletteShape, scaleTables, shTable, type Progress, type SogMeta, type SogSource } from "./sog.js";
import { decodeBitmap, type Pixels } from "./webp.js";

const { abs, exp, int, ivec2, max, mix, normalize, select, sign, sqrt, texture, uint, uniform, uvec4, vec3, vec4 } = TSL;

// Per byte, so v1 ranges and v2 codebooks take one shader: scale xyz and alpha,
// color rgb and a quaternion component, and an SH value
const TABLES = defineBundle({ scale: "float32x4", color: "float32x4", sh: "float32" });

const IMAGES = ["meansL", "meansU", "quats", "scales", "sh0", "labels"] as const;
type ImageName = (typeof IMAGES)[number];

function imageTexture(image: ImageBitmap | Pixels) {
  const texture = image instanceof ImageBitmap ? new THREE.Texture(image) : new THREE.DataTexture(image.rgba, image.width, image.height);
  texture.flipY = false;
  texture.premultiplyAlpha = false;
  texture.colorSpace = THREE.NoColorSpace;
  texture.minFilter = texture.magFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

const placeholder = imageTexture({ rgba: new Uint8Array(4), width: 1, height: 1 });

interface Decoder {
  writer: GpuArrayWriter;
  images: Record<ImageName, TslNode>;
  tables: GpuArrayReader<typeof TABLES>;
  width: TslNode;
  mins: TslNode;
  maxs: TslNode;
}

function makeDecoder(labels: boolean): Decoder {
  const images = Object.fromEntries(IMAGES.map((name) => [name, texture(placeholder)])) as Record<ImageName, TslNode>;
  const tables = new GpuArrayReader(TABLES);
  const width = uniform(1, "uint");
  const mins = uniform(new THREE.Vector3());
  const maxs = uniform(new THREE.Vector3());
  const outputs: Schema = labels ? { extSplats: Splats.EXT, shLabel: LABEL_BUNDLE } : { extSplats: Splats.EXT };

  const writer = new GpuArrayWriter({
    outputs,
    write: (index, out) => {
      const coord = ivec2(int(index.mod(width)), int(index.div(width)));
      const bytes = (name: ImageName) => uvec4(images[name].load(coord).mul(255).add(0.5)).toVar();

      const lo = bytes("meansL");
      const hi = bytes("meansU");
      const v = mix(mins, maxs, vec3(lo.xyz).add(vec3(hi.xyz).mul(256)).div(65535)).toVar();
      const center = sign(v).mul(exp(abs(v)).sub(1));

      const q = bytes("quats");
      const a = tables.load("color", q.x).w.toVar();
      const b = tables.load("color", q.y).w.toVar();
      const c = tables.load("color", q.z).w.toVar();
      const r = sqrt(max(a.mul(a).add(b.mul(b)).add(c.mul(c)).oneMinus(), 0)).toVar();
      const mode = q.w.sub(uint(252)).toVar();
      const quaternion = normalize(vec4(
        select(mode.equal(uint(0)), a, select(mode.equal(uint(1)), r, b)),
        select(mode.lessThanEqual(uint(1)), b, select(mode.equal(uint(2)), r, c)),
        select(mode.lessThanEqual(uint(2)), c, r),
        select(mode.equal(uint(0)), r, a),
      ));

      const s = bytes("scales");
      const scales = vec3(tables.load("scale", s.x).x, tables.load("scale", s.y).y, tables.load("scale", s.z).z);
      const k = bytes("sh0");
      const rgb = vec3(tables.load("color", k.x).x, tables.load("color", k.y).y, tables.load("color", k.z).z);
      const opacity = tables.load("scale", k.w).w;

      const o = out as Record<string, Record<string, TslNode>>;
      GpuSplats.storeExt(o.extSplats as { extA: TslNode; extB: TslNode }, GpuSplats.Splat(center, scales, quaternion, rgb, opacity));
      if (labels) {
        const l = bytes("labels");
        o.shLabel.label.assign(l.x.bitOr(l.y.shiftLeft(uint(8))));
      }
    },
  });
  return { writer, images, tables, width, mins, maxs };
}

const decoders = new Map<boolean, Decoder>();
const decoderFor = (labels: boolean) => {
  if (!decoders.has(labels)) {
    decoders.set(labels, makeDecoder(labels));
  }
  return decoders.get(labels)!;
};

function tablesOf(renderer: WebGPURenderer, source: SogSource) {
  const [sx, sy, sz] = scaleTables(source.meta);
  const [cr, cg, cb] = colorTables(source.meta);
  const alpha = alphaTable(source.meta);
  const data = new ArrayData({ count: 256 }).addBundle("tables", TABLES);
  const { scale, color, sh } = data.bundles.tables.channels;
  for (let b = 0; b < 256; b += 1) {
    scale.data.set([sx[b], sy[b], sz[b], alpha[b]], b * 4);
    color.data.set([cr[b], cg[b], cb[b], (b / 255 - 0.5) * Math.SQRT2], b * 4);
  }
  if (source.meta.shN) {
    sh.data.set(shTable(source.meta));
  }
  return GpuArrays.fromData(renderer, data);
}

interface PaletteWriter {
  writer: GpuArrayWriter;
  centroids: TslNode;
  tables: GpuArrayReader<typeof TABLES>;
}

// Element t is texel t % stride of entry t / stride, the entry's word k being
// coefficient k, zero past the degree's
function makePaletteWriter(degree: ShDegree, stride: number): PaletteWriter {
  const centroids = texture(placeholder);
  const tables = new GpuArrayReader(TABLES);
  const coefficients = SH_COEFFICIENTS[degree];
  const writer = new GpuArrayWriter({
    outputs: { shPalette: ShPalette.BUNDLE },
    write: (index, out) => {
      const n = index.div(uint(stride)).toVar();
      const j = index.mod(uint(stride)).toVar();
      const x = n.mod(uint(64)).mul(uint(coefficients)).toVar();
      const y = int(n.div(uint(64))).toVar();
      const word = (w: number) => {
        const k = j.mul(uint(4)).add(uint(w)).toVar();
        const texel = uvec4(centroids.load(ivec2(int(x.add(k)), y)).mul(255).add(0.5)).toVar();
        const value = vec3(tables.load("sh", texel.x), tables.load("sh", texel.y), tables.load("sh", texel.z));
        return select(k.lessThan(uint(coefficients)), GpuEncoding.encodeExtRgb(value), uint(0));
      };
      (out.shPalette as Record<string, TslNode>).shEntries.assign(uvec4(word(0), word(1), word(2), word(3)));
    },
  });
  return { writer, centroids, tables };
}

const paletteWriters = new Map<string, PaletteWriter>();
function paletteWriterFor(degree: ShDegree, stride: number) {
  const key = `${degree}|${stride}`;
  if (!paletteWriters.has(key)) {
    paletteWriters.set(key, makePaletteWriter(degree, stride));
  }
  return paletteWriters.get(key)!;
}

function decodePaletteGpu(renderer: WebGPURenderer, meta: SogMeta, image: ImageBitmap, tables: GpuArrays): { palette: GpuArrays; degree: number } {
  const { degree, size } = paletteShape(meta, image);
  const palette = GpuShPalette.create(renderer, { codec: "ext", degree, size });
  const stride = palette.bundle("shPalette").meta.stride as number;
  const centroids = imageTexture(image);
  const each = paletteWriterFor(degree, stride);
  each.centroids.value = centroids;
  each.tables.bind(tables, "tables");
  palette.write(each.writer, { at: 0, count: size * stride });
  each.centroids.value = placeholder;
  each.tables.bind();
  centroids.dispose();
  return { palette, degree };
}

// Decoded off the main thread and uploaded apart, so a stream can upload one file per frame
export interface PreparedSog {
  source: SogSource;
  images: [ImageName, ImageBitmap | Pixels][];
  centroids?: ImageBitmap;
}

export async function prepareSogGpu(source: SogSource): Promise<PreparedSog> {
  const { meta } = source;
  const names: Partial<Record<ImageName, string>> = {
    meansL: meta.means.files[0], meansU: meta.means.files[1], quats: meta.quats.files[0], scales: meta.scales.files[0], sh0: meta.sh0.files[0],
    labels: meta.shN?.files[1],
  };
  const entries = Object.entries(names).filter((entry): entry is [ImageName, string] => entry[1] !== undefined);
  const [bitmaps, centroids] = await Promise.all([
    Promise.all(entries.map(([, file]) => source.getFile(file).then(decodeBitmap))),
    meta.shN ? source.getFile(meta.shN.files[0]).then(decodeBitmap) : undefined,
  ]);
  return { source, images: entries.map(([name], i) => [name, bitmaps[i]]), centroids };
}

export function closePrepared({ images, centroids }: PreparedSog) {
  images.forEach(([, image]) => (image instanceof ImageBitmap ? image.close() : undefined));
  centroids?.close();
}

// Closes the prepared bitmaps
export function uploadSogGpu(renderer: WebGPURenderer, prepared: PreparedSog): SogArrays {
  const { source, images, centroids } = prepared;
  const { meta } = source;
  const decoder = decoderFor(meta.shN !== undefined);
  const textures = images.map(([, bitmap]) => imageTexture(bitmap));
  images.forEach(([name], i) => (decoder.images[name].value = textures[i]));
  decoder.width.value = images[0][1].width;
  decoder.mins.value.fromArray(meta.means.mins);
  decoder.maxs.value.fromArray(meta.means.maxs);
  const tables = tablesOf(renderer, source);
  decoder.tables.bind(tables, "tables");

  const arrays = new GpuArrays({ renderer, bundles: decoder.writer.outputs, capacity: meta.count });
  arrays.write(decoder.writer, { at: 0, count: meta.count });

  for (const name of IMAGES) {
    decoder.images[name].value = placeholder;
  }
  decoder.tables.bind();
  textures.forEach((each) => each.dispose());

  const palette = centroids && decodePaletteGpu(renderer, meta, centroids, tables);
  tables.dispose();
  closePrepared(prepared);
  if (!palette) {
    return { arrays, degree: 0, layout: "extSplats" };
  }
  return { arrays, palette: palette.palette, degree: palette.degree, layout: "extSplats" };
}

export async function decodeSogGpu(renderer: WebGPURenderer, source: SogSource, { onProgress }: { onProgress?: Progress } = {}): Promise<SogArrays> {
  const prepared = await prepareSogGpu(source);
  onProgress?.(1, "decoding");
  return uploadSogGpu(renderer, prepared);
}
