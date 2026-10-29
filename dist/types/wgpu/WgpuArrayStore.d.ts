import type { BundleDef, Schema } from "../core/bundles";
import { type GpuArrays } from "../gpu/GpuArrays";
import { type TslNode } from "../gpu/tsl";
export declare class WgpuArrayStore<D extends BundleDef = BundleDef> {
    readonly def: D;
    private yBits;
    private yMask;
    private channels;
    constructor(def: D);
    bind(arrays: GpuArrays<Schema, true>, name: string): this;
    store(channel: keyof D["channels"] & string, index: TslNode, value: TslNode): void;
    storeTexel(channel: keyof D["channels"] & string, texel: TslNode, value: TslNode): void;
}
