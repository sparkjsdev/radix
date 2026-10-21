import type { BundleDef } from "../core/bundles";
import { Splats, type BundleLike, type SplatLayout } from "../core/splats";
import { GpuArrayReader } from "./GpuArrayReader";
import type { GpuArrays } from "./GpuArrays";
import { GpuEncoding } from "./encoding.tsl";
import { GpuSplats, type CovSplatNode, type PbrNode, type SplatNode } from "./splats.tsl";
import { TSL, type TslNode } from "./tsl";

const { float, uint, uintBitsToFloat, uniform, vec3, vec4 } = TSL;

// name, else the standard name, else any bundle of the layout
function splatBundleName(arrays: GpuArrays, layout: SplatLayout, name?: string) {
  const bundles = arrays.bundles as Record<string, BundleLike>;
  const match = (name !== undefined ? [name] : [layout, ...Object.keys(bundles)]).find((n) => bundles[n] && Splats.layoutOf(bundles[n]) === layout);
  if (match === undefined) {
    throw new Error(name !== undefined ? `Bundle ${name} is not ${layout}` : `No ${layout} bundle in these arrays`);
  }
  return match;
}

/** Splat reads in TSL, one class per layout, whose loads read zero past count and set the index. */
export abstract class GpuSplatReader<D extends BundleDef = BundleDef> extends GpuArrayReader<D> {
  abstract readonly layout: SplatLayout;

  /** A reader of a layout, bound to nothing. */
  static for(layout: "extSplats"): GpuExtSplatReader;
  static for(layout: "covSplats"): GpuCovSplatReader;
  static for(layout: "packedSplats"): GpuPackedSplatReader;
  static for(layout: SplatLayout): AnyGpuSplatReader;
  static for(layout: SplatLayout): AnyGpuSplatReader {
    return layout === "extSplats" ? new GpuExtSplatReader() : layout === "covSplats" ? new GpuCovSplatReader() : new GpuPackedSplatReader();
  }

  /**
   * A reader bound to a splat bundle of arrays. Narrow it by layout.
   *
   * @param [name] The bundle, by default a standard name, else any splat
   *   bundle.
   */
  static from(arrays: GpuArrays, name?: string): AnyGpuSplatReader {
    const found = Splats.findBundle(arrays.bundles as Record<string, BundleLike>, name);
    if (!found) {
      throw new Error(name !== undefined ? `Bundle ${name} is not a splat bundle` : "No extSplats, covSplats or packedSplats bundle in these arrays");
    }
    return GpuSplatReader.for(found.layout).bind(arrays, found.name);
  }

  /**
   * Reads a splat bundle of arrays from now on.
   *
   * @param [arrays] The arrays, or none to read zero.
   * @param [name] The bundle, by default the layout's standard one, else any of
   *   the layout.
   */
  bind(arrays?: GpuArrays, name?: string): this {
    return super.bind(arrays, arrays && splatBundleName(arrays, this.layout, name));
  }

  /** Loads a splat in 3DGS form, converting when the layout stores covariances. */
  abstract loadSplat(index: TslNode): SplatNode;
  /** Loads a splat in covariance form, converting when the layout stores 3DGS splats. */
  abstract loadCovSplat(index: TslNode): CovSplatNode;
  abstract loadCenter(index: TslNode): TslNode;
  /** Loads a splat's base color. */
  abstract loadRgb(index: TslNode): TslNode;
  abstract loadOpacity(index: TslNode): TslNode;
}

/** Reads extSplats bundles. */
export class GpuExtSplatReader extends GpuSplatReader<typeof Splats.EXT> {
  readonly layout = "extSplats";

  /** Builds an extSplats reader, bound to nothing. */
  constructor() {
    super(Splats.EXT);
  }

  loadSplat(index: TslNode) {
    return GpuSplats.withIndex(GpuSplats.decodeExt(this.load("extA", index), this.load("extB", index)), index);
  }

  loadCovSplat(index: TslNode) {
    return GpuSplats.toCov(this.loadSplat(index));
  }

