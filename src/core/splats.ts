import { ArrayData, type ArrayBundle } from "./ArrayData";
import type { CoordinateSystem } from "./axes";
import { defineBundle, type BundleDef } from "./bundles";
import { Encoding } from "./encoding";
import type { TypedArray } from "./formats";
import { SplatMath, type Cov, type Quat, type Rgb, type Vec3 } from "./math";
import type { Progress } from "./progress";
import type { ShPalette, ShTarget } from "./sh";

/** The 3DGS fields that every layout stores. */
export interface Splat {
  center: Vec3;
  /** The scales along the splat's own axes. */
  scales: Vec3;
  quaternion: Quat;
  /** The base color. */
  rgb: Rgb;
  /** The opacity, where 1 is opaque, up to 255 / 128 in ext and cov. */
  opacity: number;
}

/** The PBR fields, which only ext splats store. */
export interface Pbr {
  /** The normal, a unit vector or zero for none. */
  normal: Vec3;
  /** The perceptual roughness, from 0 to 1. */
  roughness: number;
  /** The metalness, from 0 to 1. */
  metallic: number;
}

/** The fields of an ext splat. */
export type ExtSplat = Splat & Pbr;

/** The fields of a cov splat. */
export interface CovSplat {
  center: Vec3;
  cov: Cov;
  /** The base color. */
  rgb: Rgb;
  /** The opacity, where 1 is opaque, up to 255 / 128. */
  opacity: number;
  /** The normal, a unit vector or zero for none. */
  normal: Vec3;
}

const EXT = defineBundle({ extA: "uint32x4", extB: "uint32x4" });
const COV = defineBundle({ covA: "uint32x4", covB: "uint32x4" });
const PACKED = defineBundle({ packed: "uint32x4" });
const LOD_TREE = defineBundle({ node: "uint32x2" });
const LAYOUTS = { extSplats: EXT, covSplats: COV, packedSplats: PACKED } as const;

/** A bundle of ext splats. */
export type ExtSplats = ArrayBundle<typeof EXT>;
/** A bundle of cov splats. */
export type CovSplats = ArrayBundle<typeof COV>;
/** A bundle of packed splats. */
export type PackedSplats = ArrayBundle<typeof PACKED>;
/** A bundle of splats in any layout. */
export type SplatBundle = ExtSplats | CovSplats | PackedSplats;
/** The name of a splat layout, which is also its standard bundle name. */
export type SplatLayout = keyof typeof LAYOUTS;
/** The splat bundles, by standard name. */
export interface SplatBundles {
  extSplats: ExtSplats;
  covSplats: CovSplats;
  packedSplats: PackedSplats;
}

/** The ranges of the packed layout's 8-bit color and ln scale codes. */
export interface PackedEncoding {
  /**
   * The lowest color.
   *
   * @default 0
   */
  rgbMin: number;
  /**
   * The highest color.
   *
   * @default 1
   */
  rgbMax: number;
  /**
   * The lowest ln scale.
   *
   * @default -12
   */
  lnScaleMin: number;
  /**
   * The highest ln scale.
   *
   * @default 9
   */
  lnScaleMax: number;
}

const DEFAULT_PACKED_ENCODING: PackedEncoding = { rgbMin: 0, rgbMax: 1, lnScaleMin: -12, lnScaleMax: 9 };

/** An ArrayData with splats of layout L in the bundle named L. */
export type SplatData<L extends SplatLayout = "extSplats"> = ArrayData<{ [K in L]: (typeof LAYOUTS)[K] }>;

/** The layout to make or load splats in. */
export interface SplatTarget<L extends SplatLayout = SplatLayout> {
  /**
   * The layout.
   *
   * @default "extSplats"
   */
  layout?: L;
  /**
   * For packedSplats, the ranges of its codes.
   *
   * @default the source's encoding, else Splats.DEFAULT_PACKED_ENCODING
   */
  encoding?: Partial<PackedEncoding>;
}

