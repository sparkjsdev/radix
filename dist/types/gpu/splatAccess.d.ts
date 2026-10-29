import type { BundleDef } from "../core/bundles";
import { Splats, type SplatLayout } from "../core/splats";
import { GpuArrayReader } from "./GpuArrayReader";
import type { GpuArrays } from "./GpuArrays";
import { type CovSplatNode, type PbrNode, type SplatNode } from "./splats.tsl";
import { type TslNode } from "./tsl";
export declare abstract class GpuSplatReader<D extends BundleDef = BundleDef> extends GpuArrayReader<D> {
    abstract readonly layout: SplatLayout;
    static for(layout: "extSplats"): GpuExtSplatReader;
    static for(layout: "covSplats"): GpuCovSplatReader;
    static for(layout: "packedSplats"): GpuPackedSplatReader;
    static for(layout: SplatLayout): AnyGpuSplatReader;
    static from(arrays: GpuArrays, name?: string): AnyGpuSplatReader;
    bind(arrays?: GpuArrays, name?: string): this;
    abstract loadSplat(index: TslNode): SplatNode;
    abstract loadCovSplat(index: TslNode): CovSplatNode;
    abstract loadCenter(index: TslNode): TslNode;
    abstract loadRgb(index: TslNode): TslNode;
    abstract loadOpacity(index: TslNode): TslNode;
}
export declare class GpuExtSplatReader extends GpuSplatReader<typeof Splats.EXT> {
    readonly layout = "extSplats";
    constructor();
    loadSplat(index: TslNode): SplatNode;
    loadCovSplat(index: TslNode): CovSplatNode;
    loadPbr(index: TslNode): PbrNode;
    loadCenter(index: TslNode): any;
    loadRgb(index: TslNode): any;
    loadOpacity(index: TslNode): any;
}
export declare class GpuCovSplatReader extends GpuSplatReader<typeof Splats.COV> {
    readonly layout = "covSplats";
    constructor();
    loadSplat(index: TslNode): SplatNode;
    loadCovSplat(index: TslNode): CovSplatNode;
    loadCenter(index: TslNode): any;
    loadRgb(index: TslNode): any;
    loadOpacity(index: TslNode): any;
}
export declare class GpuPackedSplatReader extends GpuSplatReader<typeof Splats.PACKED> {
    readonly layout = "packedSplats";
    readonly encoding: TslNode;
    constructor();
    bind(arrays?: GpuArrays, name?: string): this;
    loadSplat(index: TslNode): SplatNode;
    loadCovSplat(index: TslNode): CovSplatNode;
    loadCenter(index: TslNode): any;
    loadRgb(index: TslNode): any;
    loadOpacity(index: TslNode): any;
}
export type AnyGpuSplatReader = GpuExtSplatReader | GpuCovSplatReader | GpuPackedSplatReader;
