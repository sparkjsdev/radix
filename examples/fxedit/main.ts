// A node editor for splat effect graphs, with the effect live on a scan beside it
//   ?graph=    an example, a key of EXAMPLES (default dissolve)
//   ?scan=     butterfly (default) | ceramic | sutro
//   ?splats=   the samples' base URL (default the hosted samples)
//   ?splatsSh= Sutro's base URL (default the hosted SH3 samples)
//   ?theme=    neon | toybox | glass (default the saved theme, else glass)
//   ?space=    world (default) | object: the graph's space (also ?place=)
//   ?apply=    renderer (WebGPU's default) | generator (WebGL2's): where the graph runs
//   ?gpu=      webgpu | webgpu-gl (default auto)
//   ?sort=cpu  the worker sort, also on WebGPU (also ?sort=worker)
//   ?instant=1 no motion
//   ?sound=1   sound on (default the saved choice, else off)
//   ?dpr=      1 | 2: pixel ratio 1 or the display's, up to 2 (default saved per kind of scan)
// radixFxedit in the console: the page's objects and setters, selfTest() and ready
import * as THREE from "three";
import { Pane, type FolderApi } from "tweakpane";
import {
  CameraControls, GpuArrays, SplatCollection, SplatGenerator, SplatProjector, SplatRenderer, Splats, createRenderer, getGpuCaps, loadSplats, type ArrayData,
} from "@sparkjsdev/radix";
import { SCANS, scanRotation, skyTexture, type Scan } from "./catalog.js";
import { VALUE_CHECKS, finite, runGraph } from "./checks.js";
import { addControlsFolder } from "./controlsPane.js";
import { inFrame, setFrame } from "./framed.js";
import {
  FxInputs, buildGraphModifier, fxNodes, getParam, graphKey, graphParams, setParam as writeParam, validate, type Graph, type GraphModifier, type Value,
} from "./fx/index.js";
import blank from "./fx/graphs/blank.json" with { type: "json" };
import dissolve from "./fx/graphs/dissolve.json" with { type: "json" };
import groups from "./fx/graphs/groups.json" with { type: "json" };
import heightGradient from "./fx/graphs/heightGradient.json" with { type: "json" };
import pulse from "./fx/graphs/pulse.json" with { type: "json" };
import reveal from "./fx/graphs/reveal.json" with { type: "json" };
import sway from "./fx/graphs/sway.json" with { type: "json" };
import tint from "./fx/graphs/tint.json" with { type: "json" };
import wave from "./fx/graphs/wave.json" with { type: "json" };
import colorStripes from "./fx/graphs/spark/colorStripes.json" with { type: "json" };
import disintegrate from "./fx/graphs/spark/disintegrate.json" with { type: "json" };
import electronic from "./fx/graphs/spark/electronic.json" with { type: "json" };
import flare from "./fx/graphs/spark/flare.json" with { type: "json" };
import grow from "./fx/graphs/spark/grow.json" with { type: "json" };
import radialWarp from "./fx/graphs/spark/radialWarp.json" with { type: "json" };
import shockwave from "./fx/graphs/spark/shockwave.json" with { type: "json" };
import unroll from "./fx/graphs/spark/unroll.json" with { type: "json" };
import waves from "./fx/graphs/spark/waves.json" with { type: "json" };
import colorWave from "./fx/graphs/worldlabs/colorWave.json" with { type: "json" };
import depthMap from "./fx/graphs/worldlabs/depthMap.json" with { type: "json" };
import depthOfField from "./fx/graphs/worldlabs/depthOfField.json" with { type: "json" };
import dollyZoom from "./fx/graphs/worldlabs/dollyZoom.json" with { type: "json" };
import ripple from "./fx/graphs/worldlabs/ripple.json" with { type: "json" };
import rustle from "./fx/graphs/worldlabs/rustle.json" with { type: "json" };
import sonar from "./fx/graphs/worldlabs/sonar.json" with { type: "json" };
import spotlight from "./fx/graphs/worldlabs/spotlight.json" with { type: "json" };
import wlWaves from "./fx/graphs/worldlabs/waves.json" with { type: "json" };
import { GraphDoc } from "./GraphDoc.js";
import { GraphView } from "./GraphView.js";
import { exposePort, probeGraph } from "./preview.js";
import { loadSettings, saveSettings } from "./settings.js";
import { Sound } from "./sound.js";
import { Animator } from "./springs.js";
import { THEMES, themeByName, type ThemeName } from "./themes.js";

interface Example {
  label: string;
  graph: Graph;
  group: string;
}

// JSON imports type positions as number[], not [number, number]
const asGraph = (json: unknown) => json as Graph;

