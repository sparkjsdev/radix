import { type ArrayFormat } from "./formats";
export type BundleChannels = Record<string, ArrayFormat>;
export interface BundleDef<C extends BundleChannels = BundleChannels> {
    channels: C;
    packing: 1 | 2 | 4;
    serialize: boolean;
}
export type Schema = Record<string, BundleDef>;
export declare function defineBundle<const C extends BundleChannels>(channels: C, { packing, serialize }?: {
    packing?: 1 | 2 | 4;
    serialize?: boolean;
}): BundleDef<C>;
