# The renderer

`createRenderer` returns an initialized three.js `WebGPURenderer` set up the way Radix expects: WebGPU when the browser has it and the WebGL2 backend otherwise, with the device limits that about 95% of devices support. This page also covers `getGpuCaps`, HDR output (`Hdr`), and GPU timing (`GpuProfiler`).

Code: `src/gpu/createRenderer.ts`, `baseline.ts`, `hdr.ts`, and `GpuProfiler.ts`.

```ts
const renderer = await createRenderer({ antialias: false });
const caps = getGpuCaps(renderer);
console.log(caps.backend); // "webgpu" or "webgpu-gl"
```

Shaders in Radix are written in TSL (three.js Shading Language) only, with no raw WGSL or GLSL, so the same code runs on both backends ([shaders.md](shaders.md)).

## createRenderer

An option passed to the call takes precedence over its URL parameter. An option left out comes from its URL parameter, or else from its default. A page that wants its own default and still wants the URL to override it reads the parameter and passes the value itself.

| Option | URL | Default | What it does |
|---|---|---|---|
| `backend` | `?gpu=webgpu \| webgpu-gl` | `"auto"` | `"webgpu"`, `"webgpu-gl"` (the WebGL2 backend), or `"auto"`: WebGPU when available |
| `canvas` | | a new canvas | the canvas to draw into |
| `antialias` | | three's default | MSAA |
| `hdr` | `?hdr=1 \| auto` | off | an rgba16float canvas with extended tone mapping (WebGPU): `true`, `"auto"` (when the display reports high dynamic range), or `false`. `getGpuCaps(renderer).hdr` tells whether it was enabled |
| `profile` | `?profile=1` | off | timestamp queries plus a `GpuProfiler` as `renderer.inspector` |
| `timing` | `?timing=1` | off | timestamp queries only |
| `multiview` | `?multiview=1` | off | both XR eyes in one draw where supported (`OVR_multiview2` on WebGL2) |
| `directCanvas` | `?direct=0` | on | draws straight to the canvas, without three's linear target and output pass: materials write sRGB-encoded colors themselves |
| `xr` | | off | enables `renderer.xr` before init: the WebGPU adapter must be requested XR-compatible for the WebXR / WebGPU binding |
| `limits` | | | WebGPU limits added to or replacing the baselines below: a number (capped at the adapter's) or `"adapter"` for the adapter's full limit (`LimitRequest`) |
| `logarithmicDepthBuffer` | | off | a logarithmic depth buffer, for scenes from centimeters to kilometers. Splats get it too: three derives a material's depth from its clip-space position when it has its own vertex shader |

- If WebGPU was asked for (`?gpu=webgpu`) and device creation fails, three falls back to WebGL2 by itself and Radix logs a warning.
- On WebGL2, timer queries cannot nest, so only `profile` keeps them (its phases render outside the frame's passes); `timing` alone has no effect there.
- On WebGL2, `createRenderer` enables `EXT_color_buffer_float` (float render targets and readback; it warns when the extension is missing) and `EXT_float_blend`, and logs which parameters fall below the WebGL2 baseline.

## Device baselines

On WebGPU, `createRenderer` asks for these limits above WebGPU's defaults. Each is capped at what the adapter offers, so the request never fails. Each value is met by about 95% of devices or more (web3dsurvey.com, Sep 2026). Design WebGPU code against these, not against the development machine.

| Limit | Default | Baseline |
|---|---|---|
| `maxTextureDimension1D`, `maxTextureDimension2D` | 8192 | 16384 |
| `maxTextureArrayLayers` | 256 | 2048 |
| `maxBufferSize` | 256 MiB | 1 GiB |
| `maxStorageBufferBindingSize` | 128 MiB | 256 MiB (98%; 1 GiB: 92%) |
| `maxComputeWorkgroupStorageSize` | 16 KiB | 32 KiB |
| `maxColorAttachmentBytesPerSample` | 32 | 64 |
| `maxStorageBuffersPerShaderStage`, `...InVertexStage`, `...InFragmentStage` | 8 | 10 |

Kept at the default because the next tier is under 95%: 4 storage textures per stage, 256 compute invocations per workgroup, 16 sampled textures per stage, 16 inter-stage variables, 4 bind groups. Optional features at or above 95%: `timestamp-query`, `indirect-first-instance`, `depth32float-stencil8`, `rg11b10ufloat-renderable`, `depth-clip-control`, and `bgra8unorm-storage`; `shader-f16`, `float32-filterable`, `float32-blendable`, `subgroups`, and texture compression need a fallback.

WebGL2 parameters to design against: 8192 texture size, 512 array layers, 4 draw buffers, 16 texture units per stage, 16 KiB uniform blocks, 15 varying vectors, 16 vertex attributes, and 4 MSAA samples. `snorm8` is not renderable there (`EXT_render_snorm` is at 80%).

## getGpuCaps

`getGpuCaps(renderer)` returns a `GpuCaps`:

| Field | WebGPU | WebGL2 |
|---|---|---|
| `backend` | `"webgpu"` | `"webgpu-gl"` |
| `compute` | `true` | `false` |
| `maxTextureSize`, `maxTextureLayers`, `maxColorAttachments` | the device's limits | the context's parameters |
| `maxTexturesPerStage` | sampled textures per stage | the smaller of fragment and vertex texture units |
| `maxStorageTexturesPerStage`, `maxStorageBuffersPerStage`, `maxWorkgroupStorage` | the device's limits | 0 |
| `float32Blendable`, `float32Filterable` | the features | `EXT_float_blend`, `OES_texture_float_linear` |
| `subgroups` | the feature | `false` |
| `multiview` | `"webgpu"` or `false` | `"ovr"` or `false` |
| `hdr` | `Hdr.canvasSupports(renderer)` | `false` |

Types: `GpuBackend` (`"webgpu" | "webgpu-gl"`), `CreateRendererOptions`, `LimitRequest`, and `GpuCaps`.

## HDR output

HDR output has two independent parts:

- **The HDR canvas** (WebGPU only): `createRenderer({ hdr })` configures an rgba16float canvas with extended tone mapping, so values above 1 show brighter than SDR white on HDR displays (Chrome 129+). The canvas stays sRGB-encoded, so colors drawn to it blend as on an SDR canvas.
- **Headroom tone mapping** (both backends): `Hdr.useToneMapping(renderer)` renders into three's float frame target and compresses the finished frame into `[0, headroom]` in its output pass. Values below the knee are unchanged, values above it follow a smooth shoulder, and colors past the headroom fade to white instead of clipping per channel. Headroom 1 is SDR tone mapping.

```ts
const renderer = await createRenderer({ hdr: "auto" });
// Headroom 4 on an HDR canvas, else 1
const tone = Hdr.useToneMapping(renderer);

// Uniforms: change them any time
tone.headroom.value = settings.headroom;
// Restores three's tone mapping
tone.enabled = false;
```

| Member | What it does |
|---|---|
| `Hdr.displaySupports()` | whether the display reports high dynamic range |
| `Hdr.canvasSupports(renderer)` | whether the canvas can show the extended range (WebGPU, an rgba16float canvas, and a browser that kept the extended mode) |
| `Hdr.setOutput(renderer, extended)` | switches an HDR canvas between extended and standard range without recreating anything; `false` when the canvas cannot |
| `Hdr.useToneMapping(renderer, { headroom?, knee?, whiten?, enabled? })` | the renderer's tone mapping (one per renderer; later calls return it with the options applied). Returns an `HdrToneMapping` |
| `HdrToneMapping.headroom` | the brightest linear value the output may reach: 1 for SDR, the display's headroom otherwise (a uniform; default 4 on an HDR canvas, else 1) |
| `HdrToneMapping.knee` | the fraction of the headroom kept unchanged before the shoulder (a uniform; default 0.75) |
| `HdrToneMapping.whiten` | how fast colors past the headroom fade to white; 0 never (a uniform; default 0.5) |
| `HdrToneMapping.exposure` | `renderer.toneMappingExposure` |
| `HdrToneMapping.enabled` | turns the pass on and off; on sets `toneMapping` and an sRGB output color space, off restores the previous ones |

Splats blend sRGB-encoded colors, as they were trained. The tone mapping pass decodes them first, and three encodes its result, so below the knee the frame is the same as without tone mapping. There is no web API for a display's actual headroom yet; pick one (about 2 to 8 on current HDR laptops and monitors) or make it a setting.

## GpuProfiler

`GpuProfiler` records GPU and CPU milliseconds per named phase. GPU times come from three's timestamp queries (WebGPU `timestamp-query`, or `EXT_disjoint_timer_query_webgl2` on WebGL2); CPU times wrap the phase's code. `createRenderer({ profile: true })` installs one as `renderer.inspector`.

```ts
const profiler = renderer.inspector as GpuProfiler;
// "project" and "sort" get their own rows
splatRenderer.phase = (name, run) => profiler.phase(name, run);

renderer.setAnimationLoop(async () => {
  profiler.beginFrame();
  profiler.label = "draw";
  renderer.render(scene, camera);
  // ms per phase, averaged; undefined if nothing resolved
  const report = await profiler.collect();
  // "GPU draw 2.31, project 0.09 | CPU ... ms"
  if (report) console.log(GpuProfiler.format(report));
});
```

| Member | What it does |
|---|---|
| `beginFrame()` | starts a frame; times are averaged over frames |
| `label` | the phase of the passes recorded from now on (default `"other"`) |
| `phase(name, fn)` | runs `fn` with its passes labeled `name`, and records its CPU time |
| `mark(name, ms)` | records CPU milliseconds for a phase, such as an async worker round trip |
| `collect()` | resolves pending queries: a `GpuProfile` (`gpu` and `cpu`: ms per phase per frame; `frames`: resolved frames), or `undefined` when nothing new resolved |
| `GpuProfiler.format(profile)` | one line of text, phases sorted by time |
| `active` | whether the renderer tracks timestamps; settable between frames (not inside a render: WebGL2 timer queries must end as they began). CPU phases are timed either way |
| `supported` | whether the device has timestamp queries |

Timestamps resolve a frame or two late. Chrome quantizes them to 100 µs unless WebGPU developer features are on (`--enable-webgpu-developer-features`).