/** Options of the splat file readers. */
export type SplatReadOptions<L extends SplatLayout = "extSplats"> = SplatTarget<L> & {
  /** Called with the progress of the read. */
  progress?: Progress;
  /**
   * The codec SH is stored in, or false to skip it.
   *
   * @default "ext", or the stored codec for RDX
   */
  sh?: ShTarget;
  /**
   * The axes SPZ files are converted to.
   *
   * @default the axes the file is stored in
   */
  coordinateSystem?: CoordinateSystem;
};

/** A loaded file's splats, and its SH palette when it has one. */
export interface LoadedSplats<L extends SplatLayout = "extSplats"> {
  splats: SplatData<L>;
  /** The SH palette, when the file's SH is clustered. */
  shPalette?: ShPalette;
}

/** A splat bundle, as Splats.find returns it. */
export interface FoundSplats {
  name: string;
  layout: SplatLayout;
  bundle: SplatBundle;
}

/** Anything with named channels of formats, as ArrayBundle and GpuBundle have. */
export interface BundleLike {
  channels: Record<string, { format: string } | undefined>;
}

function hasLayout(bundle: BundleLike, layout: SplatLayout) {
  const channels = LAYOUTS[layout].channels as Record<string, string>;
  const labels = Object.keys(channels);
  return labels.length === Object.keys(bundle.channels).length && labels.every((label) => bundle.channels[label]?.format === channels[label]);
}

// One property check, since the type already fixed the formats
const isExtBundle = (bundle: SplatBundle): bundle is ExtSplats => "extA" in bundle.channels;
const isCovBundle = (bundle: SplatBundle): bundle is CovSplats => "covA" in bundle.channels;

const lnHalf = (v: number) => Encoding.encodeHalf(Math.log(v));
const expHalf = (h: number) => Math.exp(Encoding.decodeHalf(h));

// Word A of ext and cov, f being its floats
function storeA(a: Uint32Array, f: Float32Array, i4: number, center: Vec3, opacity: number) {
  f[i4] = center.x;
  f[i4 + 1] = center.y;
  f[i4 + 2] = center.z;
  a[i4 + 3] = ((a[i4 + 3] & 0xffffff) | (Encoding.encodeLodOpacity(opacity) << 24)) >>> 0;
}

function storeNormal(a: Uint32Array, i4: number, normal: Vec3) {
  a[i4 + 3] = ((a[i4 + 3] & 0xff000000) | Encoding.encodeOct24(normal)) >>> 0;
}

function loadCenterA(f: Float32Array, i4: number, out: Vec3) {
  out.x = f[i4];
  out.y = f[i4 + 1];
  out.z = f[i4 + 2];
  return out;
}


function storeExtFields(a: Uint32Array, f: Float32Array, b: Uint32Array, i4: number, s: Splat) {
  storeA(a, f, i4, s.center, s.opacity);
  b[i4] = Encoding.encodeExtRgb(s.rgb);
  b[i4 + 1] = (lnHalf(s.scales.x) | (lnHalf(s.scales.y) << 16)) >>> 0;
  b[i4 + 2] = ((b[i4 + 2] & 0xffff0000) | lnHalf(s.scales.z)) >>> 0;
  b[i4 + 3] = Encoding.encodeQuatOct32(s.quaternion);
}

function storeExtPbr(a: Uint32Array, b: Uint32Array, i4: number, p: Pbr) {
  storeNormal(a, i4, p.normal);
  b[i4 + 2] = ((b[i4 + 2] & 0xffff) | (Encoding.encodeUnorm8(p.roughness) << 16) | (Encoding.encodeUnorm8(p.metallic) << 24)) >>> 0;
}

