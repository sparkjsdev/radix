// A kind of fractal: its parameters (each one a uniform the writer reads),
// the writer that bakes its samples, and the look it wants.
import * as THREE from "three";
import { TSL, type GpuArrayWriter, type TslNode } from "@sparkjsdev/radix";
import type { Look } from "./shade.js";

const { uniform } = TSL;

export interface Param {
  value: number;
  min: number;
  max: number;
  step?: number;
  label?: string;
}

export type Family = "surface" | "cloud" | "threads" | "tree";

export interface Kind {
  id: string;
  label: string;
  family: Family;
  params: Record<string, Param>;
  uniforms: Record<string, TslNode>;
  // Made on first use (one program per kind)
  writer: () => GpuArrayWriter;
  // Before each bake, with the current parameter values
  prepare?: (values: Record<string, number>) => void;
  // Look values the kind sets when chosen (motion, flatness, glow)
  look?: Partial<Look>;
  // Samples carry a 4th coordinate, turned by the draw
  fourD?: boolean;
}

// What every writer reads besides its kind's parameters
export function makeBakeUniforms() {
  return {
    seed: uniform(0, "uint"),
    // Samples in the bake
    count: uniform(1),
    // 0: rays from all around the fractal, 1: from the camera (eye, basis
    // and frustum tangents, display units)
    fromCamera: uniform(0),
    eye: uniform(new THREE.Vector3()),
    forward: uniform(new THREE.Vector3(0, 0, -1)),
    right: uniform(new THREE.Vector3(1, 0, 0)),
    up: uniform(new THREE.Vector3(0, 1, 0)),
    tanX: uniform(1),
    tanY: uniform(1),
    lightDir: uniform(new THREE.Vector3(0, 1, 0)),
    // Splat size relative to the sample spacing
    coverage: uniform(1),
    // Sphere-tracing steps per ray
    maxSteps: uniform(200),
  };
}
export type BakeUniforms = ReturnType<typeof makeBakeUniforms>;

export function paramUniforms(params: Record<string, Param>) {
  return Object.fromEntries(Object.entries(params).map(([key, param]) => [key, uniform(param.value)])) as Record<string, TslNode>;
}
