// Benchmark page of src (/build/test/bench/index.html), driven by
// scripts/bench.mjs: `await radixBench.run(config)` loads a splat
// file (kept while the file and layout stay the same), renders a fixed
// camera path at a fixed size and returns the time of every step as JSON.
// The path has three parts of frames / 3 each: still, a full turn level, and
// a full turn tilting up and down (an object: orbiting its target, its
// elevation +-30 degrees; a scene: looking all around from where the camera
// stands, pitching +-45 degrees); frames are rendered back to back, each waiting for
// the GPU. Projection and sorting run before each render (SplatRenderer
// .prepare, outside its passes, so WebGL2 timer queries do not nest),
// labeled for GpuProfiler.
// Afterwards the still view is rendered once more (sorted first in cpu
// mode) for the driver's screenshot. ?gpu= picks the backend for the page;
// ?config= (JSON) runs one config on load, for a person to look at;
// ?limits=adapter asks for the adapter's whole storage sizes.
// `await radixBench.shBench({ url })` times the projection of one file's
// splats with and without spherical harmonics (per splat ext / packed,
// palettes of ext entries and of packed entries at strides 4 and 3,
// labels in order or random) from a still view.
import * as THREE from "three";
import { NodeMaterial, type WebGPURenderer } from "three/webgpu";
import {
  ArrayData, GpuArrays, GpuProfiler, GpuShPalette, Sh, ShPalette, SortKeys, SplatCollection, SplatRenderer, Splats, TSL, WgpuSplatSorter, createRenderer,
  getGpuCaps, loadSplats,
  type ProjectionMethod, type ShCodecName, type ShDegree, type ShTarget, type SortKeyBits, type SplatLayout, type SplatObjectParams, type SplatViewParams, type Vec3,
} from "@sparkjsdev/radix";

export interface BenchConfig {
  url: string;
  layout?: SplatLayout;
  // gpu: the GPU sort every frame (WebGPU); cpu: the camera's view.sort (keys, a
  // readback and a worker sort) and apply once the camera moved past
  // `threshold`
  mode?: "gpu" | "cpu";
  method?: ProjectionMethod;
  bits?: SortKeyBits;
  size?: [number, number];
  ratio?: number;
  frames?: number;
  // World-space pose of the still view (default: outside the middle 90% of
  // the splats, `distance` extents from their middle, looking at it)
  view?: { position: Vec3Tuple; target: Vec3Tuple };
  distance?: number;
  // "object": the path orbits the target; "scene": it looks around in place
  kind?: "object" | "scene";
  // cpu mode: re-sort distance, a fraction of the scene's extent, and with
  // a sortGuard the view's turn in degrees
  threshold?: number;
  turnThreshold?: number;
  // A half turn about x (captures are stored y-down; default true), then
  // `up` (the measured up direction after the flip) turned to +y
  flip?: boolean;
  up?: Vec3Tuple;
  // The view's params and objectParams, by name
  params?: Partial<SplatViewParams & SplatObjectParams>;
  // Also count the fragments the still view rasterizes (its draw again,
  // every fragment adding 1 to a float target)
  overdraw?: boolean;
  // Diagnostics of the draw: "flat" a constant fragment stage (the draw's
  // vertex work and fill), "empty" a vertex stage that places nothing (the
  // cost of the instances alone)
  debugDraw?: "flat" | "empty";
  // Spherical harmonics: the codec to load them into (default false: skipped,
  // so files with and without SH compare on base colors)
  sh?: ShTarget;
}

type Vec3Tuple = [number, number, number];

interface PartResult {
  frames: number;
  // Per frame: CPU ms of the frame's code, wall ms including the GPU wait,
  // GPU ms per phase (timestamps; missing without timestamp queries)
  cpuMs: number;
  wallMs: number;
  gpu: Record<string, number>;
  gpuFrames: number;
  // CPU ms per frame of project, sort and draw (the render call)
  cpuPhases: Record<string, number>;
  // cpu mode
  sorts?: number;
  readMs?: number;
  sortMs?: number;
  uploadMs?: number;
  latencyFrames?: number;
}

