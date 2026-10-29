# Splat files

`loadSplats` reads PLY (standard or SuperSplat compressed), SPZ, RAD, and RDX files into a table, and `writeSplats` writes a table to any of these formats. Both run on a worker by default, so a large file does not block the page. `SplatFiles` and the per-format classes do the same work on the current thread, in a page, a worker, or Node.

Code: `src/worker/splatFiles.ts` (`loadSplats`, `loadSplatFile`, `writeSplats`); `src/core/files.ts` (`SplatFiles`), `ply.ts`, `compressedPly.ts`, `spz.ts`, `rad.ts`, and `rdx.ts`.

```ts
// Ext splats by default, in data.bundles.extSplats
const data = await loadSplats("scene.spz");

// Packed splats and packed SH, reporting progress
const packed = await loadSplats(file, {
  layout: "packedSplats",
  sh: "packed",
  onProgress: (f, stage) => bar.update(f, stage),
});

// Write an SPZ file and save it
const bytes = await writeSplats(data, "spz", { version: 3 });
const blob = new Blob([bytes]);
download(blob, "scene.spz");
```

## loadSplats

`loadSplats(source, options?)` returns a table (`SplatData<L>`). The splats are in the bundle named after the layout. A file with a LoD tree adds a `lodTree` bundle, and a file with spherical harmonics adds an SH bundle (`extSh` by default). Clustered SH in RAD files is expanded to per-splat SH on the worker.

`loadSplatFile(source, options?)` takes the same options and returns `{ splats, shPalette? }` (`LoadedSplats<L>`). The only difference: clustered SH stays a palette. `shPalette` is an `ShPalette`, and the table's `shLabel` bundle indexes it ([sh.md](sh.md#loading-and-writing)). A palette uses far less memory: 2 bytes per splat plus the palette, against 48 to 60 bytes per splat at SH3. Pass `shPalette` on to `GpuShPalette.upload`, `writeSplats`, and `Axes.convert`.