  loadPbr(index: TslNode): PbrNode {
    return GpuSplats.decodeExtPbr(this.load("extA", index), this.load("extB", index));
  }

  loadCenter(index: TslNode) {
    return uintBitsToFloat(this.load("extA", index).xyz);
  }

  loadRgb(index: TslNode) {
    return GpuEncoding.decodeExtRgb(this.load("extB", index).x);
  }

  loadOpacity(index: TslNode) {
    return GpuEncoding.decodeLodOpacity(this.load("extA", index).w.shiftRight(uint(24)));
  }
}

/** Reads covSplats bundles. */
export class GpuCovSplatReader extends GpuSplatReader<typeof Splats.COV> {
  readonly layout = "covSplats";

  /** Builds a covSplats reader, bound to nothing. */
  constructor() {
    super(Splats.COV);
  }

  /** Loads a splat in 3DGS form, by a Jacobi eigen decomposition per call. */
  loadSplat(index: TslNode) {
    return GpuSplats.fromCov(this.loadCovSplat(index));
  }

  loadCovSplat(index: TslNode) {
    return GpuSplats.withIndex(GpuSplats.decodeCov(this.load("covA", index), this.load("covB", index)), index);
  }

  loadCenter(index: TslNode) {
    return uintBitsToFloat(this.load("covA", index).xyz);
  }

  loadRgb(index: TslNode) {
    return GpuEncoding.decodeExtRgb(this.load("covB", index).x);
  }

  loadOpacity(index: TslNode) {
    return GpuEncoding.decodeLodOpacity(this.load("covA", index).w.shiftRight(uint(24)));
  }
}

/** Reads packedSplats bundles. */
export class GpuPackedSplatReader extends GpuSplatReader<typeof Splats.PACKED> {
  readonly layout = "packedSplats";
  /** vec4(rgbMin, rgbMax, lnScaleMin, lnScaleMax), set by bind. */
  readonly encoding: TslNode;

  /** Builds a packedSplats reader, bound to nothing. */
  constructor() {
    super(Splats.PACKED);
    const { rgbMin, rgbMax, lnScaleMin, lnScaleMax } = Splats.DEFAULT_PACKED_ENCODING;
    this.encoding = uniform(vec4(rgbMin, rgbMax, lnScaleMin, lnScaleMax));
  }

  /**
   * Reads a splat bundle of arrays from now on.
   *
   * @param [arrays] The arrays, or none to read zero.
   * @param [name] The bundle, by default the layout's standard one, else any of
   *   the layout.
   */
  bind(arrays?: GpuArrays, name?: string): this {
    const bundle = arrays && splatBundleName(arrays, this.layout, name);
    super.bind(arrays, bundle);
    const { rgbMin, rgbMax, lnScaleMin, lnScaleMax } = arrays && bundle ? Splats.packedEncodingOf(arrays.bundle(bundle)) : Splats.DEFAULT_PACKED_ENCODING;
    this.encoding.value.set(rgbMin, rgbMax, lnScaleMin, lnScaleMax);
    return this;
  }

  loadSplat(index: TslNode) {
    return GpuSplats.withIndex(GpuSplats.decodePacked(this.load("packed", index), this.encoding), index);
  }

  loadCovSplat(index: TslNode) {
    return GpuSplats.toCov(this.loadSplat(index));
  }

  loadCenter(index: TslNode) {
    const p = this.load("packed", index).toVar();
    return vec3(GpuEncoding.decodeHalf(p.y), GpuEncoding.decodeHalf(p.y.shiftRight(uint(16))), GpuEncoding.decodeHalf(p.z));
  }

  loadRgb(index: TslNode) {
    return this.loadSplat(index).get("rgb");
  }

  loadOpacity(index: TslNode) {
    return float(this.load("packed", index).x.shiftRight(uint(24))).div(255.0);
  }
}

/** A reader of any layout, narrowed by layout. */
export type AnyGpuSplatReader = GpuExtSplatReader | GpuCovSplatReader | GpuPackedSplatReader;
