// MLS-MPM water: a ball of water dropped in a box, simulated in TSL compute
// kernels (MpmSim.ts) and drawn with one splat per particle by a generator
// that reads the particle buffers (waterSplats), sorted with a splat scan in
// one SplatRenderer. WebGPU only: on the WebGL2 backend the page says so. The
// camera flies or orbits the box (CameraControls: F switches). The Walls
// folder moves the box faces live; water outside a moved wall is pushed back
// in. The box is drawn as fat lines (BoxLines.ts), bright while the walls
// move and dim otherwise (the Box folder).
//
// The scan (a sample on GCS, or any URL) sets the box (its robust extent),
// is drawn as the first object of the collection (the leaves of its LoD
// tree when it has one) and is baked on the GPU into a collider
// (SplatCollider.ts): a narrow-band distance field in the scan's object
// space that the simulation samples through its transform. The gizmo on the
// scan (1 translate, 2 rotate, 3 scale; uniform scale only) moves the
// collider with it; the end of a scale drag re-bakes so a voxel stays about
// `voxel` sim cells. Query parameters:
//   ?scene=      a sample: ceramic (default) | butterfly | sutro (SH3); a
//                splat file URL; or none (?splats= another base for the
//                samples, ?splatsSh= for Sutro)
//   ?flip=0      the scan as stored (samples are y-down, so flipped by default)
//   ?sceneScale= initial uniform scale of the scan
//   ?voxel=      collider voxel size in sim cells (default 1)
//   ?particles=  (default 200000), ?grid= (cells along the longest axis;
//                default 192 with a scan's box, else 48)
//   ?bounds=x,y,z  box size in metres, floor at y = 0 (default the scan's extent)
//   ?dt=         s per substep, ?substeps=, ?E= (stiffness), ?gravity= (m/s^2)
//   ?radius=     splat std dev in cells, ?opacity=
//   ?drop=       start as a slab this many cells above the floor, not a ball
//   ?controls=orbit | fly (default), ?paused=1
//   ?timing=1    GPU ms per kernel in the status line from the start (one
//                pass per kernel; Performance > "GPU timing" switches it)
//   ?gpu=        webgpu | webgpu-gl (the latter shows the WebGPU notice)
//
// `radixMpm` in the console holds the page (`ready` once the scan is
// loaded and a few frames drew). `await radixMpm.benchmark()` resets the
// water, warms up, then reports fps, CPU ms per frame, GPU ms per stage
// (with GPU timing on) and stability stats; `await radixMpm.stats()` gives
// the stats alone. The Performance folder switches the optimizations live
// for A/B (one compute pass per step, particle sort interval, tiled P2G).
import * as THREE from "three";
import GUI from "lil-gui";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import {
  CameraControls, GpuArrays, GpuProfiler, SplatCollection, SplatRenderer, Splats, createRenderer, getGpuCaps, loadSplats,
  type ArrayData, type GpuProfile,
} from "@sparkjsdev/radix";
import { BoxLines } from "./BoxLines.js";
import { COLOR_MODES, MpmSim, waterSplats } from "./MpmSim.js";
import { SplatCollider, robustSplatBounds } from "./SplatCollider.js";

const params = new URLSearchParams(location.search);
const status = document.getElementById("status")!;

const SPLATS = params.get("splats") ?? "https://storage.googleapis.com/forge-dev-public/asundqui/radix/261009/rdx";
const SPLATS_SH = params.get("splatsSh") ?? "https://storage.googleapis.com/forge-dev-public/asundqui/radix/261015/rdx-sh";
const SAMPLES: Record<string, string> = {
  ceramic: `${SPLATS}/ceramic.rdx`, butterfly: `${SPLATS}/butterfly-ai.rdx`, sutro: `${SPLATS_SH}/sutro-2m.rdx`,
};

function numberParam(name: string, fallback: number) {
  const value = Number(params.get(name));
  return params.has(name) && Number.isFinite(value) ? value : fallback;
}

