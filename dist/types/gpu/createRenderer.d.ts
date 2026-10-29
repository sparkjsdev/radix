import { WebGPURenderer } from "three/webgpu";
export type GpuBackend = "webgpu" | "webgpu-gl";
export type LimitRequest = number | "adapter";
export interface CreateRendererOptions {
    backend?: GpuBackend | "auto";
    canvas?: HTMLCanvasElement;
    antialias?: boolean;
    xr?: boolean;
    timing?: boolean;
    profile?: boolean;
    multiview?: boolean;
    directCanvas?: boolean;
    hdr?: boolean | "auto";
    limits?: Record<string, LimitRequest>;
    logarithmicDepthBuffer?: boolean;
}
export declare function createRenderer(options?: CreateRendererOptions): Promise<WebGPURenderer>;
export interface GpuCaps {
    backend: GpuBackend;
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
    subgroups: boolean;
    multiview: "ovr" | "webgpu" | false;
    hdr: boolean;
}
export declare function getGpuCaps(renderer: WebGPURenderer): GpuCaps;
