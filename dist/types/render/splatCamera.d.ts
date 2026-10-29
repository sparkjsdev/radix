import * as THREE from "three";
import type { WebGPURenderer } from "three/webgpu";
import { type TslNode } from "../gpu/tsl";
export interface EyeNodes {
    fromHead: TslNode;
    fromHeadQuat: TslNode;
    projection: TslNode;
    isOrtho: TslNode;
    renderSize: TslNode;
    ndcZMin: TslNode;
}
export interface EyeSetting {
    view: THREE.Matrix4;
    projection: THREE.Matrix4;
    ortho?: boolean;
}
export declare class SplatCamera {
    static readonly viewIndex: TslNode;
    static eyes: number;
    static readonly head: THREE.Matrix4;
    static eye(v: number | TslNode): EyeNodes;
    static set(renderer: WebGPURenderer, camera: THREE.Camera): void;
    static setViews({ head, eyes, size, ndcZMin }: {
        head: THREE.Matrix4;
        eyes: EyeSetting[];
        size: THREE.Vector2;
        ndcZMin: number;
    }): void;
}
