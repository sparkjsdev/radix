// Doom on splats, on Radix: the levels and sprites baked into splats and
// hosted on GCS (read through data.ts),
// driven by the real game (doomgeneric in WASM in a module worker,
// simWorker.ts): the camera follows the player, doors and lifts move (mover
// objects' live matrices), things mirror the mobjs (sprite-atlas objects),
// sectors light the splats inside the generators (lighting.ts), and the
// software frame's 2D layer (menus, status bar, messages) is drawn over the
// world by a second renderer (hud.ts). One SplatRenderer draws the world:
// the level objects' LoD lists (lod/LodSelector.ts), one object
// of every thing and, in free fly, the HUD's screen and weapon; a new
// collection whenever the lists or the things' views change. Without the
// sim it is a free-fly viewer of one level.
//
// Both backends: WebGPU sorts on the GPU every frame; the WebGL2 fallback
// (?gpu=webgpu-gl) sorts each view on a worker (autoSort, no sort guard,
// requestSort when things move), shows a collection once a sort of it
// lands, and selects LoD again only once the newest lists are drawn.
// Measured on an Apple M3 Max (headless Chrome, 1280 x 720, pixel ratio 1,
// radixDoom.measure() while walking and turning):
// - WebGPU (budget 3M): 60 fps on every level tried (E1M1, E1M2, E1M5,
//   E1M6, E1M8); loop CPU 1-2.3 ms, 0.4-1.1 ms of it the 26-81 projection
//   dispatches; LoD selections 35-55 ms on the worker.
// - WebGL2 (budget 1.5M): 60 fps; loop CPU 2-7 ms (p95 4-16); an order
//   lands 30-45 ms (p95 40-57) after its sort starts (keys pass + readback
//   20-37 ms, worker sort 7-9 ms); selections that hit the budget take
//   130-220 ms on the worker, so LoD trails the camera at about 5 Hz.
// - Drawing every thing as its own object (369 on E1M6) took a WebGL2 frame
//   to 32 ms (loop CPU 22 ms), hence the one batch object.
//
// Query parameters:
//   ?gpu=        webgpu | webgpu-gl
//   ?sort=       gpu | cpu (default gpu on WebGPU; ?gpusort=0 means cpu)
//   ?sim=0       free-fly viewer of ?level (default e1m1), no game
//   ?level=      the level the viewer shows first
//   ?warp=E,M    start in that map (default: title screen and demo loop)
//   ?skill=N ?nosound ?nomusic   game arguments
//   ?sensitivity= mouse scale for turning and free look (default 2)
//   ?budget=     most splats selected (default 2.5M with the GPU sort, 1.5M
//                with the CPU sort)
//   ?lod=        finest weighted size, size * max(cos, minDot) / distance
//                (default 0.002)
//   ?foveate=0   distance-only LoD (minDot 1; default 0.2)
//   ?guard=      objectParams.sortGuard (default 0: no guard band; CPU sort only)
//   ?flatten=    0..1 splat look: 0 Gaussian to 2.5 std devs, 1 flat discs
//   ?dpr=        pixel ratio (default 1)
//   ?timing=1    GPU timestamps (WebGPU) in the status line
//   ?data=       the doom data folder (default dataBase("doom"))
// `radixDoom` in the console: { ready, error, measure({ frames }), game,
// camera, controls, splatRenderer, hud, selector, lighting, level }.
import * as THREE from "three";
import GUI from "lil-gui";
import { CameraControls, GpuProfiler, SplatCollection, SplatRenderer, createRenderer, getGpuCaps, type AnySplatObject, type GpuProfile } from "@sparkjsdev/radix";
import { dataBase } from "./data.js";
import { LodSelector } from "./lod/LodSelector.js";
import { DoomGame } from "./game.js";
import { DoomHud, LoadingPanel, type ViewRect } from "./hud.js";
import { Level, LevelLoader } from "./level.js";
import { DoomLighting } from "./lighting.js";
import { GameState, INFO, PLAYER, SECTOR } from "./sim/DoomSim.js";
import { SpriteAtlas, ThingManager, spriteOptions } from "./things.js";

// Free-fly speed (m/s): half of Doom's walking speed
const WALK_SPEED = 4.5;
const DISPLAY_ASPECT = 4 / 3;
const TAN_HALF_FOV = 1;

