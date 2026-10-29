// 3D fractals in Gaussian splats. Each kind bakes a few million samples on
// the GPU (a GpuArrayWriter: a fragment pass, so both backends) into a
// table of sample.ts, a chunk per frame; a generator (shade.ts) draws every
// sample as a splat each frame, with the palette, lights, fog, motion and
// 4D turn as uniforms, then bloom and tone mapping (three's RenderPipeline).
//
// Bakes are kept: each table holds one bake (its inputs, its progress, the
// order it was last sorted into), up to a share of GPU memory (?cache=, the
// number of tables). A request finds the same samples baked before, or
// parks the bake under way (resumed when asked for again) and starts its
// own; meanwhile the queued surprises bake ahead, a slice each in turn
// (see "Surprise me" below), so most surprises need no bake at all.
//
// The shown table and the next one: once a bake is
// done, both are ordered the same way on a worker and the shown fractal
// turns into the new one splat for splat (morph.ts; styles: morph, swirl,
// burst, orb, galaxy, fountain, stardust, swarm, sweep, ripple, dissolve,
// or random, the default), its look, sky, light and camera tweened along;
// then the tables swap. Kind, sampling and 4D turn change when the
// transition starts, never during its bake, and the side it leaves keeps
// its own palette and turn. Requests during a transition wait for its end;
// "loop" keeps breathing between the last two. Small edits (a slider, new
// samples, the light, a view baked from the camera) morph quickly within
// one kind; a new look alone (palette, style, bloom, a new angle) blends
// without a bake.
//
// "Surprise me" (Space, the button at the top, the tour by default): the
// next of a few queued fractals, each baked and paired with the shown one
// ahead (their bakes take turns, so light ones land first), so it starts
// at once; when none is ready yet, a quick new look or angle for this one
// instead. Often from a new angle, then a camera shot once it lands
// (shots.ts: hold, spin, zoom, orbit, truck, crane, push). Every
// kind's bake program compiles during the first bake, so later bakes
// never stall on a compile.
//
// Kinds: distance-estimated surfaces, sphere-traced per sample and lit with
// baked occlusion and soft shadows (surfaces.ts: Mandelbulb, Mandelbox,
// kaleidoscopic IFS, quaternion Julia, Apollonian, pseudo-Kleinian);
// chaos-game clouds (clouds.ts: 3D flames, Sierpinski and Menger dust, a
// 4D Buddhabrot turned live); strange attractors as threads of light
// (attractors.ts); a fractal tree with blossoms in the wind (tree.ts).
// Presets in presets.ts, palettes in palettes.ts, idle motions in motion.ts.
//
// Query parameters:
//   ?preset=      a preset's name, lowercase with dashes (golden-hour-bulb)
//   ?splats=      samples per bake (by device and quality, device.ts:
//                 standard / high 2M / 4M on a desktop's WebGPU, 1M / 2M on
//                 iOS, 500k / 1M on Android, half on WebGL2)
//   ?quality=     standard | high (default: the device's last choice)
//   ?hidpi=       0 | 1 (default: on for desktops, off on phones and tablets)
//   ?transition=  a transition style (default random)
//   ?motion=      idle sway (default) | float | turntable | drift | still
//   ?tour=1       a surprise every 24 s
//   ?ui=0         no panel, gallery or text
//   ?gpu=         webgpu | webgpu-gl
//   ?demo=        0: straight to the gallery (the page opens on the demo
//                 menu, demo/demo.ts, unless ?ui=0 or ?tour=1); aurora |
//                 tidal | lumen: prepare that demo (a click starts it)
//   ?sound=0      demos start silent
//   ?render=1     with ?demo=<tune>: a film for a frame-by-frame recorder
//
// Demo mode (the menu the page opens on, D, or "Demo videos") plays the
// fractals as music videos. Behind its menu the gallery keeps drawing (no
// baking ahead); once a demo prepares it steps aside (drawing, camera, keys
// and bakes paused, its cache freed) and comes back as it was ("explore
// the fractals" or Esc). The canvas's resolution
// follows the frame rate (device.ts).
//
// `radixFractals` in the console holds the page: `ready` once the first
// fractal is shown, `show(name)`, `surprise()`, `shot(name)`, `bake()`
// (again, with the current
// values), `settled()` (nothing baking, sorting or moving), `progress()`
// (the transition's, or -1), `baked()` (the fraction of the current bake)
// and `samples()` (the table shown).
import * as THREE from "three";
import { RenderPipeline } from "three/webgpu";
import { bloom } from "three/examples/jsm/tsl/display/BloomNode.js";
import GUI, {                 } from "lil-gui";
import { CameraControls, GpuArrays, SplatCollection, SplatGenerator, SplatRenderer, TSL, createRenderer, getGpuCaps,                } from "@sparkjsdev/radix";
import { ATTRACTORS, attractorKind } from "./attractors.js";
import { flameKind, nebulaKind } from "./clouds.js";
                                                        
import { Budget, FramePace, Resolution, deviceTier, pixelRatioOf, saveHiDpi, saveQuality, splatsOf, tableBytes,              } from "./device.js";
import { makeBakeUniforms,                        } from "./kind.js";
import { TRANSITIONS, TableSorter, makeMorphUniforms, morphGenerator, setStyle as setTransitionStyle,                                                  } from "./morph.js";
import { MOTIONS, Motion,                 } from "./motion.js";
import { PALETTES, paletteAt } from "./palettes.js";
import { PRESETS,             } from "./presets.js";
import { Director, SHOTS,               } from "./shots.js";
import { SAMPLES } from "./sample.js";
import {
  LOOK_DEFAULTS, STYLES, copyPaletteSlot, makeLookUniforms, setPalette, setPaletteSlot, setSky, shadeGenerator, skyNode, skyOf,                     
} from "./shade.js";
import { FORMULAS, surfaceKind } from "./surfaces.js";
import { treeKind } from "./tree.js";

const { pass } = TSL;

const params = new URLSearchParams(location.search);
const status = document.getElementById("status") ;
const progressBar = document.getElementById("progress") ;
const titleName = document.querySelector("#title .name") ;
const titleSub = document.querySelector("#title .sub") ;
const title = document.getElementById("title") ;
const gallery = document.getElementById("gallery") ;
if (params.get("ui") === "0") {
  document.body.classList.add("bare");
}

