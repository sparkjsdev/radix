import { NodeMaterial, type WebGPURenderer } from "three/webgpu";
import type { GpuArrayReader } from "../gpu/GpuArrayReader";
import { type TslNode } from "../gpu/tsl";
import type { SplatProjection } from "./SplatProjection";
export declare const DrawVertex: any;
export declare const quadCorner: (v: TslNode) => any;
export declare function quadIndices(quads: number): Uint16Array<ArrayBuffer>;
export interface DrawOptions {
    projection: SplatProjection;
    eyes: number;
    projected: GpuArrayReader;
    order: (i: TslNode) => TslNode;
    count: TslNode;
    quads: number;
    encodeLinear: TslNode;
}
export declare function makeDrawMaterial(options: DrawOptions): NodeMaterial;
export declare function setDrawNodes(material: NodeMaterial, options: DrawOptions): void;
export declare function outputIsLinear(renderer: WebGPURenderer): boolean;
