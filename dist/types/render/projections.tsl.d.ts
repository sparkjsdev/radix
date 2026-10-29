import type { EyeNodes } from "./splatCamera";
import type { SplatParamNodes } from "./splatParams";
import { type PreparedSplat, type SplatForm, type SplatInView, type SplatVaryings } from "./projection.tsl";
import { type TslNode } from "../gpu/tsl";
export type ProjectionMethod = "ewa" | "3dgut" | "htgs" | "raygs";
export interface ProjectionInputs {
    ewa: "cov";
    "3dgut": "splat";
    htgs: "splat";
    raygs: "splat";
}
export interface ProjectContext<F extends SplatForm> {
    splat: PreparedSplat<F>;
    head: SplatInView;
    eyes: number;
    params: SplatParamNodes;
}
export interface SplatLook {
    visible: TslNode;
    rgb: TslNode;
    opacity: TslNode;
}
export interface ProjectionDef<F extends SplatForm = SplatForm> {
    input: F;
    headWords: number;
    eyeWords: number;
    varyings: readonly (keyof SplatVaryings)[];
    project(ctx: ProjectContext<F>): {
        words: TslNode[];
        visible: TslNode;
    };
    look(head: TslNode[], eye: TslNode[]): SplatLook;
    vertex(head: TslNode[], eye: TslNode[], view: EyeNodes, corner: TslNode, boundStdDev: TslNode, cutoffStdDev: TslNode, out: TslNode): void;
    density(varyings: SplatVaryings): TslNode;
}
export declare const PROJECTIONS: {
    [M in ProjectionMethod]: ProjectionDef<ProjectionInputs[M]>;
};
