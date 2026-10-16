// Quake on splats with Radix: the shareware maps baked into splats and
// hosted on GCS (read through data.ts), driven by the real game
// (quakegeneric in WASM in simWorker.ts): the camera follows the player's
// view, doors and platforms move, entities mirror the game every tick, light
// styles and dynamic lights light the splats, and the software frame's 2D
// layer (console, menus, status bar) is drawn over the world as splats.
// Without the sim (?sim=0) it is a free-fly viewer of one map.
//
// One SplatRenderer draws the world: the map's objects through the
// lighting's generator (lighting.ts) with the index lists a LodSelector
// picks (lod/), entities through the model atlas's
// generator (models.ts: MdlDeform, alias lighting), the particles; its
// collection is rebuilt when a selection lands or what is drawn changes. A
// second renderer in an overlay scene draws the frame (hud.ts). Both
// backends: WebGPU sorts on the GPU every frame; the WebGL2 fallback
// (?gpu=webgpu-gl, or ?sort=cpu on WebGPU) sorts on a worker: one view per
// renderer (viewKey), requestSort while entities animate (it runs after the
// sort in flight, so at the worker's pace), the next LoD
// selection only once the last one is drawn, and a cap on the LoD nodes kept
// on the GPU (world.ts residency, in the status line).
//
// Query parameters:
//   ?gpu=        webgpu | webgpu-gl
//   ?sort=       gpu | cpu (default gpu on WebGPU; ?gpusort=0 is cpu)
//   ?sim=0       free-fly viewer of ?map (default e1m1), no game
//   ?map=e1m1    start a game on that map (no map: the title and the demo
//                loop); ?warp= is an alias; ?skill=0-3
//   ?nosound     no audio
//   ?sensitivity=<n>  mouse scale (default 1)
//   ?lerp=0|1    pose / step-move interpolation (default on); ?animhz=N quantizes it
//   ?gunscale=<k>     view model scale toward the eye (default 1/3, 1 = off)
//   ?budget=     most splats drawn, entities included (default 2.5M with the GPU sort, 1.5M with the CPU sort)
//   ?lod=        finest weighted size (default 0.003; GUI "LoD")
//   ?foveate=0   distance-only LoD (default foveation, minDot 0.2)
//   ?guard=      objectParams.sortGuard (default 0: no guard band; the CPU sort only)
//   ?resident=   most LoD nodes on the GPU (default 24M on WebGL2, all on WebGPU)
//   ?flatten=<0..1>   splat look: 0 Gaussian, 1 flat discs (GUI "Splats")
//   ?timing=1    GPU timestamps per phase in the status line
//   ?dpr=        pixel ratio (default 1, no high DPI)
//   ?data=       the quake data folder (default dataBase("quake")); ?pak= the pak
// Measured on an Apple M3 Max (headless Chrome, 960 x 600, the exporter's
// merged chunks: 53-154 objects per map, 40-116 drawn at once):
// - WebGPU: e1m1 walking, 45 objects, 0.7-1.4M splats: GPU done 7 ms
//   after a frame starts (p95 9), loop CPU 1.2 ms (projection dispatches
//   0.55); the e1m3 demo, 116 objects (65 entities), 2.6M splats: loop CPU
//   1.8 ms, projection 1.2 ms; e1m4, 47M nodes resident: GPU done 9 ms.
// - WebGL2: e1m1 walking, 20 objects resident within 24M nodes, 1.26M
//   splats: an order lands 16 ms after its sort starts (p95 28; keys and
//   readback 12, worker 4), 60 fps; the e1m3 demo, 103 objects, 1.7M
//   splats (entities 1.1M of them, so the selection gets 500k): latency 32
//   ms (p95 45). Selections take 15-60 ms on the worker, 3-7 ms of uploads.
// `radixQuake` in the console: { ready, error, measure({ frames }), game,
// world, entities, selector, splatRenderer, camera, controls, lighting, hud }.
import * as THREE from "three";
import GUI from "lil-gui";
import { CameraControls, GpuProfiler, SplatCollection, SplatRenderer, createRenderer, getGpuCaps, type AnySplatObject, type GpuProfile, type SplatOrder } from "@sparkjsdev/radix";
import { dataBase } from "./data.js";
import { LodSelector } from "./lod/LodSelector.js";
import { EntityManager, lerpOptions, viewmodelOptions } from "./entities.js";
import { QuakeGame } from "./game.js";
import { LoadingPanel, QuakeHud, type FrameMode, type ViewRect } from "./hud.js";
import { QuakeLighting } from "./lighting.js";
import { ModelAtlas } from "./models.js";
import { Contents, INFO, bitsToFloat, readDlight } from "./sim/QuakeSim.js";
import { World } from "./world.js";

