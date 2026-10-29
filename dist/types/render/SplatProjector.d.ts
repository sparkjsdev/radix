import type { WebGPURenderer } from "three/webgpu";
import { type SortKeyBits } from "../core/sort";
import type { GpuArrays } from "../gpu/GpuArrays";
import { GpuArrayWriter } from "../gpu/GpuArrayWriter";
import { type AnySplatGenerator, type CovSplatModifier, type SplatModifier } from "../gpu/splatGenerator";
import { WgpuArrayWriter } from "../wgpu/WgpuArrayWriter";
import type { ProjectionMethod } from "./projections.tsl";
import { SplatCollection } from "./SplatCollection";
import { type SplatObjectParams, type SplatViewParams } from "./splatParams";
import { type ModifierSpace } from "./splatTransform.tsl";
export type ProjectPass = "full" | "keys";
export interface ProjectSettings {
    method: ProjectionMethod;
    sortBits: SortKeyBits;
    params: SplatViewParams;
    objectParams: SplatObjectParams;
    modifier?: SplatModifier;
    covModifier?: CovSplatModifier;
    modifierSpace: ModifierSpace;
}
type Writer = GpuArrayWriter | WgpuArrayWriter;
export declare class SplatProjector {
    static programs: number;
    static dispose(generator: object): void;
}
interface ProgramKey {
    pass: ProjectPass;
    method: ProjectionMethod;
    eyes: number;
    modifier?: SplatModifier;
    covModifier?: CovSplatModifier;
    webgpu: boolean;
}
export declare function programOf(generator: AnySplatGenerator, key: ProgramKey): Writer;
export declare function projectCollection({ renderer, settings, collection, arrays, pass, cullKeys }: {
    renderer: WebGPURenderer;
    settings: ProjectSettings;
    collection: SplatCollection;
    arrays: GpuArrays;
    pass: ProjectPass;
    cullKeys?: boolean;
}): void;
export declare function readSortKeys(arrays: GpuArrays, count?: number): Promise<Uint32Array<ArrayBuffer>>;
export {};
