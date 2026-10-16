# API index

This table lists every export of `@sparkjsdev/radix`, sorted by name. Everything is exported from `@sparkjsdev/radix`; the `core/` exports (marked core) also come from `@sparkjsdev/radix/core`, which has no three.js and runs in workers and Node. Kinds: class, function, value, or type.

| Name | Kind | Layer | What it is |
|---|---|---|---|
| `AnyGpuSplatReader` | type | gpu | any of the three splat readers ([splats.md](splats.md#gpusplatreader-the-shader-side)) |
| `AnySplatGenerator` | type | gpu | a generator of any data ([generators.md](generators.md#splatgenerator)) |
| `AnySplatObject` | type | render | a splat object of any data ([rendering.md](rendering.md#splatobject)) |
| `ArrayBundle` | type | core | one bundle of a table: `def`, `channels`, `meta` ([arraydata.md](arraydata.md#arraydata)) |
| `ArrayBundles` | type | core | a table's bundles by name |
| `ArrayChannel` | type | core | one channel: `{ format, data }` |
| `ArrayData` | class | core | the table: rows of elements, channels of typed arrays, named bundles ([arraydata.md](arraydata.md)) |
| `ArrayFormat` | type | core | a channel format: `"uint32x4"`, `"float16x2"`, ... ([arraydata.md](arraydata.md#formats)) |
| `ArrayFormats` | class | core | `info(format)` and `make(scalar, components)` |
| `ArrayOf` | type | core | the typed array of a format |
| `ArrayWriter` | type | gpu | what `GpuArrays.write` runs: a fragment or compute writer ([gpu-arrays.md](gpu-arrays.md#gpuarraywriter)) |
| `AutoSort` | type | render | `{ distance, angle }`: when `autoSort` re-sorts ([views.md](views.md#autosort)) |
| `Axes` | class | core | coordinate systems: `SYSTEMS`, `matrix`, `converter`, `convert` ([files.md](files.md#coordinate-systems)) |
| `AxesConverter` | type | core | converts values from one system to another in place: `vec`, `quat`, `scales`, `cov`, `splat`, `sh` |
| `BundleChannels` | type | core | channel names to formats |
| `BundleDef` | type | core | a bundle definition: `channels`, `packing`, `serialize` ([arraydata.md](arraydata.md#bundles)) |
| `BundleLike` | type | core | anything with named channels of formats |
| `ByteReader` | class | core | bytes taken in order from bytes or a stream ([files.md](files.md#splatfiles-and-the-per-format-classes)) |
| `BytesInput` | type | core | bytes, an `ArrayBuffer`, or a stream |
| `CallOptions` | type | worker | `{ onProgress? }` of a worker call ([workers.md](workers.md)) |
| `CameraControls` | class | controls | orbit and fly controls for pointer, touch, keys, gamepads, and XR ([controls.md](controls.md)) |
| `CameraControlsInertia` | type | controls | inertia per input, in seconds |
| `CameraControlsMode` | type | controls | `"fly" \| "orbit"` |
| `CameraControlsSettings` | type | controls | all the controls' settings ([controls.md](controls.md#settings)) |
| `CompressedPlyFile` | class | core | SuperSplat compressed PLY `write` (and `read`, as `PlyFile.read`) ([files.md](files.md#compressed-ply)) |
| `Compression` | class | core | gzip, gunzip, byte-transposed gzip, and reading bytes ([files.md](files.md#splatfiles-and-the-per-format-classes)) |
| `ComputeIds` | type | wgpu | a kernel body's built-in ids ([wgpu.md](wgpu.md#wgpucompute-and-wgpucomputebatch)) |
| `CoordinateSystem` | type | core | `"RUB"`, `"RDF"`, `"RFU"`, ...: where +x, +y, and +z point ([files.md](files.md#coordinate-systems)) |
| `CopySpan` | type | core | one rectangle of a texture copy |
| `Cov` | type | core | a symmetric 3x3 matrix: `{ xx, yy, zz, xy, xz, yz }` |
| `CovSplat` | type | core | a covariance-form splat record ([splats.md](splats.md#records)) |
| `CovSplatModifier` | type | gpu | a TSL function of a covariance splat ([generators.md](generators.md#modifiers)) |
| `CovSplatNode` | type | gpu | the covariance splat struct in TSL ([shaders.md](shaders.md#splat-structs)) |
| `CovSplats` | type | core | a typed `covSplats` bundle |
| `createRenderer` | function | gpu | an initialized `WebGPURenderer` with the device baselines ([renderer.md](renderer.md#createrenderer)) |
| `CreateRendererOptions` | type | gpu | its options |
| `decodeShScale` | function | core | packed SH's scale byte to a band's largest value ([sh.md](sh.md#codecs)) |
| `defineBundle` | function | core | a bundle definition ([arraydata.md](arraydata.md#bundles)) |
| `DispatchSize` | type | wgpu | threads, workgroups, or an indirect buffer |
| `encodeShScale` | function | core | a band's largest value to packed SH's scale byte, rounded up ([sh.md](sh.md#codecs)) |
| `Encoding` | class | core | the scalar and vector codecs of the splat layouts ([encoding.md](encoding.md)) |
| `ExtSplat` | type | core | a splat record with PBR fields |
| `ExtSplats` | type | core | a typed `extSplats` bundle |
| `FormatInfo` | type | core | what `ArrayFormats.info` returns |
| `FoundSh` | type | core | what `Sh.find` returns: `{ name, codec, degree }` ([sh.md](sh.md#sh)) |
| `FoundSplats` | type | core | `{ name, layout, bundle }` from `Splats.find` / `get` |
| `getGpuCaps` | function | gpu | the renderer's backend and limits ([renderer.md](renderer.md#getgpucaps)) |
| `GpuArrayReader` | class | gpu | TSL reads of one bundle ([gpu-arrays.md](gpu-arrays.md#gpuarrayreader)) |
| `GpuArrays` | class | gpu | a table in textures ([gpu-arrays.md](gpu-arrays.md#gpuarrays)) |
| `GpuArrayWriter` | class | gpu | writes bundles from TSL as a fragment pass ([gpu-arrays.md](gpu-arrays.md#gpuarraywriter)) |
| `GpuBackend` | type | gpu | `"webgpu" \| "webgpu-gl"` |
| `GpuBundle` | type | gpu | one bundle of a `GpuArrays` |
| `GpuBundles` | type | gpu | its bundles by name |
| `GpuCaps` | type | gpu | what `getGpuCaps` returns |
| `GpuChannel` | type | gpu | one channel's texture and formats |
| `GpuCovSplatReader` | class | gpu | the `covSplats` reader |
| `GpuEncoding` | class | gpu | the TSL twin of `Encoding` ([encoding.md](encoding.md#the-shader-twins)) |
| `GpuExtSplatReader` | class | gpu | the `extSplats` reader |
| `GpuPackedSplatReader` | class | gpu | the `packedSplats` reader |
| `GpuProfile` | type | gpu | GPU and CPU ms per phase |
| `GpuProfiler` | class | gpu | GPU and CPU time per named phase ([renderer.md](renderer.md#gpuprofiler)) |
| `GpuSh` | class | gpu | spherical harmonics in TSL: `evaluate`, `maxDegree`, `codec` ([sh.md](sh.md)) |
| `GpuShCodec` | type | gpu | a built-in SH codec's TSL decoder: `decodeBand` ([sh.md](sh.md#sh)) |
| `GpuShPalette` | class | gpu | SH palettes on the GPU: `upload`, `create` ([sh.md](sh.md#palettes)) |
| `GpuShReader` | class | gpu | reads and evaluates stored SH in any generator: `bind`, `color`, `apply` ([sh.md](sh.md#in-your-own-generator)) |
| `GpuSortKeys` | class | gpu | the TSL twin of `SortKeys` ([shaders.md](shaders.md#codecs)) |
| `GpuSplatMath` | class | gpu | the TSL twin of `SplatMath` |
| `GpuSplatReader` | class | gpu | splat reads in TSL: `for(layout)`, `from(arrays)` ([splats.md](splats.md#gpusplatreader-the-shader-side)) |
| `GpuSplats` | class | gpu | the splat structs and TSL codecs ([splats.md](splats.md#gpusplatreader-the-shader-side)) |
| `Hdr` | class | gpu | the HDR canvas and headroom tone mapping ([renderer.md](renderer.md#hdr-output)) |
| `HdrToneMapping` | type | gpu | the tone mapping's controls |
| `LimitRequest` | type | gpu | a WebGPU limit to request: a number or `"adapter"` |
| `LoadedSplats` | type | core | what `loadSplatFile` and the readers return: `{ splats, shPalette? }` ([files.md](files.md#loadsplats)) |
| `loadSplatFile` | function | worker | a splat file into `{ splats, shPalette? }`, a palette kept, on a worker ([files.md](files.md#loadsplats)) |
| `loadSplats` | function | worker | a splat file into its table, a palette expanded per splat, on a worker ([files.md](files.md#loadsplats)) |
| `LoadSplatsOptions` | type | worker | the options of `loadSplats` and `loadSplatFile` ([files.md](files.md#loadsplats)) |
| `MappedObject` | type | render | `{ object, offset }`: an object in a collection, with its offset |
| `ModifierSpace` | type | render | `"view" \| "world" \| "object"` or a `Matrix4` ([generators.md](generators.md#modifier-spaces)) |
| `PackedEncoding` | type | core | the ranges of packed splats' 8-bit codes ([splats.md](splats.md#choosing-a-layout)) |
| `PackedSplats` | type | core | a typed `packedSplats` bundle |
| `Pbr` | type | core | normal, roughness, and metallic |
| `PbrNode` | type | gpu | the PBR struct in TSL |
| `PlyFile` | class | core | PLY `read` (standard or compressed) and `write` ([files.md](files.md)) |
| `Progress` | type | core | `(fraction, stage) => void` |
| `ProgressStage` | type | core | `"downloading" \| "decoding" \| "encoding" \| "compressing"` |
| `ProjectionMethod` | type | render | `"ewa" \| "3dgut" \| "htgs" \| "raygs"` ([projection.md](projection.md#methods)) |
| `Quat` | type | core | `{ x, y, z, w }` |
| `RadFile` | class | core | RAD `read` and `write`, clustered SH included |
| `RadixKeysPerThread` | type | wgpu | 8 or 16 |
| `RdxFile` | class | core | RDX files: whole, chunked, over HTTP range requests ([rdx.md](rdx.md)) |
| `RdxHeader` | type | core | an RDX header |
| `RdxReader` | type | core | `header` and `readChunk(chunk, into)` |
| `Rgb` | type | core | `{ r, g, b }` |
| `ScalarType` | type | core | the scalar part of a format |
| `ScanTier` | type | wgpu | `"portable" \| "subgroup"` |
| `Schema` | type | core | bundle names to definitions |
| `Sh` | class | core | spherical harmonics on the CPU: codecs, bundles, `find`, encoders, `convert`, `evaluate` ([sh.md](sh.md#sh)) |
| `ShCodec` | type | core | a built-in SH codec (`Sh.codec(name)`): `name`, `words`, `channels`, `encode`, `decode` ([sh.md](sh.md#sh)) |
| `ShCodecName` | type | core | the SH codecs: `"ext" \| "packed"` ([sh.md](sh.md#codecs)) |
| `ShDegree` | type | core | `1 \| 2 \| 3 \| 4`: the highest SH band ([sh.md](sh.md)) |
| `ShPalette` | class | core | a table of SH entries that splats pick by label ([sh.md](sh.md#palettes)) |
| `ShTarget` | type | core | what file readers do with SH: `"ext"`, `"packed"`, or `false` ([sh.md](sh.md#loading-and-writing)) |
| `SortedSplats` | type | worker | `{ ordering, visible, keys }` from `sortSplatKeys` |
| `SortKeyBits` | type | core | `16 \| 24 \| 32` |
| `SortKeys` | class | core | sort keys: `compute`, `invalid`, `sort`, `KEYS` ([sorting.md](sorting.md#sortkeys)) |
| `sortSplatKeys` | function | worker | sorts sort keys on a worker or on the current thread ([workers.md](workers.md#sortsplatkeys)) |
| `Splat` | type | core | a splat record: center, scales, quaternion, rgb, opacity ([splats.md](splats.md#records)) |
| `SplatBindContext` | type | gpu | the generator context as three.js values, for `bind` ([generators.md](generators.md#the-generator-context)) |
| `SplatBundle` | type | core | any typed splat bundle |
| `SplatBundles` | type | core | layout names to typed bundles |
| `SplatCollection` | class | render | an immutable, ordered list of splat objects ([rendering.md](rendering.md#splatcollection)) |
| `SplatData` | type | core | a table with a layout's splat bundle |
| `SplatFiles` | class | core | splat files on the current thread ([files.md](files.md#splatfiles-and-the-per-format-classes)) |
| `SplatFormat` | type | core | `"ply" \| "compressed-ply" \| "spz" \| "rad" \| "rdx"` |
| `SplatGenerator` | value and type | gpu | makes splat `i` in TSL; `fromSplats`, `forArrays`, `indices`, `context` ([generators.md](generators.md)) |
| `SplatGeneratorContext` | type | gpu | what a generator or modifier knows of the object and the view: `viewOrigin`, ... ([generators.md](generators.md#the-generator-context)) |
| `SplatLayout` | type | core | `"extSplats" \| "covSplats" \| "packedSplats"` |
| `SplatLoadOptions` | type | core | `SplatFiles.decode`'s options |
| `SplatMath` | class | core | quaternion and covariance math ([encoding.md](encoding.md#splatmath-quaternions-and-covariances)) |
| `SplatModifier` | type | gpu | a TSL function of a splat ([generators.md](generators.md#modifiers)) |
| `SplatNode` | type | gpu | the splat struct in TSL ([shaders.md](shaders.md#splat-structs)) |
| `SplatObject` | type | render | one thing to draw: generator, data, count, matrixWorld, params, release ([rendering.md](rendering.md#splatobject)) |
| `SplatObjectParams` | type | render | the params each object projects with ([params.md](params.md)) |
| `SplatOrder` | type | render | one CPU sort's result ([views.md](views.md#orders)) |
| `SplatProjector` | class | render | the program cache: `programs`, `dispose(generator)` ([generators.md](generators.md#the-program-cache)) |
| `SplatReadOptions` | type | core | a target layout plus `progress`, `sh`, and `coordinateSystem` |
| `SplatRenderer` | class | render | the mesh that draws a collection ([rendering.md](rendering.md#splatrenderer)) |
| `SplatRequestInit` | type | core | `fetch` options for a splat file's URL, `loadSplats`' `request` ([files.md](files.md#loadsplats)) |
| `SplatRendererOptions` | type | render | its options |
| `Splats` | class | core | the splat layouts on the CPU ([splats.md](splats.md#splats-the-cpu-side)) |
| `SplatShOptions` | type | gpu | `{ codec, degree, palette? }`: the SH a `fromSplats` generator adds ([generators.md](generators.md#stored-splats-fromsplats)) |
| `SplatSource` | type | worker | a URL, a `Blob` or `File`, or bytes |
| `SplatTarget` | type | core | `{ layout?, encoding? }` |
| `SplatView` | class | render | one viewpoint of a renderer ([views.md](views.md)) |
| `SplatViewOptions` | type | render | what `viewFor` sets |
| `SplatViewParams` | type | render | the params every splat of a render shares ([params.md](params.md)) |
| `SplatWriteOptions` | type | core | the writers' options ([files.md](files.md#writesplats)) |
| `SpzExtension` | type | core | an SPZ extension record: `{ type, data }` |
| `SpzFile` | class | core | SPZ `read`, `write`, and `unpack` ([files.md](files.md#spz)) |
| `SpzUnpacked` | type | core | an SPZ file's header and byte columns |
| `SpzWriteOptions` | type | core | the SPZ writer's options |
| `StoredSplats` | type | gpu | `{ splats, indices?, shPalette? }`: the data of a `fromSplats` object |
| `StructNode` | type | gpu | a typed TSL struct node |
| `TexelSpan` | type | core | one rectangle of texels |
| `TextureLayout` | class | core | elements to texels of a 2D array texture ([arraydata.md](arraydata.md#texturelayout)) |
| `TransferableArrayData` | type | core | a table as a plain object, for `postMessage` |
| `TSL` | value | gpu | `three/tsl` with loosened node types ([shaders.md](shaders.md#tsl-and-tslnode)) |
| `TslNode` | type | gpu | any TSL node |
| `TypedArray` | type | core | any typed array a channel can hold |
| `TypedArrayConstructor` | type | core | its constructor |
| `Vec3` | type | core | `{ x, y, z }` |
| `WgpuArrayStore` | class | wgpu | writes elements at any index from compute ([wgpu.md](wgpu.md#wgpuarraystore)) |
| `WgpuArrayWriter` | class | wgpu | the compute writer ([wgpu.md](wgpu.md#wgpuarraywriter)) |
| `WgpuBuffer` | class | wgpu | a typed storage buffer ([wgpu.md](wgpu.md#wgpubuffer)) |
| `WgpuCompact` | class | wgpu | stream compaction ([wgpu.md](wgpu.md#wgpuradixsort-and-wgpucompact)) |
| `WgpuCompute` | class | wgpu | a compute kernel ([wgpu.md](wgpu.md#wgpucompute-and-wgpucomputebatch)) |
| `WgpuComputeBatch` | class | wgpu | dispatches in one compute pass |
| `WgpuRadixSort` | class | wgpu | a stable GPU radix sort ([wgpu.md](wgpu.md#wgpuradixsort-and-wgpucompact)) |
| `WgpuSplatSorter` | class | wgpu | compaction, sort, and draw arguments for projected splats ([wgpu.md](wgpu.md#wgpusplatsorter)) |
| `WorkerArgs` | type | worker | a handler's arguments |
| `WorkerCall` | type | worker | the handler names |
| `WorkerChoice` | type | worker | where a file call runs: `boolean`, a pool, or a lease ([files.md](files.md#where-the-work-runs)) |
| `WorkerLease` | class | worker | one worker of a pool, held until `release()` ([workers.md](workers.md)) |
| `WorkerPool` | class | worker | up to `size` workers, made on demand ([workers.md](workers.md)) |
| `WorkerResult` | type | worker | a handler's result |
| `WriteItem` | type | gpu | a write range plus its writer |
| `WriteRange` | type | gpu | `{ at?, count, first? }` |
| `WriterFor` | type | gpu | the writers that arrays with a given storage setting accept |
| `WriterOutput` | type | gpu | one output channel of a writer |
| `WriterOutputs` | type | gpu | a writer body's `out` argument |
| `writeSplats` | function | worker | a table to a splat file, on a worker ([files.md](files.md#writesplats)) |
| `XrInput` | type | controls | the part of `renderer.xr` the controls read |
| `Zstd` | class | core | zstd `compress` and `decompress` ([files.md](files.md#spz)) |

Internal (not exported; the tests import them by path): `SplatCamera`, `SplatParams`, `SplatProjection`, `projectCollection`, `programOf`, `readSortKeys`, and the transforms in `splatTransform.tsl.ts` ([projection.md](projection.md)).
