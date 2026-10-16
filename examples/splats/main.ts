// Radix's splat viewer: one .ply / .spz / .rad / .rdx file at a time,
// opened, dropped, pasted as a URL or picked from the samples (catalog.ts),
// drawn as the one object of a SplatRenderer's collection and placed by
// `model` (the gizmo's object). Sorted on the GPU with WebGPU, or by the
// WebGL2 fallback's worker sort when the camera or the model moves. A static
// page on the library bundle. The quick bar (quickBar.ts) holds the likely
// options, the Tweakpane panel (gui.ts) the rest. Query parameters:
//   ?url=      a splat file URL
//   ?scan=     a sample: butterfly (the default) | ceramic, or with spherical
//              harmonics: sutro | grace | bicycle | garden
//   ?sh=       how files load their spherical harmonics: ext (default) |
//              packed | 0 (skipped); the bar's "SH" sets the highest degree
//              drawn (objectParams.maxShDegree), up to the file's
//   ?method=   ewa | 3dgut | htgs | raygs
//   ?bits=     sort key width: 16 | 24 (default) | 32
//   ?sort=cpu  the WebGL2 fallback's worker sort, also on WebGPU
//   ?gpu=      webgpu | webgpu-gl
//   ?layout=packed  16-byte packed splats instead of 32-byte ext splats
//   ?flip=0    files as stored (scans are usually y-down, so flipped by default)
//   ?hdr=0 | 1 (default: HDR when the display has it), ?dpr=0 (pixel
//   ratio 1), ?stereo=1 (two eyes side by side)
//   ?profile=1 GPU timestamps per phase from the start (default off, as
//              they cost frame time; the Monitors' "GPU timing" switches them)
// `radixSplats` in the console holds the viewer.
import * as THREE from "three";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import {
  CameraControls, GpuArrays, GpuProfiler, GpuShPalette, Sh, SplatCollection, SplatRenderer, Splats, createRenderer, getGpuCaps, loadSplatFile, writeSplats,
  type ArrayData, type ProjectionMethod, type ShPalette, type ShTarget, type SortKeyBits, type SplatSource,
} from "@sparkjsdev/radix";
import { SCANS, scanRotation, skyTexture, type Scan } from "./catalog.js";
import { makeGui } from "./gui.js";
import { formatCount, makeQuickBar } from "./quickBar.js";

const params = new URLSearchParams(location.search);
const status = document.getElementById("status")!;
const toast = document.getElementById("toast")!;
const drop = document.getElementById("drop")!;
const picker = document.getElementById("picker") as HTMLInputElement;

const hdr = params.get("hdr");
const renderer = await createRenderer({ profile: true, hdr: hdr === "1" ? true : hdr === "0" ? false : "auto" });
const caps = getGpuCaps(renderer);
const webgpu = caps.backend === "webgpu";
const profiler = renderer.inspector instanceof GpuProfiler ? renderer.inspector : undefined;
if (profiler) {
  profiler.active = params.get("profile") === "1";
}
document.body.prepend(renderer.domElement);

// What the bar and the panel set beyond the splat renderer's own settings;
// the frame loop applies it
export const state = {
  layout: (params.get("layout") === "packed" ? "packedSplats" : "extSplats") as "extSplats" | "packedSplats",
  stereo: params.get("stereo") === "1",
  devicePixels: params.get("dpr") !== "0",
  gizmo: "off" as "off" | "translate" | "rotate" | "scale",
  sky: false,
  background: { r: 0, g: 0, b: 0 },
  exportFormat: "rdx" as "rdx" | "ply" | "compressed-ply" | "spz",
  // The SH codec files load into (false: skipped)
  sh: (params.get("sh") === "0" ? false : params.get("sh") === "packed" ? "packed" : "ext") as ShTarget,
};
export type ViewerState = typeof state;

const pixelRatio = () => (state.devicePixels ? devicePixelRatio : 1);
renderer.setPixelRatio(pixelRatio());
renderer.setSize(innerWidth, innerHeight);

const scene = new THREE.Scene();
const background = new THREE.Color();
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.01, 1000);
camera.position.set(0, 0, 3);
const controls = new CameraControls({ canvas: renderer.domElement, object: camera, storageKey: "radix-splats", settings: { mode: "orbit" } });
controls.lookAt(new THREE.Vector3());

// --- The splats: one file's GpuArrays, the one object of the renderer's collection ---

