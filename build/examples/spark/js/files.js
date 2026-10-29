// Splat files on the GPU for the ports, with their spherical harmonics
// (Radix loads them into an extSh bundle and draws them seen from each
// view, as Spark's SplatMesh does):
//   loadSplatFile  a splat file on the GPU: { data, arrays, indices?,
//                  shPalette? } (indices: a LoD file's leaves, the original
//                  splats, as an index list; shPalette: RAD's clustered SH)
//   fileOf         a table on the GPU, as a LoadedFile
//   fileObject     a SplatObject drawing a loaded file, with optional
//                  object-space modifiers
                                    
                                                   
import {
  GpuArrays, GpuShPalette, SplatCollection, SplatGenerator, Splats, loadSplatFile as readSplatFile,
                                                                                                                             
} from "@sparkjsdev/radix";

// A splat file on the GPU
                             
                  
                    
                                                                          
                                                                          
                      
                                              
                        
 

                              
                       
                                     
                                                         
                                                                        
                
 

export async function loadSplatFile(renderer                , url        , { layout, encoding, onProgress, sh }              = {})                      {
  const { splats, shPalette } = await readSplatFile(url, { layout, encoding, onProgress, sh });
  return fileOf(renderer, splats, shPalette);
}

// A table (and the palette of its shLabel) on the GPU, as a LoadedFile
export function fileOf(renderer                , data           , shPalette            )             {
  const leaves = lodLeaves(data);
  return {
    data, arrays: GpuArrays.fromData(renderer, data), indices: leaves && SplatGenerator.indices(renderer, leaves),
    shPalette: shPalette && GpuShPalette.upload(renderer, shPalette),
  };
}

// Frees a LoadedFile's GPU arrays
export function releaseFile({ arrays, indices, shPalette }            ) {
  [arrays, indices, shPalette].forEach((each) => each?.dispose());
}

// The leaves of a file's LoD tree (nodes without children), or undefined
// without a tree
function lodLeaves(data           ) {
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
export function fileObject(file            , { matrixWorld, modifiers }   
                              
                              
  = {})                 {
  const { arrays, indices, shPalette } = file;
  if (!indices && !modifiers) {
    return SplatCollection.arrays(arrays, { matrixWorld, shPalette });
  }
  const generator = SplatGenerator.forArrays(arrays, { remap: indices ? "indices" : undefined, modifiers, shPalette });
  return { generator, data: { splats: arrays, indices, shPalette }, count: indices ? indices.count : arrays.count, matrixWorld };
}


//# sourceURL=examples/spark/js/files.ts