# Performance

This page shows where a frame's time goes and which settings change it. The numbers here come from benchmarks of Radix alone and of Radix against SparkJS on the same scenes, both measured on an Apple M3 Max in Chrome at 1920x1080. Treat them as relative: GPU times drift by up to 1.5x from run to run.

## Where the time goes

GPU milliseconds per frame on WebGPU (`ewa`, 24-bit keys, turning):

| Scene | Splats | Project | Compact | Radix sort | Draw | Total |
|---|---:|---:|---:|---:|---:|---:|
| butterfly | 0.5M | 0.09 | 0.06 | 0.28 | 2.36 | 2.8 |
| ceramic (inside) | 2M | 0.33 | 0.16 | 0.27 | 4.29 | 5.0 |
| sutro | 2M | 0.30 | 0.15 | 0.31 | 1.27 | 2.0 |
| grace (inside) | 10M | 1.55 | 0.78 | 0.96 | 4.86 | 8.2 |

- **The draw** takes 60-85% of the frame. Inside a scene its cost is fill: pixel ratio 2 (4x the pixels) made the ceramic cave's draw 2.6x slower. With many small splats the cost is per splat.
- **Projection** is 2-5% of the frame. Packed splats (16 B) project about 30% faster than ext (32 B).
- **The GPU sort** is cheap: at 10M splats it takes about 3, 4.7, and 7 ms at 16, 24, and 32 bits.
- **The WebGL2 path** reads keys back and sorts them on a worker, outside the frame. That takes tens of milliseconds at millions of splats, but it is not part of the frame time. The order's upload and the keys pass do run inside frames, and they show up as stalls while it re-sorts.

## Settings that change it

| Setting | Effect | Trade-off |
|---|---|---|
| `method` | `ewa` is the cheapest; `raygs` within 10%; `3dgut` and `htgs` within 25% from outside an object but 4-25x slower inside a scene, where splats around the camera cover the screen | the ray methods are exact for large and close splats |
| `objectParams.minContribution` (`ewa`) and `minPixelRadius` | cull faint and tiny splats before the sort; `minContribution: 0.75` and `minPixelRadius: 1`, with `params.minAlpha: 1/255`, `blurAmount: 0`, and `preBlurAmount: 0.075`, made Radix 1.15x as fast over the benchmark scenes (1.07-1.30x) | faint splats are dropped: a slight loss of soft detail |
| `params.minAlpha` | culls splats and fragments below an alpha | as above |
| `sortBits` | 16 bits saves 35-55% of either sort; 32 bits costs about 5% of the frame on WebGPU | 16 bits ties splats within 0.1% of their distance |
| `objectParams.sortGuard` (CPU sort) | 0.5 cut the WebGL2 draw by 24-68% on full turns | re-sort on turns as well as moves (`autoSort` does) |
| layout | `packedSplats` halves memory and projects about 30% faster | 8-bit colors, scales, and rotations within its encoding's ranges |
| spherical harmonics | SH3 adds 0.28 (packed) to 0.46 ms (ext) per 2M splats to WebGPU's projection, 0.12-0.41 ms through a palette; a lower `objectParams.maxShDegree` reduces it without recompiling; `sh: false` skips SH on load ([sh.md](sh.md#costs)) | view-dependent color; 48 to 64 bytes per splat |
| pixel ratio | the draw is fill-bound inside scenes: ratio 1 instead of 2 draws a quarter of the pixels | resolution |
| `params.maxStdDev` | smaller quads | slightly harder edges |

## Against SparkJS

From a comparison on four scenes from 0.5M to 10M splats, timed one frame at a time (5 rounds) and in a vsync loop on a 120 Hz display (3 rounds). In the two interiors the camera moves while it turns, so distance sorts must re-sort. Results: the [benchmarks page](bench.html) and the [full report](bench-report.html).

- **SparkJS 2.3.1** culls like Radix and has no WebGPU path. Radix on WebGPU was 1.35x as fast; at 10M splats (Grace Cathedral, inside), 9.2 ms against 16.5 ms.
- **WebGL2**, where both sort on a worker: at defaults Spark was 1.10x as fast as Radix. Radix stalls in the frames that upload a new order, and a moving camera makes it re-sort all the time: on Grace its turning frames took 16 ms, against 10 ms turning in place. This is the main weakness of Radix's WebGL2 path.
- **Vsync:** at defaults, Radix on WebGPU held 120 fps on three scenes and 108 on Grace. On Grace the WebGL2 worker sorts drop frames: Radix 78 fps and Spark 72, with 26% and 30% of frames late and p99 frames of 51 and 59 ms. Timed, Spark showed almost no stalls.
- **Level of detail** helps most with very large scenes: Spark can build a LoD tree on load and draw a budget of splats chosen for the view. Radix loads and saves LoD trees but does not yet choose LoD subsets itself; the SOG example chooses them in example code.
- **Loading** a PLY to the first frame took Radix 0.3-2.2 s and Spark 0.1-1.6 s.

## Large scenes

- Headset GPUs (Quest 3's Adreno 7xx) mostly offer 128 MiB storage bindings: 32M keys.

## Measuring

- `createRenderer({ profile: true })` installs a `GpuProfiler`; set `splatRenderer.phase = (name, run) => profiler.phase(name, run)` for separate "project" and "sort" rows ([renderer.md](renderer.md#gpuprofiler)).
- `splatRenderer.readSortedCount()` reads the GPU sort's visible count; `SplatProjector.programs` counts compiled programs (it should stop growing after the first frames).
- `node scripts/bench.mjs --matrix <name>` runs `/build/test/bench/index.html` in headless Chrome: files x modes x methods x bits, with GPU time per phase and screenshots ([checks.md](checks.md#benchmarks)).
- Measure with the GPU otherwise idle: an emulator tab or another page rendering distorts the results.