let data: ArrayData | undefined;
// The palette of data's shLabel (RAD's clustered SH)
let shPalette: ShPalette | undefined;
// data's spherical-harmonics degree (0 without)
let shDegree = 0;
let arrays: GpuArrays | undefined;
let current: { name: string; source: SplatSource; scan?: Scan } | undefined;

// The file's transform (the gizmo moves it)
const model = new THREE.Object3D();
scene.add(model);

// The CPU sort re-sorts after the camera moves 5 cm or turns 5 degrees, and
// drops splats more than half a view outside the edges (the GPU sort culls
// to the view itself)
const splats = new SplatRenderer({
  renderer,
  method: (params.get("method") ?? "ewa") as ProjectionMethod,
  sortBits: Number(params.get("bits") ?? 24) as SortKeyBits,
  sortMode: webgpu && params.get("sort") !== "cpu" ? "gpu" : "cpu",
  autoSort: { distance: 0.05, angle: THREE.MathUtils.degToRad(5) },
});
if (profiler) {
  splats.phase = (name, run) => profiler.phase(name, run);
}
// Before the gizmo, which it would otherwise cover
splats.renderOrder = -1;
scene.add(splats);

// --- Status and errors ---

// A file's name without its folder or extension
const baseName = (name: string) => name.replace(/[?#].*$/, "").split("/").pop()!.replace(/\.\w+$/, "") || name;

const tasks = new Map<object, string>();
function startTask(label: string) {
  const key = {};
  tasks.set(key, `${label}...`);
  return {
    progress: (fraction: number, stage: string) => tasks.set(key, `${label}: ${stage} ${Math.round(fraction * 100)}%`),
    done: () => tasks.delete(key),
  };
}

// A dismissible message at the bottom, gone after 12 s
function showError(message: string) {
  const item = Object.assign(document.createElement("div"), { className: "toast-item", textContent: message });
  const close = Object.assign(document.createElement("button"), { textContent: "×", title: "Dismiss", onclick: () => item.remove() });
  item.append(close);
  toast.append(item);
  setTimeout(() => item.remove(), 12000);
}
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

// --- Loading: one file at a time, replacing the last ---

const flipFiles = params.get("flip") !== "0";
let loadRequest = 0;

async function open(name: string, source: SplatSource, scan?: Scan) {
  const request = ++loadRequest;
  const task = startTask(baseName(name));
  try {
    const loaded = await loadSplatFile(source, { name, worker: true, layout: state.layout, sh: state.sh, onProgress: task.progress });
    if (request !== loadRequest) {
      return;
    }
    data = loaded.splats;
    shPalette = loaded.shPalette;
    shDegree = Sh.find(data.bundles)?.degree ?? shPalette?.degree ?? 0;
    const fileArrays = (arrays = GpuArrays.fromData(renderer, loaded.splats));
    const paletteArrays = shPalette && GpuShPalette.upload(renderer, shPalette);
    // The arrays go once nothing draws or sorts this file's object
    const release = () => {
      fileArrays.dispose();
      paletteArrays?.dispose();
    };
    splats.collection = new SplatCollection([SplatCollection.arrays(fileArrays, { matrixWorld: model.matrixWorld, shPalette: paletteArrays, release })]);
    const reloaded = current?.source === source;
    current = { name, source, scan };
    if (Splats.findLodTree(loaded.splats)) {
      showError(`${baseName(name)} has a LoD tree: every node is drawn (no LoD rendering yet)`);
    }
    if (!reloaded) {
      place(scan);
      resetView();
    }
    gui.refresh();
  } catch (error) {
    showError(`${baseName(name)}: ${errorText(error)}`);
  } finally {
    task.done();
  }
}

const openSample = (name: string) => {
  const scan = SCANS[name];
  if (scan) {
    void open(scan.label, scan.url, scan);
  }
};
const openUrl = (url: string) => void open(url, url);

picker.addEventListener("change", () => {
  const file = picker.files?.[0];
  if (file) {
    void open(file.name, file);
  }
  picker.value = "";
});

// The drop overlay shows while files are dragged over the page
const dragsFiles = (event: DragEvent) => event.dataTransfer?.types.includes("Files") === true;
addEventListener("dragover", (event) => {
  if (dragsFiles(event)) {
    event.preventDefault();
    drop.classList.add("visible");
  }
});
addEventListener("dragleave", (event) => {
  if (!event.relatedTarget) {
    drop.classList.remove("visible");
  }
});
addEventListener("drop", (event) => {
  event.preventDefault();
  drop.classList.remove("visible");
  const file = event.dataTransfer?.files[0];
  if (file) {
    void open(file.name, file);
  }
});

// --- Placing the file and the camera ---

// Samples upright with their blur and sky; files flipped unless ?flip=0
function place(scan?: Scan) {
  model.position.set(0, 0, 0);
  model.scale.setScalar(1);
  model.quaternion.copy(scan ? scanRotation(scan) : flipFiles ? new THREE.Quaternion(1, 0, 0, 0) : new THREE.Quaternion());
  splats.objectParams.blurAmount = scan?.preBlur ? 0 : 0.3;
  splats.objectParams.preBlurAmount = scan?.preBlur ? 0.3 : 0;
  state.sky = scan?.sky ?? false;
  if (scan) {
    controls.mode = scan.mode ?? "orbit";
  }
}

// The sample's start view, else framed
function resetView() {
  const view = current?.scan?.view;
  if (!view) {
    frame();
    return;
  }
  camera.fov = view.fov;
  camera.near = 0.01;
  camera.far = 1000;
  camera.updateProjectionMatrix();
  camera.position.fromArray(view.position);
  controls.lookAt(new THREE.Vector3(...view.target));
}

// Look at the splats from in front, far enough to see the bulk of them: the
// 2nd to 98th percentile of sampled centers per axis, so floaters do not
// count. Not while exporting: writeSplats lends data's arrays to a worker.
let exporting = false;
function frame() {
  if (!data || exporting || data.count === 0) {
    return;
  }
  const { bundle } = Splats.get(data);
  const samples = Math.min(data.count, 65536);
  const axes = [new Float32Array(samples), new Float32Array(samples), new Float32Array(samples)];
  const center = { x: 0, y: 0, z: 0 };
  for (let s = 0; s < samples; s += 1) {
    Splats.loadCenter(bundle, Math.floor((s * data.count) / samples), center);
    axes[0][s] = center.x;
    axes[1][s] = center.y;
    axes[2][s] = center.z;
  }
  const [lo, hi] = [new THREE.Vector3(), new THREE.Vector3()];
  axes.forEach((values, axis) => {
    values.sort();
    lo.setComponent(axis, values[Math.floor(samples * 0.02)]);
    hi.setComponent(axis, values[Math.min(samples - 1, Math.floor(samples * 0.98))]);
  });
  model.updateMatrixWorld();
  const box = new THREE.Box3(lo, hi).applyMatrix4(model.matrixWorld);
  const middle = box.getCenter(new THREE.Vector3());
  const size = Math.max(box.getSize(new THREE.Vector3()).length(), 1e-3);
  camera.fov = 60;
  camera.near = size / 1000;
  camera.far = size * 50;
  camera.updateProjectionMatrix();
  camera.position.copy(middle).add(new THREE.Vector3(0, size * 0.2, size * 1.25));
  controls.lookAt(middle);
}

function flip() {
  model.quaternion.multiply(new THREE.Quaternion(1, 0, 0, 0));
  gui.refresh();
}

// The loaded splats, as loaded (not transformed)
async function exportFile() {
  if (!data || !current || exporting) {
    return;
  }
  const name = `${baseName(current.name)}.${state.exportFormat === "compressed-ply" ? "compressed.ply" : state.exportFormat}`;
  const task = startTask(name);
  exporting = true;
  try {
    const bytes = await writeSplats(data, state.exportFormat, { worker: true, shPalette, onProgress: task.progress });
    const url = URL.createObjectURL(new Blob([bytes]));
    Object.assign(document.createElement("a"), { href: url, download: name }).click();
    URL.revokeObjectURL(url);
  } catch (error) {
    showError(`Export: ${errorText(error)}`);
  } finally {
    exporting = false;
    task.done();
  }
}

// --- Panel, quick bar, gizmo ---

const gui = makeGui({
  state, webgpu, hdr: caps.hdr, renderer, profiler, splats, model, controls,
  actions: {
    reload: () => current && void open(current.name, current.source, current.scan),
    flip,
    frame,
    resetView,
    exportFile: () => void exportFile(),
  },
});
const bar = makeQuickBar(document.getElementById("bar")!, {
  state, webgpu, splats, controls,
  sample: () => current?.scan,
  shDegree: () => shDegree,
  actions: { pickFile: () => picker.click(), openUrl, openSample },
});

const gizmo = new TransformControls(camera, renderer.domElement);
gizmo.addEventListener("dragging-changed", (event) => (controls.enabled = !event.value));
gizmo.addEventListener("objectChange", () => gui.refresh());
scene.add(gizmo.getHelper());

addEventListener("keydown", (event) => {
  const target = event.target as HTMLElement | null;
  if (target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || event.metaKey || event.ctrlKey) {
    return;
  }
  const mode = ({ Digit1: "translate", Digit2: "rotate", Digit3: "scale", Escape: "off" } as Record<string, ViewerState["gizmo"]>)[event.code];
  if (mode) {
    state.gizmo = mode;
    gui.refresh();
  }
});

// --- Stereo: two eyes 64 mm apart side by side ---

const eyes = [0, 1].map(() => Object.assign(new THREE.PerspectiveCamera(), { viewport: new THREE.Vector4() }));
const stereoCamera = new THREE.ArrayCamera(eyes);
stereoCamera.add(...eyes);

function updateStereoCamera() {
  camera.getWorldPosition(stereoCamera.position);
  camera.getWorldQuaternion(stereoCamera.quaternion);
  const width = innerWidth / 2;
  eyes.forEach((eye, i) => {
    eye.position.set((i * 2 - 1) * 0.032, 0, 0);
    eye.viewport.set(i * width, 0, width, innerHeight);
    eye.fov = camera.fov;
    eye.near = camera.near;
    eye.far = camera.far;
    eye.aspect = width / innerHeight;
    eye.updateProjectionMatrix();
  });
  stereoCamera.updateMatrixWorld();
  return stereoCamera;
}

// --- Frame loop ---

let frames = 0;
let lastReport = performance.now();

function report(shown: THREE.Camera) {
  const now = performance.now();
  const total = arrays?.count ?? 0;
  bar.monitor((frames * 1000) / (now - lastReport), total);
  const sh = data && Sh.find(data.bundles);
  const shText = sh ? `, SH ${sh.degree} ${sh.codec}` : shPalette ? `, SH ${shPalette.degree} ${shPalette.codec} palette` : "";
  const file = current ? `${baseName(current.name)} (${state.layout === "extSplats" ? "ext" : "packed"}${shText})` : "none";
  const show = (drawn: number) => gui.monitor({ file, drawn: `${formatCount(drawn)} of ${formatCount(total)}` });
  if (splats.sortMode === "gpu") {
    void splats.readSortedCount().then(show);
  } else {
    // The CPU order of the shown camera's view
    const order = splats.views.get(shown)?.order;
    show(order?.collection === splats.collection ? order.visible : 0);
  }
  void profiler?.collect().then((profile) => gui.profile(profile));
  frames = 0;
  lastReport = now;
}

renderer.setAnimationLoop(() => {
  gui.frameBegin();
  profiler?.beginFrame();
  if (renderer.getPixelRatio() !== pixelRatio()) {
    renderer.setPixelRatio(pixelRatio());
  }
  controls.update();
  bar.refresh();

  scene.background = state.sky ? skyTexture() : background.setRGB(state.background.r, state.background.g, state.background.b, THREE.SRGBColorSpace);
  gizmo.enabled = state.gizmo !== "off";
  if (state.gizmo === "off") {
    gizmo.detach();
  } else {
    gizmo.attach(model);
    gizmo.setMode(state.gizmo);
  }

  const shown = state.stereo ? updateStereoCamera() : camera;
  const draw = () => renderer.render(scene, shown);
  if (profiler) {
    profiler.phase("draw", draw);
  } else {
    draw();
  }

  frames += 1;
  if (performance.now() - lastReport > 500) {
    report(shown);
  }
  status.textContent = tasks.size > 0 ? [...tasks.values()].join("\n") : arrays ? "" : "Drop a .ply, .spz, .rad or .rdx file anywhere, or Open...";
  gui.frameEnd();
});

addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// The initial file: ?scan=, else ?url=, else the butterfly
const scan = params.get("scan") ?? "";
const url = params.get("url") ?? undefined;
if (url && !SCANS[scan]) {
  openUrl(url);
} else {
  openSample(SCANS[scan] ? scan : "butterfly");
}

Object.assign(window, {
  radixSplats: { renderer, scene, camera, controls, splats, model, gizmo, state, gui, bar, open, openUrl, openSample, frame, resetView, flip, exportFile, data: () => data, arrays: () => arrays },
});
