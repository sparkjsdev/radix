// Shows PlayCanvas SOG (v2) and SOGS (v1) files, bundled or not, and SOG LoD scenes
// Query parameters:
//   ?sample=   a sample in catalog.ts (default hall)
//   ?url=      a .sog, .zip, meta.json or lod-meta.json, when ?sample= names no sample
//   ?sogs=     the samples' folder, served with CORS headers (default the GCS folder in catalog.ts)
//   ?decode=   cpu (default) | gpu, for single files (LoD scenes: gpu)
//   ?layout=packed  16-byte packed splats instead of 32-byte ext (CPU decode)
//   ?sh=       SH degree drawn, up to the file's: 0 to 3 (default 3)
//   ?method=   ewa (default) | 3dgut | htgs | raygs
//   ?bits=     sort key width: 16 | 24 (default) | 32
//   ?sort=cpu  the WebGL2 fallback's worker sort, also on WebGPU
//   ?gpu=      webgpu | webgpu-gl (default webgpu where available)
//   ?budget=   LoD splats selected, 0 for no budget (default 4M, or 2M with the CPU sort)
//   ?budgetMode= limit (default: the budget caps) | target (detail fills the budget)
//   ?underfill= coarser levels a LoD leaf may show while its selected one loads (default 5)
//   ?flip=0    files other than samples as stored (default a half turn about x)
//   ?hdr=      0 | 1 (default HDR when the display has it)
//   ?dpr=0     pixel ratio 1 (default the device's)
//   ?stereo=1  two eyes side by side
//   ?profile=1 GPU timestamps from the start (default off; the panel switches them)
// radixSogs in the console holds the viewer, with:
//   validate({ reference, samples = 4096 })  decoding, SH and LoD checks; reference
//              is the shown file as a PLY from splat-transform
//   measure({ frames = 240, from, to, target })  frame times, on a camera path when given
import * as THREE from "three";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import {
  CameraControls, GpuArrays, GpuProfiler, GpuShPalette, SplatCollection, SplatRenderer, Splats, createRenderer, getGpuCaps,
  type ArrayData, type ProjectionMethod, type SortKeyBits,
} from "@sparkjsdev/radix";
import { SAMPLES, sampleRotation, skyTexture, type Sample } from "./catalog.js";
import { decodeSogGpu } from "./gpuDecode.js";
import { makeGui } from "./gui.js";
import { defaultLodSettings, parseLod } from "./lod.js";
import { SogLodStream } from "./lodStream.js";
import { formatCount, makeQuickBar } from "./quickBar.js";
import { Resident } from "./resident.js";
import { sogObject, type SogArrays } from "./sh.js";
import { decodeSog, openSogInput, type SogMeta, type SogSource } from "./sog.js";
import { validate, type ValidateOptions } from "./validate.js";

const params = new URLSearchParams(location.search);
const status = document.getElementById("status")!;
const toast = document.getElementById("toast")!;
const drop = document.getElementById("drop")!;
const picker = document.getElementById("picker") as HTMLInputElement;

const gpu = params.get("gpu");
const hdr = params.get("hdr");
const renderer = await createRenderer({ backend: gpu === "webgpu" || gpu === "webgpu-gl" ? gpu : "auto", profile: true, hdr: hdr === "1" ? true : hdr === "0" ? false : "auto" });
const caps = getGpuCaps(renderer);
const webgpu = caps.backend === "webgpu";
const profiler = renderer.inspector instanceof GpuProfiler ? renderer.inspector : undefined;
if (profiler) {
  profiler.active = params.get("profile") === "1";
}
document.body.prepend(renderer.domElement);
const cpuSort = !webgpu || params.get("sort") === "cpu";

// What the bar and the panel set beyond the splat renderer's settings
export const state = {
  layout: (params.get("layout") === "packed" ? "packedSplats" : "extSplats") as "extSplats" | "packedSplats",
  decode: (params.get("decode") === "gpu" ? "gpu" : "cpu") as "cpu" | "gpu",
  sh: Math.min(3, Math.max(0, Number(params.get("sh") ?? 3))),
  stereo: params.get("stereo") === "1",
  devicePixels: params.get("dpr") !== "0",
  gizmo: "off" as "off" | "translate" | "rotate" | "scale",
  sky: false,
  background: { r: 0, g: 0, b: 0 },
  lod: {
    ...defaultLodSettings(cpuSort),
    ...(params.has("budget") ? { splatBudget: Number(params.get("budget")) } : {}),
    ...(params.get("budgetMode") === "limit" || params.get("budgetMode") === "target" ? { budgetMode: params.get("budgetMode") as "limit" | "target" } : {}),
    ...(params.has("underfill") ? { underfillLimit: Number(params.get("underfill")) } : {}),
  },
};
export type ViewerState = typeof state;

