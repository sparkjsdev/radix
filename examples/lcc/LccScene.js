// An XGRIDS LCC v1 scene (https://github.com/xgrids/LCCWhitepaper): its
// meta file (JSON, any name ending in .lcc), index.bin (one record per grid
// cell: u16 x, u16 y, then per level u32 count, u64 offset, u32 size into
// data.bin), the optional shcoef.bin (64 bytes per splat at twice data.bin's
// offsets: spherical harmonics, "Quality" files), the optional
// environment.bin (background splats outside the grid, no index: data.bin
// records, each followed by its 64 SH bytes in Quality files, quantized over
// the env* attribute ranges) and the spawn point of attrs.lcp (or
// assets/attrs.json). Plain code with no imports, so the page
// and the decode workers share it. An LccSource is a folder URL or a set of
// dropped / picked files, both structured-cloneable: names are matched
// without case (index.bin or Index.bin), range reads use HTTP Range
// requests or File.slice.

// files: each with its path inside the dropped or picked folder
                       
                                 
                                                             

                            
                                     
                                     
                                  
                                  
 

                          
               
                     
                      
                      
                         
                   
                   
                                                                                
                    
                                                               
 

// One level of one cell: `count` splats at `offset` in data.bin
                           
               
                
                
                 
               
 

                          
            
            
                                                                            
                                
                                
             
                     
 

                           
                                     
                                                         
                                             
 

// A file of a source by name (no case, any folder); undefined when absent
function fileOf(source                                       , name        ) {
  const lower = name.toLowerCase();
  return source.files.find(({ path }) => {
    const p = path.toLowerCase();
    return p === lower || p.endsWith(`/${lower}`);
  })?.file;
}

function urlOf(source                                     , name        ) {
  return new URL(name, source.meta).href;
}

