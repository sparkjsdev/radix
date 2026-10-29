import * as THREE from "three";
import type { WebGPURenderer } from "three/webgpu";
import type { ShCodecName, ShDegree } from "../core/sh";
import { type SplatLayout } from "../core/splats";
import { GpuArrays } from "./GpuArrays";
import type { CovSplatNode, SplatNode } from "./splats.tsl";
import { type TslNode } from "./tsl";
export interface SplatGeneratorContext {
    viewOrigin: TslNode;
    viewForward: TslNode;
    objectToHead: TslNode;
    headToObject: TslNode;
    objectToWorld: TslNode;
}
export interface SplatBindContext {
    viewOrigin: THREE.Vector3;
    viewForward: THREE.Vector3;
    objectToHead: THREE.Matrix4;
    headToObject: THREE.Matrix4;
    objectToWorld: THREE.Matrix4;
}
export type SplatGenerator<Data = unknown> = {
    generateSplat(index: TslNode, context?: SplatGeneratorContext): SplatNode;
    generateCovSplat?(index: TslNode, context?: SplatGeneratorContext): CovSplatNode;
    bind?: (data: Data, context?: SplatBindContext) => void;
} | {
    generateSplat?(index: TslNode, context?: SplatGeneratorContext): SplatNode;
    generateCovSplat(index: TslNode, context?: SplatGeneratorContext): CovSplatNode;
    bind?: (data: Data, context?: SplatBindContext) => void;
};
export type AnySplatGenerator = SplatGenerator<never>;
export type SplatModifier = (splat: SplatNode, context?: SplatGeneratorContext) => SplatNode;
export type CovSplatModifier = (cov: CovSplatNode, context?: SplatGeneratorContext) => CovSplatNode;
export interface StoredSplats {
    splats: GpuArrays;
    indices?: GpuArrays;
    shPalette?: GpuArrays;
}
export interface SplatShOptions {
    codec: ShCodecName;
    degree: ShDegree;
    palette?: boolean;
}
export declare const generatorContext: {
    nodes: SplatGeneratorContext;
    values: SplatBindContext;
    set: (toWorld: THREE.Matrix4, toHead: THREE.Matrix4) => void;
};
export declare const modifierContext: {
    nodes: SplatGeneratorContext;
    values: SplatBindContext;
    set: (toWorld: THREE.Matrix4, toHead: THREE.Matrix4) => void;
};
export declare const SplatGenerator: {
    context: SplatGeneratorContext;
    fromSplats({ layout, remap, modifiers, sh }?: {
        layout?: SplatLayout;
        remap?: "indices" | ((index: TslNode) => TslNode);
        modifiers?: SplatModifier[];
        sh?: SplatShOptions;
    }): SplatGenerator<StoredSplats>;
    forArrays(arrays: GpuArrays, { remap, modifiers, sh, shPalette }?: {
        remap?: "indices";
        modifiers?: SplatModifier[];
        sh?: number | false;
        shPalette?: GpuArrays;
    }): SplatGenerator<StoredSplats>;
    indices(renderer: WebGPURenderer, list: ArrayLike<number>, into?: GpuArrays): GpuArrays;
    setContext(objectToWorld: THREE.Matrix4, worldToHead: THREE.Matrix4, space?: {
        toWorld: THREE.Matrix4;
        toHead: THREE.Matrix4;
    }): void;
};