const renderer = await createRenderer({ profile: true });
if (getGpuCaps(renderer).backend !== "webgpu") {
  renderer.dispose();
  status.textContent = "";
  document.getElementById("needs-webgpu")!.hidden = false;
  Object.assign(window, { radixMpm: { ready: true, webgpu: false } });
  // Nothing else runs on this backend
  await new Promise(() => {});
}
// GPU timestamps per pass: the simulation kernels by their labels (mpmP2G,
// mpmGrid, mpmG2P, ...), the splats as project, sort and draw. Off unless
// ?timing=1 or the Performance folder turns them on (they cost frame time).
const profiler = renderer.inspector instanceof GpuProfiler ? renderer.inspector : undefined;
if (profiler) {
  profiler.active = params.get("timing") === "1";
}
renderer.setSize(innerWidth, innerHeight);
document.body.prepend(renderer.domElement);

const scene = new THREE.Scene();
// The canvas takes values as they are (createRenderer's directCanvas)
scene.background = new THREE.Color().setRGB(0.05, 0.06, 0.08, THREE.LinearSRGBColorSpace);
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.01, 100);

addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});
addEventListener("unhandledrejection", (event) => {
  status.textContent = `Error: ${event.reason instanceof Error ? event.reason.message : String(event.reason)}`;
});

// The box: ?bounds=x,y,z (metres, floor at y = 0, centred on the origin in
// x/z), else the scan's extent below, else 2 m
const boundsParam = params.get("bounds")?.split(",").map(Number);
const boxSize = new THREE.Vector3(boundsParam?.[0] || 2, boundsParam?.[1] || 2, boundsParam?.[2] || 2);
let bounds = new THREE.Box3(new THREE.Vector3(-boxSize.x / 2, 0, -boxSize.z / 2), new THREE.Vector3(boxSize.x / 2, boxSize.y, boxSize.z / 2));

// The leaves of a LoD tree's splats (nodes without children), copied into
// plain splats: interior nodes merge their children and would draw and
// collide twice. Data without a tree as it is.
function leafSplats(data: ArrayData): ArrayData {
  const tree = Splats.findLodTree(data);
  if (!tree) {
    return data;
  }
  const nodes = tree.channels.node.data;
  let count = 0;
  for (let i = 0; i < data.count; i += 1) {
    count += nodes[i * 2] === 0 ? 1 : 0;
  }
  // Runs of consecutive leaves at a time
  const leaves = Splats.make(count);
  let at = 0;
  for (let start = 0; start < data.count; start += 1) {
    let end = start;
    while (end < data.count && nodes[end * 2] === 0) {
      end += 1;
    }
    if (end > start) {
      leaves.copyFrom(data, { bundles: ["extSplats"], srcStart: start, dstStart: at, count: end - start });
      at += end - start;
      start = end;
    }
  }
  return leaves;
}

// The scan and its collider, placed by `holder` (the gizmo's object). The
// scan starts at ?sceneScale=, centred on the origin in x/z with its floor
// at y = 0, and without ?bounds= the box is its extent: the 1st to 99th
// percentile of the splat centres on each axis.
const sceneName = params.get("scene") ?? "ceramic";
const holder = new THREE.Object3D();
scene.add(holder);
let scan: GpuArrays | undefined;
let collider: SplatCollider | undefined;
let sceneSplatCount = 0;
if (sceneName !== "none") {
  const url = SAMPLES[sceneName] ?? sceneName;
  const data = await loadSplats(url, {
    onProgress: (fraction, stage) => (status.textContent = `${sceneName}: ${stage} ${Math.round(fraction * 100)}%`),
  });
  const leaves = leafSplats(data);
  sceneSplatCount = leaves.count;
  scan = GpuArrays.fromData(renderer, leaves, { bundles: ["extSplats"] });
  if (params.get("flip") !== "0") {
    holder.quaternion.set(1, 0, 0, 0);
  }
  holder.scale.setScalar(Math.max(1e-3, numberParam("sceneScale", 1.0)));
  collider = new SplatCollider({ renderer, target: holder, data: leaves, splats: scan });
  holder.updateMatrixWorld();
  const extent = robustSplatBounds(leaves, 0.01);
  const placed = extent.clone().applyMatrix4(holder.matrixWorld);
  const center = placed.getCenter(new THREE.Vector3());
  holder.position.set(-center.x, -placed.min.y, -center.z);
  holder.updateMatrixWorld();
  if (!boundsParam) {
    bounds = extent.applyMatrix4(holder.matrixWorld);
  }
}
const size = bounds.getSize(new THREE.Vector3());