// The bytes [start, end) of a scene file
export async function readRange(source           , name        , start        , end        , signal              )                                   {
  if (end <= start) {
    return new Uint8Array(0);
  }
  if (source.kind === "files") {
    const file = fileOf(source, name);
    if (!file) {
      throw new Error(`No ${name} among the files`);
    }
    return new Uint8Array(await file.slice(start, end).arrayBuffer());
  }
  const response = await fetch(urlOf(source, name), { headers: { Range: `bytes=${start}-${end - 1}` }, signal });
  if (!response.ok) {
    throw new Error(`${name}: HTTP ${response.status}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  // A server without range support sends the whole file
  return response.status === 206 ? bytes : bytes.slice(start, end);
}

// A whole small file, or undefined when it is not there
export async function readOptional(source           , name        , signal              )                                               {
  if (source.kind === "files") {
    const file = fileOf(source, name);
    return file ? new Uint8Array(await file.arrayBuffer()) : undefined;
  }
  const response = await fetch(urlOf(source, name), { signal });
  return response.ok ? new Uint8Array(await response.arrayBuffer()) : undefined;
}

async function exists(source           , name        ) {
  if (source.kind === "files") {
    return fileOf(source, name) !== undefined;
  }
  const response = await fetch(urlOf(source, name), { method: "HEAD" });
  return response.ok;
}

const vec3 = (values                      , fallback        )                           =>
  [values?.[0] ?? fallback, values?.[1] ?? fallback, values?.[2] ?? fallback];

export class LccScene {
           source           ;
           meta         ;
           cells           ;
           sh         ;
           ranges           ;
  // environment.bin may be there: among the files, or (for a URL, which is
  // only fetched to find out) the meta has env* ranges
           environment         ;
           envRanges           ;
           spawn           ;

          constructor(source           , meta         , cells           , sh         , spawn           ) {
    this.source = source;
    this.meta = meta;
    this.cells = cells;
    this.sh = sh;
    this.spawn = spawn;
    const attribute = (name        ) => meta.attributes?.find((a) => a.name === name);
    this.ranges = {
      scaleMin: vec3(attribute("scale")?.min, 0),
      scaleMax: vec3(attribute("scale")?.max, 1),
      shMin: vec3(attribute("shcoef")?.min, -1),
      shMax: vec3(attribute("shcoef")?.max, 1),
    };
    this.envRanges = {
      scaleMin: attribute("envscale") ? vec3(attribute("envscale")?.min, 0) : this.ranges.scaleMin,
      scaleMax: attribute("envscale") ? vec3(attribute("envscale")?.max, 1) : this.ranges.scaleMax,
      shMin: attribute("envshcoef") ? vec3(attribute("envshcoef")?.min, -1) : this.ranges.shMin,
      shMax: attribute("envshcoef") ? vec3(attribute("envshcoef")?.max, 1) : this.ranges.shMax,
    };
    this.environment = source.kind === "files" ? fileOf(source, "environment.bin") !== undefined : attribute("envscale") !== undefined;
  }

  // The normal ranges of the grid's splats and of the environment's
  get normalRange() {
    return this.meta.attributes?.find((a) => a.name === "normal");
  }

  get envNormalRange() {
    return this.meta.attributes?.find((a) => a.name === "envnormal");
  }

  get levels() {
    return this.meta.totalLevel;
  }

  // The scene's folder name, else the meta's name
  get name() {
    const path = this.source.kind === "url"
      ? decodeURIComponent(new URL(this.source.meta).pathname)
      : this.source.files.find((entry) => entry.path.toLowerCase().endsWith(".lcc"))?.path ?? "";
    return path.split("/").filter(Boolean).slice(-2, -1)[0] ?? this.meta.name;
  }

  static async open(source           )                    {
    const metaBytes = source.kind === "url"
      ? await fetch(source.meta).then((response) => {
        if (!response.ok) {
          throw new Error(`${source.meta}: HTTP ${response.status}`);
        }
        return response.arrayBuffer();
      })
      : await (fileOf(source, "meta.lcc") ?? source.files.find(({ path }) => path.toLowerCase().endsWith(".lcc"))?.file)?.arrayBuffer();
    if (!metaBytes) {
      throw new Error("No .lcc meta file among the files");
    }
    const meta = JSON.parse(new TextDecoder().decode(metaBytes))           ;

    const index = await readOptional(source, "index.bin");
    if (!index) {
      throw new Error("No index.bin beside the meta file");
    }
    const cells = LccScene.parseIndex(meta, index);

    const shAttribute = meta.attributes?.some((a) => a.name === "shcoef");
    const sh = meta.fileType === "Quality" || (meta.fileType === undefined && shAttribute === true && await exists(source, "shcoef.bin"));

    const attrs = await readOptional(source, "attrs.lcp") ?? await readOptional(source, "assets/attrs.json") ?? await readOptional(source, "attrs.json");
    let spawn                      ;
    try {
      const point = attrs && (JSON.parse(new TextDecoder().decode(attrs))                                    ).spawnPoint;
      spawn = point?.position && point.rotation ? point : undefined;
    } catch {
      spawn = undefined;
    }
    return new LccScene(source, meta, cells, sh, spawn);
  }

  static parseIndex(meta         , bytes            )            {
    const levels = meta.totalLevel;
    const stride = meta.indexDataSize && meta.indexDataSize >= 4 + 16 * levels ? meta.indexDataSize : 4 + 16 * levels;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const { min, max } = meta.boundingBox;
    const cells            = [];
    for (let at = 0; at + stride <= bytes.byteLength; at += stride) {
      const x = view.getUint16(at, true);
      const y = view.getUint16(at + 2, true);
      const cell = cells.length;
      const blocks             = [];
      for (let level = 0; level < levels; level += 1) {
        const o = at + 4 + level * 16;
        blocks.push({ cell, level, count: view.getUint32(o, true), offset: Number(view.getBigUint64(o + 4, true)), size: view.getUint32(o + 12, true) });
      }
      cells.push({
        x, y, blocks,
        min: [min[0] + x * meta.cellLengthX, min[1] + y * meta.cellLengthY, min[2]],
        max: [min[0] + (x + 1) * meta.cellLengthX, min[1] + (y + 1) * meta.cellLengthY, max[2]],
      });
    }
    return cells;
  }
}


//# sourceURL=examples/lcc/LccScene.ts