function loadExtFields(a: Uint32Array, f: Float32Array, b: Uint32Array, i4: number, out: Splat) {
  loadCenterA(f, i4, out.center);
  out.opacity = Encoding.decodeLodOpacity(a[i4 + 3] >>> 24);
  Encoding.decodeExtRgb(b[i4], out.rgb);
  out.scales.x = expHalf(b[i4 + 1] & 0xffff);
  out.scales.y = expHalf(b[i4 + 1] >>> 16);
  out.scales.z = expHalf(b[i4 + 2] & 0xffff);
  Encoding.decodeQuatOct32(b[i4 + 3], out.quaternion);
  return out;
}

function loadExtPbr(a: Uint32Array, b: Uint32Array, i4: number, out: Pbr) {
  Encoding.decodeOct24(a[i4 + 3] & 0xffffff, out.normal);
  out.roughness = ((b[i4 + 2] >>> 16) & 0xff) / 255;
  out.metallic = (b[i4 + 2] >>> 24) / 255;
  return out;
}

function encodeExtWords(a: Uint32Array, f: Float32Array, b: Uint32Array, i4: number, s: ExtSplat) {
  a[i4 + 3] = 0;
  b[i4 + 2] = 0;
  storeExtFields(a, f, b, i4, s);
  storeExtPbr(a, b, i4, s);
}

function decodeExtWords(a: Uint32Array, f: Float32Array, b: Uint32Array, i4: number, out: ExtSplat) {
  loadExtFields(a, f, b, i4, out);
  loadExtPbr(a, b, i4, out);
  return out;
}


// sign(c) * ln|c| keeps correlations near +-1 precise in a half float
function encodeCorrelation(value: number, a: number, b: number) {
  const c = Math.max(-1, Math.min(1, value / Math.sqrt(a * b)));
  if (c === 0 || !Number.isFinite(c)) {
    return 0;
  }
  return Math.sign(c) * Math.max(-100, Math.min(-1e-7, Math.log(Math.abs(c))));
}

function decodeCorrelation(encoded: number) {
  return encoded === 0 ? 0 : -Math.sign(encoded) * Math.exp(-Math.abs(encoded));
}

// Everything but the normal
function storeCovFields(a: Uint32Array, f: Float32Array, b: Uint32Array, i4: number, center: Vec3, cov: Cov, rgb: Rgb, opacity: number) {
  const { xx, yy, zz, xy, xz, yz } = cov;
  storeA(a, f, i4, center, opacity);
  b[i4] = Encoding.encodeExtRgb(rgb);
  b[i4 + 1] = (lnHalf(xx) | (lnHalf(yy) << 16)) >>> 0;
  b[i4 + 2] = (lnHalf(zz) | (Encoding.encodeHalf(encodeCorrelation(xy, xx, yy)) << 16)) >>> 0;
  b[i4 + 3] = (Encoding.encodeHalf(encodeCorrelation(xz, xx, zz)) | (Encoding.encodeHalf(encodeCorrelation(yz, yy, zz)) << 16)) >>> 0;
}

function encodeCovWords(a: Uint32Array, f: Float32Array, b: Uint32Array, i4: number, c: CovSplat) {
  a[i4 + 3] = 0;
  storeCovFields(a, f, b, i4, c.center, c.cov, c.rgb, c.opacity);
  storeNormal(a, i4, c.normal);
}

function decodeCovWords(a: Uint32Array, f: Float32Array, b: Uint32Array, i4: number, out: CovSplat) {
  loadCenterA(f, i4, out.center);
  Encoding.decodeOct24(a[i4 + 3] & 0xffffff, out.normal);
  out.opacity = Encoding.decodeLodOpacity(a[i4 + 3] >>> 24);
  Encoding.decodeExtRgb(b[i4], out.rgb);

  const xx = expHalf(b[i4 + 1] & 0xffff);
  const yy = expHalf(b[i4 + 1] >>> 16);
  const zz = expHalf(b[i4 + 2] & 0xffff);
  out.cov.xx = xx;
  out.cov.yy = yy;
  out.cov.zz = zz;
  out.cov.xy = decodeCorrelation(Encoding.decodeHalf(b[i4 + 2] >>> 16)) * Math.sqrt(xx * yy);
  out.cov.xz = decodeCorrelation(Encoding.decodeHalf(b[i4 + 3] & 0xffff)) * Math.sqrt(xx * zz);
  out.cov.yz = decodeCorrelation(Encoding.decodeHalf(b[i4 + 3] >>> 16)) * Math.sqrt(yy * zz);
  return out;
}

