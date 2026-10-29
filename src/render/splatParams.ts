import { GpuSh } from "../gpu/sh.tsl";
import { TSL } from "../gpu/tsl";

const { uniform } = TSL;

// What every splat drawn together shares (a SplatRenderer's params, a
// view's over them): the draw reads these too
export interface SplatViewParams {
  // Gaussian extent drawn, in standard deviations
  maxStdDev: number;
  // Fragments and splats below this alpha are dropped
  minAlpha: number;
  // 1: Gaussian falloff; 0: flat discs
  falloff: number;
}

// What each object is projected with (a SplatRenderer's objectParams, a
// view's over them, a splat object's over both)
export interface SplatObjectParams {
  // LoD opacities above 1 grow the splat instead of its opacity
  lodInflate: boolean;
  // Anti-aliasing blur in pixel area units, with opacity compensation
  blurAmount: number;
  preBlurAmount: number;
  // Centers farther than this outside the frustum (in NDC) are culled
  clipXY: number;
  minPixelRadius: number;
  maxPixelRadius: number;
  // ewa: splats whose drawn weight (opacity x 2D Gaussian area in pixels,
  // 2 pi sqrt(det)) is below this are culled; 0 keeps them all
  minContribution: number;
  // Depth of field: distance to the focal plane and tan of half the aperture angle
  focalDistance: number;
  apertureTan: number;
  // For the CPU sort: splats outside the head's view widened by this much
  // (NDC beyond the edges, plus their reach) get the invalid key, so the
  // sort orders and the draw draws fewer; 0 keeps them all. Its order lags
  // the camera, so re-sort when the view turns, not only moves
  sortGuard: number;
  // Highest spherical-harmonics band drawn (0 to 4): caps an object's SH
  // below its generator's degree without compiling anything
  maxShDegree: number;
}

// The params as the uniforms the projection and the draw read: one set,
// shared by every program, set before each dispatch and draw (three gives
// each program and draw its own copy of the values)
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

  // `params`, with `overrides` on top
  static setObject(params: SplatObjectParams, overrides?: Partial<SplatObjectParams>) {
    for (const key of Object.keys(SplatParams.OBJECT) as (keyof SplatObjectParams)[]) {
      (nodes[key] as { value: unknown }).value = overrides?.[key] ?? params[key];
    }
  }
}
