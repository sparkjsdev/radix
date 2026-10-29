import { type SortKeyBits } from "../core/sort";
import { type WorkerChoice } from "./splatFiles";
export interface SortedSplats {
    ordering: Uint32Array<ArrayBuffer>;
    visible: number;
    keys: Uint32Array<ArrayBuffer>;
}
export declare function sortSplatKeys(keys: Uint32Array<ArrayBuffer>, { bits, ordering, worker }: {
    bits: SortKeyBits;
    ordering?: Uint32Array<ArrayBuffer>;
    worker?: WorkerChoice;
}): Promise<SortedSplats>;
