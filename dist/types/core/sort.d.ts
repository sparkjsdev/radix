export type SortKeyBits = 16 | 24 | 32;
export declare class SortKeys {
    static readonly KEY16_LO: number;
    static readonly KEY16_HI: number;
    static readonly KEYS: import("./bundles").BundleDef<{
        readonly key: "unorm8x4";
    }>;
    static invalid(bits: SortKeyBits): number;
    static validMax(bits: SortKeyBits): number;
    static compute(distance: number, bits: SortKeyBits): number;
    static sort<O extends Uint32Array = Uint32Array<ArrayBuffer>>({ keys, count, bits, ordering }: {
        keys: Uint32Array;
        count: number;
        bits: SortKeyBits;
        ordering?: O;
    }): {
        ordering: O;
        visible: number;
    };
}