const renderer = await createRenderer();
const webgpu = getGpuCaps(renderer).backend === "webgpu";
const tier = deviceTier(webgpu);
const rendering = params.get("render") === "1";
const resolution = new Resolution(renderer, tier.pixelRatio);
// The frame time bakes size their chunks against
const pace = new FramePace();
// The next fractal's bake (frames may slow to about 1.5x), and the queued
// surprises' (a few ms over the device's frame time)
const nextBudget = new Budget(pace, 4096, 1 << 19, 32768);
const aheadBudget = new Budget(pace, 1024, 1 << 18, 8192);
// HiDPI on or off, from the demo menu or the panel (kept for this device)
const setHiDpi = (on         ) => {
  tier.hiDpi = on;
  saveHiDpi(on);
  resolution.setBase(pixelRatioOf(on));
};
renderer.setSize(innerWidth, innerHeight);
// The splats draw into the bloom pass's linear half-float target, so the
// pipeline's output transform tone maps and encodes sRGB (createRenderer
// leaves the canvas linear for splats drawn to it directly)
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.NeutralToneMapping;
document.body.prepend(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(40, innerWidth / innerHeight, 0.01, 100);
camera.position.set(0, 0.6, 3.4);
// The page's camera settings and nothing saved: no storage key, and the
// personal settings other Radix pages save are set aside too. A drag
// turns the fractal with the finger or mouse on every device (the defaults
// invert look on touch screens, which suits fly mode, not an orbit)
const CAMERA = {
  mode: "orbit"         , minDistance: 0.02, maxDistance: 20, moveSpeed: 0.6,
  invertLookX: false, invertLookY: false,
  // A drag's turn and pan glide on after release (a flick spins the fractal)
  inertia: { look: 0.15, move: 0.15, pointerLook: 0.7, pointerMove: 0.45 },
};
const controls = new CameraControls({ canvas: renderer.domElement, object: camera, settings: CAMERA });
controls.settings = { ...CameraControls.DEFAULTS, ...CAMERA };
controls.lookAt(new THREE.Vector3());
const motion = new Motion(renderer.domElement);
const director = new Director();
const startMotion = params.get("motion")              ;
if (MOTIONS.includes(startMotion)) {
  motion.setMode(startMotion);
}

// --- Kinds, look and state ---

const bakeU = makeBakeUniforms();
const KINDS         = [
  ...FORMULAS.map((formula) => surfaceKind(formula, bakeU)),
  flameKind(bakeU),
  nebulaKind(bakeU),
  ...ATTRACTORS.map((attractor) => attractorKind(attractor, bakeU)),
  treeKind(bakeU),
];
const kindById = new Map(KINDS.map((kind) => [kind.id, kind]));
const defaultsOf = (kind      ) => Object.fromEntries(Object.entries(kind.params).map(([key, param]) => [key, param.value]));
const values                                         = Object.fromEntries(KINDS.map((kind) => [kind.id, defaultsOf(kind)]));
const presets = PRESETS;

const u = makeLookUniforms();
const look       = { ...LOOK_DEFAULTS };
let sky      = skyOf(PALETTES.gold);
const state = {
  preset: "",
  kind: "mandelbulb",
  palette: "gold",
  style: "studio",
  splats: Number(params.get("splats")) || tier.splats,
  sampling: "orbit"                      ,
  // With camera sampling: bake again once the camera stops
  autoRefocus: true,
  coverage: 1,
  motion: motion.mode,
  motionSpeed: 1,
  transition: TRANSITIONS[params.get("transition") ?? ""] ? params.get("transition")  : "random",
  pairing: "auto"                    ,
  duration: 2,
  loop: false,
  tour: params.get("tour") === "1",
  tourSeconds: 24,
  // What the tour does next: a surprise or the next preset
  tourOrder: "surprise"                           ,
  lightAzimuth: 35,
  lightElevation: 45,
  turn: 0,
  bloom: 0.5,
  bloomRadius: 0.45,
  bloomThreshold: 0.7,
  exposure: 1,
  // Depth of field: the aperture's half-angle tangent, focused on the
  // orbit target
  aperture: 0,
};

// --- Tables of samples: the one shown, the one baked for the next
// transition, and bakes kept for later (done, or parked half way) ---

                 
                    
                   
                    
                                                                   
                
                   
 

// What a bake's writer reads, set again before each of its chunks (bakes
// take turns: the next fractal, and the ones baked ahead)
                      
             
                                 
               
                      
               
                 
                       
                               
                   
 

                
                                                             
              
               
                      
               
                     
                                                         
                  
                                                              
               
                                                                  
                    
 

const sorter = new TableSorter(renderer, state.splats, 2);
const steadyGenerator = shadeGenerator(u);
const m = makeMorphUniforms();
const transitionGenerator = morphGenerator(u, m);
const splatRenderer = new SplatRenderer({ renderer, params: { maxStdDev: 2.6 } });
scene.add(splatRenderer);

const makeTable = ()        => ({
  arrays: new GpuArrays({ renderer, bundles: { samples: SAMPLES }, capacity: state.splats }),
  ordered: { order: SplatGenerator.indices(renderer, [0]), visible: 0 },
  users: 0,
  retired: false,
});

// How many tables to keep: the shown one, the next, and bakes ahead, within
// a share of GPU memory (?cache= sets the count)
const tablesFor = (splats        ) => Number(params.get("cache")) || Math.max(2, Math.min(8, Math.floor((tier.memory * 0.8) / tableBytes(splats))));
let maxTables = tablesFor(state.splats);

const emptyBake = ()       => ({ key: "", table: makeTable(), done: 0, inputs: undefined         , used: 0 });
// Every table, a bake each: the shown one (empty at first), the next one,
// those baked ahead and those kept
let shownBake = emptyBake();
let bakes         = [shownBake];
// The bake the next transition goes to (the queued surprises' are in `bakes`)
let nextBake                  ;
const shown = () => shownBake.table;
const hidden = () => nextBake .table;

function retire(table       ) {
  table.retired = true;
  if (table.users === 0) {
    table.arrays.dispose();
    table.ordered.order.dispose();
  }
}

// A table for a new bake: a free slot, else the table of the bake used
// longest ago that nothing draws and `keep` does not hold. Undefined when
// none is free (a bake ahead waits; the next fractal's always gets one)
function tableFor(keep             , force         )                    {
  if (bakes.length < maxTables) {
    return makeTable();
  }
  const victims = bakes
    .filter((bake) => bake !== shownBake && bake !== nextBake && bake.table.users === 0 && !bake.reading && !keep.has(bake.key))
    .sort((a, b) => a.used - b.used);
  const victim = victims[0];
  if (victim) {
    bakes = bakes.filter((bake) => bake !== victim);
    victim.table.pairing = undefined;
    return victim.table;
  }
  return force ? makeTable() : undefined;
}

// Over the limit after a forced table: the oldest idle bakes go
function trim() {
  while (bakes.length > maxTables) {
    const keep = new Set(queue.map((q) => q.key));
    const idle = bakes.filter((bake) => bake !== shownBake && bake !== nextBake && !keep.has(bake.key) && !bake.reading && bake.table.users === 0).sort((a, b) => a.used - b.used);
    if (!idle[0]) {
      return;
    }
    bakes = bakes.filter((bake) => bake !== idle[0]);
    retire(idle[0].table);
  }
}

// Every bake but the shown one goes (demo mode needs the memory); a next
// one still drawn in a transition stays until it ends
function freeCache() {
  if (nextBake && nextBake.table.users === 0) {
    nextBake = undefined;
    if (phase === "baking" || phase === "sorting") {
      phase = "idle";
      pending = undefined;
      generation += 1;
    }
  }
  for (const bake of bakes) {
    if (bake !== shownBake && bake !== nextBake) {
      retire(bake.table);
    }
  }
  bakes = bakes.filter((bake) => bake === shownBake || bake === nextBake);
}

// The release of an object drawing these tables
function use(...used         ) {
  used.forEach((table) => (table.users += 1));
  return () => used.forEach((table) => {
    table.users -= 1;
    if (table.retired && table.users === 0) {
      table.arrays.dispose();
      table.ordered.order.dispose();
    }
  });
}

function showSteady() {
  const table = shown();
  splatRenderer.collection = new SplatCollection([SplatCollection.object({
    generator: steadyGenerator, data: { samples: table.arrays }, count: state.splats, matrixWorld: motion.holder.matrixWorld, release: use(table),
  })]);
}

function showTransition() {
  const [from, to] = [shown(), hidden()];
  splatRenderer.collection = new SplatCollection([SplatCollection.object({
    generator: transitionGenerator,
    data: { from: from.arrays, to: to.arrays, fromOrder: from.ordered, toOrder: to.ordered },
    count: state.splats,
    matrixWorld: motion.holder.matrixWorld,
    release: use(from, to),
  })]);
}

// --- Requests: bake, order, transition; or a change of look alone ---

                
                          
                        
              
 

// What a request may change besides the shape
                 
                      
                  
                
                
                   
                   
               
 

                
                  
                                                                       
                    
                                                                               
                
                                                 
                    
                                                
                  
                         
                                                 
                  
                                                                          
                 
 

                  
               
             
                  
                
                          
                
                   
                   
                               
               
                
                  
 

                                                                      
let phase        = "idle";
let current       = { long: true };
let pending                  ;
let target                    ;
let style                  = TRANSITIONS.morph;
let styleName = "morph";
let pairing          = "hilbert";
let duration = 1;
let generation = 0;
let firstShown = false;
// The kind in the shown table, and the 4D turn speed of the one a
// transition leaves
let shownKind = "";
let fromTurn = 0;

let bakeStart = 0;
let bakeSeconds = 0;
let bakeSeed = 1;
const bakedPose = new THREE.Matrix4();
const baked = new Set        ();

const reshapes = (plan      ) => plan.reshape !== false;

function merge(a      , b      )       {
  if (b.preset) {
    return b;
  }
  return {
    preset: a.preset, applied: a.applied, long: a.long || b.long, reshape: reshapes(a) || reshapes(b), fresh: a.fresh || b.fresh,
    remix: { ...a.remix, ...b.remix, look: { ...a.remix?.look, ...b.remix?.look } }, shot: b.shot ?? a.shot,
  };
}

function request(change      ) {
  if (phase === "morphing" || phase === "restyling") {
    pending = pending ? merge(pending, change) : change;
  } else if (phase === "baking" || phase === "sorting") {
    // Into the transition on its way
    begin(change.preset ? change : { ...merge(current, change), applied: true });
  } else if (reshapes(change)) {
    begin(change);
  } else {
    startRestyle(change);
  }
}

// The camera pose a preset's view asks for
function viewOf(preset        )       {
  const view = preset.view ?? {};
  const center = new THREE.Vector3(...(view.target ?? [0, 0, 0]));
  const az = THREE.MathUtils.degToRad(view.azimuth ?? 30);
  const el = THREE.MathUtils.degToRad(view.elevation ?? 20);
  const position = new THREE.Vector3(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az)).multiplyScalar(view.distance ?? 3.4).add(center);
  return { position, target: center, fov: view.fov ?? 40 };
}

