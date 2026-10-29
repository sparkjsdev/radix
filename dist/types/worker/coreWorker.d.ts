import { type TransferableArrayData } from "../core/ArrayData";
import type { CoordinateSystem } from "../core/axes";
import { type SplatFormat, type SplatRequestInit, type SplatWriteOptions } from "../core/files";
import type { Progress } from "../core/progress";
import { type SortKeyBits } from "../core/sort";
import { type ShTarget } from "../core/sh";
import type { SplatTarget } from "../core/splats";
interface Context {
    progress: Progress;
    signal: AbortSignal;
}
declare const handlers: {
    loadSplats({ url, bytes, name, layout, encoding, sh, coordinateSystem, palette, request }: SplatTarget & {
        url?: string;
        bytes?: Uint8Array<ArrayBuffer>;
        name?: string;
        sh?: ShTarget;
        coordinateSystem?: CoordinateSystem;
        palette?: boolean;
        request?: SplatRequestInit;
    }, { progress, signal }: Context): Promise<{
        splats: TransferableArrayData;
        shPalette?: undefined;
    } | {
        splats: TransferableArrayData;
        shPalette: TransferableArrayData | undefined;
    }>;
    writeSplats({ data, shPalette, format, options }: {
        data: TransferableArrayData;
        shPalette?: TransferableArrayData;
        format: SplatFormat;
        options?: SplatWriteOptions;
    }, { progress }: Context): Promise<{
        data: TransferableArrayData;
        shPalette: TransferableArrayData | undefined;
        bytes: Uint8Array<ArrayBuffer>;
        error: undefined;
    } | {
        data: TransferableArrayData;
        shPalette: TransferableArrayData | undefined;
        bytes: undefined;
        error: string;
    }>;
    sortKeys({ keys, count, bits, ordering }: {
        keys: Uint32Array<ArrayBuffer>;
        count: number;
        bits: SortKeyBits;
        ordering?: Uint32Array<ArrayBuffer>;
    }): {
        keys: Uint32Array<ArrayBuffer>;
        ordering: Uint32Array<ArrayBuffer>;
        visible: number;
    };
};
export type WorkerHandlers = typeof handlers;
export declare function serveWorker(): void;
export {};