const EXAMPLES: Record<string, Example> = {
  tint: { label: "1 · Tint", graph: asGraph(tint), group: "Learn" },
  heightGradient: { label: "2 · Height gradient", graph: asGraph(heightGradient), group: "Learn" },
  pulse: { label: "3 · Pulse", graph: asGraph(pulse), group: "Learn" },
  wave: { label: "4 · Wave", graph: asGraph(wave), group: "Learn" },
  reveal: { label: "5 · Reveal", graph: asGraph(reveal), group: "Learn" },
  groups: { label: "6 · Groups", graph: asGraph(groups), group: "Learn" },
  dissolve: { label: "Dissolve", graph: asGraph(dissolve), group: "Effects" },
  sway: { label: "Sway", graph: asGraph(sway), group: "Effects" },
  radialWarp: { label: "Radial warp", graph: asGraph(radialWarp), group: "From Spark" },
  colorStripes: { label: "Color stripes", graph: asGraph(colorStripes), group: "From Spark" },
  waves: { label: "Waves", graph: asGraph(waves), group: "From Spark" },
  flare: { label: "Flare", graph: asGraph(flare), group: "From Spark" },
  disintegrate: { label: "Disintegrate", graph: asGraph(disintegrate), group: "From Spark" },
  electronic: { label: "Electronic", graph: asGraph(electronic), group: "From Spark" },
  shockwave: { label: "Shockwave (click)", graph: asGraph(shockwave), group: "From Spark" },
  grow: { label: "Grow (click)", graph: asGraph(grow), group: "From Spark" },
  unroll: { label: "Unroll (click)", graph: asGraph(unroll), group: "From Spark" },
  depthMap: { label: "Depth map", graph: asGraph(depthMap), group: "World Labs" },
  depthOfField: { label: "Depth of field", graph: asGraph(depthOfField), group: "World Labs" },
  dollyZoom: { label: "Dolly zoom", graph: asGraph(dollyZoom), group: "World Labs" },
  spotlight: { label: "Spotlight (click)", graph: asGraph(spotlight), group: "World Labs" },
  sonar: { label: "Sonar (click)", graph: asGraph(sonar), group: "World Labs" },
  ripple: { label: "Ripple (click)", graph: asGraph(ripple), group: "World Labs" },
  rustle: { label: "Rustle", graph: asGraph(rustle), group: "World Labs" },
  wlWaves: { label: "Waves", graph: asGraph(wlWaves), group: "World Labs" },
  colorWave: { label: "Color wave", graph: asGraph(colorWave), group: "World Labs" },
  blank: { label: "Blank canvas", graph: asGraph(blank), group: "Build" },
};

// Largest extent of the middle 94% of centers once normalized; examples are tuned for SIZE
const SCENE_SIZE = 8;
const SIZE = 1.6;
type Placement = "world" | "object";

const params = new URLSearchParams(location.search);
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const settings = loadSettings();
if (params.get("instant") === "1") {
  settings.instant = true;
}
const sound = new Sound();
sound.muted = params.get("sound") === "1" ? false : settings.muted;
sound.volume = settings.volume;
let theme = themeByName(params.get("theme")) ?? THEMES[settings.theme];

const state = {
  example: EXAMPLES[params.get("graph") ?? ""] ? params.get("graph")! : "dissolve",
  scan: SCANS[params.get("scan") ?? ""] ? params.get("scan")! : "butterfly",
  placement: ((params.get("space") ?? params.get("place")) === "object" ? "object" : "world") as Placement,
  turntable: false,
};

const renderPane = $("render-pane");
const editorPane = $("editor-pane");
const status = $("status");
const errorsBox = $("errors");

function applyTheme(name: ThemeName) {
  theme = THEMES[name];
  document.body.dataset.theme = name;
  document.body.classList.toggle("overlay", theme.overlay);
  settings.theme = name;
  saveSettings(settings);
  document.querySelectorAll<HTMLElement>("#themes button").forEach((button) => button.classList.toggle("on", button.dataset.theme === name));
  // A ?theme= in the URL would win over the saved choice on reload
  if (params.has("theme")) {
    params.set("theme", name);
    history.replaceState(null, "", `?${params}`);
  }
}

for (const t of Object.values(THEMES)) {
  const button = document.createElement("button");
  button.type = "button";
  button.dataset.theme = t.name;
  button.title = `${t.label} (T cycles)`;
  button.style.setProperty("--swatch-a", t.colors[0]);
  button.style.setProperty("--swatch-b", t.colors[1]);
  button.append(document.createElement("i"), t.label.split(" ")[0]);
  $("themes").append(button);
}

function applySplit() {
  document.body.style.setProperty("--split", String(settings.split));
}

applyTheme(theme.name);
applySplit();

const gpu = params.get("gpu");
const renderer = await createRenderer({ backend: gpu === "webgpu" || gpu === "webgpu-gl" ? gpu : "auto" });
const caps = getGpuCaps(renderer);
const webgpu = caps.backend === "webgpu";
const applyIn = params.get("apply") === "generator" || (!webgpu && params.get("apply") !== "renderer") ? "generator" : "renderer";
renderPane.prepend(renderer.domElement);
// Saved per kind of scan; ?dpr= overrides both until the button is toggled
let dprOverride = params.has("dpr") ? Number(params.get("dpr")) > 1 : undefined;
const hiDpi = () => dprOverride ?? (SCANS[state.scan]?.scene ? settings.hiDpiScenes : settings.hiDpi);

function applyPixelRatio() {
  renderer.setPixelRatio(hiDpi() ? Math.min(devicePixelRatio, 2) : 1);
  $("hidpi").classList.toggle("on", hiDpi());
}
applyPixelRatio();

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, 1, 0.02, 100);
camera.position.set(0, 0.25, 3);
// No mode key: the bar switches modes, and F fits the graph
const controls = new CameraControls({ canvas: renderer.domElement, object: camera, settings: { mode: "orbit", modeKey: "" } });
controls.settings.modeKey = "";
controls.lookAt(new THREE.Vector3(0, 0, 0));

// The spin turns model, and its child normalized is the scan object's transform
const model = new THREE.Object3D();
const normalized = new THREE.Object3D();
model.add(normalized);
scene.add(model);

// One view for the one camera (the worker sort keeps an order per view)
const splats = new SplatRenderer({
  renderer,
  sortMode: webgpu && params.get("sort") !== "cpu" && params.get("sort") !== "worker" ? "gpu" : "cpu",
  viewKey: () => "main",
});
scene.add(splats);

// Overlay themes shift the view so the scan centers in the part the editor leaves uncovered
let framed = false;
let visibleShare = 1;
function updateViewport() {
  const width = Math.max(1, renderPane.clientWidth);
  const height = Math.max(1, renderPane.clientHeight);
  renderer.setSize(width, height);
  const covered = theme.overlay ? editorPane.getBoundingClientRect().width + 14 : 0;
  const visible = Math.max(1, width - covered);
  camera.aspect = width / height;
  if (covered > 0) {
    camera.setViewOffset(width, height, covered / 2, 0, width, height);
  } else {
    camera.clearViewOffset();
  }
  camera.updateProjectionMatrix();
  visibleShare = Math.min(1, visible / height);
  if (!framed) {
    framed = true;
    frameCamera();
  }
}