// Where a plan ends: its preset's (or the current) look, then its remix
function targetOf(change      )         {
  const preset = change.preset;
  const kind = kindById.get(preset?.kind ?? state.kind) ;
  const t         = preset ? {
    kind: preset.kind,
    look: { ...LOOK_DEFAULTS, ...kind.look, ...STYLES[preset.style], ...preset.look },
    palette: preset.palette,
    style: preset.style,
    light: [preset.light?.azimuth ?? 35, preset.light?.elevation ?? 45],
    bloom: preset.bloom ?? 0.5,
    exposure: preset.exposure ?? 1,
    aperture: preset.aperture ?? 0,
    sampling: preset.sampling ?? "orbit",
    turn: preset.turn ?? 0,
    camera: viewOf(preset),
  } : {
    kind: state.kind,
    look: { ...look },
    palette: state.palette,
    style: state.style,
    light: [state.lightAzimuth, state.lightElevation],
    bloom: state.bloom,
    exposure: state.exposure,
    aperture: state.aperture,
    sampling: state.sampling,
    turn: state.turn,
  };
  const remix = change.remix ?? {};
  if (remix.style) {
    t.style = remix.style;
    Object.assign(t.look, STYLES[remix.style]);
  }
  Object.assign(t.look, remix.look);
  t.palette = remix.palette ?? t.palette;
  t.bloom = remix.bloom ?? t.bloom;
  t.exposure = remix.exposure ?? t.exposure;
  t.aperture = remix.aperture ?? t.aperture;
  t.camera = remix.camera ?? t.camera;
  t.shot = change.shot;
  return t;
}

const round = (value        , digits = 4) => Number(value.toFixed(digits));

// What a plan would bake, changing nothing: its writer's inputs and its key
function bakeOf(change      , t        )                               {
  const kind = kindById.get(t.kind) ;
  const kindValues = change.preset && !change.applied ? { ...defaultsOf(kind), ...change.preset.params } : { ...values[kind.id] };
  // Camera sampling bakes for where the camera will be, seen from the
  // fractal at rest (idle motion only nudges it from there)
  const view = new THREE.Matrix4();
  if (t.camera) {
    view.lookAt(t.camera.position, t.camera.target, camera.up).setPosition(t.camera.position);
  } else {
    camera.updateMatrixWorld();
    view.copy(camera.matrixWorld);
  }
  const tanY = Math.tan(THREE.MathUtils.degToRad((t.camera?.fov ?? camera.fov) / 2));
  const inputs             = {
    kind, values: kindValues, seed: 0, view, tanY, aspect: camera.aspect, light: lightDirection(...t.light), sampling: t.sampling, coverage: state.coverage,
  };
  const sorted = Object.entries(kindValues).sort(([a], [b]) => (a < b ? -1 : 1)).map(([name, value]) => [name, round(value)]);
  const seen = t.sampling === "camera" ? [...view.elements.map((value) => round(value, 3)), round(tanY), round(camera.aspect, 3)] : 0;
  return { ...inputs, key: JSON.stringify([kind.id, sorted, t.sampling, t.light.map((value) => round(value, 2)), round(state.coverage), state.splats, seen]) };
}

const presetKey = (preset        ) => bakeOf({ preset, long: true }, targetOf({ preset, long: true })).key;

// Sets every uniform a bake's writer reads
function applyInputs(b            ) {
  for (const [key, uniform] of Object.entries(b.kind.uniforms)) {
    uniform.value = b.values[key];
  }
  b.kind.prepare?.(b.values);
  bakeU.seed.value = b.seed;
  bakeU.count.value = state.splats;
  bakeU.coverage.value = b.coverage;
  bakeU.fromCamera.value = b.sampling === "camera" ? 1 : 0;
  bakeU.eye.value.setFromMatrixPosition(b.view);
  bakeU.right.value.setFromMatrixColumn(b.view, 0).normalize();
  bakeU.up.value.setFromMatrixColumn(b.view, 1).normalize();
  bakeU.forward.value.setFromMatrixColumn(b.view, 2).normalize().negate();
  bakeU.tanY.value = b.tanY;
  bakeU.tanX.value = b.tanY * b.aspect;
  bakeU.lightDir.value.copy(b.light);
}

// A bake left for another is kept (a queued one stays queued)
function parkNext() {
  nextBake = undefined;
}

function begin(change      ) {
  current = change;
  const preset = change.preset;
  if (preset && !change.applied) {
    state.preset = preset.name;
    state.kind = preset.kind;
    values[preset.kind] = { ...defaultsOf(kindById.get(preset.kind) ), ...preset.params };
    announce(preset);
  }
  target = targetOf(change);

  // The same samples, baked before or under way, are used as they are
  // (new samples always bake anew)
  const wanted = bakeOf({ ...change, applied: true }, target);
  const key = change.fresh ? `${wanted.key}#${bakeSeed + 1}` : wanted.key;
  if (nextBake && nextBake.key !== key) {
    parkNext();
  }
  let bake = bakes.find((each) => each.key === key && each !== shownBake);
  if (!bake && cpuBakes.has(key)) {
    bake = restore(key, preset, tableFor(new Set(), true) );
  }
  if (!bake) {
    bakeSeed += 1;
    bake = {
      key, table: tableFor(new Set(), true) , done: 0, inputs: { ...wanted, seed: bakeSeed },
      preset: preset && key === presetKey(preset) ? preset : undefined, used: 0,
    };
    bakes.push(bake);
  }
  bake.used = performance.now();
  nextBake = bake;
  bakedPose.copy(bake.inputs.view);
  baked.add(target.kind);

  if (change.long) {
    styleName = change.style ?? (state.transition === "random" ? pick(Object.keys(TRANSITIONS)) : state.transition);
    style = TRANSITIONS[styleName];
    pairing = state.pairing === "auto" ? style.pairing : state.pairing;
    duration = state.duration;
  } else {
    styleName = "morph";
    style = { ...TRANSITIONS.morph, spread: 0.1 };
    pairing = "hilbert";
    duration = 0.8;
  }
  generation += 1;
  bakeStart = performance.now();
  if (bake.done >= state.splats) {
    bakeSeconds = 0;
    phase = "sorting";
    order(generation).catch((error) => console.error(error));
  } else {
    phase = "baking";
  }
}

const pick =    (list     ) => list[Math.floor(Math.random() * list.length)];

// Rows [done, done + count) of a bake
function bakeChunk(bake      , count        ) {
  applyInputs(bake.inputs);
  bake.table.arrays.write(bake.inputs.kind.writer(), { at: bake.done, count, first: bake.done });
  bake.done += count;
}

