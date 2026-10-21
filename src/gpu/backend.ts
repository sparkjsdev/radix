import type { WebGPURenderer } from "three/webgpu";

// Typed structurally, so no backend class is imported
export interface Backend {
  isWebGPUBackend?: boolean;
  isWebGLBackend?: boolean;
  device?: GPUDevice;
  gl?: WebGL2RenderingContext;
  get(object: object): Record<string, unknown>;
}

export function backendOf(renderer: WebGPURenderer): Backend {
  return renderer.backend as unknown as Backend;
}

export function isWebGPUBackend(renderer: WebGPURenderer) {
  return backendOf(renderer).isWebGPUBackend === true;
}

// Valid after initTexture
export function gpuTextureOf(renderer: WebGPURenderer, texture: object): GPUTexture {
  return backendOf(renderer).get(texture).texture as GPUTexture;
}

export function glTextureOf(renderer: WebGPURenderer, texture: object): WebGLTexture {
  return backendOf(renderer).get(texture).textureGPU as WebGLTexture;
}
