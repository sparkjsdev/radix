// LCC2 chunk files in .spz or .ply (.sog files decode on the GPU through
// examples/sogs/gpuDecode.ts) into ext splats with Radix's CPU reader,
// their spherical harmonics into Radix's extSh bundle (the readers' SH
// codec, drawn by lccSh.tsl.ts's ext generator). The core module is passed
// in (the decode workers load radix-core.module.js by URL, the Node checks
// import the sources).
import type * as Core from "@sparkjsdev/radix/core";

export interface DecodedChunk {
  data: Core.ArrayData;
  // Whether the chunk's splats carry SH (bundle extSh)
  sh: boolean;
}

export async function decodeChunk(core: typeof Core, bytes: Uint8Array<ArrayBuffer>, name: string, wantSh: boolean): Promise<DecodedChunk> {
  const data = (await core.SplatFiles.decode(bytes, { name, sh: wantSh ? "ext" : false })).splats as unknown as Core.ArrayData;
  return { data, sh: core.Sh.find(data.bundles) !== undefined };
}