// The next fractal's bake, in chunks sized to the device's frame time (a
// little slower frames allowed); otherwise the queued surprises', in what
// the frames leave (during transitions too). Whether a chunk was baked
function bakeStep(dt        ) {
  if (!pace.bakes()) {
    return false;
  }
  if (phase === "baking" && nextBake) {
    bakeChunk(nextBake, Math.min(nextBudget.next(dt, pace.base * 0.5 + 2), state.splats - nextBake.done));
    if (nextBake.done >= state.splats) {
      bakeSeconds = (performance.now() - bakeStart) / 1000;
      phase = "sorting";
      order(generation).catch((error) => console.error(error));
    }
    return true;
  }
  if ((phase === "idle" || phase === "morphing" || phase === "restyling") && firstShown && (!demo?.active || demo.idle)) {
    return bakeAhead(dt);
  }
  return false;
}

// --- The surprise queue: new fractals baked and paired ahead ---
//
// A few surprises wait in a queue, each a preset with its transition
// style, look and shot picked when it is queued. Their bakes take turns, a
// slice each per frame within the frame's slack, so light fractals land
// quickly and heavy ones still progress. The first one baked is paired
// ahead: its table and the shown one are sorted into its transition's
// order while nothing else happens, so a surprise starts at once.

                  
                 
                
                        
                 
              
 

let queue           = [];
let turn = 0;
let presorting = false;
// A surprise asked for during a transition plays when it ends
let surpriseNext = false;

// Phones keep the queue in CPU memory (?stash=1 anywhere): every queued bake
// but the next surprise is read back and its table freed, so the gallery
// holds 3 tables on the GPU (the shown one, the next, the bake under way)
const stashQueue = tier.platform !== "desktop" || params.get("stash") === "1";
const cpuBakes = new Map                                                 ();
const queueSize = () => (stashQueue ? 4 : Math.max(1, Math.min(4, maxTables - 2)));
// How long a kind takes to bake, roughly: sphere-traced surfaces the most
const COST                         = { surface: 4, tree: 2, cloud: 1, threads: 1 };
const costOf = (preset        ) => COST[kindById.get(preset.kind) .family];
const light = (preset        ) => costOf(preset) < 4;
const pairingOf = (name        ) => (state.pairing === "auto" ? TRANSITIONS[name].pairing : state.pairing);
const bakeFor = (key        ) => bakes.find((bake) => bake.key === key && bake !== shownBake);
const onGpu = (q        ) => (bakeFor(q.key)?.done ?? 0) >= state.splats;
const isReady = (q        ) => onGpu(q) || cpuBakes.has(q.key);

// A bake kept on the CPU, uploaded into a table (milliseconds, no bake)
function restore(key        , preset                    , table       )       {
  const saved = cpuBakes.get(key) ;
  table.arrays.upload(saved.data);
  table.pairing = undefined;
  const bake       = { key, table, done: state.splats, inputs: saved.inputs, preset, used: performance.now() };
  bakes.push(bake);
  return bake;
}

// A finished bake ahead with the queue on the CPU: kept on the GPU when it
// is the next surprise, else read back and its table freed
function settle(bake      ) {
  if (queue.find(isReady)?.key === bake.key) {
    return;
  }
  bake.reading = true;
  void bake.table.arrays.read({ start: 0, count: state.splats }).then((data) => {
    cpuBakes.set(bake.key, { data, inputs: bake.inputs });
  }).finally(() => {
    bake.reading = false;
    if (bake !== nextBake && bake !== shownBake && bake.table.users === 0) {
      bakes = bakes.filter((each) => each !== bake);
      retire(bake.table);
    }
  });
}

function queued(preset        )         {
  const style = state.transition === "random" ? pick(Object.keys(TRANSITIONS)) : state.transition;
  const remix = Math.random() < 0.35 ? randomLook() : {};
  if (preset.sampling !== "camera" && Math.random() < 0.5) {
    remix.camera = nudged(viewOf(preset));
  }
  return { preset, style, remix, shot: preset.sampling === "camera" ? "hold" : randomShot(), key: presetKey(preset) };
}

// New fractals up to the queue's size: never the one shown, a new kind
// after each when one is left
function fillQueue() {
  queue = queue.filter((q) => q.preset.name !== state.preset);
  while (queue.length < queueSize()) {
    const last = queue[queue.length - 1]?.preset.kind ?? state.kind;
    const taken = new Set([state.preset, ...queue.map((q) => q.preset.name)]);
    const fresh = presets.filter((preset) => !taken.has(preset.name));
    // At least one light fractal queued, so the first surprise lands soon
    const pool = queue.some((q) => light(q.preset)) ? fresh : fresh.filter(light);
    const varied = pool.filter((preset) => preset.kind !== last);
    if (pool.length === 0) {
      return;
    }
    queue.push(queued(pick(varied.length > 0 ? varied : pool)));
  }
}

function bakeAhead(dt        ) {
  fillQueue();
  if (stashQueue) {
    return bakeAheadStashed(dt);
  }
  const open = queue.filter((q) => !isReady(q));
  if (open.length === 0) {
    presort();
    return false;
  }
  // Until one is ready, the cheapest left; then each in turn
  const left = (q        ) => costOf(q.preset) * (1 - (bakeFor(q.key)?.done ?? 0) / state.splats);
  turn = (turn + 1) % open.length;
  const q = queue.some(isReady) ? open[turn] : open.reduce((a, b) => (left(b) < left(a) ? b : a));
  let bake = bakeFor(q.key);
  if (!bake) {
    const table = tableFor(new Set(queue.map((each) => each.key)), false);
    if (!table) {
      presort();
      return false;
    }
    const inputs = bakeOf({ preset: q.preset, long: true }, targetOf({ preset: q.preset, long: true }));
    bakeSeed += 1;
    bake = { key: q.key, table, done: 0, inputs: { ...inputs, seed: bakeSeed }, preset: q.preset, used: performance.now() };
    bakes.push(bake);
    baked.add(q.preset.kind);
  }
  if (bake === nextBake) {
    return false;
  }
  bakeChunk(bake, Math.min(aheadBudget.next(dt, 3), state.splats - bake.done));
  if (bake.done >= state.splats) {
    presort();
  }
  return true;
}

// The queue on the CPU: the next surprise uploaded and paired, and one
// bake at a time (the one under way, else the cheapest left)
function bakeAheadStashed(dt        ) {
  const keep = new Set(queue.map((each) => each.key));
  const head = queue.find(isReady);
  if (head && !bakeFor(head.key)) {
    const table = tableFor(keep, false);
    if (table) {
      restore(head.key, head.preset, table);
    }
  }
  presort();
  const open = queue.filter((q) => !isReady(q));
  if (open.length === 0) {
    return false;
  }
  const left = (q        ) => costOf(q.preset) * (1 - (bakeFor(q.key)?.done ?? 0) / state.splats);
  const q = open.find((each) => bakeFor(each.key)) ?? open.reduce((a, b) => (left(b) < left(a) ? b : a));
  let bake = bakeFor(q.key);
  if (!bake) {
    const table = tableFor(keep, false);
    if (!table) {
      return false;
    }
    const inputs = bakeOf({ preset: q.preset, long: true }, targetOf({ preset: q.preset, long: true }));
    bakeSeed += 1;
    bake = { key: q.key, table, done: 0, inputs: { ...inputs, seed: bakeSeed }, preset: q.preset, used: performance.now() };
    bakes.push(bake);
    baked.add(q.preset.kind);
  }
  if (bake === nextBake) {
    return false;
  }
  bakeChunk(bake, Math.min(aheadBudget.next(dt, 3), state.splats - bake.done));
  if (bake.done >= state.splats) {
    settle(bake);
  }
  return true;
}

