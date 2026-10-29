// Splat files on the GPU for the ports, with their spherical harmonics
// (Radix loads them into an extSh bundle and draws them seen from each
// view, as Spark's SplatMesh does):
//   loadSplatFile  a splat file on the GPU: { data, arrays, indices?,
//                  shPalette? } (indices: a LoD file's leaves, the original
//                  splats, as an index list; shPalette: RAD's clustered SH)
//   fileOf         a table on the GPU, as a LoadedFile
//   fileObject     a SplatObject drawing a loaded file, with optional
//                  object-space modifiers
import type * as THREE from "three";
import type { WebGPURenderer } from "three/webgpu";
import {
  GpuArrays, GpuShPalette, SplatCollection, SplatGenerator, Splats, loadSplatFile as readSplatFile,
  type AnySplatObject, type ArrayData, type ShPalette, type ShTarget, type SplatLayout, type SplatModifier, type SplatTarget,
} from "@sparkjsdev/radix";

// A splat file on the GPU
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

// A table (and the palette of its shLabel) on the GPU, as a LoadedFile
export function fileOf(renderer: WebGPURenderer, data: ArrayData, shPalette?: ShPalette): LoadedFile {
  const leaves = lodLeaves(data);
  return {
    data, arrays: GpuArrays.fromData(renderer, data), indices: leaves && SplatGenerator.indices(renderer, leaves),
    shPalette: shPalette && GpuShPalette.upload(renderer, shPalette),
  };
}

// Frees a LoadedFile's GPU arrays
export function releaseFile({ arrays, indices, shPalette }: LoadedFile) {
  [arrays, indices, shPalette].forEach((each) => each?.dispose());
}

// The leaves of a file's LoD tree (nodes without children), or undefined
// without a tree
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

// A SplatObject drawing a loaded file placed by `matrixWorld` (an Object3D's
// matrixWorld, say), with its SH and optional object-space modifiers; a
// file without LoD leaves or modifiers is plain SplatCollection.arrays
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
