// HDR output. Two independent pieces:
//
// - The HDR canvas (WebGPU backend only): createRenderer({ hdr }) configures
//   the canvas as rgba16float with extended tone mapping, so values above 1
//   show brighter than SDR white on HDR displays (Chrome 129+). The canvas
//   stays "srgb": its values are sRGB-encoded, so colors drawn straight to
//   it blend as they would on an SDR canvas. Hdr.setOutput() turns the
//   extended range off and on without recreating anything.
//
// - Headroom tone mapping (both backends): Hdr.useToneMapping() makes three
//   render into its float framebuffer target and compresses the finished
//   frame into [0, headroom] in its output pass: untouched below the knee, a
//   smooth shoulder above it, and colors past the headroom fading to white
//   instead of clipping per channel. headroom 1 is SDR tone mapping. The
//   target holds what the canvas would without it (splats blend
//   sRGB-encoded colors, as they were trained), so the pass decodes sRGB
//   first and three encodes the result: below the knee the frame is the
//   one without tone mapping.
//
// There is no web API for the display's actual headroom yet; pick one (about
// 2 to 8 on current HDR laptops and monitors) or expose it as a setting.
import * as THREE from "three";
import type { WebGPURenderer } from "three/webgpu";
import { backendOf } from "./backend";
import { TSL, type TslNode } from "./tsl";

const { Fn, clamp, exp, float, max, mix, select, sRGBTransferEOTF, uniform, vec3 } = TSL;

// Whether the display reports high dynamic range (the browser also needs to)
function displaySupportsHdr(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(dynamic-range: high)").matches === true;
}

interface HdrBackend {
  isWebGPUBackend?: boolean;
  device?: GPUDevice;
  context?: GPUCanvasContext;
  parameters: { outputType?: number; alpha?: boolean };
}

// The canvas can show the extended range: WebGPU with an rgba16float canvas
// (createRenderer({ hdr })) and a browser that kept the extended mode
function canvasSupportsHdr(renderer: WebGPURenderer): boolean {
  const backend = backendOf(renderer) as unknown as HdrBackend;
  if (!backend.isWebGPUBackend || backend.parameters.outputType !== THREE.HalfFloatType) {
    return false;
  }
  // Browsers without canvas tone mapping drop the member from the configuration
  const configuration = (backend.context as unknown as { getConfiguration?(): GPUCanvasConfiguration | null } | undefined)?.getConfiguration?.();
  return !configuration || (configuration as { toneMapping?: { mode?: string } }).toneMapping !== undefined;
}

// Extended (true) or standard (false) range on an HDR-capable canvas; false
// if the canvas cannot (see Hdr.canvasSupports)
function setHdrOutput(renderer: WebGPURenderer, extended: boolean): boolean {
  if (!canvasSupportsHdr(renderer)) {
    return false;
  }
  const backend = backendOf(renderer) as unknown as HdrBackend;
  backend.context!.configure({
    device: backend.device!,
    format: "rgba16float",
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    alphaMode: backend.parameters.alpha ? "premultiplied" : "opaque",
    toneMapping: { mode: extended ? "extended" : "standard" },
  } as GPUCanvasConfiguration);
  return true;
}

export interface HdrToneMapping {
  // Linear brightness the output may reach: 1 for SDR, the display's HDR
  // headroom otherwise (uniform nodes: set .value)
  headroom: TslNode;
  // Fraction of the headroom kept untouched before the shoulder
  knee: TslNode;
  // How fast colors past the headroom fade to white (0: never)
  whiten: TslNode;
  // Exposure multiplier before tone mapping (renderer.toneMappingExposure)
  get exposure(): number;
  set exposure(value: number);
  get enabled(): boolean;
  set enabled(on: boolean);
}

const toneMappings = new WeakMap<WebGPURenderer, HdrToneMapping>();