// The first ready surprise's table, then the shown one, sorted into that
// surprise's transition order (one at a time, while idle; dropped if a
// transition started meanwhile)
function presort() {
  const head = queue.find(isReady);
  if (presorting || phase !== "idle" || !head || !onGpu(head)) {
    return;
  }
  const p = pairingOf(head.style);
  const queuedTable = bakeFor(head.key) .table;
  const table = queuedTable.pairing !== p ? queuedTable : shown().pairing !== p && shown().ordered.visible > 0 ? shown() : undefined;
  if (!table) {
    return;
  }
  presorting = true;
  void sorter.sort(table.arrays, state.splats, p).then((ordered) => {
    const drawn = table === shown() ? 1 : 0;
    if (phase === "idle" && !table.retired && table.users <= drawn) {
      table.ordered.order.dispose();
      table.ordered = ordered;
      table.pairing = p;
    } else {
      ordered.order.dispose();
    }
  }).finally(() => (presorting = false));
}

// Both tables in this transition's order (a table keeps the last one it
// was sorted into), then the transition
async function order(id        ) {
  const [from, to] = [shown(), hidden()];
  if (to.pairing !== pairing) {
    const sorted = await sorter.sort(to.arrays, state.splats, pairing, to.ordered.order);
    to.ordered = sorted;
    to.pairing = pairing;
    if (id !== generation) {
      return;
    }
  }
  if (from.pairing !== pairing && from.ordered.visible > 0) {
    from.ordered = await sorter.sort(from.arrays, state.splats, pairing, from.ordered.order);
    from.pairing = pairing;
    if (id !== generation) {
      return;
    }
  }
  startTransition();
}

// The look, sky, light and post values a transition or restyle runs between
let tween   
               
                   
                     
                  
                                        
                             
             ;
// The camera's own tween, which may outlast the look's; then the shot
let cameraTween                                                                    ;
let queuedShot                      ;

function startTween(to        ) {
  director.stop(motion);
  queuedShot = undefined;
  copyPaletteSlot(u.palettes[1], u.palettes[0]);
  state.palette = to.palette;
  state.style = to.style;
  setPaletteSlot(u.palettes[0], PALETTES[to.palette]);
  [state.lightAzimuth, state.lightElevation] = to.light;
  tween = {
    time: 0,
    reverse: false,
    look: [{ ...look }, { ...to.look }],
    sky: [sky, skyOf(PALETTES[to.palette])],
    light: [u.lightDir.value.clone(), lightDirection(...to.light)],
    post: [[state.bloom, state.exposure, state.aperture], [to.bloom, to.exposure, to.aperture]],
  };
  if (to.camera) {
    cameraTween = {
      from: { position: camera.position.clone(), target: controls.getTarget(new THREE.Vector3()), fov: camera.fov },
      to: to.camera,
      time: 0,
      length: Math.max(duration, 1.4),
    };
  }
  rebuildGui();
}

function startTransition() {
  const to = target ;
  startTween(to);
  // The fractal left keeps turning in 4D; a new kind starts unturned
  u.turnFromXW.value = u.turnXW.value;
  u.turnFromYW.value = u.turnYW.value;
  u.turnFromZW.value = u.turnZW.value;
  fromTurn = state.turn;
  if (to.kind !== shownKind) {
    u.turnXW.value = u.turnYW.value = u.turnZW.value = 0;
  }
  state.turn = to.turn;
  state.sampling = to.sampling;
  setTransitionStyle(m, style);
  m.count.value = state.splats;
  m.t.value = 0;
  showTransition();
  phase = "morphing";
}

function startRestyle(change      ) {
  current = change;
  target = targetOf(change);
  duration = state.duration * 0.8;
  styleName = "restyle";
  startTween(target);
  u.paletteMix.value = 0;
  phase = "restyling";
  announceLook(target);
}

const mixNumbers = (a        , b        , k        ) => a + (b - a) * k;

function transitionStep(seconds        ) {
  if ((phase !== "morphing" && phase !== "restyling") || !tween) {
    return;
  }
  // Loop: back and forth between the two until something new is asked for
  const looping = phase === "morphing" && state.loop && !pending;
  tween.time += seconds / duration;
  if (tween.time >= 1 && looping) {
    tween.time = 0;
    tween.reverse = !tween.reverse;
  }
  if (tween.reverse && pending) {
    tween.reverse = false;
    tween.time = 1 - tween.time;
  }
  const t = Math.min(tween.time, 1);
  const shownT = tween.reverse ? 1 - t : t;
  const k = THREE.MathUtils.smoothstep(shownT, 0, 1);
  if (phase === "morphing") {
    m.t.value = shownT;
  } else {
    u.paletteMix.value = k;
  }

  const [lookFrom, lookTo] = tween.look;
  for (const key of Object.keys(lookTo)                  ) {
    if (lookFrom[key] !== lookTo[key]) {
      look[key] = mixNumbers(lookFrom[key], lookTo[key], k);
    }
  }
  setSky(u, tween.sky[0], tween.sky[1], k);
  u.lightDir.value.lerpVectors(tween.light[0], tween.light[1], k).normalize();
  [state.bloom, state.exposure, state.aperture] = tween.post[0].map((from, i) => mixNumbers(from, tween .post[1][i], k));

  if (t >= 1 && !(state.loop && phase === "morphing" && !pending)) {
    finishTransition();
  }
}

function cameraStep(seconds        ) {
  if (!cameraTween) {
    return;
  }
  cameraTween.time = Math.min(1, cameraTween.time + seconds / cameraTween.length);
  const c = THREE.MathUtils.smootherstep(cameraTween.time, 0, 1);
  const { from, to } = cameraTween;
  camera.position.lerpVectors(from.position, to.position, c);
  camera.fov = mixNumbers(from.fov, to.fov, c);
  camera.updateProjectionMatrix();
  controls.lookAt(new THREE.Vector3().lerpVectors(from.target, to.target, c));
  if (cameraTween.time >= 1) {
    cameraTween = undefined;
  }
}

function finishTransition() {
  if (phase === "morphing") {
    shownBake = nextBake ;
    shownBake.used = performance.now();
    nextBake = undefined;
    shownKind = target .kind;
    showSteady();
    trim();
  }
  u.paletteMix.value = 1;
  sky = tween .sky[1];
  setSky(u, sky, sky);
  tween = undefined;
  phase = "idle";
  firstShown = true;
  queuedShot = target?.shot;
  Object.assign(page, { ready: true });
  listeners.forEach((controller) => controller.updateDisplay());
  if (pending) {
    const change = pending;
    pending = undefined;
    request(change);
  } else if (surpriseNext) {
    surpriseNext = false;
    surprise();
  }
}

// New tables (a new sample count): the first transition grows from nothing
function allocate() {
  bakes.forEach((bake) => retire(bake.table));
  maxTables = tablesFor(state.splats);
  shownBake = emptyBake();
  bakes = [shownBake];
  nextBake = undefined;
  queue = [];
  cpuBakes.clear();
  tween = undefined;
  phase = "idle";
  pending = undefined;
  showSteady();
  begin({ long: true });
}

// --- Surprises: the next queued fractal once it is baked (usually), else
// a quick change of look or view for this one; then a shot ---

const SHOT_WEIGHTS                       = [["hold", 2], ["spin", 2], ["zoom", 2], ["orbit", 3], ["truck", 1.5], ["crane", 1.5], ["push", 1.5]];
const rand = (lo        , hi        ) => lo + Math.random() * (hi - lo);

function randomShot()           {
  let x = Math.random() * SHOT_WEIGHTS.reduce((sum, [, w]) => sum + w, 0);
  return SHOT_WEIGHTS.find(([, w]) => (x -= w) < 0)?.[0] ?? "hold";
}

function randomLook()                 {
  const remix                 = {
    look: { frequency: rand(0.6, 2.2), shift: rand(0, 1), accent: rand(-0.4, 0.8) },
    bloom: rand(0.25, 1.2),
    exposure: rand(0.9, 1.12),
    aperture: Math.random() < 0.15 ? rand(0.004, 0.011) : 0,
  };
  if (Math.random() < 0.85) {
    remix.palette = pick(Object.keys(PALETTES).filter((name) => name !== state.palette));
  }
  if (Math.random() < 0.35) {
    remix.style = pick(Object.keys(STYLES).filter((name) => name !== state.style));
  }
  return remix;
}

