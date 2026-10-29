import { type BundleDef } from "../core/bundles";
import { SortKeys } from "../core/sort";
import { GpuArrayReader } from "../gpu/GpuArrayReader";
import { type TslNode } from "../gpu/tsl";
import { type SplatForm, type SplatNodeOf, type SplatVaryings } from "./projection.tsl";
import { type ProjectionInputs, type ProjectionMethod, type SplatLook } from "./projections.tsl";
import type { EyeNodes } from "./splatCamera";
export interface ProjectedSchema {
    [name: string]: BundleDef;
    projected: BundleDef;
    sortKeys: typeof SortKeys.KEYS;
}
export interface ProjectionOutputs {
    projected: Record<string, TslNode>;
    sortKeys: {
        key: TslNode;
    };
}
export interface KeyOutputs {
    sortKeys: {
        key: TslNode;
    };
}
export declare class SplatProjection<F extends SplatForm = SplatForm> {
    static readonly METHODS: readonly ProjectionMethod[];
    readonly method: ProjectionMethod;
    readonly input: F;
    readonly headWords: number;
    readonly eyeWords: number;
    readonly varyings: readonly (keyof SplatVaryings)[];
    private def;
    private constructor();
    static get<M extends ProjectionMethod>(method: M): SplatProjection<ProjectionInputs[M]>;
    words(eyes: number): number;
    bundle(eyes: number): BundleDef;
    outputs(eyes: number): ProjectedSchema;
    reader(eyes: number): GpuArrayReader;
    loadWords(reader: GpuArrayReader, eyes: number, index: TslNode): TslNode[];
    project(splat: SplatNodeOf<F>, eyes: number): {
        words: any[];
        visible: any;
        invisible: any;
        guarded: any;
        distance: any;
    };
    write(splat: (index: TslNode) => SplatNodeOf<F>, eyes: number): (index: TslNode, out: ProjectionOutputs) => void;
    static setKeys(bits: number, cull: boolean): void;
    static writeKeys<F extends SplatForm>(splat: (index: TslNode) => SplatNodeOf<F>, form: F): (index: TslNode, out: KeyOutputs) => void;
    look(head: TslNode[], eye: TslNode[]): SplatLook;
    vertex(head: TslNode[], eye: TslNode[], view: EyeNodes, corner: TslNode, boundStdDev: TslNode, cutoffStdDev: TslNode, out: TslNode): void;
    density(varyings: SplatVaryings): TslNode;
}