const params = new URLSearchParams(location.search);
const configParam = params.get("config");
const status = document.getElementById("status")!;
// ?limits=adapter: the adapter's whole storage binding and buffer sizes
// (scenes past the 256 MiB baseline)
const fullLimits = params.get("limits") === "adapter";
const renderer = await createRenderer({ profile: true, ...(fullLimits ? { limits: { maxStorageBufferBindingSize: "adapter", maxBufferSize: "adapter" } } : {}) });
const caps = getGpuCaps(renderer);
const profiler = renderer.inspector as GpuProfiler;
const gl = (renderer.backend as unknown as { gl?: WebGL2RenderingContext }).gl;
const device = (renderer.backend as unknown as { device?: GPUDevice }).device;
document.body.append(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.01, 1000);
let loaded: { key: string; data: ArrayData; splats: GpuArrays; load: Record<string, number> } | undefined;
let splatRenderer: SplatRenderer | undefined;
// The splats' transform
const model = new THREE.Object3D();
scene.add(model);

// Wait for the GPU to finish what was submitted, then let timers run (the
// WebGL2 readback polls its fence with them), as between animation frames
async function gpuDone() {
  if (device) {
    await device.queue.onSubmittedWorkDone();
  } else if (gl) {
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function load(url: string, layout: SplatLayout, sh: ShTarget = false) {
  const key = `${url}|${layout}|${sh}`;
  if (loaded?.key === key) {
    return loaded;
  }
  loaded?.splats.dispose();
  loaded = undefined;
  const marks: Record<string, number> = {};
  const start = performance.now();
  let stage = "";
  const data = await loadSplats(url, {
    worker: true, layout, sh,
    onProgress: (_, next) => {
      if (next !== stage) {
        marks[next] = performance.now() - start;
        stage = next;
      }
    },
  });
  const decoded = performance.now();
  const splats = GpuArrays.fromData(renderer, data);
  const uploaded = performance.now();
  await gpuDone();
  const done = performance.now();
  loaded = {
    key, data, splats,
    load: { ...Object.fromEntries(Object.entries(marks).map(([name, ms]) => [`${name}At`, ms])), loadMs: decoded - start, uploadCpuMs: uploaded - decoded, uploadMs: done - decoded },
  };
  return loaded;
}

// The middle 90% of the splat centers (local space), sampled
function boundsOf(data: ArrayData) {
  const { bundle } = Splats.get(data);
  const step = Math.max(1, Math.floor(data.count / 50000));
  const axes: number[][] = [[], [], []];
  const c: Vec3 = { x: 0, y: 0, z: 0 };
  for (let i = 0; i < data.count; i += step) {
    Splats.loadCenter(bundle, i, c);
    axes[0].push(c.x);
    axes[1].push(c.y);
    axes[2].push(c.z);
  }
  const lo = new THREE.Vector3();
  const hi = new THREE.Vector3();
  axes.forEach((values, axis) => {
    values.sort((a, b) => a - b);
    lo.setComponent(axis, values[Math.floor(values.length * 0.05)]);
    hi.setComponent(axis, values[Math.floor(values.length * 0.95)]);
  });
  return new THREE.Box3(lo, hi);
}

// The camera pose at t in [0, 1) of the path; the part (0 still, 1 the
// level turn, 2 the tilting turn)
function pose(t: number, base: { position: THREE.Vector3; target: THREE.Vector3 }, kind: "object" | "scene") {
  const part = Math.min(2, Math.floor(t * 3));
  const u = t * 3 - part;
  const object = kind === "object";
  // The camera seen from the target (object) or the target from the camera
  const offset = object ? base.position.clone().sub(base.target) : base.target.clone().sub(base.position);
  const spherical = new THREE.Spherical().setFromVector3(offset);
  if (part > 0) {
    spherical.theta += u * 2 * Math.PI;
  }
  if (part === 2) {
    const tilt = THREE.MathUtils.degToRad(object ? 30 : 45) * Math.sin(u * 2 * Math.PI);
    spherical.phi = THREE.MathUtils.clamp(spherical.phi - tilt, 0.05, Math.PI - 0.05);
  }
  offset.setFromSpherical(spherical);
  if (object) {
    camera.position.copy(base.target).add(offset);
    camera.lookAt(base.target);
  } else {
    camera.position.copy(base.position);
    camera.lookAt(base.position.clone().add(offset));
  }
  camera.updateMatrixWorld();
  return part;
}

async function run(input: BenchConfig) {
  const config = {
    layout: "extSplats" as SplatLayout, mode: (caps.backend === "webgpu" ? "gpu" : "cpu") as "gpu" | "cpu", method: "ewa" as ProjectionMethod,
    bits: 24 as SortKeyBits, size: [1920, 1080] as [number, number], ratio: 1, frames: 180, distance: 1.2, kind: "object" as "object" | "scene",
    threshold: 0.01, turnThreshold: 5, flip: true, params: {} as NonNullable<BenchConfig["params"]>, ...input,
  };
  if (config.mode === "gpu" && caps.backend !== "webgpu") {
    throw new Error("radixBench: mode gpu needs the WebGPU backend");
  }
  const { data, splats, load: loadTimes } = await load(config.url, config.layout, config.sh);

  renderer.setPixelRatio(config.ratio);
  renderer.setSize(config.size[0], config.size[1]);
  camera.aspect = config.size[0] / config.size[1];
  camera.updateProjectionMatrix();

  splatRenderer?.removeFromParent();
  splatRenderer?.dispose();
  const r = new SplatRenderer({
    renderer, method: config.method, sortBits: config.bits, sortMode: config.mode, autoSort: false,
    collection: new SplatCollection([SplatCollection.arrays(splats, { matrixWorld: model.matrixWorld })]),
  });
  splatRenderer = r;
  for (const [name, value] of Object.entries(config.params)) {
    Object.assign(name in r.params ? r.params : r.objectParams, { [name]: value });
  }
  // cpu mode: the camera's view holds the order
  const view = r.viewFor(camera);
  // Kernel names (radix_compact*, radix_sort*, radix_splatDrawArgs) label the sort's passes
  r.phase = <T>(name: string, run: () => T): T => {
    if (name === "project") {
      return profiler.phase(name, run);
    }
    profiler.label = "other";
    const start = performance.now();
    const result = run();
    profiler.mark(name, performance.now() - start);
    return result;
  };
  model.quaternion.identity();
  if (config.up) {
    model.quaternion.setFromUnitVectors(new THREE.Vector3(...config.up).normalize(), new THREE.Vector3(0, 1, 0));
  }
  if (config.flip) {
    model.quaternion.multiply(new THREE.Quaternion(1, 0, 0, 0));
  }
  scene.add(r);
  scene.updateMatrixWorld();

  const box = boundsOf(data).applyMatrix4(model.matrixWorld);
  const center = box.getCenter(new THREE.Vector3());
  const extent = box.getSize(new THREE.Vector3()).length();
  const base = config.view
    ? { position: new THREE.Vector3(...config.view.position), target: new THREE.Vector3(...config.view.target) }
    : { position: center.clone().add(new THREE.Vector3(0, 0, config.distance * extent)), target: center };
  camera.near = extent * 1e-4;
  camera.far = extent * 20;
  camera.updateProjectionMatrix();

  // cpu mode: the worker sort, started after a frame when the camera moved
  const threshold = config.threshold * extent;
  const sortedAt = new THREE.Vector3(Infinity, 0, 0);
  const sortedDir = new THREE.Vector3();
  const dir = new THREE.Vector3();
  const guarded = Number(config.params.sortGuard ?? 0) > 0;
  const turnCos = Math.cos(THREE.MathUtils.degToRad(config.turnThreshold));
  let sorting: Promise<void> | undefined;
  let frame = 0;
  const sortLog: { part: number; readMs: number; sortMs: number; uploadMs: number; latency: number }[] = [];
  let firstOrderFrame = -1;
  async function sortNow(part: number) {
    sortedAt.copy(camera.position);
    camera.getWorldDirection(sortedDir);
    const startFrame = frame;
    const order = await view.sort(camera);
    const start = performance.now();
    view.apply(order);
    sortLog.push({ part, readMs: order.keysMs, sortMs: order.sortMs, uploadMs: performance.now() - start, latency: frame - startFrame });
    if (firstOrderFrame < 0) {
      firstOrderFrame = frame;
    }
  }

  // Projected and sorted before the render, outside its passes
  function renderFrame() {
    profiler.beginFrame();
    r.prepare(camera);
    profiler.label = "draw";
    const start = performance.now();
    renderer.render(scene, camera);
    profiler.mark("draw", performance.now() - start);
    profiler.label = "other";
  }

  if (config.debugDraw) {
    // Built for the frame's camera first, then swapped
    renderer.render(scene, camera);
    const material = r.material;
    const debug = new NodeMaterial();
    debug.copy(material);
    debug.vertexNode = config.debugDraw === "empty" ? TSL.vec4(0, 0, 2, 1) : material.vertexNode;
    debug.fragmentNode = TSL.vec4(0.002, 0.002, 0.002, 0.002);
    r.material = debug;
  }

  // Warm up: build every pipeline, one sort in cpu mode
  for (let i = 0; i < 5; i += 1) {
    pose(0, base, config.kind);
    renderFrame();
    await gpuDone();
    frame += 1;
    if (config.mode === "cpu" && i === 0) {
      await sortNow(-1);
    }
  }
  await profiler.collect();

  const parts: PartResult[] = [];
  for (let part = 0; part < 3; part += 1) {
    const frames = Math.max(3, Math.round(config.frames / 3));
    let cpu = 0;
    let wall = 0;
    const sortsBefore = sortLog.length;
    for (let i = 0; i < frames; i += 1) {
      const t = (part + i / frames) / 3;
      pose(t, base, config.kind);
      const start = performance.now();
      renderFrame();
      cpu += performance.now() - start;
      await gpuDone();
      wall += performance.now() - start;
      frame += 1;
      const turned = guarded && camera.getWorldDirection(dir).dot(sortedDir) < turnCos;
      if (config.mode === "cpu" && !sorting && (camera.position.distanceTo(sortedAt) > threshold || turned)) {
        sorting = sortNow(part).finally(() => (sorting = undefined));
      }
    }
    // Let the last timestamps resolve
    await gpuDone();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const profile = (await profiler.collect()) ?? { gpu: {}, cpu: {}, frames: 0 };
    const sorts = sortLog.slice(sortsBefore);
    const mean = (key: "readMs" | "sortMs" | "uploadMs" | "latency") => (sorts.length > 0 ? sorts.reduce((sum, s) => sum + s[key], 0) / sorts.length : undefined);
    parts.push({
      frames, cpuMs: cpu / frames, wallMs: wall / frames, gpu: groupPhases(profile.gpu), gpuFrames: profile.frames, cpuPhases: profile.cpu,
      ...(config.mode === "cpu" ? { sorts: sorts.length, readMs: mean("readMs"), sortMs: mean("sortMs"), uploadMs: mean("uploadMs"), latencyFrames: mean("latency") } : {}),
    });
  }
  await sorting;

  // The still view for the screenshot
  pose(0, base, config.kind);
  renderFrame();
  if (config.mode === "cpu") {
    await sortNow(-1);
  }
  renderFrame();
  await gpuDone();
  await profiler.collect();
  const overdraw = config.overdraw ? await countFragments(r) : undefined;

  const result = {
    overdraw,
    config, backend: caps.backend, splats: data.count, extent,
    view: { position: base.position.toArray(), target: base.target.toArray() },
    drawn: config.mode === "cpu" ? sortLog[sortLog.length - 1]?.latency : undefined,
    firstOrderFrame, load: loadTimes, parts,
    limits: device ? { maxStorageBufferBindingSize: device.limits.maxStorageBufferBindingSize, maxBufferSize: device.limits.maxBufferSize } : undefined,
    timestamps: profiler.supported,
  };
  status.textContent = !configParam ? "" : `${config.url}: ${data.count.toLocaleString()} splats, ${config.mode} ${config.method} ${config.bits}b\n`
    + parts.map((p, i) => `${["still", "level", "tilted"][i]}: wall ${p.wallMs.toFixed(2)} ms, ${Object.entries(p.gpu).map(([k, v]) => `${k} ${v.toFixed(2)}`).join(", ")}`).join("\n");
  return result;
}

// Fragments the drawn splats rasterize (before any discard): the same
// vertex stage, a fragment stage adding 1 per fragment into a float target
async function countFragments(r: SplatRenderer) {
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());
  const target = new THREE.RenderTarget(size.x, size.y, { type: THREE.FloatType, depthBuffer: false });
  const material = new NodeMaterial();
  material.vertexNode = r.material.vertexNode;
  material.fragmentNode = TSL.vec4(1, 0, 0, 1);
  material.transparent = true;
  material.blending = THREE.AdditiveBlending;
  material.depthTest = false;
  material.depthWrite = false;
  material.side = THREE.DoubleSide;
  material.forceSinglePass = true;
  const drawMaterial = r.material;
  r.material = material;
  renderer.setRenderTarget(target);
  renderer.setClearColor(0x000000, 0);
  renderer.clear();
  renderer.render(scene, camera);
  renderer.setRenderTarget(null);
  r.material = drawMaterial;
  const pixels = await renderer.readRenderTargetPixelsAsync(target, 0, 0, size.x, size.y) as Float32Array;
  let sum = 0;
  let max = 0;
  let covered = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    const n = pixels[i];
    sum += n;
    max = Math.max(max, n);
    covered += n > 0 ? 1 : 0;
  }
  target.dispose();
  material.dispose();
  const count = size.x * size.y;
  return { fragments: sum, perPixel: sum / count, perCoveredPixel: sum / Math.max(1, covered), max, covered: covered / count };
}