// A scan's box is a room: finer cells so the default ball fits in it
const sim = new MpmSim({
  renderer,
  bounds,
  grid: numberParam("grid", scan && !boundsParam ? 192 : 48),
  particles: numberParam("particles", 200000),
  dt: numberParam("dt", 5e-4),
  substeps: numberParam("substeps", 20),
  E: numberParam("E", 1e5),
  gravity: numberParam("gravity", 9.8),
  collider,
});
// The water starts as a ball at the centre of the box; ?drop= makes it a
// slab spanning the box in x/z with its base that many cells above the floor
const drop = params.has("drop") ? numberParam("drop", 0) : undefined;
if (drop !== undefined) {
  sim.reset(drop);
}
// With GPU timestamps, one pass per kernel so each is timed on its own
sim.batched = !profiler?.active;
const water = waterSplats(sim);
water.uniforms.radius.value = numberParam("radius", 0.4) * sim.cellSize;
water.uniforms.opacity.value = numberParam("opacity", 0.05);

// The scan and the water in one sort. The water's object is remade when the
// particle count changes, the collection when either object changes.
const splats = new SplatRenderer({ renderer });
if (profiler) {
  splats.phase = (name, run) => profiler.phase(name, run);
}
// Before the gizmo and the box lines
splats.renderOrder = -1;
scene.add(splats);
const scanObject = scan && SplatCollection.arrays(scan, { matrixWorld: holder.matrixWorld });
let showScan = true;
let waterObject = SplatCollection.object({ generator: water.generator, count: sim.count });
function updateCollection() {
  if (waterObject.count !== sim.count) {
    waterObject = SplatCollection.object({ generator: water.generator, count: sim.count });
  }
  splats.collection = new SplatCollection(scanObject && showScan ? [scanObject, waterObject] : [waterObject]);
}
updateCollection();

// Collider voxel size in sim cells (world size; the bake is in object units)
let voxelCells = numberParam("voxel", 1);
let baking = false;
async function rebake() {
  if (!collider || baking) {
    return;
  }
  baking = true;
  try {
    const bake = await collider.bake((voxelCells * sim.cellSize) / holder.scale.x);
    console.log("collider", `${bake.dims.toArray().join("x")} voxels of ${bake.voxelSize.toFixed(4)}, ${bake.ms.toFixed(1)} ms`);
  } finally {
    baking = false;
  }
}
if (collider) {
  status.textContent = "Baking the collider...";
  await rebake();
}

// The walls, live: the lines fit the box every frame, bright while it
// changes and dim otherwise
const boxLines = new BoxLines();
scene.add(boxLines);

// Transform gizmo on the scan, made before the camera controls so its
// pointerdown runs first. Scale stays uniform (the distance field is only
// exact for uniform scale): a per-axis drag applies the changed axis to all
// three. The end of a scale drag re-bakes.
let gizmo: TransformControls | undefined;
const initialPose = { position: holder.position.clone(), quaternion: holder.quaternion.clone(), scale: holder.scale.x };
if (scan) {
  const transform = new TransformControls(camera, renderer.domElement);
  gizmo = transform;
  transform.attach(holder);
  scene.add(transform.getHelper());
  let uniformScale = holder.scale.x;
  transform.addEventListener("objectChange", () => {
    if (transform.mode !== "scale") {
      return;
    }
    const { x, y, z } = holder.scale;
    const changed = [x, y, z].reduce((a, b) => (Math.abs(b - uniformScale) > Math.abs(a - uniformScale) ? b : a));
    uniformScale = Math.max(1e-3, changed);
    holder.scale.setScalar(uniformScale);
  });
  transform.addEventListener("dragging-changed", (event) => {
    controls.enabled = !event.value;
    if (!event.value && transform.mode === "scale") {
      void rebake();
    }
  });
  // Digits, since the fly controls own the letter keys
  addEventListener("keydown", (event) => {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) {
      return;
    }
    const mode = ({ Digit1: "translate", Digit2: "rotate", Digit3: "scale" } as Record<string, string>)[event.code];
    if (mode) {
      sceneSettings.gizmo = mode;
      gui.controllersRecursive().forEach((c) => c.updateDisplay());
    }
  });
}