const params = new URLSearchParams(location.search);
const status = document.getElementById("status")!;
const page: { ready: boolean; error?: string; [key: string]: unknown } = { ready: false };
(window as unknown as { radixDoom: typeof page }).radixDoom = page;
const panel = new LoadingPanel();

function fail(message: string) {
  page.error = message;
  panel.fail(message);
  status.textContent = message;
  console.error(message);
}

addEventListener("unhandledrejection", (event) => fail(event.reason instanceof Error ? event.reason.message : String(event.reason)));

const renderer = await createRenderer({ profile: params.get("timing") === "1" || params.get("profile") === "1" });
const webgpu = getGpuCaps(renderer).backend === "webgpu";
renderer.setPixelRatio(Number(params.get("dpr") ?? 1));
renderer.setSize(innerWidth, innerHeight);
renderer.setClearColor(0x000000);
document.body.prepend(renderer.domElement);
const profiler = webgpu && renderer.inspector instanceof GpuProfiler && renderer.inspector.supported ? renderer.inspector : undefined;

const cpuSort = !webgpu || params.get("sort") === "cpu" || params.get("gpusort") === "0";
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.05, 20000);
camera.rotation.order = "YXZ";
const base = dataBase("doom");
const simEnabled = params.get("sim") !== "0";
panel.show("Splat Doom");

// --- Rendering: lighting, LoD, the world renderer ---

const lighting = new DoomLighting(renderer);
const selector = new LodSelector({
  renderer,
  budget: Number(params.get("budget") ?? (cpuSort ? 1_500_000 : 2_500_000)),
  sizeLimit: Number(params.get("lod") ?? 0.002),
  minDot: params.get("foveate") === "0" ? 1 : 0.2,
});
const flatten = Math.max(0, Math.min(1, Number(params.get("flatten") ?? 0)));
const splatRenderer = new SplatRenderer({
  renderer,
  sortMode: cpuSort ? "cpu" : "gpu",
  objectParams: { sortGuard: Number(params.get("guard") ?? 0) },
  params: { maxStdDev: 2.5 - 1.5 * flatten, falloff: 1 - flatten },
});
scene.add(splatRenderer);
const phaseMs: Record<string, number> = {};
splatRenderer.phase = <T>(name: string, run: () => T): T => {
  const start = performance.now();
  try {
    return profiler ? profiler.phase(name, run) : run();
  } finally {
    phaseMs[name] = (phaseMs[name] ?? 0) + performance.now() - start;
  }
};

const controls = new CameraControls({ canvas: renderer.domElement, object: camera, storageKey: "radix-doom", settings: { mode: "fly", moveSpeed: WALK_SPEED } });

// --- The game (sim worker), sprites, HUD ---

let game: DoomGame | undefined;
let atlas: SpriteAtlas;
try {
  if (simEnabled) {
    panel.step("Fetching doom1.wad and starting the simulation worker...", 0.05);
    game = await DoomGame.create({ base, params, canvas: renderer.domElement, log: (message) => console.log(`[doom] ${message}`) });
    game.onFreeLook = (dx, dy) => {
      camera.rotation.y -= dx * 0.003;
      camera.rotation.x = Math.max(-1.5, Math.min(1.5, camera.rotation.x - dy * 0.003));
    };
  }
  panel.step("Loading the sprite atlas...", 0.1);
  atlas = await SpriteAtlas.load(`${base}sprites/sprites.json`, renderer);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
  throw error;
}
const things = new ThingManager(atlas, lighting, renderer);
const hud = game ? new DoomHud(game, renderer, lighting, atlas, splatRenderer.sortMode) : undefined;
if (hud) {
  hud.splatRenderer.params.maxStdDev = splatRenderer.params.maxStdDev;
  hud.splatRenderer.params.falloff = splatRenderer.params.falloff;
}

// --- Camera projection: the 4:3 frame letterboxed into the viewport, 90
// degrees across the engine's view window (INFO.VIEW_*), the window's center
// on the axis, so the vanilla frame lines up at any window size ---