// The scan's own view, else far enough back to show it (most of a scene) in the uncovered part
function frameCamera() {
  const scan = SCANS[state.scan];
  camera.fov = scan?.view?.fov ?? 45;
  camera.updateProjectionMatrix();
  if (scan?.view && loaded) {
    camera.position.copy(placedPoint(scan.view.position));
    controls.lookAt(placedPoint(scan.view.target));
    return;
  }
  const size = scan?.scene ? SCENE_SIZE * 0.55 : SIZE;
  const fit = (size * 0.62) / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) / visibleShare;
  camera.position.set(0, fit * (scan?.scene ? 0.25 : 0.08), fit);
  controls.lookAt(new THREE.Vector3(0, 0, 0));
}
new ResizeObserver(updateViewport).observe(renderPane);
new ResizeObserver(updateViewport).observe(editorPane);

// Controls are off over the editor unless a drag began on the render or the pointer is locked
let overEditor = false;
let steering = false;
const syncControls = () => {
  controls.enabled = !overEditor || steering || document.pointerLockElement === renderer.domElement;
};
editorPane.addEventListener("pointerenter", () => {
  overEditor = true;
  syncControls();
});
editorPane.addEventListener("pointerleave", () => {
  overEditor = false;
  syncControls();
});
renderer.domElement.addEventListener("pointerdown", () => {
  steering = true;
  syncControls();
});
for (const type of ["pointerup", "pointercancel"]) {
  addEventListener(type, () => {
    steering = false;
    syncControls();
  });
}
document.addEventListener("pointerlockchange", syncControls);

function setCameraMode(mode: "orbit" | "fly") {
  controls.mode = mode;
  document.querySelectorAll<HTMLElement>("#camera-mode button").forEach((button) => button.classList.toggle("on", button.dataset.mode === mode));
}
document.querySelectorAll<HTMLElement>("#camera-mode button").forEach((button) => button.addEventListener("click", () => setCameraMode(button.dataset.mode as "orbit" | "fly")));
setCameraMode(controls.mode);

// The upright rotation, the scale and translation that fit the middle 94% of
// the visible centers, and the sampled centers in that frame for picking
function normalization(data: ArrayData, scan: Scan) {
  const quaternion = scanRotation(scan);
  const { bundle } = Splats.get(data);
  const splat = Splats.makeSplat();
  const p = new THREE.Vector3();
  const axes: number[][] = [[], [], []];
  const step = Math.max(1, Math.floor(data.count / 60000));
  for (let i = 0; i < data.count; i += step) {
    Splats.load(bundle, i, splat);
    if (splat.opacity < 0.2) {
      continue;
    }
    p.set(splat.center.x, splat.center.y, splat.center.z).applyQuaternion(quaternion);
    axes[0].push(p.x);
    axes[1].push(p.y);
    axes[2].push(p.z);
  }
  // Sorted copies, since the pick points below need splat order
  const ranges = axes.map((values) => {
    const sorted = Float64Array.from(values).sort();
    return [sorted[Math.floor(sorted.length * 0.03)] ?? 0, sorted[Math.floor(sorted.length * 0.97)] ?? 1];
  });
  const extent = Math.max(1e-6, ...ranges.map(([lo, hi]) => hi - lo));
  const scale = (scan.scene ? SCENE_SIZE : SIZE) / extent;
  const translate = new THREE.Vector3(...ranges.map(([lo, hi]) => (lo + hi) / 2)).multiplyScalar(-scale);
  const points = new Float32Array(axes[0].length * 3);
  axes[0].forEach((_, i) => {
    points[i * 3] = axes[0][i] * scale + translate.x;
    points[i * 3 + 1] = axes[1][i] * scale + translate.y;
    points[i * 3 + 2] = axes[2][i] * scale + translate.z;
  });
  return { quaternion, scale, translate, points };
}

interface LoadedScan {
  arrays: GpuArrays;
  quaternion: THREE.Quaternion;
  scale: number;
  translate: THREE.Vector3;
  points: Float32Array;
}

// Loaded scans stay on the GPU, so switching back is instant
const scans = new Map<string, Promise<LoadedScan>>();
let loaded: LoadedScan | undefined;

// A point of the scan's upright frame (before scaling) in the normalized frame
const placedPoint = (point: [number, number, number]) => new THREE.Vector3(...point).multiplyScalar(loaded?.scale ?? 1).add(loaded?.translate ?? new THREE.Vector3());

function fetchScan(name: string, scan: Scan) {
  const task = loadSplats(scan.url, {
    name: scan.url,
    worker: true,
    onProgress: (fraction, stage) => {
      if (state.scan === name) {
        status.textContent = `loading ${scan.label.toLowerCase()}: ${stage} ${Math.round(fraction * 100)}%`;
      }
    },
  }).then((data) => ({ arrays: GpuArrays.fromData(renderer, data), ...normalization(data, scan) }));
  task.catch(() => scans.delete(name));
  return task;
}

