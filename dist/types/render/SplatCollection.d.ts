import * as THREE from "three";
import type { GpuArrays } from "../gpu/GpuArrays";
import { SplatGenerator, type AnySplatGenerator, type StoredSplats } from "../gpu/splatGenerator";
import type { SplatObjectParams } from "./splatParams";
export interface SplatObject<Data = unknown> {
    readonly generator: SplatGenerator<Data>;
    readonly data?: Data;
    readonly count: number;
    matrixWorld?: THREE.Matrix4 | (() => THREE.Matrix4);
    params?: Partial<SplatObjectParams>;
    release?: () => void;
}
export type AnySplatObject = Omit<SplatObject, "generator" | "data"> & {
    readonly generator: AnySplatGenerator;
    readonly data?: unknown;
};
export interface MappedObject {
    readonly object: AnySplatObject;
    readonly offset: number;
}
export declare class SplatCollection {
    static readonly EMPTY: SplatCollection;
    readonly objects: readonly MappedObject[];
    readonly count: number;
    constructor(objects: readonly AnySplatObject[]);
    static object<Data>(object: SplatObject<Data>): SplatObject<Data>;
    static arrays(arrays: GpuArrays, { sh, shPalette, ...object }?: Partial<Omit<SplatObject, "generator" | "data">> & {
        sh?: number | false;
        shPalette?: GpuArrays;
    }): SplatObject<StoredSplats>;
    static matrixWorldOf(object: AnySplatObject): THREE.Matrix4;
}
