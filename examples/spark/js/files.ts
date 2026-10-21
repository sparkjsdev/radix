// Splat files on the GPU for the ports, with their spherical harmonics
import type * as THREE from "three";
import type { WebGPURenderer } from "three/webgpu";
import {
  GpuArrays, GpuShPalette, SplatCollection, SplatGenerator, Splats, loadSplatFile as readSplatFile,
  type AnySplatObject, type ArrayData, type ShPalette, type ShTarget, type SplatLayout, type SplatModifier, type SplatTarget,
} from "@sparkjsdev/radix";

export interface LoadedFile {
  data: ArrayData;
  arrays: GpuArrays;
  // A LoD file's leaves: Radix loads LoD trees but does not choose nodes,
  // and drawing every node would stack merged parents over their children
  indices?: GpuArrays;
  // The palette of the splats' shLabel bundle
  shPalette?: GpuArrays;
}

export interface LoadOptions {
  layout?: SplatLayout;
  encoding?: SplatTarget["encoding"];
  onProgress?: (fraction: number, stage: string) => void;
  // Spherical harmonics: a codec (default "ext"), or false to skip them
  sh?: ShTarget;
}

export async function loadSplatFile(renderer: WebGPURenderer, url: string, { layout, encoding, onProgress, sh }: LoadOptions = {}): Promise<LoadedFile> {
  const { splats, shPalette } = await readSplatFile(url, { layout, encoding, onProgress, sh });
  return fileOf(renderer, splats, shPalette);
}

// A table on the GPU, its LoD tree's leaves as indices
export function fileOf(renderer: WebGPURenderer, data: ArrayData, shPalette?: ShPalette): LoadedFile {
  const leaves = lodLeaves(data);
  return {
    data, arrays: GpuArrays.fromData(renderer, data), indices: leaves && SplatGenerator.indices(renderer, leaves),
    shPalette: shPalette && GpuShPalette.upload(renderer, shPalette),
  };
}

export function releaseFile({ arrays, indices, shPalette }: LoadedFile) {
  [arrays, indices, shPalette].forEach((each) => each?.dispose());
}

function lodLeaves(data: ArrayData) {
  const tree = Splats.findLodTree(data);
  if (!tree) {
    return undefined;
  }
  const nodes = tree.channels.node.data;
  const leaves = new Uint32Array(data.count);
  let count = 0;
  for (let i = 0; i < data.count; i += 1) {
    if (nodes[i * 2] === 0) {
      leaves[count++] = i;
    }
  }
  return leaves.subarray(0, count);
}

// modifiers run in object space
export function fileObject(file: LoadedFile, { matrixWorld, modifiers }: {
  matrixWorld?: THREE.Matrix4;
  modifiers?: SplatModifier[];
} = {}): AnySplatObject {
  const { arrays, indices, shPalette } = file;
  if (!indices && !modifiers) {
    return SplatCollection.arrays(arrays, { matrixWorld, shPalette });
  }
  const generator = SplatGenerator.forArrays(arrays, { remap: indices ? "indices" : undefined, modifiers, shPalette });
  return { generator, data: { splats: arrays, indices, shPalette }, count: indices ? indices.count : arrays.count, matrixWorld };
}
