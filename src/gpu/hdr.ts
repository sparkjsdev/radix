import * as THREE from "three";
import type { WebGPURenderer } from "three/webgpu";
import { backendOf } from "./backend";
import { TSL, type TslNode } from "./tsl";

const { Fn, clamp, exp, float, max, mix, select, sRGBTransferEOTF, uniform, vec3 } = TSL;

function displaySupportsHdr(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(dynamic-range: high)").matches === true;
}

interface HdrBackend {
  isWebGPUBackend?: boolean;
  device?: GPUDevice;
  context?: GPUCanvasContext;
  parameters: { outputType?: number; alpha?: boolean };
}

function canvasSupportsHdr(renderer: WebGPURenderer): boolean {
  const backend = backendOf(renderer) as unknown as HdrBackend;
  if (!backend.isWebGPUBackend || backend.parameters.outputType !== THREE.HalfFloatType) {
    return false;
  }
  // Browsers without canvas tone mapping drop this member
  const configuration = (backend.context as unknown as { getConfiguration?(): GPUCanvasConfiguration | null } | undefined)?.getConfiguration?.();
  return !configuration || (configuration as { toneMapping?: { mode?: string } }).toneMapping !== undefined;
}

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

/**
 * The headroom tone mapping of a renderer. Its uniforms change through their
 * value.
 */
export interface HdrToneMapping {
  /**
   * The brightest linear value the output reaches, 1 for SDR.
   *
   * @default 4 on an HDR canvas, else 1
   */
  headroom: TslNode;
  /**
   * The fraction of the headroom left unchanged, from 0 to 0.99.
   *
   * @default 0.75
   */
  knee: TslNode;
  /**
   * How fast colors past the headroom fade to white, 0 for never.
   *
   * @default 0.5
   */
  whiten: TslNode;
  /** The exposure multiplier before tone mapping, renderer.toneMappingExposure. */
  get exposure(): number;
  set exposure(value: number);
  /** Turning it on sets the renderer's tone mapping and sRGB output, and off restores them. */
  get enabled(): boolean;
  set enabled(on: boolean);
}

const toneMappings = new WeakMap<WebGPURenderer, HdrToneMapping>();

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
      // The frame target holds sRGB-encoded colors. Identity up to the knee, then
      // an exponential shoulder, scaling all channels to keep the hue.
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

// Whether the tone mapping pass runs, so the frame target holds sRGB-encoded colors
export function hdrToneMappingActive(renderer: WebGPURenderer): boolean {
  return toneMappings.get(renderer)?.enabled === true && renderer.toneMapping === THREE.CustomToneMapping;
}

/** HDR canvas output and headroom tone mapping. */
export class Hdr {
  /** Tells whether the display reports high dynamic range. */
  static readonly displaySupports = displaySupportsHdr;
  /**
   * Tells whether the canvas can show the extended range, which needs WebGPU
   * and createRenderer({ hdr }).
   */
  static readonly canvasSupports = canvasSupportsHdr;
  /**
   * Switches an HDR canvas between the extended and the standard range.
   *
   * @return False when the canvas cannot.
   */
  static readonly setOutput = setHdrOutput;
  /**
   * The headroom tone mapping of a renderer, made on the first call. Each call
   * applies its options.
   *
   * @param [options.headroom] The brightest linear output.
   * @param [options.knee] The fraction of the headroom left unchanged.
   * @param [options.whiten] How fast colors past the headroom fade to white.
   * @param [options.enabled=true] Whether the pass runs.
   */
  static readonly useToneMapping = useHdrToneMapping;
}
