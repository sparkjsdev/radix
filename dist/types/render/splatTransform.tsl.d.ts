import * as THREE from "three";
import { type CovSplatNode, type SplatNode } from "../gpu/splats.tsl";
import { type TslNode } from "../gpu/tsl";
import type { SplatForm } from "./projection.tsl";
export type ModifierSpace = "view" | "world" | "object" | THREE.Matrix4;
export interface TransformNodes {
    matrix: TslNode;
    quat: TslNode;
    scale: TslNode;
    uniform: TslNode;
}
export declare const transforms: {
    a: TransformNodes;
    b: TransformNodes;
};
export declare function isUniformScale(m: THREE.Matrix4, tolerance?: number): boolean;
export declare function setTransforms(object: THREE.Matrix4, space: ModifierSpace | undefined): void;
export declare function transformCov(c: CovSplatNode, t: TransformNodes): CovSplatNode;
export declare function transformSplat(s: SplatNode, t: TransformNodes): SplatNode;
export declare function transformForm(node: SplatNode | CovSplatNode, form: SplatForm, t: TransformNodes, next?: SplatForm): {
    node: SplatNode | CovSplatNode;
    form: SplatForm;
};
export declare function convertForm(node: SplatNode | CovSplatNode, from: SplatForm, to: SplatForm): SplatNode | CovSplatNode;