const viewRect: ViewRect = { x: 0, y: 0, width: 320, height: 168 };
function updateProjection() {
  const W = innerWidth;
  const H = Math.max(1, innerHeight);
  if (!game) {
    camera.clearViewOffset();
    camera.aspect = W / H;
    camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(TAN_HALF_FOV / camera.aspect));
    camera.updateProjectionMatrix();
    return;
  }
  const info = game.curr.info;
  if (game.inLevel && info[INFO.VIEW_W] > 0 && info[INFO.VIEW_H] > 0) {
    Object.assign(viewRect, { x: info[INFO.VIEW_X], y: info[INFO.VIEW_Y], width: info[INFO.VIEW_W], height: info[INFO.VIEW_H] });
  }
  const { x: vx, y: vy, width: vw, height: vh } = viewRect;
  let w = W;
  let h = w / DISPLAY_ASPECT;
  if (h > H) {
    h = H;
    w = h * DISPLAY_ASPECT;
  }
  const sx = w / game.width;
  const sy = h / game.height;
  camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan((vh / vw) * TAN_HALF_FOV));
  camera.aspect = vw / vh;
  camera.setViewOffset(vw * sx, vh * sy, -((W - w) / 2 + vx * sx), -((H - h) / 2 + vy * sy), W, H);
  camera.updateProjectionMatrix();
}
updateProjection();
addEventListener("resize", () => {
  renderer.setSize(innerWidth, innerHeight);
  updateProjection();
});

// --- Levels: switching, prefetch, the collection ---

const loader = new LevelLoader();
let level: Level | undefined;
let switching = false;
let currentMap: string | undefined;
let demoIndex = -1;
let lodSerial = 0;
let dirty = true;
const serials = new WeakMap<SplatCollection, number>();

const levelUrl = (map: string) => `${base}${map}/scene.json`;
selector.onSelect = () => {
  lodSerial += 1;
  dirty = true;
};
loader.onProgress = ({ url, loaded, total }) => {
  if (switching && url === switchingUrl) {
    panel.step(`Decoding objects ${loaded}/${total}`, 0.1 + 0.4 * (loaded / total));
  }
};

// With the CPU sort, select again only once the newest lists are drawn (a
// sort of a collection holding them landed), so lists never pile up behind
// the sort
function lodShown() {
  const view = splatRenderer.views.get(camera);
  return splatRenderer.sortMode === "gpu" || !view || splatRenderer.collection.count === 0 || serials.get(view.order?.collection ?? SplatCollection.EMPTY) === lodSerial;
}

