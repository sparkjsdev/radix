# RDX files

RDX is Radix's own file format. It stores the bundles of an `ArrayData`, compressed, in chunks of rows. Any table can be saved, including tables that hold no splats. A file can be read one chunk at a time over HTTP range requests, so a large scene can start drawing before it has fully loaded.

Code: `src/core/rdx.ts` (`RdxFile`) and `compress.ts` (`Compression`), in `@sparkjsdev/radix/core`.

```ts
// One file of every serialized bundle, and the same table back
const file = await RdxFile.encode(data);
const loaded = await RdxFile.decode(file);

// Over HTTP range requests, into an empty table of the right shape
const rdx = await RdxFile.load("scene.rdx");
const target = RdxFile.makeData(rdx.header);
for (let c = 0; c < rdx.header.chunks.length; c++) {
  await rdx.readChunk(c, target);
}
```

## The layout

```
whole file:  [ header ][ chunk 0 ][ chunk 1 ] ...
chunked:     scene.rdx (the header), scene-0.rdx, scene-1.rdx, ...

a container (the header and every chunk):
  u32 magic | u32 meta bytes | u32 payload count | u32 0
    (magic: "RDXH" for the header, "RDXC" for a chunk)
  meta: JSON, padded to 16 bytes
  u32 size per payload, padded to 16 bytes
  payloads, each padded to 16 bytes
```

- **The header** holds the format version, the row count, the chunk size, each bundle's definition and meta, the table's meta, and each chunk's size in bytes (`RdxHeader`). Only bundles defined with `serialize: true` are saved.
- **A chunk** holds its rows of every channel, one payload per channel; its meta is `{ start, count }`. Each channel's bytes are transposed (byte 0 of every element, then byte 1, and so on) and gzipped (`Compression.compressTransposed`). Transposing puts the bytes of float exponents and of each packed field next to each other, so they compress much better.
- The chunk size is `RdxFile.CHUNK_SIZE` (65536) by default and can be any multiple of 4096, so every chunk covers whole texture rows and can be passed to `GpuArrays.upload` unchanged.

## Saving

| Member | What it does |
|---|---|
| `RdxFile.encode(data, { chunkSize?, progress? })` | one file: the header, then every chunk |
| `RdxFile.encodeChunks(data, options?)` | `{ header, chunks }`: the pieces as separate byte arrays |
| `RdxFile.encodeFiles(data, "scene.rdx", options?)` | a chunked set by file name: `{ "scene.rdx": header, "scene-0.rdx": chunk 0, ... }` |
| `RdxFile.chunkName("scene.rdx", 3)` | `"scene-3.rdx"`; a query or hash after `.rdx` is kept |

`writeSplats(data, "rdx")` writes a whole file on a worker ([files.md](files.md)). SH bundles (`extSh`, `packedSh`, a palette's `shLabel`) are saved like any other bundle, in their codec, and load in that codec unless `sh` asks for another. An SH palette (`ShPalette.data`) is a separate table: save it as its own RDX file, or pass it to `writeSplats` as `shPalette` to write the SH per splat ([sh.md](sh.md#palettes)).

## Loading

| Member | What it does |
|---|---|
| `RdxFile.decode(bytes, { progress? })` | a whole file to a table |
| `RdxFile.load(url, { chunked?, init? })` | an `RdxReader` over HTTP: one request for the header and one per chunk. `chunked: true` reads a chunked set, one file per chunk. `init` is passed to `fetch` |
| `RdxFile.open(readRange)` | an `RdxReader` over any `(start, end) => Promise<bytes>` |
| `RdxFile.makeData(header)` | an empty table of a header's bundles, count, and meta |
| `RdxFile.decodeHeader(bytes)` | `{ header, byteLength }`: the header at the start of `bytes`; chunk 0 of a whole file starts at `byteLength` |
| `RdxFile.decodeChunk(header, bytes, into)` | writes one chunk's rows into `into` |

An `RdxReader` has `header` and `readChunk(chunk, into)`. Chunks can be read in any order.

- The header lists every chunk's size, so after the first request a reader can compute each chunk's offset.
- When the server ignores range requests, the whole file is downloaded once and later reads use that copy.
- `loadSplats` and `SplatFiles.decode` recognize RDX by its first bytes and convert its splats to the requested layout. A splat file's `lodTree` is saved like any other bundle.

## Streaming into the GPU

```ts
// A file of packed splats
const rdx = await RdxFile.load(url);
const { count, chunkSize, chunks } = rdx.header;
const data = RdxFile.makeData(rdx.header);

const splats = new GpuArrays({
  renderer,
  bundles: { packedSplats: Splats.PACKED },
  capacity: count,
});

for (let c = 0; c < chunks.length; c++) {
  await rdx.readChunk(c, data);
  const start = c * chunkSize;
  splats.upload(data, {
    bundles: ["packedSplats"],
    srcStart: start,
    dstStart: start,
    count: Math.min(chunkSize, count - start),
  });

  // Draw the splats loaded so far
  const object = SplatCollection.arrays(splats);
  splatRenderer.collection = new SplatCollection([object]);
}
```

The arrays' `count` grows with each upload, and each new collection draws the splats uploaded so far. A packed bundle's encoding is in its meta, and `upload` copies it.

## Gotchas

- A chunked set is several files. Serve them from the same directory, under the names that `RdxFile.chunkName` returns.
- Large PLY files: `npm run convert:ply -- in.ply out.rdx` streams a PLY past Node's 2 GiB read limit into one packed RDX file (`scripts/convert-large-ply.ts`).
