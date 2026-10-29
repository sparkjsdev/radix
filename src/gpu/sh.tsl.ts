// TSL twin of core/sh.ts: the SH basis (GpuSh.evaluate), the built-in
// codecs' decoders, and GpuShReader, the reader generators hold to add a
// splat's SH color (fromSplats uses it too). A codec decodes one band at a
// time from texels it loads on demand; the bands are nested branches on a
// degree cap (GpuSh.maxDegree, set per object from objectParams.maxShDegree),
// so bands above it cost nothing and a texel two bands share loads once.
import type { WebGPURenderer } from "three/webgpu";
import { defineBundle } from "../core/bundles";
import { Sh, ShPalette, type FoundSh, type ShCodecName, type ShDegree } from "../core/sh";
import { GpuArrayReader } from "./GpuArrayReader";
import { GpuArrays } from "./GpuArrays";
import { GpuEncoding } from "./encoding.tsl";
import { TSL, type TslNode } from "./tsl";

const { If, exp2, float, int, max, min, normalize, select, uint, uniform, vec3 } = TSL;

const COMPONENTS = ["x", "y", "z", "w"] as const;

// The TSL side of a codec (same name): band `band`'s coefficients (vec3
// each, Sh.COEFFICIENTS[band - 1] to Sh.COEFFICIENTS[band] - 1) from
// texel(j), the entry's texel j (uvec4)
export interface GpuShCodec {
  readonly name: ShCodecName;
  decodeBand(band: ShDegree, texel: (j: number) => TslNode): TslNode[];
}

// Word w of the entry (uint) and byte b (uint 0..255)
const wordOf = (texel: (j: number) => TslNode, w: number) => texel(w >> 2)[COMPONENTS[w & 3]];
const byteOf = (texel: (j: number) => TslNode, b: number) => wordOf(texel, b >> 2).shiftRight(uint((b & 3) * 8)).bitAnd(uint(0xff));
const range = (band: ShDegree) => Array.from({ length: Sh.COEFFICIENTS[band] - Sh.COEFFICIENTS[band - 1] }, (_, i) => Sh.COEFFICIENTS[band - 1] + i);

const ext: GpuShCodec = {
  name: "ext",
  decodeBand: (band, texel) => range(band).map((k) => GpuEncoding.decodeExtRgb(wordOf(texel, k))),
};

const PACKED_BAND_START = [0, 0, 10, 26, 48];
const packed: GpuShCodec = {
  name: "packed",
  decodeBand(band, texel) {
    const start = PACKED_BAND_START[band];
    const code = byteOf(texel, start).toVar();
    // A value byte moved to the top of its word and read as an int is its
    // signed code times 2^24, so 2^-24 joins the scale (powers of two: the
    // products are exactly code * scale)
    const scale = select(code.equal(uint(0)), float(0), exp2(float(code).sub(192).div(16))).div(127).mul(2 ** -24).toVar();
    const signed = (b: number) => float(int(wordOf(texel, b >> 2).shiftLeft(uint(24 - (b & 3) * 8)).bitAnd(uint(0xff000000))));
    const first = Sh.COEFFICIENTS[band - 1];
    return range(band).map((k) => {
      const at = start + 1 + (k - first) * 3;
      return vec3(signed(at), signed(at + 1), signed(at + 2)).mul(scale);
    });
  },
};

const CODECS: Record<ShCodecName, GpuShCodec> = { ext, packed };

// The basis of band `band` along unit `d` (x, y, z nodes); bands 2 to 4
// share the squares (made in band 2's scope, which nests the others)
function basis(band: ShDegree, d: TslNode, squares: { xx?: TslNode; yy?: TslNode; zz?: TslNode }): TslNode[] {
  const { x, y, z } = d;
  if (band === 1) {
    return [y.mul(-0.4886025), z.mul(0.4886025), x.mul(-0.4886025)];
  }
  const xx = (squares.xx ??= x.mul(x).toVar());
  const yy = (squares.yy ??= y.mul(y).toVar());
  const zz = (squares.zz ??= z.mul(z).toVar());
  if (band === 2) {
    return [
      x.mul(y).mul(1.0925484),
      y.mul(z).mul(-1.0925484),
      zz.mul(2).sub(xx).sub(yy).mul(0.3153916),
      x.mul(z).mul(-1.0925484),
      xx.sub(yy).mul(0.5462742),
    ];
  }
  if (band === 3) {
    return [
      y.mul(xx.mul(3).sub(yy)).mul(-0.5900436),
      x.mul(y).mul(z).mul(2.8906114),
      y.mul(zz.mul(4).sub(xx).sub(yy)).mul(-0.4570458),
      z.mul(zz.mul(2).sub(xx.mul(3)).sub(yy.mul(3))).mul(0.3731763),
      x.mul(zz.mul(4).sub(xx).sub(yy)).mul(-0.4570458),
      z.mul(xx.sub(yy)).mul(1.4453057),
      x.mul(xx.sub(yy.mul(3))).mul(-0.5900436),
    ];
  }
  // Band 4 uses xx + yy + zz = 1 (`d` is unit)
  const zz7m1 = zz.mul(7).sub(1).toVar();
  const zz7m3 = zz.mul(7).sub(3).toVar();
  return [
    x.mul(y).mul(xx.sub(yy)).mul(2.5033429),
    y.mul(z).mul(xx.mul(3).sub(yy)).mul(-1.7701308),
    x.mul(y).mul(zz7m1).mul(0.9461747),
    y.mul(z).mul(zz7m3).mul(-0.6690465),
    zz.mul(zz.mul(35).sub(30)).add(3).mul(0.1057855),
    x.mul(z).mul(zz7m3).mul(-0.6690465),
    xx.sub(yy).mul(zz7m1).mul(0.4730873),
    x.mul(z).mul(xx.sub(yy.mul(3))).mul(-1.7701308),
    xx.mul(xx.sub(yy.mul(3))).sub(yy.mul(xx.mul(3).sub(yy))).mul(0.6258357),
  ];
}