// One codec per packed encoding, its constants computed once
function packedCodec({ rgbMin, rgbMax, lnScaleMin, lnScaleMax }: PackedEncoding) {
  const rgbRange = rgbMax - rgbMin;
  const lnStep = (lnScaleMax - lnScaleMin) / 254;
  const color = (v: number) => Encoding.encodeUnorm8((v - rgbMin) / rgbRange);
  const scale = (v: number) => (v <= 0 ? 0 : Math.max(1, Math.min(255, Math.round((Math.log(v) - lnScaleMin) / lnStep) + 1)));
  const colorOf = (byte: number) => rgbMin + (byte / 255) * rgbRange;
  const scaleOf = (code: number) => (code === 0 ? 0 : Math.exp(lnScaleMin + (code - 1) * lnStep));

  return {
    encode(data: Uint32Array, i4: number, s: Splat) {
      const quat = Encoding.encodeQuatOct24(s.quaternion);
      data[i4] = (color(s.rgb.r) | (color(s.rgb.g) << 8) | (color(s.rgb.b) << 16) | (Encoding.encodeUnorm8(s.opacity) << 24)) >>> 0;
      data[i4 + 1] = (Encoding.encodeHalf(s.center.x) | (Encoding.encodeHalf(s.center.y) << 16)) >>> 0;
      data[i4 + 2] = (Encoding.encodeHalf(s.center.z) | ((quat & 0xffff) << 16)) >>> 0;
      data[i4 + 3] = (scale(s.scales.x) | (scale(s.scales.y) << 8) | (scale(s.scales.z) << 16) | ((quat >>> 16) << 24)) >>> 0;
    },

    decode(data: Uint32Array, i4: number, out: Splat): Splat {
      const x = data[i4];
      const y = data[i4 + 1];
      const z = data[i4 + 2];
      const w = data[i4 + 3];
      out.rgb.r = colorOf(x & 0xff);
      out.rgb.g = colorOf((x >>> 8) & 0xff);
      out.rgb.b = colorOf((x >>> 16) & 0xff);
      out.opacity = (x >>> 24) / 255;

      out.center.x = Encoding.decodeHalf(y & 0xffff);
      out.center.y = Encoding.decodeHalf(y >>> 16);
      out.center.z = Encoding.decodeHalf(z & 0xffff);

      out.scales.x = scaleOf(w & 0xff);
      out.scales.y = scaleOf((w >>> 8) & 0xff);
      out.scales.z = scaleOf((w >>> 16) & 0xff);
      Encoding.decodeQuatOct24((z >>> 16) | ((w >>> 24) << 16), out.quaternion);
      return out;
    },
  };
}

const extWords = (bundle: ExtSplats) => {
  const a = bundle.channels.extA.data;
  return { a, f: Encoding.floatView(a), b: bundle.channels.extB.data };
};

const covWords = (bundle: CovSplats) => {
  const a = bundle.channels.covA.data;
  return { a, f: Encoding.floatView(a), b: bundle.channels.covB.data };
};

const arraysOf = (bundle: ArrayBundle) => Object.fromEntries(Object.entries(bundle.channels).map(([label, channel]) => [label, channel.data])) as Record<string, TypedArray>;

const covScratch: CovSplat = {
  center: { x: 0, y: 0, z: 0 }, cov: { xx: 1, yy: 1, zz: 1, xy: 0, xz: 0, yz: 0 }, rgb: { r: 1, g: 1, b: 1 }, opacity: 1, normal: { x: 0, y: 0, z: 0 },
};