// Around the box centre, starting from the front, slightly above
const center = bounds.getCenter(new THREE.Vector3());
const extent = Math.max(size.x, size.y, size.z);
camera.position.set(center.x, center.y + 0.1 * extent, center.z + 0.1 * extent);
const controls = new CameraControls({
  canvas: renderer.domElement,
  object: camera,
  settings: { mode: params.get("controls") === "orbit" ? "orbit" : "fly", minDistance: extent * 0.02, maxDistance: extent * 10 },
});
controls.lookAt(center);

// GUI: the simulation uniforms are live; the particle count is applied by
// reset (it resizes the particle buffers); the grid needs a reload
const settings = {
  get camera() { return controls.mode; },
  set camera(mode: "orbit" | "fly") { controls.mode = mode; },
  paused: params.get("paused") === "1",
  particles: sim.count,
  step: () => { sim.step(); },
  reset: () => {
    sim.setCount(settings.particles);
    sim.reset(drop);
    updateCollection();
  },
  get dt() { return sim.uniforms.dt.value; },
  set dt(v: number) { sim.uniforms.dt.value = v; },
  get E() { return sim.uniforms.E.value; },
  set E(v: number) { sim.uniforms.E.value = v; },
  get gravity() { return sim.gravity; },
  set gravity(v: number) { sim.gravity = v; },
  get radius() { return water.uniforms.radius.value / sim.cellSize; },
  set radius(v: number) { water.uniforms.radius.value = v * sim.cellSize; },
  get opacity() { return water.uniforms.opacity.value; },
  set opacity(v: number) { water.uniforms.opacity.value = v; },
  get variation() { return water.uniforms.variation.value; },
  set variation(v: number) { water.uniforms.variation.value = v; },
  get color() { return COLOR_MODES[water.uniforms.colorMode.value]; },
  set color(mode: (typeof COLOR_MODES)[number]) { water.uniforms.colorMode.value = COLOR_MODES.indexOf(mode); },
  get speedRange() { return water.uniforms.speedRange.value; },
  set speedRange(v: number) { water.uniforms.speedRange.value = v; },
  get pressureRange() { return water.uniforms.pressureRange.value; },
  set pressureRange(v: number) { water.uniforms.pressureRange.value = v; },
};
const gui = new GUI({ title: "MPM water" });
gui.add(settings, "camera", ["orbit", "fly"]).listen();
gui.add(settings, "paused");
gui.add(settings, "step");
gui.add(settings, "reset");
gui.add(settings, "particles", 4096, 524288, 4096).name("particles (on reset)");
gui.add(settings, "dt", 1e-5, 2e-3, 1e-5).name("dt (s/substep)");
gui.add(sim, "substeps", 1, 100, 1);
gui.add(settings, "E", 1e4, 1e7, 1e4).name("E (stiffness)");
gui.add(sim.uniforms.densityRate, "value", 0, 1, 0.01).name("density correction");
gui.add(settings, "gravity", -20, 20, 0.1).name("gravity (m/s^2)");
gui.add(settings, "radius", 0.05, 2, 0.01).name("splat radius (cells)");
gui.add(settings, "opacity", 0.05, 1, 0.01);
gui.add(settings, "variation", 0, 1, 0.01).name("brightness variation");
gui.add(settings, "color", [...COLOR_MODES]);
gui.add(settings, "speedRange", 0.1, 10, 0.1).name("white at (m/s)");
gui.add(settings, "pressureRange", 0.02, 2, 0.01).name("deep blue at (m head)");