// Spherical harmonics in TSL: the basis, the codecs' decoders and the degree
// cap. Sh is the CPU twin.
export class GpuSh {
  // The drawn degree's cap (uint): set per object from objectParams.maxShDegree
  // by the renderer, read by every GpuShReader
  static readonly maxDegree: TslNode = uniform(Sh.MAX_DEGREE, "uint");

  // A codec's TSL decoder by name
  static codec(name: ShCodecName): GpuShCodec {
    return CODECS[Sh.codec(name).name];
  }

  // The SH color (vec3) along unit `dir` through `degree`: band b's
  // coefficients come from coefficients(b), called inside a branch on
  // min(maxDegree, limit) >= b, each band's nested in the one below it, so
  // a band above the cap costs nothing and values (texels) made for one
  // band can be reused by the next (`limit`: a uint node, such as the
  // degree a reader is bound to; cap false: no branch)
  static evaluate(dir: TslNode, degree: number, coefficients: (band: ShDegree) => TslNode[], { cap = true, limit }: { cap?: boolean; limit?: TslNode } = {}): TslNode {
    const d = dir.toVar();
    const sum = vec3(0, 0, 0).toVar();
    const top = cap ? (limit ? min(GpuSh.maxDegree, limit) : GpuSh.maxDegree).toVar() : undefined;
    const squares = {};
    const add = (band: ShDegree) => {
      const values = coefficients(band);
      sum.addAssign(basis(band, d, squares).reduce((total: TslNode, w: TslNode, k: number) => total.add(values[k].mul(w)), vec3(0, 0, 0)));
      if (band < degree) {
        next((band + 1) as ShDegree);
      }
    };
    const next = (band: ShDegree) => (top ? If(top.greaterThanEqual(uint(band)), () => add(band)) : add(band));
    if (degree >= 1) {
      next(1);
    }
    return sum;
  }
}

// The SH of stored splats, for any generator: per-splat (a codec's bundle
// beside the splats, found by Sh.find) or palette (bundle shLabel, then an
// ShPalette's entries). bind() points it at an object's arrays (and
// palette) before its dispatch: arrays with SH of a lower degree than the
// reader's, or none, read what they have (the bands above cost nothing).
// color(index, origin, center) is the SH color of stored splat `index` seen
// from `origin`, to add to its rgb.
export class GpuShReader {
  readonly codec: ShCodecName;
  readonly degree: ShDegree;
  readonly palette: boolean;
  private gpuCodec: GpuShCodec;
  // One reader per channel (per splat), so a lower-degree bundle binds
  // the channels it has; one for the palette's entries
  private channels: { name: string; reader: GpuArrayReader }[];
  private labels: GpuArrayReader | undefined;
  private stride: TslNode;
  // The degree of the SH bound (0: none)
  private bound: TslNode;

  constructor({ codec, degree, palette = false }: { codec: ShCodecName; degree: ShDegree; palette?: boolean }) {
    this.codec = codec;
    this.degree = degree;
    this.palette = palette;
    this.gpuCodec = GpuSh.codec(codec);
    const names = palette ? ["shEntries"] : Object.keys(Sh.bundle(this.codec, degree).channels);
    this.channels = names.map((name) => ({ name, reader: new GpuArrayReader(defineBundle({ [name]: "uint32x4" })) }));
    this.labels = palette ? new GpuArrayReader(Sh.LABEL) : undefined;
    this.stride = uniform(1, "uint");
    this.bound = uniform(0, "uint");
  }

  // The reader of the SH in `arrays` (and `palette`), or undefined when
  // they have none, at most `degree`
  static for(arrays: GpuArrays, { palette, degree }: { palette?: GpuArrays; degree?: number } = {}): GpuShReader | undefined {
    const found = GpuShReader.find(arrays, palette);
    if (!found || degree === 0) {
      return undefined;
    }
    return new GpuShReader({ codec: found.codec, degree: Math.min(degree ?? Sh.MAX_DEGREE, found.degree) as ShDegree, palette: found.palette });
  }