async function setScan(name: string) {
  const scan = SCANS[name];
  if (!scan) {
    return;
  }
  state.scan = name;
  ($("scan") as HTMLSelectElement).value = name;
  renderPane.classList.add("loading");
  status.textContent = `loading ${scan.label.toLowerCase()}…`;
  if (!scans.has(name)) {
    scans.set(name, fetchScan(name, scan));
  }
  let next: LoadedScan;
  try {
    next = await scans.get(name)!;
  } catch (error) {
    status.textContent = `${scan.label}: ${error instanceof Error ? error.message : String(error)}`;
    renderPane.classList.remove("loading");
    return;
  }
  if (state.scan !== name) {
    return;
  }
  loaded = next;
  normalized.quaternion.copy(next.quaternion);
  normalized.scale.setScalar(next.scale);
  normalized.position.copy(next.translate);
  collections.clear();
  install();
  splats.objectParams.blurAmount = scan.preBlur ? 0 : 0.3;
  splats.objectParams.preBlurAmount = scan.preBlur ? 0.3 : 0;
  scene.background = scan.sky ? skyTexture() : null;
  applyPixelRatio();
  if (framed) {
    frameCamera();
  }
  renderPane.classList.remove("loading");
  renderPane.classList.remove("pop");
  void renderPane.offsetWidth;
  renderPane.classList.add("pop");
}

// The sampled center nearest the camera within a small radius of the ray, else
// (unless strict) the one nearest the ray, as local and world points
function pick(clientX: number, clientY: number, strict = false) {
  const points = loaded?.points;
  if (!points || points.length === 0) {
    return undefined;
  }
  const rect = renderer.domElement.getBoundingClientRect();
  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1), camera);
  const { origin, direction } = raycaster.ray;
  model.updateMatrixWorld();
  const p = new THREE.Vector3();
  const radius2 = 0.02 ** 2;
  let hit = -1;
  let hitT = Infinity;
  let near = -1;
  let nearD = Infinity;
  for (let i = 0; i < points.length; i += 3) {
    p.fromArray(points, i).applyMatrix4(model.matrixWorld).sub(origin);
    const t = p.dot(direction);
    if (t <= 0) {
      continue;
    }
    const d2 = p.lengthSq() - t * t;
    if (d2 < radius2 && t < hitT) {
      hit = i;
      hitT = t;
    } else if (d2 < nearD) {
      near = i;
      nearD = d2;
    }
  }
  const index = hit >= 0 ? hit : strict ? -1 : near;
  if (index < 0) {
    return undefined;
  }
  const local = new THREE.Vector3().fromArray(points, index);
  return { local, world: local.clone().applyMatrix4(model.matrixWorld) };
}

// Fly mode's right drag orbits the splat under (x, y), in canvas CSS pixels
controls.pick = (x, y) => {
  const rect = renderer.domElement.getBoundingClientRect();
  return Promise.resolve(pick(rect.left + x, rect.top + y, true)?.world);
};

const START = performance.now();
const clock = () => (performance.now() - START) / 1000;

const animator = new Animator();
const doc = new GraphDoc(fxNodes, EXAMPLES[state.example].graph);
const view = new GraphView($("graph"), doc, { animator, sound, theme, settings });
let modifier: GraphModifier | undefined;
let probeModifier: GraphModifier | undefined;
let valid = true;
// The installed modifier, the last one drawn without throwing, and the structures that threw
let applied: GraphModifier | undefined;
let working: GraphModifier | undefined;
const failed = new Map<string, string>();
// The worker sort cannot see uniforms: sort again at the next render
let changed = true;

// The generator path's generators, and the scan's collections by modifier (undefined: plain)
const generators = new WeakMap<GraphModifier, ReturnType<typeof SplatGenerator.fromSplats>>();
const collections = new Map<unknown, SplatCollection>();

function collectionOf(target: GraphModifier | undefined) {
  if (!target) {
    return SplatCollection.arrays(loaded!.arrays, { matrixWorld: normalized.matrixWorld });
  }
  let generator = generators.get(target);
  if (!generator) {
    generator = SplatGenerator.fromSplats({ layout: "extSplats", modifiers: [inFrame(target.modifier)] });
    generators.set(target, generator);
  }
  return SplatCollection.object({ generator, data: { splats: loaded!.arrays }, count: loaded!.arrays.count, matrixWorld: normalized.matrixWorld });
}

// A modifier is a program key, so switching compiles only a new structure
function install() {
  const active = probeModifier ?? modifier;
  applied = active && !failed.has(active.key) ? active : working;
  const inGenerator = applyIn === "generator";
  splats.modifier = inGenerator ? undefined : applied?.modifier;
  splats.modifierSpace = state.placement === "object" ? model.matrixWorld : "world";
  if (loaded) {
    const key = inGenerator ? applied : undefined;
    let collection = collections.get(key);
    if (!collection) {
      collection = new SplatCollection([collectionOf(key)]);
      collections.set(key, collection);
    }
    splats.collection = collection;
  }
  changed = true;
}

// The generator path's frame: the normalized scan's (object) or the world
function updateFrame() {
  model.updateMatrixWorld();
  setFrame(state.placement === "object" ? normalized.matrix : normalized.matrixWorld);
}

function showErrors(errors: string[]) {
  errorsBox.replaceChildren();
  errorsBox.hidden = errors.length === 0;
  if (errors.length > 0) {
    const head = document.createElement("div");
    head.className = "fx-errors-head";
    head.textContent = modifier ? "The render shows the last graph that worked:" : "Nothing to show yet:";
    errorsBox.append(head);
    for (const message of errors) {
      const line = document.createElement("div");
      line.textContent = message;
      errorsBox.append(line);
    }
  }
}

function rebuild(reason?: string) {
  const errors = doc.errors();
  view.setErrors(errors);
  showErrors(errors);
  if (errors.length > 0) {
    if (valid && reason !== "load") {
      view.shakeErrors();
      sound.play("error");
    }
    valid = false;
    return;
  }
  modifier = buildGraphModifier(doc.graph);
  const recovered = !valid && reason !== "load";
  valid = true;
  updateProbe();
  install();
  if (failed.has(modifier.key)) {
    showErrors([failed.get(modifier.key)!]);
  }
  if (recovered) {
    view.celebrate();
    sound.play("ok");
  }
}