| Option (`LoadSplatsOptions`) | Default | What it does |
|---|---|---|
| `source` | | a URL (string or `URL`, resolved against the page), a `Blob` or `File`, or the file's bytes (`Uint8Array` or `ArrayBuffer`): a `SplatSource` |
| `layout` | `"extSplats"` | `"extSplats"`, `"covSplats"`, or `"packedSplats"`; the file decodes directly into it ([splats.md](splats.md#choosing-a-layout)) |
| `encoding` | the file's, else the defaults | the ranges of a packed layout's 8-bit codes (`Partial<PackedEncoding>`) |
| `sh` | `"ext"` (RDX: its stored codec) | the SH codec (`"ext"` or `"packed"`), or `false` to skip SH (`ShTarget`; [sh.md](sh.md)) |
| `coordinateSystem` | as stored | SPZ only: the axes to convert to, such as `"RUB"` or `"RDF"` (`CoordinateSystem`). `meta.coordinateSystem` names the table's axes after loading ([below](#coordinate-systems)) |
| `name` | the URL or file name | identifies the format by its extension when the first bytes do not |
| `worker` | the shared pool | where it runs (below) |
| `onProgress` | | `(fraction, stage)`, where `stage` is `"downloading"`, `"decoding"`, `"encoding"`, or `"compressing"` (a `ProgressStage`) |
| `request` | | `fetch` options for a URL source, such as `{ credentials: "include", headers: { Authorization } }` (`SplatRequestInit`: `RequestInit` without `signal`, `body`, `window`, or `method`). A `Headers` object becomes a plain record on its way to a worker |
| `signal` | | an `AbortSignal`: aborting rejects the promise with `signal.reason` at once. The download stops, and so does the decode, at its next progress report, on a worker or here. A load still waiting for a pool's worker leaves the queue |

RDX, RAD, and PLY are detected by the magic number in their first bytes, and SPZ by a gzip header, SPZ 4's `NGSP` header, or its extension. A compressed PLY is detected as `"ply"`: the PLY reader tells the two kinds apart by their header.

## writeSplats

`writeSplats(data, format, options?)` returns the file's bytes. `format` is `"ply"`, `"compressed-ply"`, `"spz"`, `"rad"`, or `"rdx"` (a `SplatFormat`). PLY, compressed PLY, SPZ, and RAD write the splat bundle in any layout, the SH bundle, and the `lodTree` where the format supports one. They write PBR data (normals, roughness, metallic) only with `pbr: true`. RDX writes every bundle marked `serialize: true` as it is, including ext splats' PBR bits.

| Option (`SplatWriteOptions`) | Formats | Default | What it does |
|---|---|---|---|
| `pbr` | PLY, SPZ | `false` | write normals, roughness, and metallic ([SPZ](#spz)). Ext splats only |
| `compatibility` | PLY | `false` | zero normals (`nx`, `ny`, `nz`) for tools that expect them |
| `sort` | compressed PLY | `true` | write the splats in Morton order of their centers, as SuperSplat does, so each chunk of 256 covers a small box; `false` keeps the table's order |
| `version` | SPZ | 3 | 2 or 3 (gzip container) or 4 (SPZ 4: `NGSP` header, zstd). All keep SH up to degree 4 |
| `lod` | SPZ | when the data has a tree | write the `lodTree` bundle (child counts below 2^16) |
| `coordinateSystem` | SPZ | `meta.coordinateSystem` | version 4: the axes to record, if not `"RUB"`. The data is not converted |
| `zstdLevel` | SPZ | 12 | version 4: Node's zstd level, 1 to 22. Browsers use Radix's own encoder, which has no levels |
| `fractionalBits` | SPZ | 12 | fraction bits of the 24-bit fixed-point centers |
| `antialiased` | SPZ | `true` | the file's antialiasing flag |
| `chunkSize` | RAD, RDX | 65536 | splats per chunk (RDX: a multiple of 4096) |
| `sh` | PLY, compressed PLY, SPZ, RAD | `true` | the SH bundle, when the data has one |
| `radSh` | RAD | `"s8"` | the SH encoding: `"s8"` over each band's largest value in the chunk (the property's `min` / `max`), `"f16"`, or `"f32"` |
| `shPalette` | all | | the `ShPalette` that the table's `shLabel` bundle indexes. RAD writes it as clustered SH (`sh1_code`..`sh3_code` in chunk 0 as `radSh`, `s8` over each band's largest value; `sh_label` as `u16`). Other formats write per-splat SH |
| `worker`, `onProgress` | all | | as for `loadSplats` |

On a worker, `writeSplats` transfers the table's arrays (and the palette's) to the worker and puts them back in place afterwards, so the table and its bundle objects are usable again when the promise settles, even if the write fails. Do not use the table while a write is running, and take its arrays from its bundles again afterwards: the ones held before were detached. For the same reason `writeSplats` takes no `signal`: an aborted write would leave the arrays on the worker.

## Where the work runs

| `worker` (`WorkerChoice`) | Runs on |
|---|---|
| left out | the shared pool where the page can make workers; otherwise the current thread (Node, or code already in a worker) |
| `true` | the shared pool; throws where workers are unavailable |
| `false` | the current thread |
| a `WorkerPool` | one call on that pool |
| a `WorkerLease` | that worker; the caller keeps the lease |

- Both paths run the same functions, so they give the same results.
- Bytes passed to a worker are transferred: the caller's buffer is detached.
- The shared pool is `WorkerPool.default`, made on first use with up to 4 workers ([workers.md](workers.md)).

## What each format keeps

PLY, SPZ, and RAD decode directly into the requested layout. RDX returns every bundle it saved ([rdx.md](rdx.md)) and converts its splats when they are stored in a different layout.

| Format | Reads | Writes | PBR | LoD tree | SH (degree 1 to 4) |
|---|---|---|---|---|---|
| PLY | binary 3DGS, RGB point clouds, and compressed PLY | 3DGS, float32 | normals, roughness, and metallic (`pbr`) | no | `f_rest_*` float32 (72 at degree 4): read and written exactly |
| Compressed PLY | SuperSplat files with or without color ranges | 16 bytes per splat in chunks of 256, with color ranges | no | no | an `sh` element of `uchar` codes over ±4; degree 3 at most (degree-4 SH writes its first 3 bands) |
| SPZ | versions 1 to 4 in the gzip container, and SPZ 4 | version 2 or 3 (gzip), or 4 | normals, roughness, and metallic (`pbr`) | yes (`lod`) | 8-bit codes over ±1, up to degree 4 |
| RAD | RAD0 with embedded chunks, or one RADC chunk | RAD0, gzipped float32 and uint32 columns | no | yes | `sh1`..`sh3` (degree-4 SH writes its first 3 bands): `s8` (default; over each band's largest value per chunk), `s8_delta`, `f16`, or `f32` (`radSh`); clustered SH (a palette) read and written |
| RDX | Radix's own: every saved bundle | every serialized bundle, whole or chunked | yes | yes | the SH bundle as stored, in any codec |

- Spherical harmonics load into an SH bundle beside the splats ([sh.md](sh.md)). The `sh` option picks the codec: `"ext"` (default), `"packed"`, or `false` to skip SH (the degree is then recorded in `meta.ignoredShDegree`). RDX keeps its stored codec unless `sh` is given.
- RAD's clustered SH (Spark's `build-lod --cluster-sh`) loads through `loadSplatFile` as an `ShPalette` plus an `shLabel` bundle. With more than 65,536 entries it loads as per-splat SH. RDX does not store palettes yet; writers expand them.
- Writers include the SH bundle by default (`sh: true`). Format limits apply: compressed PLY clamps values to ±4 and SPZ to ±1 (Sutro has a few coefficients up to ±4.9). RAD's `s8` keeps every value, but uses a coarser step in chunks with outliers.
- RAD files that reference external chunk files are rejected.
- Point-cloud PLYs (positions and colors only) load as small round splats, 0.001 units across.

## SPZ

Niantic's SPZ ([nianticlabs/spz](https://github.com/nianticlabs/spz)) has two containers. `SpzFile` reads both.

| Container | Versions | Layout |
|---|---|---|
| gzip | reads 1 to 4; writes 2 or 3 (default 3) | 16-byte header; columns for centers, alphas, colors, scales, rotations, and SH; Radix's LoD tree (flag 0x80) and PBR (flag 0x40); upstream extension records (flag 0x02) |
| SPZ 4 (`NGSP`) | reads and writes 4 | 32-byte plaintext header; extension records; a table of contents; one zstd stream per non-empty column |

- Version 2 stores rotations as x, y, z in 3 bytes with w >= 0, which loses precision near 180 degrees. Versions 3 and 4 use 4 bytes (smallest-three). Some files put version 4 in the gzip container; that is version 3's layout and loads the same way.
- Both containers store the same bytes per splat. SH: 8-bit codes, `(b - 128) / 128`, coefficient-major RGB. LoD tree: u16 child counts, then u32 child starts. PBR: Oct24 normals (0 means none), unorm8 roughness, unorm8 metallic. These are the bits an ext splat stores, so PBR values round-trip.
- SPZ 4 stores the LoD tree and PBR in Radix vendor records (`"RX"`: `0x52580001` and `0x52580002`), each a zstd frame of the bytes above. It never sets flags 0x40 or 0x80, so upstream's reader skips these records with a warning and loads the rest.
- Upstream records are read from both containers. `0xADBE0002` (safe orbit camera) goes to `meta.safeOrbitCamera` as `{ elevationMin, elevationMax, radiusMin }` (radians, scene units). `0xADBE0003` is the stored coordinate system. Other record types are skipped and listed in `meta.skippedExtensions`. Version 4 writes the safe orbit back; the gzip writer writes no upstream records.
- `meta.container` is `"gzip"` or `"ngsp"`; `meta.version` is the header's version.
- `SpzFile.unpack(input, { sh? })` returns the header and raw byte columns (`SpzUnpacked`) without decoding them. `input` is bytes or a `ReadableStream`. gzip is inflated as bytes arrive, SPZ 4 streams are decompressed one at a time, and with `sh: false` the SH stream (last in SPZ 4) is never read.
- SPZ 4 headers get upstream's checks: the table of contents follows the header, stream counts and sizes match the header, no bytes follow the last stream, and the point count is at most 1024 × file bytes / 9.

### zstd

SPZ 4 compresses with zstd (`Zstd.compress`, `Zstd.decompress`). Radix uses the first of these that is available: Node's zlib (compressing at `zstdLevel`, default 12), the browser's `CompressionStream` / `DecompressionStream("zstd")` (no browser has them yet), then fzstd to decode and Radix's own encoder to encode. Radix's encoder codes literals only, with Huffman codes.

Sizes against version 3 (gzip), over 2 GB of columns from the splats viewer's samples and SharedTestModels' SH files:

| Encoder | Size | Speed |
|---|---|---|
| Radix's encoder | +2.1% (+8 to +22% on small files with SH) | 170 MB/s |
| Node, level 3 | +1.7% | 310 MB/s |
| Node, level 6 | ±0% | 117 MB/s |
| Node, level 12 (default) | -1.7% | 25 MB/s |
| Node, level 15 | -2.4% | 6 MB/s |
| Node, level 19 | -4.9% | 2 MB/s |

SPZ 4 does not make files much smaller, so version 3 stays the default. Write version 4 for readers that need it.

### Coordinate systems

SPZ names axes like upstream: three letters for the directions of +x, +y, and +z. For example `"RUB"` (right, up, back: three.js and SPZ's default), `"RDF"` (common in PLY files), and `"RFU"` (z up). `Axes.SYSTEMS` lists all 16 in SPZ's numbering. A file without a coordinate-system record is `"RUB"`.

- By default a file loads as stored, as in Spark and upstream's `UNSPECIFIED`. `meta.coordinateSystem` names its axes.
- With `coordinateSystem` set, the reader converts while decoding. With M the signed permutation between the two systems, centers and normals become M p, rotations become M R Mᵀ (scales are permuted to match), and each SH band is multiplied by its own matrix. Flips only change signs. Quarter turns (between z-up and y-up systems) mix the coefficients within each band.
- `Axes` does the same outside the readers. `Axes.converter(from, to)` converts single values (`vec`, `quat`, `scales`, `cov`, `splat`, `sh`). `Axes.convert(data, to, { from?, shPalette? })` converts a whole table in place, in any layout. `Axes.matrix(from, to)` returns M.
- Upstream flips the sign of SH coefficient 23 (the last in band 4) when y flips. That is a bug: its basis function, x⁴ - 6x²y² + y⁴, is even in every axis. Radix keeps the sign, so degree-4 conversions that flip y differ from upstream at that coefficient.
- A quarter turn can push SH coefficients past SPZ's ±1 range, so writing in a turned system clamps a few (541 of the seashell sample's 194k splats).

## Compressed PLY

SuperSplat and PlayCanvas's splat-transform write a quantized PLY, usually named `.compressed.ply`. It is valid PLY syntax but not the standard 3DGS layout, so it has its own writer, `CompressedPlyFile.write` (or `writeSplats(data, "compressed-ply")`). `PlyFile.read` reads both kinds; `CompressedPlyFile.read` is the same function.

The file has a `chunk` element with one row per 256 splats: the box of their centers (`min_x` to `max_z`), the range of their log scales (`min_scale_x` to `max_scale_z`) and, in current files, the range of their colors (`min_r` to `max_r`; older files have none, and colors then span 0 to 1). The `vertex` element holds four `uint` words per splat:

| Word | Bits | What it holds |
|---|---|---|
| `packed_position` | 11, 10, 11 | x, y, z in the chunk's box |
| `packed_rotation` | 2, then 10, 10, 10 | the index of the largest of w, x, y, z, then the other three, each within ±1/√2 |
| `packed_scale` | 11, 10, 11 | log scales in the chunk's range |
| `packed_color` | 8, 8, 8, 8 | r, g, b (`0.5 + SH_C0 * f_dc`) in the chunk's range, then linear opacity |

An optional `sh` element holds spherical harmonics as one `uchar` per value, channel-major (`f_rest_{c * N + k}`), mapped as splat-transform does: `((b + 0.5) / 256 - 0.5) * 8`, with 0 and 255 at the ends, so values span ±4. They load into the SH bundle like the float ones. A compressed file loads with `meta.compressed` set to `true`.

The writer writes the 18-property chunks, an `sh` element when the data has SH (in the same order as the vertices), and no LoD tree. Log scales are clamped to ±20, as splat-transform does. With the default `sort: true` the splats come back in a different order than the table's.

## SplatFiles and the per-format classes

These run the same steps on the current thread, without workers:

| Member | What it does |
|---|---|
| `SplatFiles.detectFormat(bytes, name?)` | the `SplatFormat`, from the first bytes or else the extension; throws for unknown files |
| `SplatFiles.decode(bytes, { name?, layout?, encoding?, sh?, coordinateSystem?, progress? })` | a file's bytes to `{ splats, shPalette? }` |
| `SplatFiles.fetch(url, { layout?, encoding?, sh?, coordinateSystem?, progress?, init? })` | downloads (the first 40% of the progress) and decodes; `init` is passed to `fetch` |
| `SplatFiles.encode(data, format, { ...SplatWriteOptions, progress? })` | a table to a file's bytes |
| `PlyFile.read` / `write`, `CompressedPlyFile.read` / `write`, `SpzFile.read` / `write`, `RadFile.read` / `write` | one format; readers take `(bytes, { layout?, encoding?, sh?, progress? })` (SPZ also `coordinateSystem`, and a `ReadableStream`) and return `{ splats, shPalette? }` (only RAD's clustered SH makes a palette) |
| `SpzFile.unpack` | an SPZ file's header and byte columns, undecoded ([SPZ](#spz)) |
| `RdxFile` | RDX files, whole, chunked, or over HTTP range requests ([rdx.md](rdx.md)) |
| `Compression.gzip`, `gunzip`, `readBytes`, `compressTransposed`, `decompressTransposed` | gzip through the platform's `CompressionStream`, and byte-transposed gzip for RDX |
| `Zstd.compress`, `Zstd.decompress` | zstd frames ([SPZ](#spz)) |
| `ByteReader` | reads bytes in order from a buffer or a stream with chunks of any size: `read(n)`, `peek(n)`, `skip(n)`, `rest()`, `atEnd()`, `stream()`, `cancel()` |
| `Axes` | coordinate systems and conversions ([SPZ](#coordinate-systems)) |

Types: `LoadedSplats`, `LoadSplatsOptions`, `SplatFormat`, `SplatLoadOptions`, `SplatRequestInit`, `SplatWriteOptions`, `SpzWriteOptions`, `SpzUnpacked`, `SpzExtension`, `CoordinateSystem`, `AxesConverter`, `SplatSource`, `WorkerChoice`, `Progress`, `ProgressStage`, and `BytesInput` (`Uint8Array`, `ArrayBuffer`, or a `ReadableStream`).

## Gotchas

- `loadSplats` and `loadSplatFile` transfer the bytes you pass to the worker. Pass a copy to keep the original.
- A clustered RAD loaded with `loadSplats` and saved as RAD is written per splat, and is larger. To keep the clusters, load it with `loadSplatFile` and pass `shPalette` to `writeSplats`.
- A file whose format has no LoD tree loads without one. Radix does not build trees.
- `writeSplats(data, "rdx")` writes every serialized bundle, including bundles of an app's own; mark derived data `serialize: false`.
