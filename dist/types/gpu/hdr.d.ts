import type { WebGPURenderer } from "three/webgpu";
import { type TslNode } from "./tsl";
declare function displaySupportsHdr(): boolean;
declare function canvasSupportsHdr(renderer: WebGPURenderer): boolean;
declare function setHdrOutput(renderer: WebGPURenderer, extended: boolean): boolean;
export interface HdrToneMapping {
    headroom: TslNode;
    knee: TslNode;
    whiten: TslNode;
    get exposure(): number;
    set exposure(value: number);
    get enabled(): boolean;
    set enabled(on: boolean);
}
declare function useHdrToneMapping(renderer: WebGPURenderer, { headroom, knee, whiten, enabled, }?: {
    headroom?: number;
    knee?: number;
    whiten?: number;
    enabled?: boolean;
}): HdrToneMapping;
export declare function hdrToneMappingActive(renderer: WebGPURenderer): boolean;
export declare class Hdr {
    static readonly displaySupports: typeof displaySupportsHdr;
    static readonly canvasSupports: typeof canvasSupportsHdr;
    static readonly setOutput: typeof setHdrOutput;
    static readonly useToneMapping: typeof useHdrToneMapping;
}
export {};