// Performance switches (A/B the optimizations live)
const perfFolder = gui.addFolder("Performance");
const batchedControl = perfFolder.add(sim, "batched").name("one pass per step");
perfFolder.add(sim, "sortEvery", 0, 120, 1).name("sort every (steps)");
perfFolder.add(sim, "tiledP2G").name("tiled P2G");
// GPU ms per kernel in the status line: one pass per kernel while on
if (profiler?.supported) {
  const timing = {
    get gpu() { return profiler.active; },
    set gpu(on: boolean) {
      profiler.active = on;
      sim.batched = !on;
      batchedControl.updateDisplay();
    },
  };
  perfFolder.add(timing, "gpu").name("GPU timing (per kernel)");
}

// Walls: each face slides within the initial box (the grid only extends a
// little beyond it), kept at least two cells from the opposite face
const wallsFolder = gui.addFolder("Walls");
const wallGap = 2 * sim.cellSize;
for (const axis of ["x", "y", "z"] as const) {
  const lo = bounds.min[axis];
  const hi = bounds.max[axis];
  const step = (hi - lo) / 200;
  wallsFolder.add(sim.walls.min, axis, lo, hi - wallGap, step).name(`min ${axis}`).onChange((v: number) => {
    sim.walls.min[axis] = Math.min(v, sim.walls.max[axis] - wallGap);
    wallsFolder.controllers.forEach((c) => c.updateDisplay());
  });
  wallsFolder.add(sim.walls.max, axis, lo + wallGap, hi, step).name(`max ${axis}`).onChange((v: number) => {
    sim.walls.max[axis] = Math.max(v, sim.walls.min[axis] + wallGap);
    wallsFolder.controllers.forEach((c) => c.updateDisplay());
  });
}
wallsFolder.add({ restore: () => { sim.walls.copy(bounds); wallsFolder.controllers.forEach((c) => c.updateDisplay()); } }, "restore")
  .name("restore box");

// Box lines: pixel width, opacity when idle, fade after the last change
// (an edit here shows them at full opacity too)
const boxFolder = gui.addFolder("Box");
boxFolder.onChange(() => boxLines.touch());
boxFolder.add(boxLines.settings, "width", 0.5, 8, 0.25).name("width (px)");
boxFolder.add(boxLines.settings, "idle", 0, 1, 0.01).name("idle opacity");
boxFolder.add(boxLines.settings, "hold", 0, 3, 0.05).name("hold (s)");
boxFolder.add(boxLines.settings, "fade", 0, 5, 0.05).name("fade (s)");
boxFolder.add(boxLines.settings, "midlines").name("face midlines");
boxFolder.add(boxLines, "visible").name("show box");

// Scene: the gizmo mode, the collider switches, and the bake parameters
// (applied by "rebake")
const sceneSettings = {
  get gizmo() { return !gizmo?.enabled ? "off" : gizmo.mode; },
  set gizmo(mode: string) {
    if (!gizmo) {
      return;
    }
    gizmo.enabled = mode !== "off";
    gizmo.getHelper().visible = gizmo.enabled;
    if (mode !== "off") {
      gizmo.setMode(mode as "translate" | "rotate" | "scale");
    }
  },
  get show() { return showScan; },
  set show(v: boolean) {
    showScan = v;
    updateCollection();
  },
  get collide() { return (collider?.uniforms.enabled.value ?? 0) > 0.5; },
  set collide(v: boolean) { if (collider) collider.uniforms.enabled.value = v ? 1 : 0; },
  get friction() { return sim.uniforms.friction.value; },
  set friction(v: number) { sim.uniforms.friction.value = v; },
  get voxel() { return voxelCells; },
  set voxel(v: number) { voxelCells = v; },
  rebake: () => { void rebake(); },
  resetPose: () => {
    const rescaled = holder.scale.x !== initialPose.scale;
    holder.position.copy(initialPose.position);
    holder.quaternion.copy(initialPose.quaternion);
    holder.scale.setScalar(initialPose.scale);
    if (rescaled) {
      void rebake();
    }
  },
};
if (collider) {
  const sceneFolder = gui.addFolder("Scene");
  sceneFolder.add(sceneSettings, "gizmo", ["translate", "rotate", "scale", "off"]).name("gizmo (1/2/3)");
  sceneFolder.add(sceneSettings, "collide");
  sceneFolder.add(sceneSettings, "show").name("show scene");
  sceneFolder.add(sceneSettings, "friction", 0, 2, 0.01);
  sceneFolder.add(sceneSettings, "resetPose").name("reset pose");
  sceneFolder.add(sceneSettings, "voxel", 0.25, 4, 0.05).name("voxel (cells, bake)");
  sceneFolder.add(collider.settings, "minOpacity", 0, 1, 0.01).name("min opacity (bake)");
  sceneFolder.add(collider.settings, "threshold", 0.05, 4, 0.05).name("coverage (bake)");
  sceneFolder.add(collider.settings, "shell", 0.5, 3, 0.1).name("shell voxels (bake)");
  sceneFolder.add(collider.settings, "band", 2, 8, 1).name("band voxels (bake)");
  sceneFolder.add(sceneSettings, "rebake");
}