const HORIZONTAL_FOV = 90;
// Vanilla 4:3 display of the 320x240 frame (hud.ts letterboxes it the same way)
const DISPLAY_ASPECT = 4 / 3;
// Free-fly speed (m/s): half of Quake's running speed
const WALK_SPEED = 5;

const params = new URLSearchParams(location.search);
const status = document.getElementById("status")!;
const page: { ready: boolean; error?: string; [key: string]: unknown } = { ready: false };
(window as unknown as { radixQuake: typeof page }).radixQuake = page;

function fail(message: string) {
  page.error = message;
  status.className = "error";
  status.textContent = message;
  panel.fail(message);
}
addEventListener("unhandledrejection", (event) => fail(event.reason instanceof Error ? event.reason.message : String(event.reason)));

const panel = new LoadingPanel();
panel.show("Splat Quake");

const renderer = await createRenderer({ profile: params.get("timing") === "1" });
const webgpu = getGpuCaps(renderer).backend === "webgpu";
renderer.setPixelRatio(Number(params.get("dpr") ?? 1));
renderer.setSize(innerWidth, innerHeight);
document.body.prepend(renderer.domElement);
const profiler = renderer.inspector instanceof GpuProfiler && renderer.inspector.supported && webgpu ? renderer.inspector : undefined;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000000);
// Near 0.02 m: the view model scaled toward the eye keeps its grip inside
// Quake's own 4-unit near clip only if ours is closer; the sky is 5 km out
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.02, 20000);
camera.rotation.order = "YXZ";

const base = dataBase("quake");
const cpuSort = !webgpu || params.get("sort") === "cpu" || params.get("gpusort") === "0";
const sortMode = cpuSort ? "cpu" : "gpu";
const lighting = new QuakeLighting(renderer);
// Splats drawn at most: models have no LoD, so the selection gets what the
// entities leave (setBudget)
let budget = Number(params.get("budget") ?? (cpuSort ? 1_500_000 : 2_500_000));
const selector = new LodSelector({
  renderer,
  budget,
  sizeLimit: Number(params.get("lod") ?? 0.003),
  minDot: params.get("foveate") === "0" ? 1 : 0.2,
});
const residentNodes = Number(params.get("resident") ?? (webgpu ? Infinity : 24_000_000));
const splatRenderer = new SplatRenderer({ renderer, sortMode, viewKey: () => "main", objectParams: { sortGuard: Number(params.get("guard") ?? 0) } });
scene.add(splatRenderer);

// CPU ms of the projection dispatches and the sort, per frame
const phaseMs: Record<string, number> = {};
splatRenderer.phase = <T>(name: string, run: () => T): T => {
  const start = performance.now();
  try {
    return profiler ? profiler.phase(name, run) : run();
  } finally {
    phaseMs[name] = (phaseMs[name] ?? 0) + performance.now() - start;
  }
};

if (params.has("lerp")) {
  lerpOptions.lerp = params.get("lerp") !== "0";
}
if (params.has("animhz")) {
  lerpOptions.animHz = Number(params.get("animhz")) || 0;
}
if (params.has("gunscale")) {
  viewmodelOptions.depthScale = Math.max(0.1, Math.min(1, Number(params.get("gunscale")) || 1));
}