// A new angle on the same target: around, up or down, nearer or farther
function nudged(view      )       {
  const offset = view.position.clone().sub(view.target);
  const distance = offset.length() * rand(0.75, 1.2);
  const azimuth = Math.atan2(offset.x, offset.z) + (Math.random() < 0.5 ? -1 : 1) * THREE.MathUtils.degToRad(rand(25, 80));
  const elevation = THREE.MathUtils.degToRad(rand(-5, 45));
  const position = new THREE.Vector3(Math.cos(elevation) * Math.sin(azimuth), Math.sin(elevation), Math.cos(elevation) * Math.cos(azimuth))
    .multiplyScalar(distance).add(view.target);
  return { position, target: view.target.clone(), fov: view.fov };
}

function surprise() {
  tourTime = 0;
  if (phase === "morphing" || phase === "restyling") {
    surpriseNext = true;
    return;
  }
  fillQueue();
  const ready = queue.find(onGpu) ?? queue.find(isReady);
  if (ready && Math.random() < 0.85) {
    queue = queue.filter((q) => q !== ready);
    announce(ready.preset);
    request({ preset: ready.preset, long: true, remix: ready.remix, shot: ready.shot, style: ready.style });
    cpuBakes.delete(ready.key);
    return;
  }
  // Nothing baked yet (or now and then anyway): a new look, often from a new angle
  const fromCamera = state.sampling === "camera";
  const remix = randomLook();
  if (!fromCamera && Math.random() < 0.7) {
    remix.camera = nudged({ position: camera.position.clone(), target: controls.getTarget(new THREE.Vector3()), fov: camera.fov });
  }
  request({ long: false, reshape: false, remix, shot: fromCamera ? "hold" : randomShot() });
}

// Every kind's bake program, compiled while the first fractal bakes (the
// screen shows only the sky) or later while nothing else happens, so a
// first bake of a kind never stalls a frame
const warmTable = new GpuArrays({ renderer, bundles: { samples: SAMPLES }, capacity: 4096 });
let warmAt = 0;

function warmStep(now        ) {
  if ((firstShown && phase !== "idle") || now < warmAt) {
    return;
  }
  const kind = KINDS.find((each) => !baked.has(each.id));
  if (kind) {
    baked.add(kind.id);
    warmTable.write(kind.writer(), { at: 0, count: 4 });
    warmAt = firstShown ? now + 300 : now;
  }
}

// --- Bloom and tone mapping ---

const pipeline = new RenderPipeline(renderer);
const scenePass = pass(scene, camera);
const sceneColor = scenePass.getTextureNode("output");
const glow = bloom(sceneColor, state.bloom, state.bloomRadius, state.bloomThreshold);
pipeline.outputNode = sceneColor.add(glow);
scene.backgroundNode = skyNode(u);

// --- Light, palette, presets ---

function lightDirection(azimuth        , elevation        ) {
  const az = THREE.MathUtils.degToRad(azimuth);
  const el = THREE.MathUtils.degToRad(elevation);
  return new THREE.Vector3(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az));
}

const slug = (name        ) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

function announce(preset        ) {
  titleName.textContent = preset.name;
  titleSub.textContent = `${kindById.get(preset.kind) .label} · ${preset.palette} · ${preset.style}`;
  title.classList.remove("faded");
  clearTimeout(fadeTimer);
  fadeTimer = setTimeout(() => title.classList.add("faded"), 5000);
  for (const chip of gallery.children) {
    chip.classList.toggle("active", (chip               ).dataset.name === preset.name);
  }
}

// The title for a new look of the same fractal
function announceLook(to        ) {
  titleSub.textContent = `${kindById.get(to.kind) .label} · ${to.palette} · ${to.style}`;
  title.classList.remove("faded");
  clearTimeout(fadeTimer);
  fadeTimer = setTimeout(() => title.classList.add("faded"), 5000);
}

function show(preset        ) {
  tourTime = 0;
  request({ preset, long: true });
}
let fadeTimer = 0;
let tourTime = 0;

const step = (by        ) => {
  // From the preset asked for last, so quick presses walk the list
  const name = pending?.preset?.name ?? state.preset;
  const index = presets.findIndex((preset) => preset.name === name);
  const preset = presets[(index + by + presets.length) % presets.length];
  announce(preset);
  show(preset);
};

document.getElementById("demos") .onclick = () => void openDemo();
document.getElementById("surprise") .onclick = () => surprise();
const surpriseDots = document.querySelector("#surprise small") ;

for (const preset of presets) {
  const chip = document.createElement("button");
  chip.dataset.name = preset.name;
  const palette = PALETTES[preset.palette];
  const stops = [0, 0.25, 0.5, 0.75, 1].map((t) => paletteAt(palette, t * 0.9).map((c) => Math.round(c * 255 * 0.8)).join(","));
  chip.style.background = `linear-gradient(120deg, ${stops.map((rgb) => `rgb(${rgb})`).join(", ")})`;
  chip.innerHTML = `${preset.name}<small>${kindById.get(preset.kind) .label}</small>`;
  chip.onclick = () => {
    announce(preset);
    show(preset);
  };
  gallery.append(chip);
}

// --- The panel ---

const gui = new GUI({ title: "Fractals" });
gui.domElement.classList.add("ui");
if (tier.platform !== "desktop") {
  gui.close();
}
// The swipe direction, for this visit (the demos' camera too)
const swipe = { reverse: false };
gui.add(swipe, "reverse").name("reverse swipe").onChange((on         ) => {
  controls.settings.invertLookX = on;
  controls.settings.invertLookY = on;
});
let shapeFolder                 ;
const listeners               = [];
const edit = () => request({ long: false });
const reseed = () => request({ long: false, fresh: true });

function rebuildGui() {
  listeners.forEach((controller) => controller.updateDisplay());
  shapeFolder?.destroy();
  const kind = kindById.get(state.kind) ;
  shapeFolder = gui.addFolder(`Shape: ${kind.label}`);
  const kindValues = values[kind.id];
  for (const [key, param] of Object.entries(kind.params)) {
    shapeFolder.add(kindValues, key, param.min, param.max, param.step ?? 0.01).name(param.label ?? key).onFinishChange(edit);
  }
  shapeFolder.add({ reseed }, "reseed").name("new samples (R)");
  // Right under the gallery folder
  gui.$children.insertBefore(shapeFolder.domElement, transitionFolder.domElement.nextSibling);
}

const watch =                       (controller   ) => {
  listeners.push(controller);
  return controller;
};

const galleryFolder = gui.addFolder("Gallery");
watch(galleryFolder.add(state, "preset", presets.map((preset) => preset.name)).onChange((name        ) => show(presets.find((preset) => preset.name === name) )));
watch(galleryFolder.add(state, "kind", Object.fromEntries(KINDS.map((kind) => [kind.label, kind.id]))).name("fractal").onChange((id        ) => {
  request({ long: true, remix: { look: kindById.get(id) .look } });
  rebuildGui();
}));
galleryFolder.add({ surprise }, "surprise").name("surprise me (space)");
watch(galleryFolder.add(state, "tour").name("tour (T)"));
galleryFolder.add(state, "tourOrder", ["surprise", "in order"]).name("tour moves");
galleryFolder.add(state, "tourSeconds", 8, 90, 1).name("seconds each");
watch(galleryFolder.add(state, "motion", [...MOTIONS]).onChange((mode            ) => motion.setMode(mode)));
galleryFolder.add(state, "motionSpeed", 0, 4, 0.01).name("motion speed").onChange((speed        ) => (motion.speed = speed));

const transitionFolder = gui.addFolder("Transitions");
watch(transitionFolder.add(state, "transition", [...Object.keys(TRANSITIONS), "random"]).name("style"));
watch(transitionFolder.add(state, "pairing", { auto: "auto", "nearest (Hilbert curve)": "hilbert", "by height": "layers", "by radius": "radial", "by angle": "spiral", random: "random" }));
transitionFolder.add(state, "duration", 0.3, 10, 0.1).name("seconds");
watch(transitionFolder.add(state, "loop").name("loop between the last two"));
transitionFolder.close();