/**
 * Reads, writes, finds and converts splat tables of any layout on the CPU,
 * matching GpuSplats.
 *
 * Methods that take a bundle are typed by it, so they accept only the layouts
 * that store what they read.
 */
export class Splats {
  static readonly EXT = EXT;
  static readonly COV = COV;
  /** The packed layout's bundle, which keeps its PackedEncoding in meta.encoding. */
  static readonly PACKED = PACKED;
  /**
   * A LoD tree in bundle lodTree, one node per splat holding its child count
   * and first child's index.
   */
  static readonly LOD_TREE = LOD_TREE;
  static readonly LAYOUTS = LAYOUTS;
  /** Colors from 0 to 1 and ln scales from -12 to 9. */
  static readonly DEFAULT_PACKED_ENCODING: Readonly<PackedEncoding> = DEFAULT_PACKED_ENCODING;


  /** Makes a unit splat at the origin, white and opaque. */
  static makeSplat(): Splat {
    return { center: { x: 0, y: 0, z: 0 }, scales: { x: 1, y: 1, z: 1 }, quaternion: { x: 0, y: 0, z: 0, w: 1 }, rgb: { r: 1, g: 1, b: 1 }, opacity: 1 };
  }

  /** Makes PBR fields with no normal, roughness 1 and metallic 0. */
  static makePbr(): Pbr {
    return { normal: { x: 0, y: 0, z: 0 }, roughness: 1, metallic: 0 };
  }

  /** Makes an ext splat with the fields of makeSplat and makePbr. */
  static makeExtSplat(): ExtSplat {
    return { ...Splats.makeSplat(), ...Splats.makePbr() };
  }

  /** Makes a unit cov splat at the origin, white and opaque, with no normal. */
  static makeCovSplat(): CovSplat {
    return {
      center: { x: 0, y: 0, z: 0 }, cov: { xx: 1, yy: 1, zz: 1, xy: 0, xz: 0, yz: 0 }, rgb: { r: 1, g: 1, b: 1 },
      opacity: 1, normal: { x: 0, y: 0, z: 0 },
    };
  }


  /** Returns a packed bundle's encoding with the defaults filled in. */
  static packedEncodingOf(bundle: { meta: Record<string, unknown> }): PackedEncoding {
    return { ...DEFAULT_PACKED_ENCODING, ...(bundle.meta.encoding as Partial<PackedEncoding> | undefined) };
  }

  /** Checks whether a bundle has the ext layout's channels. */
  static isExt(bundle: ArrayBundle): bundle is ExtSplats {
    return hasLayout(bundle, "extSplats");
  }

  /** Checks whether a bundle has the cov layout's channels. */
  static isCov(bundle: ArrayBundle): bundle is CovSplats {
    return hasLayout(bundle, "covSplats");
  }

  /** Checks whether a bundle has the packed layout's channels. */
  static isPacked(bundle: ArrayBundle): bundle is PackedSplats {
    return hasLayout(bundle, "packedSplats");
  }

  /** Returns the layout of a splat bundle. */
  static layoutOf(bundle: SplatBundle): SplatLayout;
  /** Returns a bundle's layout, by its channel names and formats. */
  static layoutOf(bundle: BundleLike): SplatLayout | undefined;
  static layoutOf(bundle: BundleLike): SplatLayout | undefined {
    return (Object.keys(LAYOUTS) as SplatLayout[]).find((layout) => hasLayout(bundle, layout));
  }

  /**
   * Finds the splat bundle among the bundles of an ArrayData or GpuArrays.
   *
   * @param [name] The bundle to check. Without it, the standard names come
   *   first, then any bundle of a splat layout.
   */
  static findBundle(bundles: Record<string, BundleLike>, name?: string): { name: string; layout: SplatLayout } | undefined {
    const names = name !== undefined ? [name] : [...Object.keys(LAYOUTS), ...Object.keys(bundles)];
    for (const candidate of names) {
      const bundle = bundles[candidate];
      const layout = bundle && Splats.layoutOf(bundle);
      if (layout) {
        return { name: candidate, layout };
      }
    }
    return undefined;
  }