// The last click on the scan in both spaces, so input.click follows the placement
let lastClick: { local: THREE.Vector3; world: THREE.Vector3; time: number } | undefined;

function applyClick() {
  if (lastClick) {
    FxInputs.click.point.value.copy(state.placement === "object" ? lastClick.local : lastClick.world);
    FxInputs.click.time.value = lastClick.time;
    changed = true;
  }
}

let down: { x: number; y: number; time: number } | undefined;
renderer.domElement.addEventListener("pointerdown", (event) => {
  down = event.button === 0 ? { x: event.clientX, y: event.clientY, time: performance.now() } : undefined;
});
renderer.domElement.addEventListener("pointerup", (event) => {
  if (!down || Math.hypot(event.clientX - down.x, event.clientY - down.y) > 5 || performance.now() - down.time > 500) {
    return;
  }
  const hit = pick(event.clientX, event.clientY);
  if (!hit) {
    return;
  }
  lastClick = { ...hit, time: clock() };
  applyClick();
  const rect = renderPane.getBoundingClientRect();
  const ping = document.createElement("div");
  ping.className = "render-ping";
  ping.style.left = `${event.clientX - rect.left}px`;
  ping.style.top = `${event.clientY - rect.top}px`;
  ping.addEventListener("animationend", () => ping.remove());
  renderPane.append(ping);
  sound.play("drop");
});

// The camera for input.camera, in the modifier's space
const toModel = new THREE.Matrix4();
const drawingBuffer = new THREE.Vector2();
function feedCamera() {
  const { position, forward, pixelSize } = FxInputs.camera;
  camera.updateMatrixWorld();
  camera.getWorldPosition(position.value);
  camera.getWorldDirection(forward.value);
  if (state.placement === "object") {
    model.updateMatrixWorld();
    toModel.copy(model.matrixWorld).invert();
    position.value.applyMatrix4(toModel);
    forward.value.transformDirection(toModel);
  }
  // One drawing-buffer pixel at unit depth, the unit of the depth of field's blur
  pixelSize.value = (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) / Math.max(1, renderer.getDrawingBufferSize(drawingBuffer).y);
}

function setParam(name: string, value: Value) {
  for (const target of [modifier, probeModifier]) {
    try {
      if (target) {
        writeParam(target, name, value);
      }
    } catch {
      // Not a param of this graph (an input of a node the output does not reach)
    }
  }
  changed = true;
}

function updateProbe() {
  const port = view.probe;
  // A port inside a group is wired out to the top first
  const exposed = port && valid ? exposePort(doc.graph, fxNodes, doc.path, port) : undefined;
  const graph = exposed ? probeGraph(exposed.graph, fxNodes, exposed.port) : undefined;
  if (port && (!graph || validate(graph, fxNodes).length > 0)) {
    view.setProbe(undefined);
  }
  probeModifier = graph && view.probe ? buildGraphModifier(graph) : undefined;
}

doc.on((change) => {
  if (change.kind === "structure" && (change.reason === "enter" || change.reason === "exit")) {
    // Same graph, another level of it
    showLesson();
  } else if (change.kind === "structure") {
    rebuild(change.reason);
  } else if (change.kind === "value" && change.param && change.value !== undefined) {
    // Inside a group: every instance of it
    for (const name of change.params ?? [change.param]) {
      setParam(name, change.value);
    }
  }
  $("undo").toggleAttribute("disabled", !doc.canUndo);
  $("redo").toggleAttribute("disabled", !doc.canRedo);
});

view.onProbe = (port) => {
  view.setProbe(port);
  updateProbe();
  install();
  sound.play(port ? "open" : "pick");
};
view.onFlow = (on) => $("flow").classList.toggle("on", on);

function loadExample(name: string) {
  const example = EXAMPLES[name];
  if (!example) {
    return;
  }
  state.example = name;
  ($("example") as HTMLSelectElement).value = name;
  view.setProbe(undefined);
  probeModifier = undefined;
  doc.load(example.graph);
  showLesson();
}

// The example's lesson, or inside a group what the group does
function showLesson() {
  const example = EXAMPLES[state.example];
  const group = doc.group;
  $("lesson-title").textContent = group ? `${group.label ?? doc.groupName} (a group)` : example.label.replace(/^\d+ · /, "").replace(/ \(click\)$/, "");
  $("lesson-text").textContent = group ? group.description ?? "Nodes folded into one. Its inputs come in on the left, its outputs leave on the right." : example.graph.description ?? "";
  const source = $<HTMLAnchorElement>("lesson-source");
  source.hidden = !example.graph.source || Boolean(group);
  if (example.graph.source) {
    source.href = example.graph.source.url;
    source.textContent = `after ${example.graph.source.name} (${example.graph.source.license})`;
  }
}

function setPlacement(placement: Placement) {
  state.placement = placement;
  document.querySelectorAll<HTMLElement>("#place button").forEach((button) => button.classList.toggle("on", button.dataset.place === placement));
  applyClick();
  install();
}

function setSortMode(mode: "gpu" | "cpu") {
  splats.sortMode = webgpu ? mode : "cpu";
  document.querySelectorAll<HTMLButtonElement>("#sort button").forEach((button) => {
    button.classList.toggle("on", button.dataset.sort === splats.sortMode);
    button.disabled = button.dataset.sort === "gpu" && !webgpu;
  });
}