// Headroom tone mapping for `renderer` (one per renderer; later calls return
// it with the options applied). Enabling it sets toneMapping and an sRGB
// output color space; disabling restores what was there.
function useHdrToneMapping(renderer: WebGPURenderer, {
  headroom,
  knee,
  whiten,
  enabled = true,
}: { headroom?: number; knee?: number; whiten?: number; enabled?: boolean } = {}): HdrToneMapping {
  let toneMapping = toneMappings.get(renderer);
  if (!toneMapping) {
    const u = { headroom: uniform(1), knee: uniform(0.75), whiten: uniform(0.5) };
    renderer.library.addToneMapping(Fn(([color, exposure]: [TslNode, TslNode]) => {
      const c = sRGBTransferEOTF(max(color, vec3(0.0))).mul(exposure).toVar();
      const peak = max(c.r, max(c.g, c.b)).toVar();
      const limit = max(u.headroom, 1e-3).toVar();
      const start = limit.mul(clamp(u.knee, 0.0, 0.99)).toVar();
      const range = limit.sub(start).toVar();
      // Identity up to the knee, then an exponential shoulder toward the
      // limit (continuous in value and slope); hue kept by scaling all channels
      const mapped = select(peak.lessThanEqual(start), peak, start.add(range.mul(float(1).sub(exp(peak.sub(start).div(range).negate()))))).toVar();
      const scaled = c.mul(mapped.div(max(peak, 1e-6)));
      const past = max(peak.sub(limit), 0.0).div(limit);
      return mix(scaled, vec3(mapped), float(1).sub(exp(past.mul(u.whiten).negate())));
    }), THREE.CustomToneMapping);

    const saved = { toneMapping: renderer.toneMapping, outputColorSpace: renderer.outputColorSpace };
    let on = false;
    toneMapping = {
      ...u,
      get exposure() {
        return renderer.toneMappingExposure;
      },
      set exposure(value: number) {
        renderer.toneMappingExposure = value;
      },
      get enabled() {
        return on;
      },
      set enabled(value: boolean) {
        if (value === on) {
          return;
        }
        on = value;
        if (on) {
          saved.toneMapping = renderer.toneMapping;
          saved.outputColorSpace = renderer.outputColorSpace;
          renderer.toneMapping = THREE.CustomToneMapping;
          renderer.outputColorSpace = THREE.SRGBColorSpace;
        } else {
          renderer.toneMapping = saved.toneMapping;
          renderer.outputColorSpace = saved.outputColorSpace;
        }
      },
    };
    toneMapping.headroom.value = canvasSupportsHdr(renderer) ? 4 : 1;
    toneMappings.set(renderer, toneMapping);
  }

  if (headroom !== undefined) {
    toneMapping.headroom.value = headroom;
  }
  if (knee !== undefined) {
    toneMapping.knee.value = knee;
  }
  if (whiten !== undefined) {
    toneMapping.whiten.value = whiten;
  }
  toneMapping.enabled = enabled;
  return toneMapping;
}

// Whether `renderer` renders through Hdr.useToneMapping's pass now (its
// frame target then holds sRGB-encoded colors)
export function hdrToneMappingActive(renderer: WebGPURenderer): boolean {
  return toneMappings.get(renderer)?.enabled === true && renderer.toneMapping === THREE.CustomToneMapping;
}

export class Hdr {
  // Whether the display reports high dynamic range (the browser also needs to)
  static readonly displaySupports = displaySupportsHdr;
  // The canvas can show the extended range: WebGPU with an rgba16float
  // canvas (createRenderer({ hdr })) and a browser that kept the extended mode
  static readonly canvasSupports = canvasSupportsHdr;
  // Extended (true) or standard (false) range on an HDR-capable canvas;
  // false if the canvas cannot
  static readonly setOutput = setHdrOutput;
  // Headroom tone mapping for a renderer (one per renderer; later calls
  // return it with the options applied)
  static readonly useToneMapping = useHdrToneMapping;
}
