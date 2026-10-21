import { GpuSh } from "../gpu/sh.tsl";
import { TSL } from "../gpu/tsl";

const { uniform } = TSL;

/** Params every splat of a render shares, since the draw reads them too. */
export interface SplatViewParams {
  /**
   * How far each Gaussian is drawn, in standard deviations.
   *
   * @default Math.sqrt(8)
   */
  maxStdDev: number;
  /**
   * The alpha below which fragments and splats are dropped.
   *
   * @default 0.5 / 255
   */
  minAlpha: number;
  /**
   * 1 for Gaussian falloff, 0 for flat discs.
   *
   * @default 1
   */
  falloff: number;
}

/** Params per object, over the view's and the renderer's. */
export interface SplatObjectParams {
  /**
   * Whether LoD opacities above 1 grow the splat instead of its opacity.
   *
   * @default true
   */
  lodInflate: boolean;
  /**
   * The anti-aliasing blur with opacity compensation, in pixel area units.
   *
   * @default 0.3
   */
  blurAmount: number;
  /**
   * The blur without opacity compensation, in pixel area units.
   *
   * @default 0
   */
  preBlurAmount: number;
  /**
   * How far outside the frustum splat centers are kept, in NDC.
   *
   * @default 1.4
   */
  clipXY: number;
  /**
   * The radius below which splats are culled, in pixels.
   *
   * @default 0
   */
  minPixelRadius: number;
  /**
   * The largest radius drawn, in pixels.
   *
   * @default 512
   */
  maxPixelRadius: number;
  /**
   * The opacity times area in pixels below which ewa culls a splat.
   *
   * @default 0
   */
  minContribution: number;
  /**
   * The distance to the depth of field's focal plane, or 0 for none.
   *
   * @default 0
   */
  focalDistance: number;
  /**
   * The tangent of half the aperture angle, or 0 for no depth of field.
   *
   * @default 0
   */
  apertureTan: number;
  /**
   * How far outside the view the CPU sort keeps splats, in NDC plus their
   * reach, or 0 for no limit. With it set, re-sort when the view turns.
   *
   * @default 0
   */
  sortGuard: number;
  /**
   * The highest spherical-harmonics band drawn, 0 to 4.
   *
   * @default 4
   */
  maxShDegree: number;
}

// Shared by every program and draw, and set before each, since three gives each its own copy
const nodes = {
  minAlpha: uniform(0.5 / 255),
  maxStdDev: uniform(Math.sqrt(8)),
  falloff: uniform(1),
  lodInflate: uniform(true),
  blurAmount: uniform(0.3),
  preBlurAmount: uniform(0),
  clipXY: uniform(1.4),
  minPixelRadius: uniform(0),
  maxPixelRadius: uniform(512),
  minContribution: uniform(0),
  focalDistance: uniform(0),
  apertureTan: uniform(0),
  sortGuard: uniform(0),
  maxShDegree: GpuSh.maxDegree,
};

export type SplatParamNodes = typeof nodes;

export class SplatParams {
  static readonly VIEW: Readonly<SplatViewParams> = { maxStdDev: Math.sqrt(8), minAlpha: 0.5 / 255, falloff: 1 };
  static readonly OBJECT: Readonly<SplatObjectParams> = {
    lodInflate: true, blurAmount: 0.3, preBlurAmount: 0, clipXY: 1.4, minPixelRadius: 0, maxPixelRadius: 512, minContribution: 0, focalDistance: 0, apertureTan: 0, sortGuard: 0,
    maxShDegree: 4,
  };

  static readonly nodes = nodes;

  static setView(params: SplatViewParams) {
    nodes.maxStdDev.value = params.maxStdDev;
    nodes.minAlpha.value = params.minAlpha;
    nodes.falloff.value = params.falloff;
  }

  static setObject(params: SplatObjectParams, overrides?: Partial<SplatObjectParams>) {
    for (const key of Object.keys(SplatParams.OBJECT) as (keyof SplatObjectParams)[]) {
      (nodes[key] as { value: unknown }).value = overrides?.[key] ?? params[key];
    }
  }
}