const exampleSelect = $("example") as HTMLSelectElement;
for (const group of ["Learn", "Effects", "From Spark", "World Labs", "Build"]) {
  const optgroup = document.createElement("optgroup");
  optgroup.label = group;
  for (const [name, example] of Object.entries(EXAMPLES).filter(([, e]) => e.group === group)) {
    optgroup.append(new Option(example.label, name));
  }
  exampleSelect.append(optgroup);
}
exampleSelect.addEventListener("change", () => loadExample(exampleSelect.value));
// Choosing the current example again reloads it: a select reports only
// changes, so it holds no value while open
exampleSelect.addEventListener("focus", () => {
  exampleSelect.dataset.previous = exampleSelect.value;
  exampleSelect.selectedIndex = -1;
});
exampleSelect.addEventListener("blur", () => {
  if (exampleSelect.selectedIndex === -1) {
    exampleSelect.value = exampleSelect.dataset.previous ?? state.example;
  }
});
// Hand the keys back to the editor after a choice
for (const id of ["example", "scan"]) {
  $(id).addEventListener("change", () => $(id).blur());
}

function switchTheme(name: ThemeName) {
  if (name === theme.name) {
    return;
  }
  const apply = () => {
    applyTheme(name);
    view.setTheme(theme);
    buildMotionFolder();
    updateViewport();
  };
  const transition = (document as Document & { startViewTransition?: (update: () => void) => unknown }).startViewTransition;
  if (transition && !view.instant) {
    transition.call(document, apply);
  } else {
    apply();
  }
  sound.play("pick");
}
document.querySelectorAll<HTMLElement>("#themes button").forEach((button) =>
  button.addEventListener("click", () => switchTheme(button.dataset.theme as ThemeName)));
const themeNames = Object.keys(THEMES) as ThemeName[];
document.addEventListener("keydown", (event) => {
  const target = event.target as HTMLElement;
  if (event.key.toLowerCase() !== "t" || event.metaKey || event.ctrlKey || event.altKey || !view.active
    || view.palette.open || target.closest?.("input, textarea, select")) {
    return;
  }
  switchTheme(themeNames[(themeNames.indexOf(theme.name) + (event.shiftKey ? themeNames.length - 1 : 1)) % themeNames.length]);
});

const scanSelect = $("scan") as HTMLSelectElement;
for (const [name, scan] of Object.entries(SCANS)) {
  scanSelect.append(new Option(scan.label, name));
}
scanSelect.addEventListener("change", () => void setScan(scanSelect.value));

document.querySelectorAll<HTMLElement>("#place button").forEach((button) => button.addEventListener("click", () => setPlacement(button.dataset.place as Placement)));
document.querySelectorAll<HTMLElement>("#sort button").forEach((button) => button.addEventListener("click", () => setSortMode(button.dataset.sort as "gpu" | "cpu")));
$("turntable").addEventListener("click", () => {
  state.turntable = !state.turntable;
  $("turntable").classList.toggle("on", state.turntable);
});
$("hidpi").addEventListener("click", () => {
  const next = !hiDpi();
  dprOverride = undefined;
  if (SCANS[state.scan]?.scene) {
    settings.hiDpiScenes = next;
  } else {
    settings.hiDpi = next;
  }
  saveSettings(settings);
  applyPixelRatio();
  updateViewport();
});
$("undo").addEventListener("click", () => view.undo());
$("redo").addEventListener("click", () => view.redo());
$("layout").addEventListener("click", () => void view.layout());
$("group").addEventListener("click", () => view.toggleGroup());
$("fit").addEventListener("click", () => view.fit());
$("flow").addEventListener("click", () => view.setFlow(!view.flow));
$("add").addEventListener("click", () => view.openPalette(view.root.clientWidth / 2 - 130, 60));
$("copy").addEventListener("click", async () => {
  await navigator.clipboard?.writeText(JSON.stringify(doc.graph, null, 2)).catch(() => {});
  view.juice.toast("graph JSON copied", "ok");
});
const soundButton = $("sound");
const showSound = () => {
  soundButton.classList.toggle("on", !sound.muted);
  soundButton.textContent = sound.muted ? "♪̸" : "♪";
  soundButton.title = sound.muted ? "Sound off" : "Sound on";
};
soundButton.addEventListener("click", () => {
  sound.muted = !sound.muted;
  settings.muted = sound.muted;
  saveSettings(settings);
  showSound();
  sound.play("ok");
});
showSound();
$("lesson-toggle").addEventListener("click", () => $("lesson").classList.toggle("collapsed"));

// The controls overlay, whose keys are handled in the capture phase, ahead of the editor's
const keys = $("keys");
function showKeys(show: boolean) {
  keys.hidden = !show;
  $("keys-button").classList.toggle("on", show);
  sound.play(show ? "open" : "pick");
}
const keysOpen = () => !keys.hasAttribute("hidden");
$("keys-button").addEventListener("click", () => showKeys(!keysOpen()));
keys.addEventListener("pointerdown", (event) => {
  if (!(event.target as HTMLElement).closest(".keys-card")) {
    showKeys(false);
  }
});
document.addEventListener("keydown", (event) => {
  if ((event.target as HTMLElement).closest?.("input, textarea, select")) {
    return;
  }
  if (event.key === "?" || (event.key === "Escape" && keysOpen())) {
    showKeys(event.key === "?" && !keysOpen());
    event.preventDefault();
    event.stopImmediatePropagation();
  }
}, true);

const divider = $("divider");
divider.addEventListener("pointerdown", (event) => {
  divider.setPointerCapture(event.pointerId);
  const move = (e: PointerEvent) => {
    settings.split = Math.max(0.25, Math.min(0.8, 1 - e.clientX / innerWidth));
    applySplit();
  };
  const up = () => {
    divider.removeEventListener("pointermove", move);
    saveSettings(settings);
  };
  divider.addEventListener("pointermove", move);
  divider.addEventListener("pointerup", up, { once: true });
});

const pane = new Pane({ container: $("pane"), title: "settings", expanded: false });
const motionState = { instant: settings.instant };
let motionFolder: FolderApi | undefined;
const settingsChanged = () => {
  saveSettings(settings);
  view.refresh();
};

