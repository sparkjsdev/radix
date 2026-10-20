import * as THREE from "three";
import { WebGPURenderer } from "three/webgpu";
import { backendOf } from "./backend";
import { WEBGL2_BASELINE, WEBGL2_OPTIONAL_EXTENSIONS, WEBGL2_REQUIRED_EXTENSIONS, WEBGPU_BASELINE_LIMITS, WEBGPU_DEFAULT_LIMITS } from "./baseline";
import { GpuProfiler } from "./GpuProfiler";
import { Hdr } from "./hdr";

export type GpuBackend = "webgpu" | "webgpu-gl";

// A requested WebGPU limit: a target (capped at the adapter's) or "adapter"
// for the adapter's full limit
export type LimitRequest = number | "adapter";

export interface CreateRendererOptions {
  // "auto": WebGPU when available, else the WebGL2 backend
  backend?: GpuBackend | "auto";
  canvas?: HTMLCanvasElement;
  antialias?: boolean;
  // Enable renderer.xr before init: the WebGPU adapter must be requested
  // XR-compatible for the WebXR / WebGPU binding
  xr?: boolean;
  // GPU timestamp queries; see also `profile`
  timing?: boolean;
  // Timestamp queries plus a GpuProfiler as renderer.inspector (WebGPU, or
  // WebGL2 with EXT_disjoint_timer_query_webgl2)
  profile?: boolean;
  // Both XR eyes in one draw where supported: OVR_multiview2 on the WebGL2
  // backend (three's WebGPU XR has no multiview yet)
  multiview?: boolean;
  // On by default: draw straight to the canvas instead of through three's
  // linear intermediate target and output pass; materials then write
  // sRGB-encoded colors themselves
  directCanvas?: boolean;
  // rgba16float canvas with extended tone mapping on WebGPU (hdr.ts): true,
  // "auto" (when the display reports high dynamic range) or false.
  // getGpuCaps().hdr tells whether it took.
  hdr?: boolean | "auto";
  // Added to or replacing WEBGPU_BASELINE_LIMITS
  limits?: Record<string, LimitRequest>;
  // A logarithmic depth buffer, for scenes from centimeters to kilometers
  logarithmicDepthBuffer?: boolean;
}

// A WebGPURenderer on WebGPU or its WebGL2 fallback, initialized, asking for
// the device baselines in baseline.ts
export async function createRenderer(options: CreateRendererOptions = {}): Promise<WebGPURenderer> {
  const requested = options.backend ?? "auto";
  const profile = options.profile ?? false;
  const timing = profile || (options.timing ?? false);
  const multiview = options.multiview ?? false;
  const directCanvas = options.directCanvas ?? true;
  const hdrOption = options.hdr ?? false;
  const xr = options.xr ?? false;

  const forceWebGL = requested === "webgpu-gl" || !navigator.gpu;
  const hdr = !forceWebGL && (hdrOption === true || (hdrOption === "auto" && Hdr.displaySupports()));
  const requiredLimits = forceWebGL ? undefined : await adapterLimits(xr, options.limits);
  const renderer = new WebGPURenderer({
    canvas: options.canvas,
    antialias: options.antialias,
    forceWebGL,
    trackTimestamp: timing,
    multiview,
    logarithmicDepthBuffer: options.logarithmicDepthBuffer ?? false,
    // three configures an rgba16float canvas with extended tone mapping for this
    ...(hdr ? { outputType: THREE.HalfFloatType } : {}),
    ...(requiredLimits ? { requiredLimits } : {}),
  });
  renderer.xr.enabled = xr;
  await renderer.init();

  // WebGPURenderer falls back to WebGL2 by itself when device creation fails
  const internals = backendOf(renderer) as { trackTimestamp?: boolean; gl?: WebGL2RenderingContext };
  if (internals.gl) {
    if (requested === "webgpu") {
      console.warn("WebGPU unavailable, using the WebGL2 backend");
    }
    // Its timer queries cannot nest, so only profiling (whose phases render
    // outside the frame's passes) keeps them
    internals.trackTimestamp = profile && internals.gl.getExtension("EXT_disjoint_timer_query_webgl2") !== null;
    checkWebGL2(internals.gl);
  }
  if (hdrOption === true && !Hdr.canvasSupports(renderer)) {
    console.info("HDR canvas unavailable (needs the WebGPU backend and canvas tone mapping)");
  }

  if (directCanvas) {
    renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    renderer.toneMapping = THREE.NoToneMapping;
  }
  if (profile) {
    renderer.inspector = new GpuProfiler();
  }
  return renderer;
}

