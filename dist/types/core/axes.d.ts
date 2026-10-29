import type { ArrayData } from "./ArrayData";
import type { Cov, Quat, Vec3 } from "./math";
import { type Progress } from "./progress";
import { type ShDegree, type ShPalette } from "./sh";
import { type ExtSplat, type Splat } from "./splats";
export type CoordinateSystem = "LDB" | "RDB" | "LUB" | "RUB" | "LDF" | "RDF" | "LUF" | "RUF" | "LFD" | "RFD" | "LFU" | "RFU" | "LBD" | "RBD" | "LBU" | "RBU";
export interface AxesConverter {
    readonly matrix: number[];
    readonly identity: boolean;
    vec(v: Vec3): Vec3;
    quat(q: Quat): Quat;
    scales(s: Vec3): Vec3;
    cov(c: Cov): Cov;
    splat<S extends Splat | ExtSplat>(s: S): S;
    sh(coeffs: Float32Array, degree: ShDegree): Float32Array;
}
export declare class Axes {
    static readonly SYSTEMS: readonly CoordinateSystem[];
    static matrix(from: CoordinateSystem, to: CoordinateSystem): number[];
    static converter(from: CoordinateSystem, to: CoordinateSystem): AxesConverter;
    static convert(data: ArrayData, to: CoordinateSystem, { from, shPalette, progress, }?: {
        from?: CoordinateSystem;
        shPalette?: ShPalette;
        progress?: Progress;
    }): ArrayData;
}