function buildMotionFolder() {
  motionFolder?.dispose();
  motionFolder = pane.addFolder({ title: `motion (${theme.label})`, index: 0 });
  motionFolder.addBinding(motionState, "instant", { label: "instant" }).on("change", () => {
    settings.instant = motionState.instant;
    settingsChanged();
  });
  const motion = settings.motion[theme.name];
  motionFolder.addBinding(motion, "stiffness", { min: 20, max: 800 }).on("change", settingsChanged);
  motionFolder.addBinding(motion, "damping", { min: 0.1, max: 1.5 }).on("change", settingsChanged);
  motionFolder.addBinding(motion, "tilt", { min: 0, max: 0.06 }).on("change", settingsChanged);
  motionFolder.addBinding(motion, "squash", { min: 0, max: 10 }).on("change", settingsChanged);
  motionFolder.addBinding(motion, "stagger", { label: "stagger (ms/px)", min: 0, max: 2 }).on("change", settingsChanged);
  motionFolder.addButton({ title: "theme defaults" }).on("click", () => {
    Object.assign(motion, THEMES[theme.name].motion);
    motionFolder?.refresh();
    settingsChanged();
  });
}
buildMotionFolder();

const flowFolder = pane.addFolder({ title: "flow and layout", expanded: false });
flowFolder.addBinding(settings, "flowSpeed", { label: "flow waves/s", min: 0.1, max: 3 }).on("change", settingsChanged);
flowFolder.addBinding(settings, "layerSpacing", { label: "layer gap", min: 20, max: 240, step: 1 }).on("change", settingsChanged);
flowFolder.addBinding(settings, "nodeSpacing", { label: "node gap", min: 8, max: 120, step: 1 }).on("change", settingsChanged);
const soundFolder = pane.addFolder({ title: "sound", expanded: false });
soundFolder.addBinding(settings, "volume", { min: 0, max: 1 }).on("change", () => {
  sound.volume = settings.volume;
  saveSettings(settings);
});
addControlsFolder(pane, controls);

setPlacement(state.placement);
setSortMode(splats.sortMode);
loadExample(state.example);
void setScan(state.scan);

let last = performance.now();
let frames = 0;
let fpsTime = last;
let fps = 0;
// Renders, and the first render of the drawn modifier with the scan loaded
let renderCount = 0;
let shownAt = 0;
let shown: unknown;

function render() {
  const now = performance.now();
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (state.turntable) {
    model.rotation.y += dt * 0.5;
  }
  // The settings panel can switch the mode too
  if (!document.querySelector(`#camera-mode button.on[data-mode="${controls.mode}"]`)) {
    setCameraMode(controls.mode);
  }
  controls.update();
  FxInputs.time.value = clock();
  feedCamera();
  updateFrame();

  // The worker sort follows camera and matrix moves but not uniforms. A request
  // during a sort runs after it, so this keeps pace with the worker.
  const active = probeModifier ?? modifier;
  if (splats.sortMode === "cpu" && (changed || active?.usesTime)) {
    splats.requestSort();
  }
  changed = false;

  // A graph whose TSL fails to build throws here: show the last one that worked
  const drawn = applied;
  try {
    renderer.render(scene, camera);
    working = drawn ?? working;
  } catch (error) {
    if (!drawn || drawn === working) {
      throw error;
    }
    const message = `${drawn.key}: ${error instanceof Error ? error.message : String(error)}`;
    console.error(error);
    failed.set(drawn.key, message);
    showErrors([message]);
    install();
  }
  renderCount += 1;
  if (shown !== applied || !loaded) {
    shown = applied;
    shownAt = renderCount;
  }

  frames += 1;
  if (now - fpsTime > 500) {
    fps = (frames * 1000) / (now - fpsTime);
    frames = 0;
    fpsTime = now;
    if (!renderPane.classList.contains("loading") && loaded) {
      const probing = view.probe ? `  probe ${view.probe}` : "";
      status.textContent = `${caps.backend}  ${loaded.arrays.count.toLocaleString()} splats  ${fps.toFixed(0)} fps  ${splats.sortMode} sort  ${state.placement} space (${applyIn})${probing}`;
    }
  }
}
renderer.setAnimationLoop(render);

interface CheckResult {
  name: string;
  ok: boolean;
  detail?: string;
}

// Resolves after count renders of the current modifier with the scan loaded
function renders(count = 2) {
  const start = renderCount;
  return new Promise<void>((resolve) => {
    const wait = () => {
      const drawn = loaded !== undefined && shown === applied && renderCount - shownAt + 1 >= count;
      return drawn && renderCount - start >= count ? resolve() : requestAnimationFrame(wait);
    };
    wait();
  });
}

// renders(), then with the worker sort a fresh order applied and drawn, so both
// of the modifier's programs are built
async function settled() {
  await renders();
  if (splats.sortMode === "cpu") {
    const view = splats.viewFor("main");
    view.apply(await view.sort(camera));
    await renders();
  }
}

