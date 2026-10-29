import * as THREE from "three";
import { NodeMaterial, type WebGPURenderer } from "three/webgpu";
import type { SortKeyBits } from "../core/sort";
import type { CovSplatModifier, SplatModifier } from "../gpu/splatGenerator";
import { WorkerPool, type WorkerLease } from "../worker/WorkerPool";
import type { ProjectionMethod } from "./projections.tsl";
import { SplatCollection } from "./SplatCollection";
import { type SplatObjectParams, type SplatViewParams } from "./splatParams";
import type { ModifierSpace } from "./splatTransform.tsl";
import { SplatView, type AutoSort, type SplatViewOptions, type ViewSettings } from "./SplatView";
export interface SplatRendererOptions {
    renderer: WebGPURenderer;
    collection?: SplatCollection;
    method?: ProjectionMethod;
    sortBits?: SortKeyBits;
    params?: Partial<SplatViewParams>;
    objectParams?: Partial<SplatObjectParams>;
    modifier?: SplatModifier;
    covModifier?: CovSplatModifier;
    modifierSpace?: ModifierSpace;
    sortMode?: "gpu" | "cpu";
    autoSort?: AutoSort | false;
    sortWorker?: WorkerPool | WorkerLease;
    viewKey?: (camera: THREE.Camera) => unknown;
    onInvalidate?: (view?: SplatView) => void;
}
export declare class SplatRenderer extends THREE.Mesh<THREE.InstancedBufferGeometry, NodeMaterial> {
    private static readonly renderers;
    private static readonly watched;
    private static readonly lost;
    static sortWorkers: number;
    static get sortPool(): WorkerPool;
    readonly renderer: WebGPURenderer;
    method: ProjectionMethod;
    sortBits: SortKeyBits;
    readonly params: SplatViewParams;
    readonly objectParams: SplatObjectParams;
    modifier?: SplatModifier;
    covModifier?: CovSplatModifier;
    modifierSpace: ModifierSpace;
    autoSort: AutoSort | false;
    sortWorker?: WorkerPool | WorkerLease;
    viewKey: (camera: THREE.Camera) => unknown;
    onInvalidate?: (view?: SplatView) => void;
    view?: SplatView;
    phase?: <T>(name: string, run: () => T) => T;
    private _collection;
    private _sortMode;
    private _views;
    private warnedViews;
    private live;
    private token;
    private disposed;
    private projected;
    private sorter?;
    private preparedAt;
    private orderReader;
    private orderCount;
    private encodeLinear;
    private drawState;
    constructor({ renderer, collection, method, sortBits, params, objectParams, modifier, covModifier, modifierSpace, sortMode, autoSort, sortWorker, viewKey, onInvalidate, }: SplatRendererOptions);
    get collection(): SplatCollection;
    set collection(collection: SplatCollection);
    get sortMode(): "gpu" | "cpu";
    set sortMode(mode: "gpu" | "cpu");
    get views(): ReadonlyMap<unknown, SplatView>;
    viewFor(key: unknown, options?: SplatViewOptions): SplatView;
    requestSort(): void;
    readSortedCount(): Promise<number>;
    onBeforeRender(_renderer: unknown, _scene: THREE.Scene, camera: THREE.Camera): void;
    prepare(camera: THREE.Camera): void;
    dispose(): void;
    /** @internal The settings `view` draws with: its own over this renderer's */
    settingsOf(view?: SplatView): ViewSettings;
    /** @internal Sort keys on the app's sortWorker, else the shared sort pool */
    sortKeys(keys: Uint32Array<ArrayBuffer>, bits: SortKeyBits): Promise<import("..").SortedSplats>;
    /** @internal A view was disposed */
    forget(view: SplatView): void;
    /** @internal The live collections changed: watch new objects, release retired ones */
    updateLive(): void;
    private static sweep;
    private viewOf;
    private update;
    private makeProjected;
    private buildMaterial;
}
