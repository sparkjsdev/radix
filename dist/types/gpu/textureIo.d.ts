import type * as THREE from "three";
import type { WebGPURenderer } from "three/webgpu";
import { type ArrayFormat, type TypedArray } from "../core/formats";
import type { CopySpan, TexelSpan } from "../core/layout";
export declare function uploadTexels(renderer: WebGPURenderer, texture: THREE.Texture, format: ArrayFormat, spans: TexelSpan[], values: TypedArray): void;
export declare function readTexels(renderer: WebGPURenderer, texture: THREE.Texture, format: ArrayFormat, spans: TexelSpan[], dest: TypedArray): Promise<void>;
export declare function copyTexels(renderer: WebGPURenderer, src: THREE.Texture, dst: THREE.Texture, spans: CopySpan[]): void;
