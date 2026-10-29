import type { WebGPURenderer } from "three/webgpu";

// The parts of a WebGPURenderer backend this module reaches into: the raw
// device or GL context and the per-object GPU resources three keeps.
// Structural, so no backend class import is needed.
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

// The GPUTexture / WebGLTexture three created for `texture` (after initTexture)
export function gpuTextureOf(renderer: WebGPURenderer, texture: object): GPUTexture {
  return backendOf(renderer).get(texture).texture as GPUTexture;
}

export function glTextureOf(renderer: WebGPURenderer, texture: object): WebGLTexture {
  return backendOf(renderer).get(texture).textureGPU as WebGLTexture;
}