const colorFolder = gui.addFolder("Color");
watch(colorFolder.add(state, "palette", Object.keys(PALETTES)).onChange((name        ) => {
  setPalette(u, PALETTES[name]);
  sky = skyOf(PALETTES[name]);
}));
watch(colorFolder.add(look, "frequency", 0.1, 6, 0.01));
watch(colorFolder.add(look, "shift", 0, 2, 0.001));
watch(colorFolder.add(look, "cycle", -0.3, 0.3, 0.001).name("cycle speed"));
watch(colorFolder.add(look, "accent", -1, 1, 0.01));
watch(colorFolder.add(look, "saturation", 0, 2, 0.01));
watch(colorFolder.add(u.background, "value", 0, 2, 0.01).name("sky"));

const lightFolder = gui.addFolder("Light");
watch(lightFolder.add(state, "style", Object.keys(STYLES)).onChange((name        ) => {
  Object.assign(look, STYLES[name]);
  listeners.forEach((controller) => controller.updateDisplay());
}));
const relight = () => {
  u.lightDir.value.copy(lightDirection(state.lightAzimuth, state.lightElevation));
};
watch(lightFolder.add(state, "lightAzimuth", -180, 180, 1).name("azimuth").onChange(relight).onFinishChange(edit));
watch(lightFolder.add(state, "lightElevation", -10, 90, 1).name("elevation").onChange(relight).onFinishChange(edit));
for (const [key, min, max] of [["key", 0, 4], ["ambient", 0, 2], ["occlusion", 0, 1], ["shadows", 0, 1], ["specular", 0, 3], ["shininess", 2, 120], ["metal", 0, 1], ["rim", 0, 3], ["glow", 0, 4], ["crevices", 0, 4], ["fog", 0, 0.6]]         ) {
  watch(lightFolder.add(look, key, min, max, 0.01));
}
lightFolder.close();

const splatFolder = gui.addFolder("Splats");
splatFolder.add(state, "splats", { "250k": 250_000, "500k": 500_000, "1M": 1_000_000, "1.5M": 1_500_000, "2M": 2_000_000, "3M": 3_000_000, "4M": 4_000_000 })
  .onChange(allocate);
watch(splatFolder.add(look, "sizeScale", 0.2, 4, 0.01).name("size"));
watch(splatFolder.add(look, "opacity", 0.02, 1, 0.01));
watch(splatFolder.add(look, "flatness", 0.2, 5, 0.01).name("thickness"));
watch(splatFolder.add(state, "sampling", { "all around": "orbit", "from the camera": "camera" }).onChange(edit));
splatFolder.add(state, "autoRefocus").name("bake when still");
splatFolder.add({ refocus: reseed }, "refocus").name("bake for this view");
splatFolder.add(state, "coverage", 0.3, 3, 0.01).name("bake size").onFinishChange(edit);
splatFolder.add(tier, "hiDpi").name("HiDPI").onChange(setHiDpi).listen();
splatFolder.close();


const motionFolder = gui.addFolder("Effects");
watch(motionFolder.add(look, "sway", 0, 3, 0.01));
watch(motionFolder.add(look, "petals", 0, 2, 0.01));
watch(motionFolder.add(look, "pulse", 0, 2, 0.01).name("light pulses"));
watch(motionFolder.add(look, "pulseSpeed", -1, 1, 0.01).name("pulse speed"));
watch(motionFolder.add(look, "twinkle", 0, 1, 0.01));
watch(motionFolder.add(state, "turn", -0.5, 0.5, 0.001).name("4D turn"));
motionFolder.close();

const postFolder = gui.addFolder("Bloom and exposure");
watch(postFolder.add(state, "bloom", 0, 3, 0.01));
postFolder.add(state, "bloomRadius", 0, 1, 0.01).name("radius");
postFolder.add(state, "bloomThreshold", 0, 2, 0.01).name("threshold");
watch(postFolder.add(state, "exposure", 0.2, 3, 0.01));
watch(postFolder.add(state, "aperture", 0, 0.03, 0.0005).name("depth of field"));
postFolder.add(renderer, "toneMapping", { neutral: THREE.NeutralToneMapping, AgX: THREE.AgXToneMapping, ACES: THREE.ACESFilmicToneMapping, none: THREE.NoToneMapping })
  .name("tone mapping").onChange(() => (pipeline.needsUpdate = true));
postFolder.close();

gui.add({ save }, "save").name("save PNG (S)");

function save() {
  pipeline.render();
  renderer.domElement.toBlob((blob) => {
    const link = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob ), download: `${slug(state.preset || state.kind)}.png` });
    link.click();
  });
}

addEventListener("keydown", (event) => {
  if ((event.target               ).closest("input, select, textarea") || event.metaKey || event.ctrlKey || demo?.active) {
    return;
  }
  const key = event.key.toLowerCase();
  if (key === "d") {
    void openDemo();
  } else if (key === "n") {
    step(1);
  } else if (key === "p") {
    step(-1);
  } else if (key === "t") {
    state.tour = !state.tour;
    tourTime = 0;
    listeners.forEach((controller) => controller.updateDisplay());
  } else if (key === " ") {
    event.preventDefault();
    surprise();
  } else if (key === "r") {
    reseed();
  } else if (key === "h") {
    document.body.classList.toggle("bare");
  } else if (key === "s") {
    save();
  }
});

// A camera move of the user's ends the page's own
motion.onInput = () => {
  cameraTween = undefined;
  queuedShot = undefined;
  director.stop(motion);
};

// --- Start ---

const page = {
  ready: false, renderer, scene, camera, controls, state, look, values, kinds: KINDS, uniforms: u, motion,
  presets: presets.map((preset) => ({ name: preset.name, slug: slug(preset.name) })),
  show: (name        ) => show(presets.find((preset) => slug(preset.name) === slug(name)) ),
  baked: () => (phase === "baking" && nextBake ? nextBake.done / state.splats : 1),
  settled: () => phase === "idle" && !pending,
  // The bakes kept (the shown one first): preset, done (0..1)
  cache: () => bakes.map((bake) => ({ preset: bake.preset?.name ?? (bake.key ? "edited" : "empty"), done: bake.done / state.splats, shown: bake === shownBake })),
  // Queued surprises kept in CPU memory
  cpu: () => cpuBakes.size,
  // The transition's progress, or -1 outside one
  progress: () => (phase === "morphing" ? m.t.value : -1),
  surprise,
  shot: (name          ) => director.start(name),
  shots: SHOTS,
  samples: () => shown().arrays,
  bake: reseed,
  setPalette: (name        ) => {
    state.palette = name;
    setPalette(u, PALETTES[name]);
    sky = skyOf(PALETTES[name]);
  },
};
Object.assign(window, { radixFractals: page });

// A quality (from the demo menu): its samples, for the gallery (baked again)
// and the demos (kept for this device)
function setQuality(quality         ) {
  tier.quality = quality;
  tier.splats = splatsOf(tier.platform, webgpu, quality);
  saveQuality(quality);
  if (!params.get("splats") && state.splats !== tier.splats) {
    state.splats = tier.splats;
    allocate();
    gui.controllersRecursive().forEach((controller) => controller.updateDisplay());
  }
}

