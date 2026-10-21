import * as THREE from "three";
import { WebGPURenderer } from "three/webgpu";
import { backendOf } from "./backend";
import { WEBGL2_BASELINE, WEBGL2_OPTIONAL_EXTENSIONS, WEBGL2_REQUIRED_EXTENSIONS, WEBGPU_BASELINE_LIMITS, WEBGPU_DEFAULT_LIMITS } from "./baseline";
import { GpuProfiler } from "./GpuProfiler";
import { Hdr } from "./hdr";

/** The backend a renderer runs on, WebGPU or three's WebGL2 backend. */
export type GpuBackend = "webgpu" | "webgpu-gl";

/** A WebGPU limit to request, capped at the adapter's, or "adapter" for its full limit. */
export type LimitRequest = number | "adapter";

/** The options of createRenderer. */
export interface CreateRendererOptions {
  /**
   * The backend, where "auto" uses WebGPU when available, else WebGL2.
   *
   * @default "auto"
   */
  backend?: GpuBackend | "auto";
  canvas?: HTMLCanvasElement;
  antialias?: boolean;
  /**
   * Whether to enable renderer.xr before init, so the WebGPU adapter is
   * XR-compatible.
   *
   * @default false
   */
  xr?: boolean;
  /**
   * Whether to make GPU timestamp queries, which WebGL2 keeps only with
   * profile.
   *
   * @default false
   */
  timing?: boolean;
  /**
   * Whether to add timestamp queries and a GpuProfiler as renderer.inspector.
   *
   * @default false
   */
  profile?: boolean;
  /**
   * Whether to draw both XR eyes at once, on WebGL2 with OVR_multiview2 only.
   *
   * @default false
   */
  multiview?: boolean;
  /**
   * Whether to draw without a linear target or output pass, so materials write
   * sRGB-encoded colors.
   *
   * @default true
   */
  directCanvas?: boolean;
  /**
   * Whether to make an rgba16float canvas with extended tone mapping on WebGPU,
   * or "auto" for HDR displays.
   *
   * @default false
   */
  hdr?: boolean | "auto";
  /** WebGPU limits added to or replacing the baselines. */
  limits?: Record<string, LimitRequest>;
  /**
   * Whether to use a logarithmic depth buffer.
   *
   * @default false
   */
  logarithmicDepthBuffer?: boolean;
}

/**
 * Creates a WebGPURenderer on WebGPU or WebGL2, requesting the device
 * baselines.
 *
 * @return The renderer, once initialized.
 */
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
    // three makes this an rgba16float canvas with extended tone mapping
    ...(hdr ? { outputType: THREE.HalfFloatType } : {}),
    ...(requiredLimits ? { requiredLimits } : {}),
  });
  renderer.xr.enabled = xr;
  await renderer.init();

  // three falls back to WebGL2 when device creation fails
  const internals = backendOf(renderer) as { trackTimestamp?: boolean; gl?: WebGL2RenderingContext };
  if (internals.gl) {
    if (requested === "webgpu") {
      console.warn("WebGPU unavailable, using the WebGL2 backend");
    }
    // WebGL2 timer queries cannot nest, so only profiling keeps them
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

// Each limit is capped at the adapter's so requestDevice cannot fail, and the
// adapter is requested as WebGPUBackend.init does. Unknown keys, which
// requestDevice rejects, and values no better than the default are dropped.
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

    // The min* limits are alignments, better when lower
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

/** What a renderer's device supports. */
export interface GpuCaps {
  backend: GpuBackend;
  /** Whether compute shaders and storage resources are available, on WebGPU only. */
  compute: boolean;
  /** The largest texture width or height, in texels. */
  maxTextureSize: number;
  maxTextureLayers: number;
  maxColorAttachments: number;
  /**
   * The most sampled textures per shader stage, on WebGL2 the lower of the
   * fragment and vertex units.
   */
  maxTexturesPerStage: number;
  /** The most storage textures per shader stage, 0 on WebGL2. */
  maxStorageTexturesPerStage: number;
  /** The most storage buffers per shader stage, 0 on WebGL2. */
  maxStorageBuffersPerStage: number;
  /** Workgroup storage in bytes, 0 on WebGL2. */
  maxWorkgroupStorage: number;
  float32Blendable: boolean;
  float32Filterable: boolean;
  subgroups: boolean;
  /** Both XR eyes in one draw, with OVR_multiview2 on WebGL2 or the WebGPU feature. */
  multiview: "ovr" | "webgpu" | false;
  /** Whether the canvas shows values above 1 brighter than white. */
  hdr: boolean;
}

/** Reads what the device of an initialized renderer supports. */
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