const pixelRatio = () => (state.devicePixels ? devicePixelRatio : 1);
renderer.setPixelRatio(pixelRatio());
renderer.setSize(innerWidth, innerHeight);

const scene = new THREE.Scene();
const background = new THREE.Color();
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.01, 1000);
camera.position.set(0, 0, 3);
const controls = new CameraControls({ canvas: renderer.domElement, object: camera, settings: { mode: "orbit" } });
controls.lookAt(new THREE.Vector3());

// The shown file's transform, which the gizmo moves
const model = new THREE.Object3D();
scene.add(model);

const splats = new SplatRenderer({
  renderer,
  method: (params.get("method") ?? "ewa") as ProjectionMethod,
  sortBits: Number(params.get("bits") ?? 24) as SortKeyBits,
  sortMode: cpuSort ? "cpu" : "gpu",
  autoSort: { distance: 0.05, angle: THREE.MathUtils.degToRad(5) },
});
if (profiler) {
  splats.phase = (name, run) => profiler.phase(name, run);
}
// Before the gizmo, which it would otherwise cover
splats.renderOrder = -1;
scene.add(splats);

const baseName = (name: string) => name.replace(/[?#].*$/, "").split("/").filter(Boolean).slice(-2).join("/") || name;

const tasks = new Map<object, string>();
function startTask(label: string) {
  const key = {};
  tasks.set(key, `${label}...`);
  return {
    progress: (fraction: number, stage: string) => tasks.set(key, `${label}: ${stage} ${Math.round(fraction * 100)}%`),
    done: () => tasks.delete(key),
  };
}

function showError(message: string) {
  const item = Object.assign(document.createElement("div"), { className: "toast-item", textContent: message });
  const close = Object.assign(document.createElement("button"), { textContent: "×", title: "Dismiss", onclick: () => item.remove() });
  item.append(close);
  toast.append(item);
  setTimeout(() => item.remove(), 12000);
}
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

type OpenInput = string | File | File[];

interface Shown {
  name: string;
  input: OpenInput;
  sample?: Sample;
  format: string;
  // Splats of the file, or of the scene's finest level
  count: number;
  // Until drawn, for a LoD scene until its first selection is
  loadMs?: number;
  started: number;
  // In the file's own frame
  bounds: THREE.Box3;
  file?: SogArrays;
  source?: SogSource;
  data?: ArrayData;
  meta?: SogMeta;
  resident?: Resident;
  stream?: SogLodStream;
}

let shown: Shown | undefined;
let loadRequest = 0;

const unlog = (v: number) => Math.sign(v) * (Math.exp(Math.abs(v)) - 1);
const meansBounds = (meta: SogMeta) =>
  new THREE.Box3(new THREE.Vector3(...meta.means.mins.map(unlog)), new THREE.Vector3(...meta.means.maxs.map(unlog)));

function release(old?: Shown) {
  old?.resident?.drop();
  old?.stream?.dispose();
}

// The collection of a single file (a LoD stream makes its own each update)
function rebuild() {
  if (!shown) {
    splats.collection = SplatCollection.EMPTY;
  } else if (shown.stream) {
    shown.stream.setDegree(state.sh);
  } else {
    const { file, resident } = shown;
    splats.collection = new SplatCollection([sogObject(file!, { degree: state.sh, matrixWorld: model.matrixWorld, release: resident!.hold() })]);
  }
}

async function open(name: string, input: OpenInput, sample?: Sample) {
  const request = ++loadRequest;
  const task = startTask(baseName(name));
  const started = performance.now();
  try {
    const opened = await openSogInput(input, { name, onProgress: task.progress });
    let next: Shown;
    if (opened.kind === "lod") {
      const tree = parseLod(opened.json, opened.url);
      if (request !== loadRequest) {
        return;
      }
      const stream = new SogLodStream({ renderer, tree, camera, matrixWorld: model.matrixWorld, settings: state.lod, degree: state.sh });
      const files = tree.files.length + (tree.environment ? 1 : 0);
      next = {
        name, input, sample, started, stream, count: tree.levelTotals[0],
        format: `SOG LoD: ${tree.levels} levels, ${files} files, ${tree.leaves} leaves`,
        bounds: new THREE.Box3(new THREE.Vector3(...tree.min), new THREE.Vector3(...tree.max)),
      };
    } else {
      const { source } = opened;
      const { meta } = source;
      let file: SogArrays;
      let data: ArrayData | undefined;
      if (state.decode === "gpu") {
        file = await decodeSogGpu(renderer, source, { onProgress: task.progress });
      } else {
        const decoded = await decodeSog(source, { layout: state.layout, onProgress: task.progress });
        data = decoded.data;
        file = {
          arrays: GpuArrays.fromData(renderer, decoded.data), palette: decoded.palette && GpuShPalette.upload(renderer, decoded.palette),
          degree: decoded.degree, layout: state.layout,
        };
      }
      const resident = new Resident(() => {
        file.arrays.dispose();
        file.palette?.dispose();
      });
      if (request !== loadRequest) {
        resident.drop();
        return;
      }
      const sh = file.palette ? `SH ${file.degree}, palette ${formatCount(file.palette.count)}` : "no SH";
      next = {
        name, input, sample, started, file, source, data, meta, resident, count: meta.count, bounds: meansBounds(meta),
        format: `SOG${meta.version === 1 ? "S v1" : " v2"}, ${sh}, ${state.decode} decode`,
      };
    }

    const reloaded = shown?.input === input;
    release(shown);
    shown = next;
    if (next.stream) {
      splats.collection = SplatCollection.EMPTY;
    } else {
      shown.loadMs = performance.now() - started;
    }
    rebuild();
    if (!reloaded) {
      place(sample);
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
  const sample = SAMPLES[name];
  if (sample) {
    void open(sample.label, sample.url, sample);
  }
};
const openUrl = (url: string) => void open(url, url);
const openFiles = (files: File[]) => {
  if (files.length > 0) {
    void open(files.length === 1 ? files[0].name : (files[0].webkitRelativePath.split("/")[0] || `${files.length} files`), files.length === 1 ? files[0] : files);
  }
};

picker.addEventListener("change", () => {
  openFiles([...(picker.files ?? [])]);
  picker.value = "";
});

async function droppedFiles(transfer: DataTransfer): Promise<File[]> {
  const entries = [...transfer.items].map((item) => item.webkitGetAsEntry()).filter((entry): entry is FileSystemEntry => entry !== null);
  if (!entries.some((entry) => entry.isDirectory)) {
    return [...transfer.files];
  }
  const files: File[] = [];
  const visit = async (entry: FileSystemEntry): Promise<void> => {
    if (entry.isFile) {
      files.push(await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject)));
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
        if (batch.length === 0) {
          break;
        }
        await Promise.all(batch.map(visit));
      }
    }
  };
  await Promise.all(entries.map(visit));
  return files;
}

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
  if (event.dataTransfer) {
    droppedFiles(event.dataTransfer).then(openFiles, (error: unknown) => showError(errorText(error)));
  }
});