// GPU ms per phase: project, compact, radix, args (sorter), draw, the rest
// by name
function groupPhases(gpu: Record<string, number>) {
  const out: Record<string, number> = {};
  for (const [name, ms] of Object.entries(gpu)) {
    const phase = name.startsWith("radix_compact") ? "compact" : name.startsWith("radix_sort") ? "radix" : name === "radix_splatDrawArgs" ? "args" : name;
    out[phase] = (out[phase] ?? 0) + ms;
  }
  out.total = Object.values(out).reduce((a, b) => a + b, 0);
  return out;
}

function dispose() {
  splatRenderer?.removeFromParent();
  splatRenderer?.dispose();
  splatRenderer = undefined;
  loaded?.splats.dispose();
  loaded = undefined;
}

// The GPU sort alone (WebGPU): WgpuSplatSorter on `count` random keys, a
// `valid` fraction of them valid, `rounds` times each waiting for the GPU.
// GPU ms per kernel group (timestamps) and wall ms per sort (with the
// buffer copies, which timestamps miss).
async function sortBench({ counts = [500_000, 2_000_000, 6_000_000, 10_000_000], bits = [16, 24, 32] as SortKeyBits[], valid = 0.9, rounds = 20 } = {}) {
  if (!device) {
    throw new Error("sortBench needs the WebGPU backend");
  }
  const rows = [];
  for (const count of counts) {
    const data = new ArrayData({ count }).addBundle("sortKeys", SortKeys.KEYS);
    const keys = new Uint32Array(data.bundles.sortKeys.channels.key.data.buffer, 0, count);
    const sorter = new WgpuSplatSorter(renderer);
    const arrays = new GpuArrays({ renderer, bundles: { sortKeys: SortKeys.KEYS }, capacity: count });
    for (const b of bits) {
      const max = SortKeys.validMax(b);
      for (let i = 0; i < count; i += 1) {
        keys[i] = Math.random() < valid ? Math.floor(Math.random() * max) : SortKeys.invalid(b);
      }
      arrays.upload(data);
      for (let i = 0; i < 3; i += 1) {
        sorter.sort(arrays, count, b);
        await device.queue.onSubmittedWorkDone();
      }
      await profiler.collect();
      let wall = 0;
      for (let i = 0; i < rounds; i += 1) {
        profiler.beginFrame();
        profiler.label = "other";
        const start = performance.now();
        sorter.sort(arrays, count, b);
        await device.queue.onSubmittedWorkDone();
        wall += performance.now() - start;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
      const profile = await profiler.collect();
      rows.push({ count, bits: b, wallMs: wall / rounds, gpu: groupPhases(profile?.gpu ?? {}), detail: profile?.gpu });
    }
    sorter.dispose();
    arrays.dispose();
  }
  return rows;
}

// The projection's cost with spherical harmonics: the same splats (`url`,
// a file with SH3) drawn with none, per splat (ext, packed) and through a
// palette of `paletteSize` entries made from the first splats' SH (ext
// and packed, strides 4 and 3; labels in order, so neighbors share
// entries, or random, the worst case for caches), from the still view of
// run(), `frames` frames each, `rounds` times over all variants in turn.
// Medians of GPU ms per phase (timestamps) and wall ms.
async function shBench({ url, frames = 60, rounds = 3, size = [1920, 1080] as [number, number], paletteSize = 65536, method = "ewa" as ProjectionMethod }: {
  url: string;
  frames?: number;
  rounds?: number;
  size?: [number, number];
  paletteSize?: number;
  method?: ProjectionMethod;
}) {
  const { data } = await load(url, "extSplats", "ext");
  const found = Sh.find(data.bundles);
  if (!found) {
    throw new Error(`${url} has no spherical harmonics`);
  }
  const degree = found.degree as ShDegree;
  const count = data.count;
  const decode = Sh.decoder(data, found);
  const coeffs = new Float32Array(Sh.VALUES);

  const plain = new ArrayData({ count, capacity: data.capacity, meta: {} });
  plain.addBundle("extSplats", data.bundles.extSplats.def, { data: { extA: data.bundles.extSplats.channels.extA.data, extB: data.bundles.extSplats.channels.extB.data } });
  const withLabels = (order: "ordered" | "random") => {
    const out = new ArrayData({ count, capacity: data.capacity, meta: {} });
    out.addBundle("extSplats", data.bundles.extSplats.def, { data: { extA: data.bundles.extSplats.channels.extA.data, extB: data.bundles.extSplats.channels.extB.data } });
    const labels = out.addBundle("shLabel", Sh.LABEL).bundles.shLabel.channels.label.data;
    for (let i = 0; i < count; i += 1) {
      labels[i] = order === "ordered" ? Math.floor((i * paletteSize) / count) : (Math.imul(i, 2654435761) >>> 0) % paletteSize;
    }
    return out;
  };
  const paletteOf = (codec: ShCodecName, stride: number) => {
    const palette = ShPalette.create({ codec, degree, size: paletteSize, stride });
    for (let n = 0; n < paletteSize; n += 1) {
      palette.set(n, decode(n % count, coeffs));
    }
    return palette;
  };
  const variants: { name: string; table: ArrayData; palette?: ShPalette }[] = [
    { name: "none", table: plain },
    { name: "ext per splat", table: data },
    { name: "packed per splat", table: Sh.convert(data, "packed") },
  ];
  for (const codec of ["ext", "packed"] as const) {
    for (const stride of codec === "ext" ? [4] : [4, 3]) {
      const palette = paletteOf(codec, stride);
      for (const order of ["ordered", "random"] as const) {
        variants.push({ name: `${codec} palette, stride ${stride}, ${order} labels`, table: withLabels(order), palette });
      }
    }
  }

  renderer.setPixelRatio(1);
  renderer.setSize(size[0], size[1]);
  camera.aspect = size[0] / size[1];
  model.quaternion.set(1, 0, 0, 0);
  scene.updateMatrixWorld();
  const box = boundsOf(data).applyMatrix4(model.matrixWorld);
  const center = box.getCenter(new THREE.Vector3());
  const extent = box.getSize(new THREE.Vector3()).length();
  camera.position.copy(center).add(new THREE.Vector3(0, 0, 1.2 * extent));
  camera.lookAt(center);
  camera.near = extent * 1e-4;
  camera.far = extent * 20;
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();

  // Rounds over every variant in turn, so drift (clocks, heat) spreads over all
  const results = variants.map(() => ({ project: [] as number[], draw: [] as number[], wall: [] as number[] }));
  for (let round = 0; round < rounds; round += 1) {
    for (const [v, variant] of variants.entries()) {
      const arrays = GpuArrays.fromData(renderer, variant.table);
      const palette = variant.palette && GpuShPalette.upload(renderer, variant.palette);
      const r = new SplatRenderer({
        renderer, method, sortMode: caps.backend === "webgpu" ? "gpu" : "cpu", autoSort: false,
        collection: new SplatCollection([SplatCollection.arrays(arrays, { matrixWorld: model.matrixWorld, shPalette: palette })]),
      });
      r.phase = <T>(name: string, run: () => T): T => (name === "project" ? profiler.phase(name, run) : run());
      scene.add(r);
      const frame = () => {
        profiler.beginFrame();
        r.prepare(camera);
        profiler.label = "draw";
        renderer.render(scene, camera);
        profiler.label = "other";
      };
      for (let i = 0; i < 5; i += 1) {
        frame();
        await gpuDone();
      }
      // cpu mode (WebGL2): one sort, so the draw draws
      if (r.sortMode === "cpu") {
        const view = r.viewFor(camera);
        view.apply(await view.sort(camera));
      }
      await profiler.collect();
      let wall = 0;
      for (let i = 0; i < frames; i += 1) {
        const start = performance.now();
        frame();
        await gpuDone();
        wall += performance.now() - start;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
      const gpu = groupPhases((await profiler.collect())?.gpu ?? {});
      results[v].project.push(gpu.project);
      results[v].draw.push(gpu.draw);
      results[v].wall.push(wall / frames);
      r.removeFromParent();
      r.dispose();
      arrays.dispose();
      palette?.dispose();
    }
  }
  const median = (values: number[]) => {
    const known = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
    return known.length ? known[Math.floor(known.length / 2)] : undefined;
  };
  const rows = variants.map((variant, v) => ({
    name: variant.name, splats: count, project: median(results[v].project), draw: median(results[v].draw), wallMs: median(results[v].wall), rounds: results[v],
  }));
  return { backend: caps.backend, url, splats: count, degree, timestamps: profiler.supported, rows };
}

// The draw's shader code (after a run)
async function shaders() {
  return splatRenderer ? renderer.debug.getShaderAsync(scene, camera, splatRenderer) : undefined;
}

Object.assign(window, { radixBench: { run, sortBench, shBench, dispose, shaders, renderer: renderer as WebGPURenderer, caps } });

if (configParam) {
  console.log(await run(JSON.parse(configParam) as BenchConfig));
}