  // What SH `arrays` (and `palette`) hold: { codec, degree, palette }
  static find(arrays: GpuArrays, palette?: GpuArrays): (Pick<FoundSh, "codec" | "degree"> & { palette: boolean }) | undefined {
    if (palette && arrays.bundles.shLabel) {
      const meta = palette.bundle("shPalette").meta;
      return { codec: Sh.codec(meta.codec as string).name, degree: meta.degree as ShDegree, palette: true };
    }
    const found = Sh.find(arrays.bundles);
    return found && { codec: found.codec, degree: found.degree, palette: false };
  }

  // Read the SH of `arrays` (per splat), or its labels and `palette`'s
  // entries; nothing reads zero
  bind(arrays?: GpuArrays, palette?: GpuArrays): this {
    if (this.labels) {
      const ok = !!(arrays?.bundles.shLabel && palette?.bundles.shPalette);
      const meta = ok ? palette!.bundle("shPalette").meta : undefined;
      const usable = ok && meta!.codec === this.codec;
      this.labels.bind(usable ? arrays : undefined, "shLabel");
      this.channels[0].reader.bind(usable ? palette : undefined, "shPalette");
      this.stride.value = (meta?.stride as number | undefined) ?? 1;
      this.bound.value = usable ? Math.min(this.degree, meta!.degree as number) : 0;
      return this;
    }
    const found = arrays && Sh.find(arrays.bundles);
    const usable = found?.codec === this.codec ? found : undefined;
    const bundle = usable && arrays!.bundle(usable.name);
    for (const { name, reader } of this.channels) {
      reader.bind(bundle?.channels[name] ? arrays : undefined, usable?.name);
    }
    this.bound.value = usable ? Math.min(this.degree, usable.degree) : 0;
    return this;
  }

  // Texel j of stored splat `index`'s entry, each loaded on first use and
  // kept (the palette's label too): use it in one scope or nested ones
  private texels(index: TslNode): (j: number) => TslNode {
    const loaded: TslNode[] = [];
    let first: TslNode | undefined;
    return (j) => {
      if (!loaded[j]) {
        if (this.labels) {
          first ??= uint(this.labels.load("label", index)).mul(this.stride).toVar();
          loaded[j] = this.channels[0].reader.load("shEntries", first.add(uint(j))).toVar();
        } else {
          loaded[j] = this.channels[j].reader.load(this.channels[j].name, index).toVar();
        }
      }
      return loaded[j];
    };
  }

  private decode(band: ShDegree, texel: (j: number) => TslNode): TslNode[] {
    return this.gpuCodec.decodeBand(band, texel);
  }

  // Band `band`'s coefficients of stored splat `index` (vec3 each); texels
  // are loaded once per call
  band(index: TslNode, band: ShDegree): TslNode[] {
    return this.decode(band, this.texels(index));
  }

  // All coefficients through the reader's degree (no cap), each texel
  // loaded once
  coefficients(index: TslNode): TslNode[] {
    const texel = this.texels(index);
    return ([1, 2, 3, 4] as const).filter((b) => b <= this.degree).flatMap((b) => this.decode(b, texel));
  }

  // The SH color of stored splat `index` at `center` seen from `origin`
  // (both in the splats' space); add it to rgb and clamp at 0. Each texel
  // (and the label) loads once, in the branch of the first band needing it.
  color(index: TslNode, origin: TslNode, center: TslNode): TslNode {
    const texel = this.texels(index.toVar());
    return GpuSh.evaluate(normalize(center.sub(origin)), this.degree, (band) => this.decode(band, texel), { limit: this.bound });
  }

  // splat.rgb plus the SH color, clamped at 0, for a splat node of either form
  apply(splat: TslNode, index: TslNode, origin: TslNode): TslNode {
    const out = splat.toVar();
    const rgb = out.get("rgb");
    rgb.assign(max(rgb.add(this.color(index, origin, out.get("center"))), vec3(0, 0, 0)));
    return out;
  }
}

// Palettes on the GPU: an ShPalette's table uploaded, or an empty one for a
// GPU writer to fill (element t is entry floor(t / stride), texel t % stride)
export class GpuShPalette {
  static upload(renderer: WebGPURenderer, palette: ShPalette): GpuArrays {
    return GpuArrays.fromData(renderer, palette.data);
  }

  static create<Storage extends boolean = false>(renderer: WebGPURenderer, { codec, degree, size, stride, storage }: {
    codec: ShCodecName;
    degree: ShDegree;
    size: number;
    stride?: number;
    storage?: Storage;
  }): GpuArrays<{ shPalette: typeof ShPalette.BUNDLE }, Storage> {
    const s = stride ?? ShPalette.strideOf(codec, degree);
    const arrays = new GpuArrays({ renderer, bundles: { shPalette: ShPalette.BUNDLE }, capacity: size * s, storage });
    arrays.bundle("shPalette").meta = { codec, degree, size, stride: s };
    return arrays;
  }
}
