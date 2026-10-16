// WinQuake surface lighting inside the generators (a renderer modifier costs
// several times more on WebGL2): world objects draw through worldGenerator
// (their LoD lists, remapped), whose bind sets each object's mode, styles
// and effect before its dispatch; models.ts lights models with the same
// colormap LUT and surfaceLight.
//
// The bake stores raw palette colors with the lightmap in two bytes of each
// splat (Radix roughness = the bake's `extra`, metallic = its
// `metallic`):
//   mode static: metallic = lightmap of styles[0], extra = 255 for fullbright texels
//   mode styles: metallic = lightmap of styles[0], extra = lightmap of styles[1]
//   mode unlit:  liquids, sky (metallic / extra carry sky texcoords)
// The shader reproduces R_BuildLightMap:
//   light = sum(lightmap_i * style_i / 256) + sum(max(0, radius - dist))
//   row   = (255 - clamp(light, 0, 255)) / 4   (colormap row, 0 bright .. 63 dark)
// and the row becomes a brightness factor through the 64-entry LUT of the
// colormap's mean luminance ratio per row (scene.json lightLut). Time-driven
// looks: the scrolling sky (two layers, r_sky.c), liquid turbulence
// (D_DrawTurbulent8Span's sine shift, inverted onto the splats) and the
// underwater warp (D_WarpScreen: the splats' tan-angle view coordinates get
// the screen warp's sines at their own depth, so sizes and sort order stay).
import * as THREE from "three";
import type { WebGPURenderer } from "three/webgpu";
import { ArrayData, GpuArrayReader, GpuArrays, GpuExtSplatReader, TSL, defineBundle, type SplatGenerator, type SplatNode, type TslNode } from "@sparkjsdev/radix";
import { LIGHTSTYLE_NORMAL, MAX_LIGHTSTYLES } from "./sim/QuakeSim.js";

const { If, Loop, clamp, float, floor, int, length, max, min, mix, mod, select, sin, uint, uniform, vec2, vec4 } = TSL;

export type LightMode = "static" | "styles" | "unlit";
export type SurfaceEffect = "none" | "sky" | "liquid";

export interface LightingOptions {
  enabled: boolean;
  // Sky scrolling and liquid turbulence
  effects: boolean;
  // Integer colormap rows like vanilla (banding) instead of interpolating
  quantize: boolean;
  dlights: boolean;
  // Animated light styles (off: every style at 'm')
  styles: boolean;
  // Undulate the world while the view is underwater (r_waterwarp)
  waterWarp: boolean;
}

// One world object's lighting, read at its dispatch
export interface SurfaceLight {
  mode: LightMode;
  styles: [number, number];
  effect: SurfaceEffect;
  matrixWorld: THREE.Matrix4;
}

// A world object's data: its splats (read at each dispatch: undefined once
// freed, which draws nothing) and lighting, and the selection's index list
export interface WorldData {
  source: { readonly splats?: GpuArrays; readonly light: SurfaceLight };
  indices: GpuArrays;
}

const MODE = { static: 0, styles: 1, unlit: 2 } as const;
const EFFECT = { none: 0, sky: 1, liquid: 2 } as const;
// r_sky.c: the back layer scrolls at skyspeed texels/s, the front at twice that
const SKY_SPEED = 8;
const SKY_SIZE = 128;
// d_scan.c turbulence: AMP 8 texels, CYCLE 128, SPEED 20
const TURB_AMP = 8;
const TURB_CYCLE = 128;
const TURB_SPEED = 20;
// D_WarpScreen: AMP2 3 pixels of the 320-wide view, whose 90 degree fov puts
// 160 pixels per unit of tan(angle)
const WARP_AMP = 3 / 160;
const WARP_PIXELS_PER_TAN = 160;
const LUT_ROWS = 64;
const MAX_DLIGHTS = 32;

const VALUES = defineBundle({ value: "float32x4" });
const TEXELS = defineBundle({ rgba: "uint8x4" });

export class QuakeLighting {
  options: LightingOptions = { enabled: true, effects: true, quantize: false, dlights: true, styles: true, waterWarp: true };
  // Game time (cl.time) for the sky and liquid effects
  time = 0;
  // The view is inside water / slime / lava: the warp shows
  underwater = false;
  readonly generator: SplatGenerator<WorldData>;

  private readonly styleValues = new Float32Array(MAX_LIGHTSTYLES).fill(LIGHTSTYLE_NORMAL);
  private readonly lutData = new ArrayData({ count: LUT_ROWS }).addBundle("values", VALUES);
  private readonly dlightData = new ArrayData({ count: MAX_DLIGHTS }).addBundle("values", VALUES);
  private readonly skyData = new ArrayData({ count: 256 * 128 }).addBundle("texels", TEXELS);
  private readonly lut: GpuArrays;
  private readonly dlights: GpuArrays;
  private readonly sky: GpuArrays;
  private readonly lutReader = new GpuArrayReader(VALUES);
  private readonly dlightReader = new GpuArrayReader(VALUES);
  private readonly skyReader = new GpuArrayReader(TEXELS);
  // Shared by every program that lights (world, models)
  private readonly u = {
    enabled: uniform(1, "int"),
    quantize: uniform(0, "int"),
    dlights: uniform(0, "uint"),
    units: uniform(32),
    time: uniform(0),
    warp: uniform(0),
    view: uniform(new THREE.Matrix4()),
    viewInverse: uniform(new THREE.Matrix4()),
  };
  // Per world object (worldGenerator's bind)
  private readonly object = {
    mode: uniform(0, "int"),
    style0: uniform(LIGHTSTYLE_NORMAL),
    style1: uniform(0),
    effect: uniform(0, "int"),
    toWorld: uniform(new THREE.Matrix4()),
    toObject: uniform(new THREE.Matrix4()),
  };

