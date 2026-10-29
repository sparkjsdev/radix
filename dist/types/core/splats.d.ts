import { ArrayData, type ArrayBundle } from "./ArrayData";
import type { CoordinateSystem } from "./axes";
import { type BundleDef } from "./bundles";
import { type Cov, type Quat, type Rgb, type Vec3 } from "./math";
import type { Progress } from "./progress";
import type { ShPalette, ShTarget } from "./sh";
export interface Splat {
    center: Vec3;
    scales: Vec3;
    quaternion: Quat;
    rgb: Rgb;
    opacity: number;
}
export interface Pbr {
    normal: Vec3;
    roughness: number;
    metallic: number;
}
export type ExtSplat = Splat & Pbr;
export interface CovSplat {
    center: Vec3;
    cov: Cov;
    rgb: Rgb;
    opacity: number;
    normal: Vec3;
}
declare const EXT: BundleDef<{
    readonly extA: "uint32x4";
    readonly extB: "uint32x4";
}>;
declare const COV: BundleDef<{
    readonly covA: "uint32x4";
    readonly covB: "uint32x4";
}>;
declare const PACKED: BundleDef<{
    readonly packed: "uint32x4";
}>;
declare const LOD_TREE: BundleDef<{
    readonly node: "uint32x2";
}>;
declare const LAYOUTS: {
    readonly extSplats: BundleDef<{
        readonly extA: "uint32x4";
        readonly extB: "uint32x4";
    }>;
    readonly covSplats: BundleDef<{
        readonly covA: "uint32x4";
        readonly covB: "uint32x4";
    }>;
    readonly packedSplats: BundleDef<{
        readonly packed: "uint32x4";
    }>;
};
export type ExtSplats = ArrayBundle<typeof EXT>;
export type CovSplats = ArrayBundle<typeof COV>;
export type PackedSplats = ArrayBundle<typeof PACKED>;
export type SplatBundle = ExtSplats | CovSplats | PackedSplats;
export type SplatLayout = keyof typeof LAYOUTS;
export interface SplatBundles {
    extSplats: ExtSplats;
    covSplats: CovSplats;
    packedSplats: PackedSplats;
}
export interface PackedEncoding {
    rgbMin: number;
    rgbMax: number;
    lnScaleMin: number;
    lnScaleMax: number;
}
export type SplatData<L extends SplatLayout = "extSplats"> = ArrayData<{
    [K in L]: (typeof LAYOUTS)[K];
}>;
export interface SplatTarget<L extends SplatLayout = SplatLayout> {
    layout?: L;
    encoding?: Partial<PackedEncoding>;
}
export type SplatReadOptions<L extends SplatLayout = "extSplats"> = SplatTarget<L> & {
    progress?: Progress;
    sh?: ShTarget;
    coordinateSystem?: CoordinateSystem;
};
export interface LoadedSplats<L extends SplatLayout = "extSplats"> {
    splats: SplatData<L>;
    shPalette?: ShPalette;
}
export interface FoundSplats {
    name: string;
    layout: SplatLayout;
    bundle: SplatBundle;
}
export interface BundleLike {
    channels: Record<string, {
        format: string;
    } | undefined>;
}
export declare class Splats {
    static readonly EXT: BundleDef<{
        readonly extA: "uint32x4";
        readonly extB: "uint32x4";
    }>;
    static readonly COV: BundleDef<{
        readonly covA: "uint32x4";
        readonly covB: "uint32x4";
    }>;
    static readonly PACKED: BundleDef<{
        readonly packed: "uint32x4";
    }>;
    static readonly LOD_TREE: BundleDef<{
        readonly node: "uint32x2";
    }>;
    static readonly LAYOUTS: {
        readonly extSplats: BundleDef<{
            readonly extA: "uint32x4";
            readonly extB: "uint32x4";
        }>;
        readonly covSplats: BundleDef<{
            readonly covA: "uint32x4";
            readonly covB: "uint32x4";
        }>;
        readonly packedSplats: BundleDef<{
            readonly packed: "uint32x4";
        }>;
    };
    static readonly DEFAULT_PACKED_ENCODING: Readonly<PackedEncoding>;
    static makeSplat(): Splat;
    static makePbr(): Pbr;
    static makeExtSplat(): ExtSplat;
    static makeCovSplat(): CovSplat;
    static packedEncodingOf(bundle: {
        meta: Record<string, unknown>;
    }): PackedEncoding;
    static isExt(bundle: ArrayBundle): bundle is ExtSplats;
    static isCov(bundle: ArrayBundle): bundle is CovSplats;
    static isPacked(bundle: ArrayBundle): bundle is PackedSplats;
    static layoutOf(bundle: SplatBundle): SplatLayout;
    static layoutOf(bundle: BundleLike): SplatLayout | undefined;
    static findBundle(bundles: Record<string, BundleLike>, name?: string): {
        name: string;
        layout: SplatLayout;
    } | undefined;
    static find(data: ArrayData, name?: string): FoundSplats | undefined;
    static get(data: ArrayData, name?: string): FoundSplats;
    static findLodTree(data: ArrayData): ArrayBundle<typeof LOD_TREE> | undefined;
    static add(data: ArrayData, { layout, encoding }?: SplatTarget): SplatBundle;
    static make<L extends SplatLayout = "extSplats">(count: number, { meta, ...target }?: SplatTarget<L> & {
        meta?: Record<string, unknown>;
    }): SplatData<L>;
    static convert<L extends SplatLayout>(data: ArrayData, { layout, encoding }: SplatTarget<L> & {
        layout: L;
    }): SplatData<L>;
    static encodeExt(bundle: ExtSplats, i: number, s: ExtSplat): void;
    static decodeExt(bundle: ExtSplats, i: number, out: ExtSplat): ExtSplat;
    static encodeCov(bundle: CovSplats, i: number, c: CovSplat): void;
    static decodeCov(bundle: CovSplats, i: number, out: CovSplat): CovSplat;
    static encodePacked(bundle: PackedSplats, i: number, s: Splat, encoding?: PackedEncoding): void;
    static decodePacked(bundle: PackedSplats, i: number, out: Splat, encoding?: PackedEncoding): Splat;
    static load(bundle: SplatBundle, i: number, out: Splat): Splat;
    static store(bundle: SplatBundle, i: number, s: Splat): void;
    static loadPbr(bundle: ExtSplats, i: number, out: Pbr): Pbr;
    static storePbr(bundle: ExtSplats, i: number, p: Pbr): void;
    static loadCenter(bundle: SplatBundle, i: number, out: Vec3): Vec3;
    static encoder(bundle: SplatBundle): (i: number, s: ExtSplat) => void;
    static decoder(bundle: SplatBundle): (i: number, out: ExtSplat) => ExtSplat;
    static toCov(s: Splat, out: CovSplat): CovSplat;
    static fromCov(c: CovSplat, out: Splat): Splat;
}
export {};