async function selfTest() {
  const results: CheckResult[] = [];
  const report = (name: string, detail?: string) => {
    results.push({ name, ok: !detail, detail });
    (detail ? console.error : console.log)(`${detail ? "FAIL" : "ok  "}  ${name}${detail ? `  (${detail})` : ""}`);
  };
  for (const [name, graph, check] of VALUE_CHECKS) {
    const run = await runGraph(renderer, graph).catch((error) => String(error));
    report(`value: ${name}`, typeof run === "string" ? run : !run ? "pass did not run" : check(run));
  }

  const current = state.example;
  for (const [name, example] of Object.entries(EXAMPLES)) {
    const key = graphKey(example.graph, fxNodes);
    loadExample(name);
    await settled();
    report(`${name}: renders`, failed.get(`fx:${key}`) ?? (applied === modifier && working === modifier ? undefined : "not drawn"));

    await view.layout({ animate: false });
    report(`${name}: layout keeps the structure`, graphKey(doc.graph, fxNodes) === key ? undefined : "key changed");
    const copy = JSON.parse(JSON.stringify(doc.graph)) as Graph;
    report(`${name}: JSON round-trip validates`, validate(copy, fxNodes).join("; ") || undefined);
    if (name !== "blank") {
      const run = await runGraph(renderer, example.graph).catch((error) => String(error));
      report(`${name}: runs on the GPU`, typeof run === "string" ? run : !run ? "pass did not run" : finite(run) ? undefined : "non-finite");
    }

    const param = graphParams(doc.graph, fxNodes).find((p) => p.type === "float");
    if (param && modifier) {
      const programs = SplatProjector.programs;
      const value = (param.value as number) + 0.25;
      doc.setValue(param.node, param.input, value, "selftest");
      doc.endGesture();
      await settled();
      const ok = SplatProjector.programs === programs && getParam(modifier, param.name) === value && modifier.uniforms.get(param.name)?.value === value;
      report(`${name}: value edit without rebuild (${param.name})`, ok ? undefined : `programs ${programs} -> ${SplatProjector.programs}, value ${String(getParam(modifier, param.name))}`);
    }

    const outputs = Object.keys(doc.graph.nodes).flatMap((id) =>
      Object.keys(doc.lookup.get(doc.graph.nodes[id].type)?.outputs ?? {}).map((port) => `${id}.${port}`));
    const bad = outputs.filter((port) => {
      const probe = probeGraph(doc.graph, fxNodes, port);
      return probe && validate(probe, fxNodes).length > 0;
    });
    report(`${name}: ${outputs.length} probe graphs validate`, bad.length ? bad.join(", ") : undefined);
    for (const id of Object.keys(doc.graph.nodes).filter((node) => doc.isGroupNode(node))) {
      await checkGroup(name, id, report);
    }
    if (name !== "blank") {
      // Folding every node but the output into a group and back keeps the program
      const scratch = new GraphDoc(fxNodes, example.graph);
      const outputId = Object.keys(scratch.graph.nodes).find((node) => fxNodes.get(scratch.graph.nodes[node].type)?.output);
      const card = scratch.groupNodes(Object.keys(scratch.graph.nodes).filter((node) => node !== outputId));
      const grouped = scratch.errors();
      const groupedKey = grouped.length ? "" : graphKey(scratch.graph, fxNodes);
      if (card) {
        scratch.ungroup(card);
      }
      const back = scratch.errors();
      report(`${name}: group and ungroup`, grouped.join("; ") || back.join("; ") || (card && graphKey(scratch.graph, fxNodes) !== key ? "program changed" : undefined) || (groupedKey ? undefined : "no key"));
    }
  }
  loadExample(current);
  const failures = results.filter((r) => !r.ok).length;
  console.log(`Radix fxedit selfTest on ${caps.backend} (${splats.sortMode} sort): ${results.length - failures}/${results.length} passed`);
  return { backend: caps.backend, sortMode: splats.sortMode, passed: results.length - failures, total: results.length, failures: results.filter((r) => !r.ok) };
}

async function checkGroup(name: string, id: string, report: (name: string, detail?: string) => void) {
  doc.enter(id);
  const level = doc.level;
  const ports = Object.keys(level.nodes).flatMap((node) => Object.keys(doc.lookup.get(level.nodes[node].type)?.outputs ?? {}).map((port) => `${node}.${port}`));
  const bad = ports.filter((port) => {
    const exposed = exposePort(doc.graph, fxNodes, doc.path, port);
    // Types the probe viewer shows (not vec2 / vec4) must validate
    const probe = exposed && probeGraph(exposed.graph, fxNodes, exposed.port);
    return !exposed || (probe && validate(probe, fxNodes).length > 0);
  });
  report(`${name}: ${ports.length} probes inside group ${id}`, bad.length ? bad.join(", ") : undefined);
  const sources = doc.sources();
  const target = Object.entries(level.nodes).flatMap(([node, n]) => Object.entries(doc.lookup.get(n.type)?.inputs ?? {})
    .filter(([input, def]) => def.type === "float" && !def.optional && !sources.has(`${node}.${input}`)).map(([input]) => [node, input]))[0];
  if (target && modifier) {
    const [node, input] = target;
    const programs = SplatProjector.programs;
    const value = Number(level.nodes[node].inputs?.[input] ?? doc.def(node)!.inputs[input].default) + 0.125;
    doc.setValue(node, input, value, "selftest-group");
    doc.endGesture();
    await settled();
    const flat = doc.flatParams(`${node}.${input}`);
    const ok = SplatProjector.programs === programs && flat.every((param) => {
      try {
        return getParam(modifier!, param) === value;
      } catch {
        return true;
      }
    });
    report(`${name}: value edit inside group ${id} (${node}.${input})`, ok ? undefined : "rebuilt or not written");
  }
  doc.exit(0);
}

const handle = {
  renderer, scene, camera, controls, splats, model, doc, view, settings, sound, examples: EXAMPLES,
  modifier: () => probeModifier ?? modifier,
  applyIn, loadExample, setScan, setPlacement, setSortMode, selfTest,
  // Points in the scan's upright frame before scaling
  placedView: (position: [number, number, number], target: [number, number, number]) => {
    camera.position.copy(placedPoint(position));
    controls.lookAt(placedPoint(target));
  },
  setTheme: switchTheme,
  // Once the scan is drawn with the first graph, with the worker sort in its first order
  ready: false,
};
Object.assign(window, { radixFxedit: handle });
void renders(1).then(function waitForOrder() {
  if (splats.sortMode === "gpu" || splats.views.get("main")?.order?.collection === splats.collection) {
    handle.ready = true;
  } else {
    requestAnimationFrame(waitForOrder);
  }
});