const flipFiles = params.get("flip") !== "0";

function place(sample?: Sample) {
  model.position.set(0, 0, 0);
  model.scale.setScalar(1);
  model.quaternion.copy(sample || flipFiles ? sampleRotation(sample) : new THREE.Quaternion());
  state.sky = sample?.sky ?? false;
  controls.mode = sample?.mode ?? "orbit";
}

function resetView() {
  const view = shown?.sample?.view;
  if (!view) {
    frame();
    return;
  }
  camera.fov = view.fov;
  camera.near = 0.01;
  camera.far = 2000;
  camera.updateProjectionMatrix();
  camera.position.fromArray(view.position);
  controls.lookAt(new THREE.Vector3(...view.target));
}

// With CPU data, frames the 2nd to 98th percentile of sampled centers, so floaters don't count
function frame() {
  if (!shown) {
    return;
  }
  const box = shown.bounds.clone();
  const data = shown.data;
  if (data && data.count > 0) {
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
    axes.forEach((values, axis) => {
      values.sort();
      box.min.setComponent(axis, values[Math.floor(samples * 0.02)]);
      box.max.setComponent(axis, values[Math.min(samples - 1, Math.floor(samples * 0.98))]);
    });
  }
  model.updateMatrixWorld();
  box.applyMatrix4(model.matrixWorld);
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
  shown?.stream?.invalidate();
  gui.refresh();
}

function setSh(degree: number) {
  state.sh = degree;
  rebuild();
  gui.refresh();
}