  /** Finds a table's splat bundle, as findBundle does. */
  static find(data: ArrayData, name?: string): FoundSplats | undefined {
    const found = Splats.findBundle(data.bundles, name);
    return found && { ...found, bundle: data.bundles[found.name] as unknown as SplatBundle };
  }

  /** Gets a table's splat bundle as findBundle finds it, throwing when there is none. */
  static get(data: ArrayData, name?: string): FoundSplats {
    const found = Splats.find(data, name);
    if (!found) {
      throw new Error(name !== undefined ? `Bundle ${name} is not a splat bundle` : "No extSplats, covSplats or packedSplats bundle");
    }
    return found;
  }

  /** Finds the lodTree bundle beside the splats. */
  static findLodTree(data: ArrayData): ArrayBundle<typeof LOD_TREE> | undefined {
    const bundle = data.bundles.lodTree;
    return bundle?.channels.node?.format === "uint32x2" ? (bundle as ArrayBundle<typeof LOD_TREE>) : undefined;
  }

  /** Adds an empty splat bundle named after its layout. */
  static add(data: ArrayData, { layout = "extSplats", encoding }: SplatTarget = {}): SplatBundle {
    const meta = layout === "packedSplats" ? { encoding: { ...DEFAULT_PACKED_ENCODING, ...encoding } } : {};
    data.addBundle(layout, LAYOUTS[layout] as BundleDef, { meta });
    return data.bundles[layout] as unknown as SplatBundle;
  }

  /** Makes a table of empty splats. */
  static make<L extends SplatLayout = "extSplats">(count: number, { meta, ...target }: SplatTarget<L> & {
    meta?: Record<string, unknown>;
  } = {}): SplatData<L> {
    const data = new ArrayData({ count, meta });
    Splats.add(data, target);
    return data as unknown as SplatData<L>;
  }

  /**
   * Returns a table with its splats in another layout, sharing every other
   * bundle's arrays.
   *
   * @param target The layout, and for packedSplats the encoding, by default the
   *   source's.
   * @return data itself when it already is in the layout, else a new table.
   */
  static convert<L extends SplatLayout>(data: ArrayData, { layout, encoding }: SplatTarget<L> & { layout: L }): SplatData<L> {
    const found = Splats.get(data);
    const source = found.layout === "packedSplats" ? Splats.packedEncodingOf(found.bundle) : undefined;
    const sameEncoding = !encoding || layout !== "packedSplats"
      || (source !== undefined && Object.entries(encoding).every(([key, value]) => source[key as keyof PackedEncoding] === value));
    if (found.layout === layout && found.name === layout && sameEncoding) {
      return data as unknown as SplatData<L>;
    }

    const out = new ArrayData({ count: data.count, capacity: data.capacity, meta: { ...data.meta } });
    for (const [name, bundle] of Object.entries(data.bundles)) {
      if (name !== found.name) {
        out.addBundle(name, bundle.def, { data: arraysOf(bundle), meta: bundle.meta });
      }
    }

    if (found.layout === layout && sameEncoding) {
      out.addBundle(layout, found.bundle.def as BundleDef, { data: arraysOf(found.bundle as ArrayBundle), meta: found.bundle.meta });
      return out as unknown as SplatData<L>;
    }

    const decode = Splats.decoder(found.bundle);
    const encode = Splats.encoder(Splats.add(out, { layout, encoding: { ...source, ...encoding } }));
    const s = Splats.makeExtSplat();
    for (let i = 0; i < data.count; i += 1) {
      encode(i, decode(i, s));
    }
    return out as unknown as SplatData<L>;
  }


  /** Writes every field of an ext splat. */
  static encodeExt(bundle: ExtSplats, i: number, s: ExtSplat) {
    const { a, f, b } = extWords(bundle);
    encodeExtWords(a, f, b, i * 4, s);
  }

