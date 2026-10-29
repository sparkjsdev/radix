import { InspectorBase, type ComputeNode } from "three/webgpu";
export interface GpuProfile {
    gpu: Record<string, number>;
    cpu: Record<string, number>;
    frames: number;
}
export declare class GpuProfiler extends InspectorBase {
    label: string;
    private frame;
    private passes;
    private cpu;
    private cpuFrames;
    beginFrame(): void;
    phase<T>(name: string, fn: () => T): T;
    mark(name: string, ms: number): void;
    beginCompute(uid: string, computeNode: ComputeNode): void;
    beginRender(uid: string): void;
    get active(): boolean;
    set active(on: boolean);
    get supported(): boolean;
    private backend;
    collect(): Promise<GpuProfile | undefined>;
    static format(profile: GpuProfile): string;
}
