import { ArrayData } from "../core/ArrayData";
import type { CoordinateSystem } from "../core/axes";
import { type SplatFormat, type SplatRequestInit, type SplatWriteOptions } from "../core/files";
import type { Progress } from "../core/progress";
import { type ShTarget } from "../core/sh";
import type { LoadedSplats, SplatData, SplatLayout, SplatTarget } from "../core/splats";
import { WorkerLease, WorkerPool } from "./WorkerPool";
export type WorkerChoice = boolean | WorkerPool | WorkerLease;
export type SplatSource = string | URL | Blob | Uint8Array<ArrayBuffer> | ArrayBuffer;
export declare function workerTarget(worker: WorkerChoice | undefined): WorkerPool | WorkerLease | undefined;
export type LoadSplatsOptions<L extends SplatLayout = "extSplats"> = SplatTarget<L> & {
    name?: string;
    worker?: WorkerChoice;
    onProgress?: Progress;
    sh?: ShTarget;
    coordinateSystem?: CoordinateSystem;
    request?: SplatRequestInit;
    signal?: AbortSignal;
};
export declare function loadSplats<L extends SplatLayout = "extSplats">(source: SplatSource, options?: LoadSplatsOptions<L>): Promise<SplatData<L>>;
export declare function loadSplatFile<L extends SplatLayout = "extSplats">(source: SplatSource, options?: LoadSplatsOptions<L>): Promise<LoadedSplats<L>>;
export declare function writeSplats(data: ArrayData, format: SplatFormat, { worker, onProgress, shPalette, ...options }?: SplatWriteOptions & {
    worker?: WorkerChoice;
    onProgress?: Progress;
}): Promise<Uint8Array<ArrayBuffer>>;