// GPU ms per phase, accumulated over the frames the profiler resolved: one
// accumulator for the status line (drained every STATUS_INTERVAL_MS), one
// for a running benchmark
interface GpuAccumulator { sums: Record<string, number>; frames: number }
const newAccumulator = (): GpuAccumulator => ({ sums: {}, frames: 0 });
let statusGpu = newAccumulator();
let benchGpu: GpuAccumulator | undefined;
let collecting = false;
function collectGpuProfile() {
  if (!profiler?.active || collecting) {
    return;
  }
  collecting = true;
  void profiler.collect().then((profile) => {
    if (!profile) {
      return;
    }
    for (const accumulator of [statusGpu, benchGpu]) {
      if (accumulator) {
        for (const [phase, ms] of Object.entries(profile.gpu)) {
          accumulator.sums[phase] = (accumulator.sums[phase] ?? 0) + ms * profile.frames;
        }
        accumulator.frames += profile.frames;
      }
    }
  }).catch((error) => console.error("GPU profile", error)).finally(() => { collecting = false; });
}
function averageGpu(accumulator: GpuAccumulator): GpuProfile & { total: number } {
  const gpu: Record<string, number> = {};
  let total = 0;
  for (const [phase, sum] of Object.entries(accumulator.sums)) {
    gpu[phase] = sum / accumulator.frames;
    total += gpu[phase];
  }
  return { gpu, cpu: {}, total, frames: accumulator.frames };
}

// Particle state summary: J range, fastest particle in cells per substep,
// non-finite particles, and settled-height percentiles (world y)
async function stats() {
  const p = await sim.pos.read(0, sim.count);
  const v = await sim.vel.read(0, sim.count);
  let jMin = Infinity;
  let jMax = -Infinity;
  let vMax = 0;
  let nan = 0;
  const ys: number[] = [];
  for (let i = 0; i < p.length; i += 4) {
    if (![p[i], p[i + 1], p[i + 2], p[i + 3], v[i], v[i + 1], v[i + 2]].every(Number.isFinite)) {
      nan++;
      continue;
    }
    jMin = Math.min(jMin, p[i + 3]);
    jMax = Math.max(jMax, p[i + 3]);
    vMax = Math.max(vMax, Math.hypot(v[i], v[i + 1], v[i + 2]));
    ys.push(sim.gridMin.y + p[i + 1] * sim.cellSize);
  }
  ys.sort((a, b) => a - b);
  const quantile = (q: number) => ys[Math.floor(q * (ys.length - 1))] ?? NaN;
  return {
    jMin, jMax, cellsPerSubstep: vMax * sim.uniforms.dt.value, nan, y10: quantile(0.1), y50: quantile(0.5),
  };
}