const gui = makeGui({
  state, webgpu, hdr: caps.hdr, renderer, profiler, splats, model, controls,
  actions: {
    reload: () => shown && void open(shown.name, shown.input, shown.sample),
    setSh,
    lodChanged: () => shown?.stream?.invalidate(),
    flip,
    frame,
    resetView,
  },
});
const bar = makeQuickBar(document.getElementById("bar")!, {
  state, webgpu, splats, controls,
  sample: () => shown?.sample,
  actions: { pickFiles: () => picker.click(), openUrl, openSample, setSh },
});

const gizmo = new TransformControls(camera, renderer.domElement);
gizmo.addEventListener("dragging-changed", (event) => (controls.enabled = !event.value));
gizmo.addEventListener("objectChange", () => {
  shown?.stream?.invalidate();
  gui.refresh();
});
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

// Two eyes 64 mm apart, side by side
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

interface Sampling {
  frames: number;
  frameMs: number[];
  loopMs: number[];
  switches: number;
  // Per frame: whether the collection switched, LoD files loaded by then, and
  // the range tables made as count, splats listed and ms
  switched: boolean[];
  landed: number[];
  lists: number[][];
  // WebGPU: from the frame's start to the GPU finishing its work
  doneMs: number[];
  path?: { from: THREE.Vector3; to: THREE.Vector3; target?: THREE.Vector3 };
  done: () => void;
}
let sampling: Sampling | undefined;

const stats = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  const median = at(0.5);
  return {
    mean: +(values.reduce((sum, v) => sum + v, 0) / Math.max(1, values.length)).toFixed(2), p50: +median.toFixed(2), p95: +at(0.95).toFixed(2),
    max: +(sorted[sorted.length - 1] ?? 0).toFixed(2), over2xMedian: values.filter((v) => v > 2 * median).length,
  };
};

// Given a start and an end, the camera flies between them in world space,
// looking at the target when given, else along the line
async function measure({ frames = 240, from, to, target }: { frames?: number; from?: number[]; to?: number[]; target?: number[] } = {}) {
  const path = from && to ? { from: new THREE.Vector3().fromArray(from), to: new THREE.Vector3().fromArray(to), target: target && new THREE.Vector3().fromArray(target) } : undefined;
  const lod = shown?.stream?.stats;
  const before = lod && { ...lod, shownLevels: [...lod.shownLevels] };
  const sample = await new Promise<Sampling>((resolve) => {
    const each: Sampling = { frames, frameMs: [], loopMs: [], switches: 0, switched: [], landed: [], lists: [], doneMs: [], path, done: () => resolve(each) };
    sampling = each;
  });
  const after = shown?.stream?.stats;
  const median = stats(sample.frameMs).p50;
  const slow = sample.frameMs.flatMap((ms, i) => (ms > 2 * median ? [{
    frame: i, ms: +ms.toFixed(1), loopMs: +sample.loopMs[i].toFixed(1), switched: sample.switched[i], landed: sample.landed[i] - (sample.landed[i - 1] ?? sample.landed[i]),
    lists: sample.lists[i], gpuDoneMs: sample.doneMs[i] === undefined ? undefined : +sample.doneMs[i].toFixed(1),
  }] : [])).sort((a, b) => b.ms - a.ms).slice(0, 20);
  const listMs = sample.lists.filter(([n]) => n > 0).map(([, , ms]) => ms);
  return {
    backend: webgpu ? "webgpu" : "webgl2", sortMode: splats.sortMode, frames: sample.frameMs.length,
    frameMs: stats(sample.frameMs), loopCpuMs: stats(sample.loopMs), gpuDoneMs: stats(sample.doneMs.filter((ms) => ms !== undefined)),
    collectionSwitches: sample.switches, slow, listMs: stats(listMs),
    lod: after && before && {
      selections: after.selections - before.selections, loaded: after.loaded - before.loaded, evicted: after.evicted - before.evicted,
      levelsBefore: before.shownLevels, levelsAfter: [...after.shownLevels], residentSplats: after.residentSplats, residentFiles: after.residentFiles,
      residentBudget: state.lod.residentBudget, failed: after.failed, decodeMs: after.decodeMs,
      selected: after.selected, budget: state.lod.splatBudget, budgetMode: state.lod.budgetMode, waiting: [...after.waiting],
    },
  };
}

// With the CPU sort, a new LoD collection waits until the last one is drawn, so
// selections never pile up behind the sort. An empty collection is never sorted.
function lastShown(view: THREE.Camera) {
  const order = splats.views.get(view)?.order;
  return splats.sortMode === "gpu" || splats.collection.count === 0 || !splats.views.get(view) || order?.collection === splats.collection;
}

let frames = 0;
let lastReport = performance.now();
let lastFrame = performance.now();