  /**
   * Reads every field of an ext splat.
   *
   * @return out.
   */
  static decodeExt(bundle: ExtSplats, i: number, out: ExtSplat): ExtSplat {
    const { a, f, b } = extWords(bundle);
    return decodeExtWords(a, f, b, i * 4, out);
  }

  /** Writes every field of a cov splat. */
  static encodeCov(bundle: CovSplats, i: number, c: CovSplat) {
    const { a, f, b } = covWords(bundle);
    encodeCovWords(a, f, b, i * 4, c);
  }

  /**
   * Reads every field of a cov splat.
   *
   * @return out.
   */
  static decodeCov(bundle: CovSplats, i: number, out: CovSplat): CovSplat {
    const { a, f, b } = covWords(bundle);
    return decodeCovWords(a, f, b, i * 4, out);
  }

  /**
   * Writes a packed splat.
   *
   * @param [encoding=Splats.packedEncodingOf(bundle)] The ranges of its codes.
   */
  static encodePacked(bundle: PackedSplats, i: number, s: Splat, encoding = Splats.packedEncodingOf(bundle)) {
    packedCodec(encoding).encode(bundle.channels.packed.data, i * 4, s);
  }

  /**
   * Reads a packed splat.
   *
   * @param [encoding=Splats.packedEncodingOf(bundle)] The ranges of its codes.
   * @return out.
   */
  static decodePacked(bundle: PackedSplats, i: number, out: Splat, encoding = Splats.packedEncodingOf(bundle)): Splat {
    return packedCodec(encoding).decode(bundle.channels.packed.data, i * 4, out);
  }


  /**
   * Reads the 3DGS fields of a splat in any layout, diagonalizing cov splats.
   *
   * @return out.
   */
  static load(bundle: SplatBundle, i: number, out: Splat): Splat {
    if (isExtBundle(bundle)) {
      const { a, f, b } = extWords(bundle);
      return loadExtFields(a, f, b, i * 4, out);
    }
    if (isCovBundle(bundle)) {
      return Splats.fromCov(Splats.decodeCov(bundle, i, covScratch), out);
    }
    return Splats.decodePacked(bundle, i, out);
  }

  /** Writes the 3DGS fields of a splat in any layout, keeping ext's PBR bits and cov's normal. */
  static store(bundle: SplatBundle, i: number, s: Splat) {
    if (isExtBundle(bundle)) {
      const { a, f, b } = extWords(bundle);
      storeExtFields(a, f, b, i * 4, s);
    } else if (isCovBundle(bundle)) {
      const { a, f, b } = covWords(bundle);
      storeCovFields(a, f, b, i * 4, s.center, SplatMath.covFromScaleQuat(s.scales, s.quaternion, covScratch.cov), s.rgb, s.opacity);
    } else {
      Splats.encodePacked(bundle, i, s);
    }
  }

  /**
   * Reads the PBR fields of an ext splat.
   *
   * @return out.
   */
  static loadPbr(bundle: ExtSplats, i: number, out: Pbr): Pbr {
    return loadExtPbr(bundle.channels.extA.data, bundle.channels.extB.data, i * 4, out);
  }

  /** Writes the PBR fields of an ext splat, keeping its 3DGS bits. */
  static storePbr(bundle: ExtSplats, i: number, p: Pbr) {
    storeExtPbr(bundle.channels.extA.data, bundle.channels.extB.data, i * 4, p);
  }

  /**
   * Reads the center of a splat in any layout.
   *
   * @return out.
   */
  static loadCenter(bundle: SplatBundle, i: number, out: Vec3): Vec3 {
    if (isExtBundle(bundle)) {
      return loadCenterA(Encoding.floatView(bundle.channels.extA.data), i * 4, out);
    }
    if (isCovBundle(bundle)) {
      return loadCenterA(Encoding.floatView(bundle.channels.covA.data), i * 4, out);
    }
    const data = bundle.channels.packed.data;
    out.x = Encoding.decodeHalf(data[i * 4 + 1] & 0xffff);
    out.y = Encoding.decodeHalf(data[i * 4 + 1] >>> 16);
    out.z = Encoding.decodeHalf(data[i * 4 + 2] & 0xffff);
    return out;
  }