  constructor(renderer: WebGPURenderer) {
    this.setLut(Array.from({ length: LUT_ROWS }, (_, i) => (LUT_ROWS - i) / 32));
    this.lut = GpuArrays.fromData(renderer, this.lutData);
    this.dlights = GpuArrays.fromData(renderer, this.dlightData);
    this.sky = GpuArrays.fromData(renderer, this.skyData);
    this.lutReader.bind(this.lut, "values");
    this.dlightReader.bind(this.dlights, "values");
    this.skyReader.bind(this.sky, "texels");
    this.generator = this.worldGenerator();
  }

  set unitsPerMeter(units: number) {
    this.u.units.value = units;
  }

  // Brightness factor per colormap row (scene.json lightLut)
  setLut(levels: ArrayLike<number>) {
    const values = this.lutData.bundles.values.channels.value.data;
    for (let i = 0; i < LUT_ROWS; i += 1) {
      values.fill(i < levels.length ? levels[i] : 0, i * 4, i * 4 + 4);
    }
    this.lut?.upload(this.lutData);
  }

  // The 256x128 RGBA sky (scene.json skyRgba, base64), or none
  setSky(base64?: string) {
    const texels = this.skyData.bundles.texels.channels.rgba.data;
    texels.fill(0);
    if (base64) {
      const binary = atob(base64);
      for (let i = 0; i < binary.length && i < texels.length; i += 1) {
        texels[i] = binary.charCodeAt(i);
      }
    }
    this.sky.upload(this.skyData);
  }

  setStyles(values: ArrayLike<number>) {
    for (let i = 0; i < MAX_LIGHTSTYLES; i += 1) {
      this.styleValues[i] = i < values.length ? values[i] : LIGHTSTYLE_NORMAL;
    }
  }

  styleValue(style: number) {
    if (!this.options.styles || !(style >= 0 && style < MAX_LIGHTSTYLES)) {
      return LIGHTSTYLE_NORMAL;
    }
    return this.styleValues[style];
  }

  // Dynamic lights: positions in meters (three's frame), radius in units
  setDlights(lights: { x: number; y: number; z: number; radius: number }[]) {
    const count = Math.min(MAX_DLIGHTS, lights.length);
    const values = this.dlightData.bundles.values.channels.value.data;
    lights.slice(0, count).forEach((light, i) => values.set([light.x, light.y, light.z, light.radius], i * 4));
    this.u.dlights.value = count;
    if (count > 0) {
      this.dlights.upload(this.dlightData);
    }
  }

  // The frame's globals, after the camera is placed
  update(camera: THREE.Camera) {
    const { options, u } = this;
    u.enabled.value = options.enabled ? 1 : 0;
    u.quantize.value = options.quantize ? 1 : 0;
    if (!options.dlights) {
      u.dlights.value = 0;
    }
    u.time.value = this.time;
    u.warp.value = options.waterWarp && this.underwater ? WARP_AMP : 0;
    camera.updateMatrixWorld();
    u.viewInverse.value.copy(camera.matrixWorld);
    u.view.value.copy(camera.matrixWorld).invert();
  }

  // Colormap row 0..63 -> brightness factor (interpolated unless quantized)
  lutFactor(rowIn: TslNode): TslNode {
    const row = clamp(rowIn, 0.0, float(LUT_ROWS - 1)).toVar();
    If(this.u.quantize.equal(int(1)), () => {
      row.assign(floor(row));
    });
    const lo = uint(floor(row)).toVar();
    const hi = min(lo.add(uint(1)), uint(LUT_ROWS - 1));
    return mix(this.lutReader.fetch("value", lo).x, this.lutReader.fetch("value", hi).x, row.sub(floor(row)));
  }

  // Brightness factor for a light value 0..255 (R_AliasSetupLighting's)
  lightFactor(light: TslNode): TslNode {
    return this.lutFactor(float(255.0).sub(clamp(light, 0.0, 255.0)).div(4.0));
  }

