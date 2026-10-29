import type { SplatParamNodes } from "./splatParams";
import type { CovSplatNode, SplatNode } from "../gpu/splats.tsl";
import { type TslNode } from "../gpu/tsl";
export declare const NDC_RANGE = 2;
export type SplatForm = "splat" | "cov";
export type SplatNodeOf<F extends SplatForm> = F extends "cov" ? CovSplatNode : SplatNode;
export interface PreparedSplat<F extends SplatForm = SplatForm> {
    form: F;
    splat: SplatNodeOf<F>;
    opacity: TslNode;
    stdDev: TslNode;
}
export declare function prepareSplat<F extends SplatForm>(source: SplatNodeOf<F>, form: F, params: SplatParamNodes): PreparedSplat<F>;
export declare function cullInvisible({ form, splat, opacity }: PreparedSplat, params: SplatParamNodes): TslNode;
export declare const storedOpacity: (opacity: TslNode) => any;
export interface ViewFrame {
    matrix?: TslNode;
    quat?: TslNode;
    projection: TslNode;
    isOrtho: TslNode;
    renderSize: TslNode;
    ndcZMin: TslNode;
}
export declare function eyeFrame(v: number | TslNode): ViewFrame;
export declare function headFrame(): ViewFrame;
export declare const frameQuat: (frame: ViewFrame, q: TslNode) => any;
export interface SplatInView {
    frame: ViewFrame;
    center: TslNode;
    clip: TslNode;
    ndc: TslNode;
    blur: TslNode;
}
export declare function splatInView(s: PreparedSplat, frame: ViewFrame, params: SplatParamNodes): SplatInView;
export declare function cullDepth({ center, clip, frame }: SplatInView): TslNode;
export declare function cullClipXY({ clip }: SplatInView, params: SplatParamNodes): TslNode;
export declare function inSortGuard({ form, splat }: PreparedSplat, head: SplatInView, guard: TslNode, params: SplatParamNodes): TslNode;
export declare function viewCov(s: PreparedSplat<"cov">, frame: ViewFrame): TslNode;
export declare function viewBasis(s: PreparedSplat<"splat">, frame: ViewFrame): {
    quat: TslNode;
    scales: TslNode;
};
export declare function mipInflate(v: SplatInView, quat: TslNode, scales: TslNode, opacity: TslNode, params: SplatParamNodes): void;
export declare const mahalanobis2: (center: TslNode, quat: TslNode, scales: TslNode) => any;
export interface Bound {
    ndc: TslNode;
    angle: TslNode;
    scales: TslNode;
}
export declare const makeBound: () => Bound;
export declare const eigenvector2: any;
export declare function boundFromCov(a: TslNode, b: TslNode, d: TslNode, stdDev: TslNode, params: SplatParamNodes, bound: Bound): TslNode;
export declare function screenBound(frame: ViewFrame, params: SplatParamNodes, bound: Bound): void;
export declare function clipBoundToScreen(renderSize: TslNode, bound: Bound): TslNode;
export declare const encodeNdc: (ndc: TslNode) => any;
export declare const decodeNdc: (word: TslNode) => any;
export declare const encodeDepth20: (viewZ: TslNode) => any;
export declare const decodeDepth20: (code: TslNode) => any;
export declare const encodeAngle12: (angle: TslNode) => any;
export declare const decodeAngle12: (code: TslNode) => any;
export declare function encodeLogScale(scale: TslNode, bits: number, outward?: boolean): any;
export declare function decodeLogScale(code: TslNode, bits: number): any;
export declare const encodeOpacity: (opacity: TslNode) => any;
export declare const decodeOpacity: (byte: TslNode) => any;
export declare function encodeCenter(center: TslNode): [TslNode, TslNode, TslNode];
export declare const decodeCenter: any;
export declare function encodeBound(bound: Bound): [TslNode, TslNode];
export declare function decodeBound(w0: TslNode, w1: TslNode): Bound;
export interface SplatVaryings {
    uv: TslNode;
    localDir: TslNode;
    localCross: TslNode;
    c2: TslNode;
}
export declare const clipW: (viewZ: TslNode, projection: TslNode) => any;
export declare const clipZ: (viewZ: TslNode, projection: TslNode) => any;
export declare const unproject: any;
export declare function boundCorner(bound: Bound, center: TslNode, corner: TslNode, projection: TslNode, renderSize: TslNode, out: TslNode): any;
export declare function rayVertex(bound: Bound, center: TslNode, quat: TslNode, scales: TslNode, cornerIn: TslNode, shrink: TslNode, projection: TslNode, isOrtho: TslNode, renderSize: TslNode, out: TslNode): void;
export declare function rayDensity(v: SplatVaryings): TslNode;
export declare function fragmentAlpha(z2: TslNode, opacity: TslNode, falloff: TslNode): TslNode;
