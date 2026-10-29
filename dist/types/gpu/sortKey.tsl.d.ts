import { type TslNode } from "./tsl";
export declare class GpuSortKeys {
    static invalid(bits: TslNode): TslNode;
    static compute(distance: TslNode, bits: TslNode): TslNode;
    static pack(key: TslNode): TslNode;
    static unpack(rgba: TslNode): TslNode;
}
