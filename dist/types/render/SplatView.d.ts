import * as THREE from "three";
import { type SortKeyBits } from "../core/sort";
import { GpuArrays } from "../gpu/GpuArrays";
import type { CovSplatModifier, SplatModifier } from "../gpu/splatGenerator";
import { SplatCollection } from "./SplatCollection";
import type { SplatObjectParams, SplatViewParams } from "./splatParams";
import { type ProjectSettings } from "./SplatProjector";
import type { SplatRenderer } from "./SplatRenderer";
import type { ModifierSpace } from "./splatTransform.tsl";
export interface SplatOrder {
    readonly collection: SplatCollection;
    readonly version: number;
    readonly ordering: Uint32Array<ArrayBuffer>;
    readonly visible: number;
    readonly keysMs: number;
    readonly sortMs: number;
}
export interface AutoSort {
    distance: number;
    angle: number;
}
export interface SplatViewOptions {
    collection?: SplatCollection;
    params?: Partial<SplatViewParams>;
    objectParams?: Partial<SplatObjectParams>;
    modifier?: SplatModifier | null;
    covModifier?: CovSplatModifier | null;
    modifierSpace?: ModifierSpace;
    sortBits?: SortKeyBits;
    autoSort?: AutoSort | false;
}
export interface ViewSettings extends ProjectSettings {
    collection: SplatCollection;
    autoSort: AutoSort | false;
}
export declare class SplatView {
    readonly splats: SplatRenderer;
    readonly key: unknown;
    params: Partial<SplatViewParams>;
    objectParams: Partial<SplatObjectParams>;
    modifier?: SplatModifier | null;
    covModifier?: CovSplatModifier | null;
    modifierSpace?: ModifierSpace;
    sortBits?: SortKeyBits;
    autoSort?: AutoSort | false;
    private _collection?;
    private _order?;
    private orderArrays?;
    private sorts;
    private pending;
    private landed;
    private keyArrays;
    private disposed;
    private autoSorting;
    private sortRequested;
    private sortedFrom?;
    /** @internal Made by SplatRenderer.viewFor */
    constructor(splats: SplatRenderer, key: unknown);
    get collection(): SplatCollection | undefined;
    set collection(collection: SplatCollection | undefined);
    get order(): SplatOrder | undefined;
    requestSort(): void;
    sort(camera: THREE.Camera): Promise<SplatOrder>;
    apply(order: SplatOrder): boolean;
    dispose(): void;
    /**
     * @internal SplatRenderer's, before a render in cpu mode, after
     * autoSort's step: the applied order's collection, with its indices
     */
    drawn(camera: THREE.Camera): {
        collection: SplatCollection;
        arrays: GpuArrays;
        visible: number;
    } | undefined;
    /** @internal The collections this view holds live: its own, and in cpu mode its orders' */
    collections(): SplatCollection[];
    /** @internal requestSort without onInvalidate (cpu mode only) */
    wantSort(): void;
    /** @internal The renderer switched to gpu: the orders go */
    dropOrders(): void;
    private land;
    private checkDisposed;
    private autoSortStep;
    private needsSort;
}