// A demo's last fractal, shown at once as it was: its samples become the
// shown table (or it bakes, if they did not come), in its own look, the
// demo's palette, from the demo's camera
function adopt(h         ) {
  const preset = presets.find((each) => each.name === h.preset);
  if (!preset) {
    h.arrays?.dispose();
    return;
  }
  const view       = { position: h.camera.position, target: h.camera.target, fov: h.camera.fov };
  if (!h.arrays || h.count !== state.splats) {
    h.arrays?.dispose();
    request({ preset, long: true, remix: { camera: view, palette: h.palette } });
    return;
  }
  // Whatever the gallery had under way stops
  tween = undefined;
  cameraTween = undefined;
  pending = undefined;
  surpriseNext = false;
  queuedShot = undefined;
  director.stop(motion);
  parkNext();
  generation += 1;

  state.preset = preset.name;
  state.kind = preset.kind;
  values[preset.kind] = { ...defaultsOf(kindById.get(preset.kind) ), ...preset.params };
  announce(preset);
  const t = targetOf({ preset, long: true, remix: { palette: h.palette } });
  current = { preset, long: true };
  target = t;
  const inputs = bakeOf({ preset, long: true, applied: true }, t);
  bakeSeed += 1;
  shownBake = {
    key: inputs.key, table: { arrays: h.arrays, ordered: { order: SplatGenerator.indices(renderer, [0]), visible: 0 }, users: 0, retired: false },
    done: state.splats, inputs: { ...inputs, seed: bakeSeed }, preset, used: performance.now(),
  };
  bakes.push(shownBake);
  trim();
  shownKind = preset.kind;
  queue = queue.filter((q) => q.preset.name !== preset.name);

  Object.assign(look, t.look);
  state.palette = t.palette;
  state.style = t.style;
  setPalette(u, PALETTES[t.palette]);
  sky = skyOf(PALETTES[t.palette]);
  setSky(u, sky, sky);
  u.paletteMix.value = 1;
  [state.lightAzimuth, state.lightElevation] = t.light;
  u.lightDir.value.copy(lightDirection(...t.light));
  [state.bloom, state.exposure, state.aperture, state.turn, state.sampling] = [t.bloom, t.exposure, t.aperture, t.turn, t.sampling];
  u.turnXW.value = u.turnYW.value = u.turnZW.value = 0;
  camera.position.copy(view.position);
  camera.fov = view.fov;
  camera.updateProjectionMatrix();
  controls.lookAt(view.target);

  phase = "idle";
  firstShown = true;
  showSteady();
  rebuildGui();
  listeners.forEach((controller) => controller.updateDisplay());
}

// --- Demo mode (loaded when first opened) ---

let demo                      ;

async function loadDemo() {
  if (!demo) {
    const { DemoMode } = await import("./demo/demo.js");
    demo = new DemoMode({
      renderer, webgpu, canvas: renderer.domElement, kinds: KINDS, bakeU, get splats() {
        return Number(params.get("splats")) || tier.splats;
      }, memory: tier.memory, platform: tier.platform,
      hiDpi: () => tier.hiDpi,
      setHiDpi,
      quality: () => tier.quality,
      setQuality,
      splatsAt: (quality         ) => splatsOf(tier.platform, webgpu, quality),
      resolution: rendering ? undefined : resolution,
      pace,
      enter: () => {
        controls.enabled = false;
        director.stop(motion);
        document.body.classList.add("demo");
      },
      yield: freeCache,
      adopt,
      reverse: () => swipe.reverse,
      exit: () => {
        controls.enabled = true;
        document.body.classList.remove("demo");
      },
    }, { sound: params.get("sound") !== "0" });
    Object.assign(page, { demo });
  }
  return demo;
}

async function openDemo(name         , start = false) {
  (await loadDemo()).open(name, start);
}

showSteady();
const demoParam = params.get("demo");
if (rendering && demoParam) {
  void loadDemo().then((mode) => mode.film(demoParam));
} else {
  show(presets.find((preset) => slug(preset.name) === params.get("preset")) ?? presets[0]);
  if (demoParam !== "0" && params.get("ui") !== "0" && !state.tour) {
    void openDemo(demoParam ?? undefined);
  }
}

let last = performance.now();
let frames = 0;
let fps = 0;
let fpsTime = last;
const lastPose = new THREE.Matrix4();
let stillSince = 0;
const samePose = (a               , b               ) => a.elements.every((value, i) => Math.abs(value - b.elements[i]) < 1e-4);
const inverse = new THREE.Matrix4();

renderer.setAnimationLoop((now) => {
  const dt = now - last;
  last = now;
  if (demo?.active && demo.state !== "menu") {
    demo.frame(dt);
    return;
  }
  const seconds = Math.min(dt, 100) / 1000;

  transitionStep(seconds);
  cameraStep(seconds);
  if (!cameraTween && queuedShot && phase === "idle") {
    director.start(queuedShot);
    queuedShot = undefined;
  }
  director.update(seconds, camera, controls, motion);
  motion.update(seconds, camera, controls, { held: Boolean(cameraTween) || director.holds, baked: state.sampling === "camera" });
  controls.update();
  // Camera sampling follows the view: a new bake once the camera has moved
  // and held still
  camera.updateMatrixWorld();
  if (!samePose(camera.matrixWorld, lastPose)) {
    lastPose.copy(camera.matrixWorld);
    stillSince = now;
  }
  if (state.sampling === "camera" && state.autoRefocus && phase === "idle" && !cameraTween && !samePose(camera.matrixWorld, bakedPose) && now - stillSince > 400) {
    edit();
  }
  if (state.tour && phase === "idle") {
    tourTime += seconds;
    if (tourTime > state.tourSeconds) {
      if (state.tourOrder === "surprise") {
        surprise();
      } else {
        step(1);
      }
    }
  }
  warmStep(now);

  u.time.value = now / 1000;
  for (const key of Object.keys(look)                  ) {
    u[key].value = look[key];
  }
  u.turnXW.value += state.turn * seconds;
  u.turnZW.value += state.turn * 0.61 * seconds;
  u.turnFromXW.value += fromTurn * seconds;
  u.turnFromZW.value += fromTurn * 0.61 * seconds;
  inverse.copy(motion.holder.matrixWorld).invert();
  camera.getWorldPosition(u.camera.value).applyMatrix4(inverse);
  glow.strength.value = state.bloom;
  glow.radius.value = state.bloomRadius;
  glow.threshold.value = state.bloomThreshold;
  renderer.toneMappingExposure = state.exposure;
  splatRenderer.objectParams.apertureTan = state.aperture;
  splatRenderer.objectParams.focalDistance = controls.distance;

  if (!bakeStep(dt)) {
    pace.update(dt);
  }
  pipeline.render();
  if (!rendering) {
    resolution.update(dt, phase === "baking" || queue.some((q) => !isReady(q)));
  }

  frames += 1;
  if (now - fpsTime > 500) {
    fps = (frames * 1000) / (now - fpsTime);
    frames = 0;
    fpsTime = now;
  }
  const baking = phase === "baking" && nextBake ? nextBake.done / state.splats : 0;
  progressBar.style.width = `${phase === "baking" ? 100 * baking : phase === "idle" ? 0 : 100}%`;
  progressBar.style.opacity = phase === "baking" || phase === "sorting" ? "1" : "0";
  const readyCount = queue.filter(isReady).length;
  const ahead = ` · surprises ${readyCount}/${queue.length} ready`;
  const dots = queue.map((q) => (isReady(q) ? "\u25cf" : "\u25cb")).join("");
  if (surpriseDots.textContent !== dots) {
    surpriseDots.textContent = dots;
  }
  const doing = {
    idle: `${bakeSeconds > 0 ? `baked in ${bakeSeconds.toFixed(1)} s` : "from the cache"}${ahead}`,
    baking: `baking ${Math.round(100 * baking)}%`,
    sorting: `pairing (${pairing})`,
    morphing: `${styleName} ${Math.round(m.t.value * 100)}%${pending ? " · next waiting" : ""}`,
    restyling: `new look${pending ? " · next waiting" : ""}`,
  }[phase];
  const scale = resolution.scale < 0.99 ? ` · ${Math.round(resolution.scale * 100)}% res` : "";
  status.textContent = `${webgpu ? "WebGPU" : "WebGL2"} · ${(state.splats / 1e6).toFixed(2)}M splats · ${fps.toFixed(0)} fps${scale} · ${doing}` +
    (director.holds || director.name === "spin" ? ` · ${director.name}` : "");
  if (!firstShown) {
    status.textContent += " · first bake";
  }
});

addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});


//# sourceURL=examples/fractals/main.ts