let switchingUrl: string | undefined;
async function switchLevel(url: string, label: string) {
  switching = true;
  switchingUrl = url;
  game?.pause(true);
  panel.show(`Loading ${label}`);
  panel.step(loader.pendingUrl === url ? "Waiting for the decoded level..." : "Fetching scene.json...", 0.05);
  try {
    const started = performance.now();
    const decoded = await loader.take(url);
    const decodedAt = performance.now();
    level?.dispose();
    things.clear();
    const next = new Level(decoded, lighting, selector);
    level = next;
    dirty = true;
    const { file } = decoded;
    lighting.unitsPerMeter = file.unitsPerMeter;
    lighting.setLut(file.lightLut, file.lightLutInverse);
    lighting.setSectorLights(file.sectors.map((s) => s.light));
    if (!game) {
      things.setStatic(file.things);
    }
    if (!game?.inLevel) {
      camera.position.fromArray(file.player.position);
      camera.rotation.set(0, file.player.yaw, 0, "YXZ");
    } else {
      game.applyCamera(camera, 1, file.unitsPerMeter);
    }
    await next.upload(decoded, renderer, (done, total) => panel.step(`Uploading to the GPU ${done}/${total}`, 0.5 + 0.4 * (done / total)));
    panel.step("Selecting detail...", 0.95);
    while (!selector.update(camera, { force: true })) {
      await nextFrame();
    }
    await selector.settle();
    dirty = true;
    // Shown: the GPU sort draws it next frame, the CPU sort once its order lands
    for (let frames = 0; frames < 600 && !lodShown(); frames += 1) {
      await nextFrame();
    }
    console.log(`[doom] ${label}: ${file.objects.length} objects, ${next.resident.toLocaleString()} splats; decode wait ${((decodedAt - started) / 1000).toFixed(1)} s, upload and first selection ${((performance.now() - decodedAt) / 1000).toFixed(1)} s`);
    panel.hide();
  } catch (error) {
    fail(`Could not load ${label}: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    game?.pause(false);
    switching = false;
    switchingUrl = undefined;
  }
}

function nextFrame() {
  return new Promise<void>((done) => requestAnimationFrame(() => done()));
}

// The map the game most likely enters next, for prefetching
function nextMapHint(): string | undefined {
  if (!game) {
    return undefined;
  }
  if (game.gameState === GameState.Intermission) {
    return game.nextMap;
  }
  if (game.gameState === GameState.DemoScreen || (game.gameState === GameState.Level && game.demoPlayback)) {
    return game.demoMaps.length > 0 ? game.demoMaps[(demoIndex + 1) % game.demoMaps.length] : undefined;
  }
  const match = game.gameState === GameState.Level && currentMap ? /^e(\d+)m(\d+)$/.exec(currentMap) : null;
  if (!match) {
    return undefined;
  }
  const map = Number(match[2]);
  return map === 9 ? `e${match[1]}m4` : map >= 8 ? undefined : `e${match[1]}m${map + 1}`;
}

function updateLevelState() {
  if (!game || switching) {
    return;
  }
  const map = game.mapId;
  if (map && map !== currentMap) {
    currentMap = map;
    if (game.demoPlayback) {
      const index = game.demoMaps.indexOf(map, demoIndex + 1);
      demoIndex = index >= 0 ? index : game.demoMaps.indexOf(map);
    }
    void switchLevel(levelUrl(map), map.toUpperCase());
    return;
  }
  const hint = nextMapHint();
  if (hint && hint !== currentMap && loader.pendingUrl !== levelUrl(hint)) {
    loader.prefetch(levelUrl(hint)).catch((error: unknown) => console.warn(`Prefetch of ${hint} failed`, error));
  }
}

// The world's collection: level lists, the things and the HUD in free fly
let shownThings: AnySplatObject[] = [];
let hudVersion = -1;
function updateCollection() {
  const thingObjects = things.objects();
  const thingsChanged = thingObjects.length !== shownThings.length || thingObjects.some((object, i) => object !== shownThings[i]);
  if (!dirty && !thingsChanged && (hud?.version ?? -1) === hudVersion) {
    return;
  }
  dirty = false;
  shownThings = thingObjects;
  hudVersion = hud?.version ?? -1;
  const collection = new SplatCollection([...(level?.objects() ?? []), ...thingObjects, ...(hud?.worldObjects() ?? [])]);
  serials.set(collection, lodSerial);
  splatRenderer.collection = collection;
}

// --- Panel ---

const gui = new GUI({ title: "Doom" });
gui.close();
const settings = { budget: selector.budget, detail: Math.log10(selector.sizeLimit), foveation: selector.minDot < 1, sort: splatRenderer.sortMode, flatten };
const lodFolder = gui.addFolder("LoD");
lodFolder.add(settings, "budget", 100_000, 8_000_000, 100_000).name("splat budget").onChange((value: number) => (selector.budget = value));
lodFolder.add(settings, "detail", -3.5, -1.5, 0.05).name("finest size (log10)").onChange((value: number) => (selector.sizeLimit = 10 ** value));
lodFolder.add(settings, "foveation").onChange((on: boolean) => (selector.minDot = on ? 0.2 : 1));
const sortControl = lodFolder.add(settings, "sort", ["gpu", "cpu"]).onChange((mode: "gpu" | "cpu") => {
  splatRenderer.sortMode = mode;
  if (hud) {
    hud.splatRenderer.sortMode = mode;
    hud.splatRenderer.requestSort();
  }
  dirty = true;
});
if (!webgpu) {
  sortControl.disable();
}
const lightingFolder = gui.addFolder("Lighting");
for (const key of ["enabled", "quantize", "diminish", "contrast"] as const) {
  lightingFolder.add(lighting.options, key);
}
const facingControl = gui.addFolder("Sprites").add(spriteOptions, "idealFacing").name("ideal facing (])");
gui.addFolder("Splats").add(settings, "flatten", 0, 1, 0.01).onChange((f: number) => {
  for (const r of [splatRenderer, hud?.splatRenderer]) {
    if (r) {
      r.params.maxStdDev = 2.5 - 1.5 * f;
      r.params.falloff = 1 - f;
    }
  }
});
if (game && hud) {
  const g = game;
  const gameFolder = gui.addFolder("Game");
  gameFolder.add({ get paused() { return g.userPaused; }, set paused(v: boolean) { g.setUserPaused(v); } }, "paused").name("paused (\\)").listen();
  gameFolder.add(hud, "frameMode", ["splats", "canvas", "off"]).name("overlay (menus, HUD)").onChange(() => hud.redraw());
  gameFolder.add(hud, "showWeapon").name("weapon");
  gameFolder.add(hud, "vanilla").name("vanilla frame (compare)");
}
addEventListener("keydown", (event) => {
  if (event.code === "BracketRight" && !event.repeat) {
    spriteOptions.idealFacing = !spriteOptions.idealFacing;
    facingControl.updateDisplay();
  }
});

// --- Measurement ---

interface Sample {
  frameMs: number[];
  loopMs: number[];
  project: number[];
  splats: number[];
  orders: { keysMs: number; sortMs: number; visible: number; count: number }[];
  gpu: Record<string, number>;
  gpuFrames: number;
}
let sampling: { sample: Sample; frames: number; done: () => void } | undefined;
const stats = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => +(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0).toFixed(2);
  return { mean: +(values.reduce((sum, v) => sum + v, 0) / Math.max(1, values.length)).toFixed(2), p50: at(0.5), p95: at(0.95), max: at(1) };
};
async function measure({ frames = 120 }: { frames?: number } = {}) {
  const sample: Sample = { frameMs: [], loopMs: [], project: [], splats: [], orders: [], gpu: {}, gpuFrames: 0 };
  await new Promise<void>((done) => (sampling = { sample, frames, done }));
  const gpu = sample.gpuFrames > 0 ? Object.fromEntries(Object.entries(sample.gpu).map(([name, ms]) => [name, +(ms / sample.gpuFrames).toFixed(3)])) : undefined;
  return {
    backend: webgpu ? "webgpu" : "webgl2",
    sortMode: splatRenderer.sortMode,
    map: level?.file.map,
    objects: splatRenderer.collection.objects.length,
    levelObjects: level?.parts.length,
    things: things.count,
    resident: level?.resident,
    budget: selector.budget,
    pixels: [renderer.domElement.width, renderer.domElement.height],
    splats: stats(sample.splats),
    frameMs: stats(sample.frameMs),
    loopCpuMs: stats(sample.loopMs),
    projectCpuMs: stats(sample.project),
    gpuMs: gpu,
    lod: { ...selector.stats },
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
Object.assign(page, { measure, camera, controls, splatRenderer, selector, lighting, things, renderer, game, hud });
Object.defineProperty(page, "level", { get: () => level });

// --- The loop ---

if (!game) {
  await switchLevel(levelUrl(params.get("level") ?? "e1m1"), (params.get("level") ?? "e1m1").toUpperCase());
} else {
  panel.hide();
}

let frozenView: THREE.Matrix4 | undefined;
let last = performance.now();
let frameTimes: number[] = [];
let statusAt = 0;
let lastOrder = 0;
let drawnFrames = 0;
let gpuLine = "";
let visible = 0;
let countingVisible = false;
renderer.setAnimationLoop((now) => {
  const loopStart = performance.now();
  const frameMs = now - last;
  last = now;

  let alpha = 1;
  if (game) {
    game.update();
    alpha = game.paused ? 1 : game.alpha(now);
    updateLevelState();
    updateProjection();
  }
  const following = !game || (game.follow && game.inLevel && !!level);
  controls.enabled = !game || !game.follow || !game.inLevel;
  if (controls.enabled) {
    controls.update();
  }
  if (game && game.follow && game.inLevel && level) {
    game.applyCamera(camera, alpha, level.file.unitsPerMeter);
  }
  camera.updateMatrixWorld();
  const freeFly = !!game && !game.follow && game.inLevel && !!level;
  if (!freeFly) {
    frozenView = undefined;
  } else if (!frozenView) {
    frozenView = camera.matrixWorld.clone();
  }

  if (game && game.inLevel && level) {
    const { curr } = game;
    lighting.setSectorLights(curr.sectors, SECTOR.STRIDE, SECTOR.LIGHT, curr.sectorCount);
    lighting.extraLight = curr.player[PLAYER.EXTRALIGHT];
    lighting.fixedColormap = curr.player[PLAYER.FIXEDCOLORMAP];
  } else {
    lighting.extraLight = 0;
    lighting.fixedColormap = 0;
  }
  lighting.update(camera);
  if (level) {
    level.updateMovers(game?.inLevel ? game.prev : undefined, game?.inLevel ? game.curr : undefined, alpha);
    if (game) {
      if (game.inLevel) {
        things.updateFromSim(game.prev, game.curr, alpha);
      } else if (things.count > 0) {
        things.clear();
      }
    }
    things.updateViews(camera.position);
    // Things move through their table: the CPU sort cannot see it (one
    // request waits behind a sort in flight, so this keeps the worker's pace)
    if (things.moved && splatRenderer.sortMode === "cpu") {
      splatRenderer.requestSort();
    }
  }
  hud?.update(alpha, frozenView, viewRect, camera);
  if (!switching && lodShown()) {
    selector.update(camera);
  }
  updateCollection();

  phaseMs.project = 0;
  phaseMs.sort = 0;
  profiler?.beginFrame();
  renderer.render(scene, camera);
  if (following) {
    hud?.render();
  }
  if (profiler) {
    void profiler.collect().then((report?: GpuProfile) => {
      if (report && report.frames > 0) {
        gpuLine = GpuProfiler.format(report);
        if (sampling) {
          for (const [name, ms] of Object.entries(report.gpu)) {
            sampling.sample.gpu[name] = (sampling.sample.gpu[name] ?? 0) + ms * report.frames;
          }
          sampling.sample.gpuFrames += report.frames;
        }
      }
    });
  }

  const order = splatRenderer.views.get(camera)?.order;
  const count = splatRenderer.collection.count;
  const drawn = count > 0 && (splatRenderer.sortMode === "gpu" || order !== undefined);
  drawnFrames = drawn && !switching ? drawnFrames + 1 : 0;
  if (!page.ready && level && drawnFrames > 3 && (!game || (game.inLevel && game.curr.gametic > 0))) {
    page.ready = true;
  }

  if (sampling) {
    const { sample } = sampling;
    sample.frameMs.push(frameMs);
    sample.loopMs.push(performance.now() - loopStart);
    sample.project.push(phaseMs.project);
    sample.splats.push(count);
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

  frameTimes.push(frameMs);
  if (now - statusAt > 500) {
    statusAt = now;
    const mean = frameTimes.reduce((sum, v) => sum + v, 0) / Math.max(1, frameTimes.length);
    frameTimes = [];
    if (splatRenderer.sortMode === "gpu" && !countingVisible && count > 0) {
      countingVisible = true;
      void splatRenderer.readSortedCount().then((n) => {
        visible = n;
        countingVisible = false;
      });
    }
    const s = selector.stats;
    const sortLine = splatRenderer.sortMode === "gpu"
      ? `GPU sort: ${visible.toLocaleString()} in view`
      : order ? `CPU sort: keys + readback ${order.keysMs.toFixed(1)} ms, worker ${order.sortMs.toFixed(1)} ms, ${order.visible.toLocaleString()} of ${order.collection.count.toLocaleString()} kept` : "CPU sort: waiting for the first order";
    const lines = [];
    if (page.error) {
      lines.push(`Error: ${page.error}`);
    }
    lines.push(level
      ? `${level.file.map}: ${level.parts.length} objects, ${things.count} things, ${level.resident.toLocaleString()} splats resident${switching ? " (switching...)" : ""}`
      : switching ? "Loading..." : "No level");
    lines.push(`drawing ${count.toLocaleString()} splats in ${splatRenderer.collection.objects.length} objects (budget ${selector.budget.toLocaleString()}, finest ${selector.sizeLimit.toPrecision(2)}, foveation ${selector.minDot < 1 ? "on" : "off"}); LoD ${s.workerMs.toFixed(1)} ms worker, ${s.changed} lists changed`);
    lines.push(`${webgpu ? "WebGPU" : "WebGL2"}, ${sortLine}`);
    if (game) {
      const pause = game.holdPaused ? " (held for loading)" : game.userPaused ? " (paused)" : "";
      lines.push(`sim: gametic ${game.curr.gametic}, ${game.ticksPerSecond} tics/s${pause}, ${["level", "intermission", "finale", "title"][game.gameState] ?? game.gameState}${game.mapId ? ` ${game.mapId}` : ""}${game.demoPlayback ? " demo" : ""}, ${game.follow ? "following the player" : "free fly"}`);
    }
    lines.push(`frame ${mean.toFixed(1)} ms (${(1000 / mean).toFixed(0)} fps), project ${phaseMs.project.toFixed(2)} ms CPU${gpuLine ? `; ${gpuLine}` : ""}`);
    lines.push(game?.playing ? "WASD/arrows, mouse, Ctrl fire, Space use; \\ pauses (free camera), Esc releases the mouse and opens the menu" : "WASD/arrows move, drag to look, Q/E down/up, shift to run");
    status.textContent = lines.join("\n");
  }
});
