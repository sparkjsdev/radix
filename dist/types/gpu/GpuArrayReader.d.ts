import type { BundleDef } from "../core/bundles";
import { type GpuArrays } from "./GpuArrays";
import { type TslNode } from "./tsl";
export declare class GpuArrayReader<D extends BundleDef = BundleDef> {
    readonly def: D;
    readonly count: TslNode;
    private yBits;
    private yMask;
    private channels;
    constructor(def: D);
    bind(arrays?: GpuArrays, name?: string): this;
    load(channel: keyof D["channels"] & string, index: TslNode): TslNode;
    fetch(channel: keyof D["channels"] & string, index: TslNode): TslNode;
    private channel;
}