// --- The game, the model atlas, the HUD ---

const simEnabled = params.get("sim") !== "0";
let game: QuakeGame | undefined;
let entities: EntityManager | undefined;
let hud: QuakeHud | undefined;
let atlas: ModelAtlas | undefined;
try {
  if (simEnabled) {
    panel.step("Fetching pak0.pak and starting the simulation worker...", 0.05);
    game = await QuakeGame.create({ base, params, canvas: renderer.domElement, log: (message) => console.log(`[quake] ${message}`) });
    panel.step("Loading the model atlas...", 0.1);
    atlas = await ModelAtlas.load(`${base}models/models.json`, renderer, lighting);
    entities = new EntityManager(renderer, atlas);
    hud = new QuakeHud(game, renderer, sortMode);
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
  throw error;
}

// --- Camera: the player's view, or free fly ---

const controls = new CameraControls({ canvas: renderer.domElement, object: camera, storageKey: "radix-quake", settings: { mode: "fly", moveSpeed: WALK_SPEED } });
const freeLook = new THREE.Euler(0, 0, 0, "YXZ");
if (game) {
  game.onFreeLook = (dx, dy) => {
    freeLook.setFromQuaternion(camera.quaternion, "YXZ");
    freeLook.y -= dx * 0.004;
    freeLook.x = Math.max(-1.55, Math.min(1.55, freeLook.x - dy * 0.004));
    freeLook.z = 0;
    camera.quaternion.setFromEuler(freeLook);
  };
}

// The software renderer's 3D view inside the 320x240 frame (scr_vrect) and
// its horizontal fov; viewsize 100 until the sim reports its own
const viewRect: ViewRect = { x: 0, y: 0, width: 320, height: 192, fovX: HORIZONTAL_FOV };

// Match the camera to the software frame: the frame is letterboxed 4:3
// into the viewport, the engine projects `fovX` across the view rect's width
// with square pixels (CalcFov), and the view rect's center is the optical
// axis. The view rect as displayed is the camera's "full image" and the
// viewport an off-center window onto it, so a world direction lands on the
// same pixel in both renderers at any window size. Without the sim: 90
// degrees across the viewport.
function updateCameraProjection() {
  const W = innerWidth;
  const H = Math.max(1, innerHeight);
  if (!game) {
    camera.clearViewOffset();
    camera.aspect = W / H;
    camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(HORIZONTAL_FOV / 2)) / camera.aspect));
    camera.updateProjectionMatrix();
    return;
  }
  if (game.inLevel) {
    const info = game.curr.info;
    if (info[INFO.VIEW_W] > 0 && info[INFO.VIEW_H] > 0) {
      Object.assign(viewRect, { x: info[INFO.VIEW_X], y: info[INFO.VIEW_Y], width: info[INFO.VIEW_W], height: info[INFO.VIEW_H] });
    }
    const fov = bitsToFloat(info[INFO.FOV]);
    if (fov >= 10 && fov <= 170) {
      viewRect.fovX = fov;
    }
  }
  const { x: vx, y: vy, width: vw, height: vh, fovX } = viewRect;
  let w = W;
  let h = w / DISPLAY_ASPECT;
  if (h > H) {
    h = H;
    w = h * DISPLAY_ASPECT;
  }
  const x0 = (W - w) / 2;
  const y0 = (H - h) / 2;
  const sx = w / game.width;
  const sy = h / game.height;
  camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan((vh / vw) * Math.tan(THREE.MathUtils.degToRad(fovX / 2))));
  camera.aspect = vw / vh;
  camera.setViewOffset(vw * sx, vh * sy, -(x0 + vx * sx), -(y0 + vy * sy), W, H);
  camera.updateProjectionMatrix();
}
updateCameraProjection();
addEventListener("resize", () => {
  renderer.setSize(innerWidth, innerHeight);
  updateCameraProjection();
});