function report(view: THREE.Camera) {
  const now = performance.now();
  const total = shown?.stream ? shown.stream.stats.shown : (shown?.count ?? 0);
  bar.monitor((frames * 1000) / (now - lastReport), total);
  const file = shown ? baseName(shown.name) : "none";
  const load = shown?.loadMs !== undefined ? `${(shown.loadMs / 1000).toFixed(2)} s` : shown ? "loading" : "";
  const show = (drawn: number) => gui.monitor({ file, format: shown?.format ?? "", load, drawn: `${formatCount(drawn)} of ${formatCount(total)}` });
  if (splats.sortMode === "gpu") {
    void splats.readSortedCount().then(show);
  } else {
    const order = splats.views.get(view)?.order;
    show(order?.collection === splats.collection ? order.visible : 0);
  }
  gui.lod(shown?.stream?.stats);
  void profiler?.collect().then((profile) => gui.profile(profile));
  frames = 0;
  lastReport = now;
}

renderer.setAnimationLoop(() => {
  const loopStart = performance.now();
  gui.frameBegin();
  profiler?.beginFrame();
  if (renderer.getPixelRatio() !== pixelRatio()) {
    renderer.setPixelRatio(pixelRatio());
  }
  if (sampling?.path) {
    const { from, to, target } = sampling.path;
    const t = sampling.frameMs.length / Math.max(1, sampling.frames - 1);
    camera.position.lerpVectors(from, to, t);
    camera.lookAt(target ?? to.clone().add(to.clone().sub(from)));
  } else {
    controls.update();
  }
  bar.refresh();

  scene.background = state.sky ? skyTexture() : background.setRGB(state.background.r, state.background.g, state.background.b, THREE.SRGBColorSpace);
  gizmo.enabled = state.gizmo !== "off";
  if (state.gizmo === "off") {
    gizmo.detach();
  } else {
    gizmo.attach(model);
    gizmo.setMode(state.gizmo);
  }

  const view = state.stereo ? updateStereoCamera() : camera;
  const stream = shown?.stream;
  let switched = false;
  if (stream && lastShown(view)) {
    model.updateMatrixWorld();
    camera.updateMatrixWorld();
    if (stream.update()) {
      splats.collection = stream.collection;
      switched = true;
    }
  }
  if (shown && shown.loadMs === undefined && splats.collection.count > 0 && lastShown(view)) {
    shown.loadMs = performance.now() - shown.started;
  }

  const draw = () => renderer.render(scene, view);
  if (profiler) {
    profiler.phase("draw", draw);
  } else {
    draw();
  }

  const now = performance.now();
  if (sampling) {
    sampling.frameMs.push(now - lastFrame);
    sampling.loopMs.push(now - loopStart);
    sampling.switches += switched ? 1 : 0;
    sampling.switched.push(switched);
    sampling.landed.push(stream?.stats.loaded ?? 0);
    const s = stream?.stats;
    sampling.lists.push(switched && s ? [s.lists, s.listSplats, +s.listMs.toFixed(1)] : [0, 0, 0]);
    const device = (renderer.backend as { device?: GPUDevice }).device;
    if (device) {
      const { doneMs } = sampling;
      const i = sampling.frameMs.length - 1;
      void device.queue.onSubmittedWorkDone().then(() => (doneMs[i] = performance.now() - loopStart));
    }
    if (sampling.frameMs.length >= sampling.frames) {
      const done = sampling.done;
      sampling = undefined;
      done();
    }
  }
  lastFrame = now;

  frames += 1;
  if (now - lastReport > 500) {
    report(view);
  }
  status.textContent = tasks.size > 0 ? [...tasks.values()].join("\n") : shown ? "" : "Drop a .sog / .zip or a SOG folder anywhere, or Open...";
  gui.frameEnd();
});

addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

const sampleName = params.get("sample") ?? "";
const url = params.get("url");
if (url && !SAMPLES[sampleName]) {
  openUrl(url);
} else {
  openSample(SAMPLES[sampleName] ? sampleName : "hall");
}

Object.assign(window, {
  radixSogs: {
    renderer, scene, camera, controls, splats, model, gizmo, state, gui, bar, open, openUrl, openSample, frame, resetView, flip, setSh, measure,
    shown: () => shown,
    get ready() {
      return shown !== undefined && shown.loadMs !== undefined && splats.collection.count > 0 && lastShown(camera);
    },
    validate: (options: Omit<ValidateOptions, "renderer" | "shown"> = {}) => validate({ ...options, renderer, shown }),
  },
});