// CPU ms of sim.step() and the splats + render per frame while a benchmark runs
let bench: { frames: number; stepMs: number; renderMs: number } | undefined;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function benchmark({ warmup = 2, seconds = 5 }: { warmup?: number; seconds?: number } = {}) {
  settings.reset();
  settings.paused = false;
  await sleep(warmup * 1000);
  bench = { frames: 0, stepMs: 0, renderMs: 0 };
  benchGpu = profiler?.active ? newAccumulator() : undefined;
  const start = performance.now();
  await sleep(seconds * 1000);
  const elapsed = (performance.now() - start) / 1000;
  const measured = bench;
  bench = undefined;
  // Timestamps resolve a frame or two late
  await sleep(200);
  const gpu = benchGpu && benchGpu.frames > 0 ? averageGpu(benchGpu) : undefined;
  benchGpu = undefined;
  const result = {
    config: {
      particles: sim.count, E: sim.uniforms.E.value, dt: sim.uniforms.dt.value, substeps: sim.substeps,
      scene: !!scanObject && showScan, sceneSplats: sceneSplatCount,
    },
    fps: measured.frames / elapsed,
    stepMs: measured.stepMs / measured.frames,
    renderMs: measured.renderMs / measured.frames,
    gpu,
    stats: await stats(),
  };
  console.log("benchmark", result);
  return result;
}

// For console / Playwright driving, e.g. `await radixMpm.sim.pos.read(0, 8)`
const handle = {
  ready: false, webgpu: true,
  renderer, scene, camera, controls, sim, water, splats, scan, holder, collider, gizmo, boxLines, settings, profiler,
  rebake, stats, benchmark,
};
Object.assign(window, { radixMpm: handle });

// Frame loop: controls, one step of substeps, one render
const STATUS_INTERVAL_MS = 500;
let frames = 0;
let drawn = 0;
let lastStatus = performance.now();
let gpuLine = "";

renderer.setAnimationLoop(() => {
  profiler?.beginFrame();
  controls.update();
  boxLines.update(sim.walls);
  const t0 = performance.now();
  if (!settings.paused) {
    // A batched step is one pass: name it (split passes carry kernel labels)
    if (profiler && sim.batched) {
      profiler.phase("sim", () => sim.step());
    } else {
      sim.step();
    }
  }
  const t1 = performance.now();
  const draw = () => renderer.render(scene, camera);
  if (profiler) {
    profiler.phase("draw", draw);
  } else {
    draw();
  }
  if (bench) {
    bench.frames += 1;
    bench.stepMs += t1 - t0;
    bench.renderMs += performance.now() - t1;
  }
  collectGpuProfile();
  drawn += 1;
  handle.ready ||= drawn >= 5;

  frames += 1;
  const now = performance.now();
  if (now - lastStatus > STATUS_INTERVAL_MS) {
    if (!profiler?.active) {
      gpuLine = "";
    } else if (statusGpu.frames > 0) {
      gpuLine = `\n${GpuProfiler.format(averageGpu(statusGpu))}`;
    }
    statusGpu = newAccumulator();
    const fps = (frames * 1000) / (now - lastStatus);
    frames = 0;
    lastStatus = now;
    const { res } = sim;
    const simMsPerFrame = sim.uniforms.dt.value * sim.substeps * 1000;
    const bake = collider?.lastBake;
    const voxelCm = bake ? bake.voxelSize * holder.scale.x * 100 : 0;
    status.textContent = `${sim.count.toLocaleString()} particles | grid ${res.x}x${res.y}x${res.z} (${(sim.cellSize * 100).toFixed(1)} cm cells)`
      + ` | ${fps.toFixed(0)} fps | ${simMsPerFrame.toFixed(1)} sim ms/frame${settings.paused ? " (paused)" : ""}`
      + (scan ? `\nscan ${sceneName}: ${sceneSplatCount.toLocaleString()} splats${showScan ? "" : " (hidden)"}` : "")
      + (bake ? `\ncollider ${bake.dims.toArray().join("x")} (${voxelCm.toFixed(1)} cm voxels), baked in ${bake.ms.toFixed(0)} ms` : "")
      + (baking ? " (baking)" : "")
      + gpuLine;
  }
});