// --- The world: one map at a time ---

let world: World | undefined;
let switching = false;
let currentMap: string | undefined;

// Collections: rebuilt when a selection lands or what is drawn changes.
// Each gets a number, so the CPU sort's shown order tells whether the
// latest selection is on screen yet
let dirty = true;
let built = 0;
let lodBuilt = 0;
const builtAt = new WeakMap<SplatCollection, number>();
let lastObjects: AnySplatObject[] = [];
selector.onSelect = () => {
  dirty = true;
  lodBuilt = built + 1;
};

function rebuild() {
  const objects = [...(world?.splatObjects() ?? []), ...(entities?.objects() ?? []), ...(hud?.frameSplats.worldObject ? [hud.frameSplats.worldObject] : [])];
  dirty = false;
  if (objects.length === lastObjects.length && objects.every((object, i) => object === lastObjects[i])) {
    return;
  }
  lastObjects = objects;
  setBudget(objects);
  const collection = new SplatCollection(objects);
  builtAt.set(collection, (built += 1));
  splatRenderer.collection = collection;
}

// The selection's budget: the total less the entities' splats, in steps of
// 250k (a new budget selects again), at least a third of the total
function setBudget(objects: AnySplatObject[]) {
  const generator = lighting.generator as unknown;
  const models = objects.reduce((sum, object) => sum + (object.generator === generator ? 0 : object.count), 0);
  selector.budget = Math.max(Math.round(budget / 3), budget - Math.ceil(models / 250_000) * 250_000);
}

// Whether the latest selection is drawn (the CPU sort: an order of a
// collection that has it landed), so the next may start
function lodShown() {
  if (splatRenderer.sortMode === "gpu") {
    return true;
  }
  const order = splatRenderer.views.get("main")?.order;
  return order ? (builtAt.get(order.collection) ?? 0) >= lodBuilt : splatRenderer.collection.count === 0;
}

function sceneUrl(map: string) {
  return `${base}${map}/scene.json`;
}

