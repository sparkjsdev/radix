import { type PackedEncoding } from "../core/splats";
import { type AnySplatGenerator, type SplatGeneratorContext } from "./splatGenerator";
import { type TslNode } from "./tsl";
declare const structBrand: unique symbol;
export interface StructNode<Fields extends string, Brand extends string> {
    readonly [structBrand]: Brand;
    get(field: Fields): TslNode;
    toVar(name?: string): StructNode<Fields, Brand>;
    assign(value: StructNode<Fields, Brand>): unknown;
}
export type SplatNode = StructNode<"center" | "scales" | "quaternion" | "rgb" | "opacity" | "index", "Splat">;
export type CovSplatNode = StructNode<"center" | "xxyyzz" | "xyxzyz" | "rgb" | "opacity" | "normal" | "index", "CovSplat">;
export type PbrNode = StructNode<"normal" | "roughness" | "metallic", "Pbr">;
export declare class GpuSplats {
    static readonly Splat: (...fields: TslNode[]) => SplatNode;
    static readonly CovSplat: (...fields: TslNode[]) => CovSplatNode;
    static readonly Pbr: (...fields: TslNode[]) => PbrNode;
    static decodeExt(a: TslNode, b: TslNode): SplatNode;
    static decodeExtPbr(a: TslNode, b: TslNode): PbrNode;
    static encodeExt(s: SplatNode, p: PbrNode): TslNode;
    static decodeCov(a: TslNode, b: TslNode): CovSplatNode;
    static encodeCov(c: CovSplatNode): TslNode;
    static decodePacked(p: TslNode, encoding?: PackedEncoding | TslNode): SplatNode;
    static encodePacked(s: SplatNode, encoding?: PackedEncoding | TslNode): TslNode;
    static storeExt(out: {
        extA: TslNode;
        extB: TslNode;
    }, s: SplatNode, pbr?: PbrNode): void;
    static storeCov(out: {
        covA: TslNode;
        covB: TslNode;
    }, c: CovSplatNode): void;
    static storePacked(out: {
        packed: TslNode;
    }, s: SplatNode, encoding?: PackedEncoding | TslNode): void;
    static toCov(s: SplatNode): CovSplatNode;
    static fromCov(c: CovSplatNode): SplatNode;
    static splatOf(generator: AnySplatGenerator, index: TslNode, context?: SplatGeneratorContext): SplatNode;
    static covSplatOf(generator: AnySplatGenerator, index: TslNode, context?: SplatGeneratorContext): CovSplatNode;
    static withIndex<N extends SplatNode | CovSplatNode>(node: N, index: TslNode): N;
    static normalOf(s: SplatNode): TslNode;
}
export {};
