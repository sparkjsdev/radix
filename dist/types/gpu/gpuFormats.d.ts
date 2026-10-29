import * as THREE from "three";
import { type ArrayFormat, type ScalarType } from "../core/formats";
export interface GpuFormatInfo {
    format: ArrayFormat;
    components: number;
    scalar: ScalarType;
    kind: "uint" | "sint" | "float";
    webgpu: GPUTextureFormat;
    gl: string;
    glFormat: string;
    glType: string;
    threeFormat: THREE.PixelFormat;
    threeType: THREE.TextureDataType;
    node: string;
    renderable: boolean;
    storable: boolean;
}
export declare function gpuFormatInfo(format: ArrayFormat): GpuFormatInfo;