// WEBGPU_BASELINE_LIMITS merged with `overrides`, each capped at the
// adapter's value so the device request cannot fail. The adapter is
// requested the way WebGPUBackend.init requests its own. Limits it does not
// name are skipped (requestDevice rejects unknown keys), as are values no
// better than the default.
async function adapterLimits(xrCompatible: boolean, overrides: Record<string, LimitRequest> = {}) {
  const adapter = await navigator.gpu.requestAdapter({ featureLevel: "compatibility", xrCompatible } as GPURequestAdapterOptions);
  if (!adapter) {
    return undefined;
  }

  const supported = adapter.limits as unknown as Record<string, number>;
  const limits: Record<string, number> = {};
  const short: string[] = [];
  for (const [name, request] of Object.entries({ ...WEBGPU_BASELINE_LIMITS, ...overrides })) {
    if (!(name in adapter.limits)) {
      continue;
    }

    // min* limits (alignments) are better when lower
    const lowerIsBetter = name.startsWith("min");
    const available = supported[name];
    let value = available;
    if (request !== "adapter") {
      value = lowerIsBetter ? Math.max(request, available) : Math.min(request, available);
      if (value !== request) {
        short.push(`${name} ${available} (baseline ${request})`);
      }
    }

    const fallback = WEBGPU_DEFAULT_LIMITS[name];
    if (fallback === undefined || (lowerIsBetter ? value < fallback : value > fallback)) {
      limits[name] = value;
    }
  }

  if (short.length > 0) {
    console.info(`WebGPU adapter below the limit baseline: ${short.join(", ")}`);
  }
  return Object.keys(limits).length > 0 ? limits : undefined;
}

function checkWebGL2(gl: WebGL2RenderingContext) {
  for (const name of WEBGL2_REQUIRED_EXTENSIONS) {
    if (!gl.getExtension(name)) {
      console.warn(`WebGL2 extension ${name} missing: float16 / float32 targets and readback will fail`);
    }
  }
  for (const name of WEBGL2_OPTIONAL_EXTENSIONS) {
    gl.getExtension(name);
  }

  const short = Object.entries(WEBGL2_BASELINE)
    .map(([name, baseline]) => [name, baseline, gl.getParameter(gl[name as keyof WebGL2RenderingContext] as number) as number] as const)
    .filter(([, baseline, value]) => value < baseline)
    .map(([name, baseline, value]) => `${name} ${value} (baseline ${baseline})`);
  if (short.length > 0) {
    console.info(`WebGL2 device below the baseline: ${short.join(", ")}`);
  }
}

export interface GpuCaps {
  backend: GpuBackend;
  // Compute shaders, storage buffers and textures (WebGPU only)
  compute: boolean;
  maxTextureSize: number;
  maxTextureLayers: number;
  maxColorAttachments: number;
  maxTexturesPerStage: number;
  maxStorageTexturesPerStage: number;
  maxStorageBuffersPerStage: number;
  maxWorkgroupStorage: number;
  float32Blendable: boolean;
  float32Filterable: boolean;
  // WebGPU subgroup operations
  subgroups: boolean;
  // Both eyes in one draw: OVR_multiview2 on the WebGL2 backend, the WebGPU
  // multiview feature (not yet used by three's WebGPU XR), or neither
  multiview: "ovr" | "webgpu" | false;
  // The canvas shows values above 1 brighter than white (createRenderer({ hdr }))
  hdr: boolean;
}

// Valid after createRenderer (the renderer is initialized)
export function getGpuCaps(renderer: WebGPURenderer): GpuCaps {
  const backend = backendOf(renderer);
  if (backend.isWebGPUBackend) {
    const limits = backend.device!.limits;
    return {
      backend: "webgpu",
      compute: true,
      maxTextureSize: limits.maxTextureDimension2D,
      maxTextureLayers: limits.maxTextureArrayLayers,
      maxColorAttachments: limits.maxColorAttachments,
      maxTexturesPerStage: limits.maxSampledTexturesPerShaderStage,
      maxStorageTexturesPerStage: limits.maxStorageTexturesPerShaderStage,
      maxStorageBuffersPerStage: limits.maxStorageBuffersPerShaderStage,
      maxWorkgroupStorage: limits.maxComputeWorkgroupStorageSize,
      float32Blendable: renderer.hasFeature("float32-blendable"),
      float32Filterable: renderer.hasFeature("float32-filterable"),
      subgroups: renderer.hasFeature("subgroups"),
      multiview: backend.device!.features.has("multiview") ? "webgpu" : false,
      hdr: Hdr.canvasSupports(renderer),
    };
  }

  const gl = backend.gl!;
  return {
    backend: "webgpu-gl",
    compute: false,
    maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
    maxTextureLayers: gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS),
    maxColorAttachments: gl.getParameter(gl.MAX_DRAW_BUFFERS),
    maxTexturesPerStage: Math.min(gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS), gl.getParameter(gl.MAX_VERTEX_TEXTURE_IMAGE_UNITS)),
    maxStorageTexturesPerStage: 0,
    maxStorageBuffersPerStage: 0,
    maxWorkgroupStorage: 0,
    float32Blendable: gl.getExtension("EXT_float_blend") !== null,
    float32Filterable: gl.getExtension("OES_texture_float_linear") !== null,
    subgroups: false,
    multiview: gl.getExtension("OVR_multiview2") !== null ? "ovr" : false,
    hdr: false,
  };
}