  /**
   * Returns a function that writes every field the layout stores, made once for
   * a loop over splats.
   */
  static encoder(bundle: SplatBundle): (i: number, s: ExtSplat) => void {
    if (isExtBundle(bundle)) {
      const { a, f, b } = extWords(bundle);
      return (i, s) => encodeExtWords(a, f, b, i * 4, s);
    }
    if (isCovBundle(bundle)) {
      const { a, f, b } = covWords(bundle);
      const cov = Splats.makeCovSplat();
      return (i, s) => {
        Splats.toCov(s, cov);
        cov.normal.x = s.normal.x;
        cov.normal.y = s.normal.y;
        cov.normal.z = s.normal.z;
        encodeCovWords(a, f, b, i * 4, cov);
      };
    }
    const data = bundle.channels.packed.data;
    const codec = packedCodec(Splats.packedEncodingOf(bundle));
    return (i, s) => codec.encode(data, i * 4, s);
  }

  /**
   * Returns a function that reads every field of a splat, made once for a loop
   * over splats, with no normal, roughness 1 and metallic 0 where the layout
   * lacks them.
   */
  static decoder(bundle: SplatBundle): (i: number, out: ExtSplat) => ExtSplat {
    if (isExtBundle(bundle)) {
      const { a, f, b } = extWords(bundle);
      return (i, out) => decodeExtWords(a, f, b, i * 4, out);
    }
    const noPbr = (out: ExtSplat, normal?: Vec3) => {
      out.normal.x = normal?.x ?? 0;
      out.normal.y = normal?.y ?? 0;
      out.normal.z = normal?.z ?? 0;
      out.roughness = 1;
      out.metallic = 0;
      return out;
    };
    if (isCovBundle(bundle)) {
      const { a, f, b } = covWords(bundle);
      const cov = Splats.makeCovSplat();
      return (i, out) => {
        Splats.fromCov(decodeCovWords(a, f, b, i * 4, cov), out);
        return noPbr(out, cov.normal);
      };
    }
    const data = bundle.channels.packed.data;
    const codec = packedCodec(Splats.packedEncodingOf(bundle));
    return (i, out) => noPbr(codec.decode(data, i * 4, out) as ExtSplat);
  }


  /**
   * Converts a splat to its covariance form, leaving out.normal as is.
   *
   * @return out.
   */
  static toCov(s: Splat, out: CovSplat): CovSplat {
    out.center.x = s.center.x;
    out.center.y = s.center.y;
    out.center.z = s.center.z;
    out.rgb.r = s.rgb.r;
    out.rgb.g = s.rgb.g;
    out.rgb.b = s.rgb.b;
    out.opacity = s.opacity;
    SplatMath.covFromScaleQuat(s.scales, s.quaternion, out.cov);
    return out;
  }

  /**
   * Diagonalizes a cov splat into scales and a rotation, dropping its normal.
   *
   * @return out.
   */
  static fromCov(c: CovSplat, out: Splat): Splat {
    const { values, basis } = SplatMath.symEigens(c.cov);
    out.center.x = c.center.x;
    out.center.y = c.center.y;
    out.center.z = c.center.z;
    out.rgb.r = c.rgb.r;
    out.rgb.g = c.rgb.g;
    out.rgb.b = c.rgb.b;
    out.opacity = c.opacity;
    out.scales.x = Math.sqrt(Math.max(values.x, 0));
    out.scales.y = Math.sqrt(Math.max(values.y, 0));
    out.scales.z = Math.sqrt(Math.max(values.z, 0));
    SplatMath.basisToQuat(basis, out.quaternion);
    return out;
  }
}
