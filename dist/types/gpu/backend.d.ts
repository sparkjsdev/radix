import type { WebGPURenderer } from "three/webgpu";
export interface Backend {
    isWebGPUBackend?: boolean;
    isWebGLBackend?: boolean;
    device?: GPUDevice;
    gl?: WebGL2RenderingContext;
    get(object: object): Record<string, unknown>;
}
export declare function backendOf(renderer: WebGPURenderer): Backend;
export declare function isWebGPUBackend(renderer: WebGPURenderer): boolean;
export declare function gpuTextureOf(renderer: WebGPURenderer, texture: object): GPUTexture;
export declare function glTextureOf(renderer: WebGPURenderer, texture: object): WebGLTexture;