// Switches to `map`, holding the game until its splats are on screen
async function switchMap(map: string) {
  switching = true;
  game?.pause(true);
  panel.show(`Loading ${map.toUpperCase()}`);
  try {
    world?.dispose();
    world = undefined;
    entities?.clear();
    dirty = true;
    rebuild();
    const next = await World.load(sceneUrl(map), {
      renderer, selector, lighting, residentNodes,
      onProgress: (loaded, total) => panel.step(`Loading objects ${loaded}/${total}`, 0.15 + 0.75 * (loaded / total)),
    });
    world = next;
    const { file } = next;
    camera.far = Math.max(1000, file.skyRadius * 4);
    updateCameraProjection();
    lighting.unitsPerMeter = file.unitsPerMeter;
    lighting.setLut(file.lightLut);
    lighting.setSky(file.skyRgba);
    if (!game?.follow || !game.inLevel) {
      camera.position.fromArray(file.player.position);
      camera.rotation.set(0, THREE.MathUtils.degToRad(file.player.yaw - 90), 0, "YXZ");
    } else {
      game.applyCamera(camera, 1, file.unitsPerMeter);
    }
    camera.updateMatrixWorld();
    panel.step("Selecting detail...", 0.95);
    world.update(game, 1);
    selector.update(camera, { force: true });
    await selector.settle();
    rebuild();
    // On the CPU sort, wait for the first order of it
    for (let frames = 0; !lodShown() && frames < 600; frames += 1) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    panel.hide();
  } catch (error) {
    fail(`Could not load ${map}: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    switching = false;
    game?.pause(false);
  }
}

// Level changes follow the game's world model
function updateLevel() {
  const map = game ? game.mapId : params.get("map") ?? params.get("level") ?? "e1m1";
  if (map && map !== currentMap && !switching) {
    currentMap = map;
    void switchMap(map);
  }
}

// --- Lighting and entities from the sim, per frame ---

const dlights: { x: number; y: number; z: number; radius: number }[] = [];
function updateLighting() {
  if (game?.inLevel && world) {
    const { curr } = game;
    lighting.setStyles(curr.lightstyles);
    dlights.length = 0;
    const s = 1 / world.file.unitsPerMeter;
    for (let i = 0; i < curr.dlightCount; i += 1) {
      const light = readDlight(curr, i);
      dlights.push({ x: light.x * s, y: light.z * s, z: -light.y * s, radius: light.radius });
    }
    lighting.setDlights(dlights);
    lighting.time = game.time;
    // r_waterwarp: the player's view leaf is liquid, while the camera is that view
    const contents = curr.info[INFO.VIEWLEAF_CONTENTS];
    lighting.underwater = game.follow && contents <= Contents.WATER && contents >= Contents.LAVA;
  } else {
    lighting.setDlights([]);
    lighting.time = performance.now() / 1000;
    lighting.underwater = false;
  }
  lighting.update(camera);
}

// The pose the frame screen and the weapon hang from in free fly: the
// camera's pose when following ended
let frozenView: THREE.Matrix4 | undefined;
function updateFreeFly() {
  const freeFly = !!game && !game.follow && game.inLevel && !!world;
  if (!freeFly) {
    frozenView = undefined;
  } else if (!frozenView) {
    camera.updateMatrixWorld();
    frozenView = camera.matrixWorld.clone();
  }
}

// --- Panel ---

const splatOptions = { flatten: Math.max(0, Math.min(1, Number(params.get("flatten") ?? 0))) };
function applyFlatten() {
  for (const each of [splatRenderer, hud?.frameSplats.splats]) {
    if (each) {
      each.params.maxStdDev = Math.sqrt(8) - (Math.sqrt(8) - 1) * splatOptions.flatten;
      each.params.falloff = 1 - splatOptions.flatten;
    }
  }
}
applyFlatten();

const gui = new GUI({ title: "Quake" });
gui.close();
const lodFolder = gui.addFolder("LoD");
const lodSettings = { budget, detail: Math.log10(selector.sizeLimit), foveation: selector.minDot < 1, guard: splatRenderer.objectParams.sortGuard, sort: splatRenderer.sortMode };
lodFolder.add(lodSettings, "budget", 100_000, 8_000_000, 100_000).name("splat budget").onChange((value: number) => {
  budget = value;
  setBudget(lastObjects);
});
lodFolder.add(lodSettings, "detail", -3.5, -1.5, 0.05).name("finest size (log10)").onChange((value: number) => (selector.sizeLimit = 10 ** value));
lodFolder.add(lodSettings, "foveation").onChange((on: boolean) => (selector.minDot = on ? 0.2 : 1));
lodFolder.add(lodSettings, "guard", 0, 2, 0.05).name("sort guard (CPU sort)").onChange((value: number) => (splatRenderer.objectParams.sortGuard = value));
const sortControl = lodFolder.add(lodSettings, "sort", ["gpu", "cpu"]).onChange((mode: "gpu" | "cpu") => {
  splatRenderer.sortMode = mode;
  if (hud) {
    hud.frameSplats.splats.sortMode = mode;
  }
});
if (!webgpu) {
  sortControl.disable();
}
const lightingFolder = gui.addFolder("Lighting");
lightingFolder.add(lighting.options, "enabled");
lightingFolder.add(lighting.options, "quantize");
lightingFolder.add(lighting.options, "dlights");
lightingFolder.add(lighting.options, "styles").name("light styles");
lightingFolder.add(lighting.options, "effects").name("sky scroll, liquids");
lightingFolder.add(lighting.options, "waterWarp").name("underwater warp");
const modelsFolder = gui.addFolder("Models");
modelsFolder.add(lerpOptions, "lerp").name("frame lerp");
modelsFolder.add(lerpOptions, "animHz", 0, 72, 1).name("lerp steps/s (0 = smooth)");
modelsFolder.add(lerpOptions, "lerpMove").name("step-move lerp");
modelsFolder.add(viewmodelOptions, "depthScale", 0.1, 1, 0.01).name("weapon depth scale (1 = off)");
gui.addFolder("Splats").add(splatOptions, "flatten", 0, 1, 0.01).name("flatten (?flatten=)").onChange(applyFlatten);
if (game && hud) {
  const g = game;
  const h = hud;
  const gameFolder = gui.addFolder("Game");
  gameFolder.add({ get paused() { return g.userPaused; }, set paused(v: boolean) { g.setUserPaused(v); } }, "paused").name("paused (\\)").listen();
  gameFolder.add({ get overlay() { return h.frameMode; }, set overlay(mode: FrameMode) { h.frameMode = mode; } }, "overlay", ["splats", "canvas", "off"]).name("overlay (console, HUD)");
  gameFolder.add(h, "showWeapon").name("weapon");
  gameFolder.add({ get vanilla() { return h.vanilla; }, set vanilla(on: boolean) { h.vanilla = on; } }, "vanilla").name("vanilla frame (compare)");
}

// --- Measurement ---

interface Sample {
  frameMs: number[];
  loopMs: number[];
  doneMs: number[];
  project: number[];
  splats: number[];
  objects: number[];
  orders: { keysMs: number; sortMs: number; visible: number; count: number }[];
  selections: { workerMs: number; roundTripMs: number; uploadMs: number; total: number; changed: number }[];
}
let sampling: { sample: Sample; frames: number; done: () => void } | undefined;

// When the GPU has finished the work submitted so far: WebGPU's queue, or a
// WebGL2 finish (measurements only)
const backend = renderer.backend as unknown as { device?: GPUDevice; gl?: WebGL2RenderingContext };
function gpuDone(): Promise<void> {
  if (backend.device) {
    return backend.device.queue.onSubmittedWorkDone();
  }
  backend.gl?.finish();
  return Promise.resolve();
}

const stats = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mean = values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  return { mean: +mean.toFixed(2), p50: +at(0.5).toFixed(2), p95: +at(0.95).toFixed(2), max: +(sorted[sorted.length - 1] ?? 0).toFixed(2) };
};

// Frame, projection and sort timings over the next `frames` frames (doneMs:
// from a frame's start to the GPU finishing it, whatever the display's rate)
async function measure({ frames = 120 }: { frames?: number } = {}) {
  const sample: Sample = { frameMs: [], loopMs: [], doneMs: [], project: [], splats: [], objects: [], orders: [], selections: [] };
  await new Promise<void>((done) => (sampling = { sample, frames, done }));
  return {
    backend: webgpu ? "webgpu" : "webgl2",
    sortMode: splatRenderer.sortMode,
    map: world?.file.map,
    worldObjects: world?.objects.length,
    nodes: world?.nodes,
    residentNodes: world?.resident,
    budget,
    lodBudget: selector.budget,
    sizeLimit: selector.sizeLimit,
    entities: entities?.count,
    pixels: [renderer.domElement.width, renderer.domElement.height],
    frames: sample.frameMs.length,
    objects: stats(sample.objects),
    splats: stats(sample.splats),
    frameMs: stats(sample.frameMs),
    doneMs: stats(sample.doneMs),
    loopCpuMs: stats(sample.loopMs),
    projectCpuMs: stats(sample.project),
    lod: sample.selections.length > 0 ? {
      selections: sample.selections.length,
      workerMs: stats(sample.selections.map((each) => each.workerMs)),
      roundTripMs: stats(sample.selections.map((each) => each.roundTripMs)),
      uploadMs: stats(sample.selections.map((each) => each.uploadMs)),
      total: stats(sample.selections.map((each) => each.total)),
      listsChanged: stats(sample.selections.map((each) => each.changed)),
    } : undefined,
    cpuSort: sample.orders.length > 0 ? {
      sorts: sample.orders.length,
      keysAndReadbackMs: stats(sample.orders.map((o) => o.keysMs)),
      workerSortMs: stats(sample.orders.map((o) => o.sortMs)),
      latencyMs: stats(sample.orders.map((o) => o.keysMs + o.sortMs)),
      sorted: stats(sample.orders.map((o) => o.count)),
      kept: stats(sample.orders.map((o) => o.visible)),
    } : undefined,
  };
}

Object.assign(page, { measure, selector, splatRenderer, camera, controls, lighting, renderer });
Object.defineProperties(page, {
  game: { get: () => game },
  world: { get: () => world },
  entities: { get: () => entities },
  hud: { get: () => hud },
});

// --- The loop ---

let last = performance.now();
let frameTimes: number[] = [];
let drawnFrames = 0;
let lastOrder = 0;
let lastSelections = 0;
let visible = 0;
let countingVisible = false;
let gpuLine = "";
let statusAt = 0;
renderer.setAnimationLoop((now) => {
  const loopStart = performance.now();
  const frameMs = now - last;
  last = now;

  let alpha = 1;
  if (game) {
    game.update();
    alpha = game.paused ? 1 : game.alpha(now);
  }
  updateLevel();
  const following = !!game && game.follow && game.inLevel && !!world;
  controls.enabled = !following;
  controls.update();
  if (following && world) {
    game!.applyCamera(camera, alpha, world.file.unitsPerMeter);
  }
  if (game) {
    updateCameraProjection();
    updateFreeFly();
  }
  camera.updateMatrixWorld();

  if (world && !switching) {
    dirty = world.update(game, alpha) || dirty;
    world.residency(camera);
  }
  if (entities && game) {
    if (game.inLevel && world) {
      entities.setViewPose(frozenView ?? camera.matrixWorld, !!frozenView);
      entities.showViewmodel = hud?.showWeapon ?? true;
      entities.update(game.prev, game.curr, alpha, camera, now);
    } else {
      entities.clear();
    }
    dirty = true;
  }
  updateLighting();
  hud?.update(camera, frozenView, viewRect);
  if (dirty) {
    rebuild();
  }
  if (world && !switching && lodShown()) {
    selector.update(camera);
  }
  // The CPU sort cannot see poses, particles, liquids or the warp move
  if (splatRenderer.sortMode === "cpu" && game?.playing && (entities?.animating || lighting.underwater)) {
    splatRenderer.requestSort();
  }

  phaseMs.project = 0;
  phaseMs.sort = 0;
  profiler?.beginFrame();
  if (profiler) {
    profiler.label = "draw";
  }
  renderer.render(scene, camera);
  hud?.frameSplats.render(renderer);
  if (profiler) {
    void profiler.collect().then((report?: GpuProfile) => {
      if (report && report.frames > 0) {
        gpuLine = GpuProfiler.format(report);
      }
    });
  }

  const order = splatRenderer.views.get("main")?.order;
  const count = splatRenderer.collection.count;
  const drawing = count > 0 && (splatRenderer.sortMode === "gpu" || order !== undefined);
  drawnFrames = drawing && !switching ? drawnFrames + 1 : drawnFrames;
  if (!page.ready && world && !switching && drawnFrames >= 3 && (!game || (game.curr.tick > 0 && (game.inLevel || !params.has("map"))))) {
    page.ready = true;
  }

  if (sampling) {
    const { sample } = sampling;
    sample.frameMs.push(frameMs);
    sample.loopMs.push(performance.now() - loopStart);
    void gpuDone().then(() => sample.doneMs.push(performance.now() - loopStart));
    if (selector.stats.selections !== lastSelections) {
      sample.selections.push({ ...selector.stats });
    }
    sample.project.push(phaseMs.project);
    sample.splats.push(count);
    sample.objects.push(splatRenderer.collection.objects.length);
    if (order && order.version !== lastOrder) {
      sample.orders.push({ keysMs: order.keysMs, sortMs: order.sortMs, visible: order.visible, count: order.collection.count });
    }
    if (sample.frameMs.length >= sampling.frames) {
      const done = sampling.done;
      sampling = undefined;
      done();
    }
  }
  lastOrder = order?.version ?? lastOrder;
  lastSelections = selector.stats.selections;

  frameTimes.push(frameMs);
  if (now - statusAt > 500) {
    statusAt = now;
    const mean = frameTimes.reduce((sum, value) => sum + value, 0) / Math.max(1, frameTimes.length);
    frameTimes = [];
    if (splatRenderer.sortMode === "gpu" && !countingVisible) {
      countingVisible = true;
      void splatRenderer.readSortedCount().then((n) => {
        visible = n;
        countingVisible = false;
      });
    }
    status.textContent = describe(mean, order);
  }
});

function describe(mean: number, order: SplatOrder | undefined) {
  const lines: string[] = [];
  const s = selector.stats;
  if (world) {
    const residency = world.limited
      ? `, ${(world.resident / 1e6).toFixed(1)}M of ${(world.nodes / 1e6).toFixed(1)}M LoD nodes on the GPU (${(world.resident * 32 / 1e9).toFixed(2)} GB; WebGL2 cap ?resident=${residentNodes.toLocaleString()}: farther objects load as you come near)`
      : `, ${(world.nodes / 1e6).toFixed(1)}M LoD nodes on the GPU (${(world.nodes * 32 / 1e9).toFixed(2)} GB)`;
    lines.push(`${world.file.map} "${world.file.title}": ${world.objects.length} objects${residency}`);
  } else {
    lines.push(switching ? "Loading..." : "No map loaded");
  }
  lines.push(`drawing ${splatRenderer.collection.count.toLocaleString()} splats in ${splatRenderer.collection.objects.length} objects (${entities?.count ?? 0} entities); budget ${budget.toLocaleString()} (LoD ${selector.budget.toLocaleString()}), finest ${selector.sizeLimit.toPrecision(2)}, foveation ${selector.minDot < 1 ? "on" : "off"}; selection ${s.workerMs.toFixed(1)} ms worker, ${s.uploadMs.toFixed(1)} ms upload`);
  const sortLine = splatRenderer.sortMode === "gpu"
    ? `GPU sort: ${visible.toLocaleString()} in view`
    : order ? `CPU sort: keys + readback ${order.keysMs.toFixed(1)} ms, worker ${order.sortMs.toFixed(1)} ms, ${order.visible.toLocaleString()} of ${order.collection.count.toLocaleString()} kept (guard ${splatRenderer.objectParams.sortGuard})` : "CPU sort: waiting for the first order";
  lines.push(`${webgpu ? "WebGPU" : "WebGL2"}, ${sortLine}`);
  if (game) {
    const { curr } = game;
    const pause = game.holdPaused ? " (held for loading)" : game.userPaused ? " (paused)" : "";
    lines.push(`sim: tick ${curr.tick}, ${game.ticksPerSecond} ticks/s${pause}, ${game.connected ? (game.intermission ? "intermission" : "level") : "title"}${game.mapId ? ` ${game.mapId}` : ""}${game.demoPlayback ? " demo" : ""}, ${curr.entityCount} entities, ${curr.dlightCount} dlights, ${curr.particleCount} particles, ${game.follow ? "following the view" : "free fly"}`);
  }
  lines.push(`frame ${mean.toFixed(1)} ms (${(1000 / mean).toFixed(0)} fps), project ${phaseMs.project.toFixed(2)} ms CPU${gpuLine ? `; ${gpuLine}` : ""}`);
  lines.push(game?.playing ? "WASD/arrows, mouse look, Ctrl/LMB fire, Space jump, ` console; \\ pauses (free fly), Esc releases the mouse and opens the menu" : "WASD/arrows move, drag to look, Q/E down/up, Shift faster");
  return lines.join("\n");
}