  // R_BuildLightMap + R_AddDynamicLights: lightmap bytes (0..255) scaled by
  // the style values (256 = 1) plus every dynamic light in reach of `world`
  // (meters), as the brightness factor
  surfaceLight(world: TslNode, lightmap0: TslNode, lightmap1: TslNode, style0: TslNode, style1: TslNode): TslNode {
    const { u } = this;
    const light = lightmap0.mul(style0).add(lightmap1.mul(style1)).div(256.0).toVar();
    Loop({ start: uint(0), end: u.dlights, type: "uint", condition: "<" }, ({ i }: { i: TslNode }) => {
      const dl = this.dlightReader.fetch("value", i).toVar();
      light.addAssign(max(dl.w.sub(length(world.sub(dl.xyz)).mul(u.units)), 0.0));
    });
    return this.lightFactor(light);
  }

  get enabledNode(): TslNode {
    return this.u.enabled.equal(int(1));
  }

  // Lights, scrolls or warps one world splat (object space in and out);
  // lightmap bytes `m` (metallic) and `e` (roughness, the bake's extra)
  private shade(splat: SplatNode, m: TslNode, e: TslNode) {
    const { u, object: o } = this;
    const rgb = splat.get("rgb");
    const center = splat.get("center");
    const world = o.toWorld.mul(vec4(center, 1.0)).xyz.toVar();

    If(this.enabledNode.and(o.mode.notEqual(int(MODE.unlit))), () => {
      const fullbright = o.mode.equal(int(MODE.static)).and(e.greaterThan(254.5));
      If(fullbright.not(), () => {
        const second = select(o.mode.equal(int(MODE.styles)), e, float(0.0));
        rgb.mulAssign(this.surfaceLight(world, m, second, o.style0, o.style1));
      });
    });

    // Sky: the two scrolling layers at this splat's texel (front wins where opaque)
    If(o.effect.equal(int(EFFECT.sky)), () => {
      const scroll = u.time.mul(SKY_SPEED);
      const base = vec2(m, e).div(255.0).mul(SKY_SIZE);
      const back = mod(base.add(scroll), SKY_SIZE);
      const front = mod(base.add(scroll.mul(2.0)), SKY_SIZE);
      const texel = (x: TslNode, y: TslNode) => vec4(this.skyReader.fetch("rgba", uint(y).mul(uint(256)).add(uint(x)))).div(255.0);
      const frontTexel = texel(front.x, front.y).toVar();
      const backTexel = texel(back.x.add(SKY_SIZE), back.y);
      rgb.assign(mix(backTexel.rgb, frontTexel.rgb, frontTexel.a));
    });

    // Liquids: move the texel's splat by the inverse of the turbulent shift
    // (map units; world x / z stand in for the texture axes)
    If(o.effect.equal(int(EFFECT.liquid)), () => {
      const s = world.x.mul(u.units);
      const t = world.z.mul(u.units);
      const phase = u.time.mul(TURB_SPEED);
      const cycle = float((Math.PI * 2) / TURB_CYCLE);
      world.x.subAssign(sin(t.add(phase).mul(cycle)).mul(TURB_AMP).div(u.units));
      world.z.subAssign(sin(s.add(phase).mul(cycle)).mul(TURB_AMP).div(u.units));
    });

    // Underwater: x by a sine of y and y by a sine of x, in tan units at the
    // splat's own depth
    If(u.warp.greaterThan(0.0), () => {
      const view = u.view.mul(vec4(world, 1.0)).toVar();
      const depth = view.z.negate().toVar();
      If(depth.greaterThan(0.01), () => {
        const tu = view.x.div(depth).toVar();
        const tv = view.y.div(depth).toVar();
        const phase = u.time.mul(TURB_SPEED);
        const cycle = float((Math.PI * 2) / TURB_CYCLE);
        const du = sin(tv.mul(WARP_PIXELS_PER_TAN).add(phase).mul(cycle)).mul(u.warp);
        const dv = sin(tu.mul(WARP_PIXELS_PER_TAN).add(phase).mul(cycle)).mul(u.warp);
        world.assign(u.viewInverse.mul(vec4(tu.add(du).mul(depth), tv.add(dv).mul(depth), view.z, 1.0)).xyz);
      });
    });
    center.assign(o.toObject.mul(vec4(world, 1.0)).xyz);
  }

  // Stored splats through an index list (a LoD selection), lit per object
  private worldGenerator(): SplatGenerator<WorldData> {
    const reader = new GpuExtSplatReader();
    const list = new GpuArrayReader(ArrayData.INDICES);
    const o = this.object;
    return {
      generateSplat: (i) => {
        const at = list.load("index", i);
        const splat = reader.loadSplat(at).toVar();
        const bz = reader.load("extB", at).z;
        this.shade(splat, float(bz.shiftRight(uint(24))), float(bz.shiftRight(uint(16)).bitAnd(uint(0xff))));
        return splat;
      },
      bind: ({ source: { splats, light }, indices }) => {
        reader.bind(splats);
        list.bind(indices, "indices");
        o.mode.value = MODE[light.mode];
        o.style0.value = this.styleValue(light.styles[0]);
        o.style1.value = light.styles[1] >= 0 ? this.styleValue(light.styles[1]) : 0;
        o.effect.value = this.options.effects ? EFFECT[light.effect] : EFFECT.none;
        o.toWorld.value.copy(light.matrixWorld);
        o.toObject.value.copy(light.matrixWorld).invert();
      },
    };
  }
}
