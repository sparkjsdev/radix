// LCC2 chunk files in .spz or .ply (.sog files decode on the GPU through
// examples/sogs/gpuDecode.ts) into ext splats with Radix's CPU reader,
// their spherical harmonics into Radix's extSh bundle (the readers' SH
// codec, drawn by lccSh.tsl.ts's ext generator). The core module is passed
// in (the decode workers load radix-core.module.js by URL, the Node checks
// import the sources).
                                                    

                               
                       
                                                       
              
 

export async function decodeChunk(core             , bytes                         , name        , wantSh         )                        {
  const data = (await core.SplatFiles.decode(bytes, { name, sh: wantSh ? "ext" : false })).splats                             ;
  return { data, sh: core.Sh.find(data.bundles) !== undefined };
}


//# sourceURL=examples/lcc/lccChunk.ts