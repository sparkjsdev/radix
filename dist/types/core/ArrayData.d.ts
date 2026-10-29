import { type BundleDef, type Schema } from "./bundles";
import { type ArrayFormat, type ArrayOf, type TypedArray } from "./formats";
export type ArrayChannel<F extends ArrayFormat = ArrayFormat> = F extends ArrayFormat ? {
    format: F;
    data: ArrayOf<F>;
} : never;
export interface ArrayBundle<D extends BundleDef = BundleDef> {
    def: D;
    channels: {
        [K in keyof D["channels"]]: ArrayChannel<D["channels"][K]>;
    };
    meta: Record<string, unknown>;
}
export type ArrayBundles<S extends Schema> = {
    [K in keyof S]: ArrayBundle<S[K]>;
};
export interface TransferableArrayData {
    count: number;
    capacity: number;
    meta: Record<string, unknown>;
    bundles: Record<string, {
        def: BundleDef;
        meta: Record<string, unknown>;
        channels: Record<string, TypedArray>;
    }>;
}
export declare class ArrayData<S extends Schema = Schema> {
    static readonly INDICES: BundleDef<{
        readonly index: "uint32";
    }>;
    count: number;
    capacity: number;
    bundles: ArrayBundles<S>;
    meta: Record<string, unknown>;
    constructor({ bundles, count, capacity, meta }?: {
        bundles?: S;
        count?: number;
        capacity?: number;
        meta?: Record<string, unknown>;
    });
    addBundle<N extends string, D extends BundleDef>(name: N, def: D, init?: {
        data?: Partial<Record<keyof D["channels"], TypedArray>>;
        meta?: Record<string, unknown>;
    }): ArrayData<S & Record<N, D>>;
    removeBundle(name: string): boolean;
    setCapacity(capacity: number): boolean;
    ensureCapacity(capacity: number): boolean;
    copyFrom(src: ArrayData, { bundles, srcStart, dstStart, count }?: {
        bundles?: string[];
        srcStart?: number;
        dstStart?: number;
        count?: number;
    }): void;
    clone(): ArrayData<S>;
    swap(other: ArrayData<S>): void;
    toTransferable(): TransferableArrayData;
    setFromTransferable(t: TransferableArrayData): this;
    static fromTransferable(t: TransferableArrayData): ArrayData;
    static transferables(value: unknown): ArrayBuffer[];
    private get anyBundles();
}
