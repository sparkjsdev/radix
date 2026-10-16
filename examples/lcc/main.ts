// Radix's LCC viewer: XGRIDS LCC v1 scenes (meta.lcc, index.bin, data.bin,
// optional shcoef.bin and environment.bin; see LccScene.ts) and LCC2 scenes
// (meta.lcc2, an N-ary tree of chunk files; see Lcc2Scene.ts), after the
// splat viewer in examples/splats/. In LCC v1 each cell of the scene's grid
// draws one of its levels, chosen from the camera (LccStreamer.ts); a pool
// of workers range-reads the chosen blocks and decodes them into ext splats
// with Radix's CPU encoder (lccDecode.ts, from
// dist/radix-core.module.js), and each block is one object of a
// SplatRenderer's collection, drawn with its spherical harmonics when the
// scene has them (lccSh.tsl.ts). In LCC2 the camera picks a cut through the
// tree (lcc2Select.ts) and each chunk file is one object drawing its drawn
// nodes' rows (Lcc2Streamer.ts: .sog decoded on the GPU by examples/sogs/,
// .spz / .ply on the workers). Both draw the environment (background
// splats) whole. Samples are hosted (catalog.ts); a scene
// folder can be opened or dropped. The quick bar (quickBar.ts) holds the
// likely options, the Tweakpane panel (gui.ts) the rest. Query parameters:
//   ?scene=    a sample of catalog.ts (default showroom2)
//   ?url=      a meta.lcc or .lcc2 URL (its folder holds the other files)
//   ?level=    auto (default) | a level for every cell
//   ?lod=      distance within which cells draw level 0 (default half a
//              cell; LCC2: half a leaf's width, or more for small leaves)
//   ?budget=   most splats drawn (default 8M with the GPU sort, 3M with the CPU sort)
//   ?cache=    GPU cache in MB (default 2048)
//   ?sh=0      spherical harmonics off
//   ?env=0     environment.bin off
//   ?workers=  decode workers (default half the cores, 2 to 4)
//   ?method=   ewa | 3dgut | htgs | raygs
//   ?bits=     sort key width: 16 | 24 (default) | 32
//   ?sort=cpu  the WebGL2 fallback's worker sort, also on WebGPU
//   ?gpu=      webgpu | webgpu-gl
//   ?hdr=0 | 1 (default: HDR when the display has it), ?dpr=0 (pixel ratio 1)
//   ?profile=1 GPU timestamps per phase from the start (default off, as
//              they cost frame time; the Monitors' "GPU timing" switches them)
//   ?lcc=      the samples' root folder (default their copies on GCS)
//   ?lcc2=     the LCC2 samples' root folder (default beside ?lcc= when it
//              is given, else on GCS)
// `radixLcc` in the console holds the viewer.
import * as THREE from "three";
import {
  ArrayData, CameraControls, GpuProfiler, SplatCollection, Splats, createRenderer, getGpuCaps, writeSplats, SplatRenderer,
  type ProjectionMethod, type SortKeyBits,
} from "@sparkjsdev/radix";
import { SAMPLES, sampleUrl, type LccSample } from "./catalog.js";
import { CollisionOverlay } from "./collisionOverlay.js";
import { CollisionStream } from "./CollisionStream.js";
import { makeGui } from "./gui.js";
import { Lcc2Scene } from "./Lcc2Scene.js";
import { Lcc2Streamer } from "./Lcc2Streamer.js";
import { LccDecoders } from "./LccDecoders.js";
import { LccScene, type LccSource, type LccSpawn } from "./LccScene.js";
import { lccGenerator } from "./lccSh.tsl.js";
import { LccStreamer, LEVEL_COLORS, type LccStream, type LccStreamerSettings } from "./LccStreamer.js";
import { formatCount, makeQuickBar } from "./quickBar.js";
import { DEFAULT_WALK, Walker } from "./walk.js";

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

// What the bar and the panel set beyond the renderer's and the streamer's
// own settings; the frame loop applies it
export const state = {
  devicePixels: params.get("dpr") !== "0",
  background: { r: 0, g: 0, b: 0 },
  sh: { enabled: params.get("sh") !== "0", degree: 3 },
  showCells: false,
  exportFormat: "rdx" as "rdx" | "ply" | "compressed-ply" | "spz",
  // The collision overlay, and the radius (scene units) collision loads within
  collision: { mesh: params.get("collision") === "1", boxes: false, leaves: false, leafDepth: 6, depthTest: false, opacity: 0.6, radius: 100 },
  walk: { ...DEFAULT_WALK },
};
export type ViewerState = typeof state;

const pixelRatio = () => (state.devicePixels ? devicePixelRatio : 1);
renderer.setPixelRatio(pixelRatio());
renderer.setSize(innerWidth, innerHeight);

const scene = new THREE.Scene();
const background = new THREE.Color();
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.02, 2000);
const controls = new CameraControls({ canvas: renderer.domElement, object: camera, storageKey: "radix-lcc", settings: { mode: "fly" } });

// The scene's placement (Z-up files turned upright), and the cell boxes in
// the file's frame under it
const model = new THREE.Object3D();
scene.add(model);
const cellBoxes = new THREE.Group();
model.add(cellBoxes);
const overlay = new CollisionOverlay();
model.add(overlay.group);
const walker = new Walker({ camera, controls, model, settings: state.walk });

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
scene.add(splats);

const decoders = new LccDecoders(params.has("workers") ? { workers: Number(params.get("workers")) } : {});

const level = params.get("level");
const settings: LccStreamerSettings = {
  level: level === null || level === "auto" ? "auto" : Number(level),
  lodDistance: 1,
  hysteresis: 0.15,
  behindPenalty: 2,
  budgetMode: "limit",
  budget: Number(params.get("budget") ?? (splats.sortMode === "gpu" ? 8_000_000 : 3_000_000)),
  cacheBytes: Number(params.get("cache") ?? 2048) * 1e6,
  freeze: false,
  colorByLevel: false,
  environment: params.get("env") !== "0",
  keepCpu: false,
};

// --- Status and errors ---

function showError(message: string) {
  const item = Object.assign(document.createElement("div"), { className: "toast-item", textContent: message });
  const close = Object.assign(document.createElement("button"), { textContent: "×", title: "Dismiss", onclick: () => item.remove() });
  item.append(close);
  toast.append(item);
  setTimeout(() => item.remove(), 12000);
}
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

// --- Opening scenes: one at a time, replacing the last ---

// What both scene kinds give the page
interface OpenScene {
  kind: "lcc" | "lcc2";
  name: string;
  levels: number;
  sh: boolean;
  scale?: number[];
  spawn?: LccSpawn;
  // In the file's frame, without the environment, and with it (the far
  // plane reaches it: LCC2's env.boundingBox, v1's "position" attribute)
  box: { min: number[]; max: number[] };
  envBox?: { min: number[]; max: number[] };
  // The monitors' description
  summary: string;
  v1?: LccScene;
  v2?: Lcc2Scene;
}

let current: { scene: OpenScene; streamer: LccStream; sample?: LccSample; collision?: CollisionStream; collisionState: string } | undefined;
let opening = "";
let openRequest = 0;
const page: { ready: boolean; error?: string } = { ready: false };

// A source is LCC2 when its URL or one of its files ends in .lcc2
const isLcc2 = (source: LccSource) => (source.kind === "url"
  ? Lcc2Scene.isMetaName(new URL(source.meta).pathname)
  : source.files.some(({ path }) => Lcc2Scene.isMetaName(path)));

// LCC2's default level 0 distance: half the median width of the tree's
// leaves, or for trees of small leaves the scene's diagonal over 2^levels,
// times 4
function lodDistanceOf(scene: Lcc2Scene) {
  const widths: number[] = [];
  for (let node = 1; node < scene.nodes; node += 1) {
    if (scene.isLeaf(node)) {
      const b = scene.bounds.subarray(node * 6, node * 6 + 6);
      widths.push(Math.max(b[3] - b[0], b[4] - b[1]));
    }
  }
  widths.sort((a, b) => a - b);
  const { min, max } = scene.box;
  const diagonal = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
  return Math.max((widths[widths.length >> 1] ?? 1) / 2, (diagonal / 2 ** scene.levels) * 4);
}

async function openScene(source: LccSource): Promise<OpenScene> {
  if (isLcc2(source)) {
    const v2 = await Lcc2Scene.open(source);
    return {
      kind: "lcc2", name: v2.name, levels: v2.levels, sh: v2.sh, scale: v2.meta.scale, spawn: v2.spawn, box: v2.box, envBox: v2.meta.env?.boundingBox, v2,
      summary: `${v2.name}: LCC2 ${v2.meta.version ?? ""}, ${v2.nodes - 1} nodes, ${v2.levels} levels, ${v2.splatType}`,
    };
  }
  const v1 = await LccScene.open(source);
  return {
    kind: "lcc", name: v1.name, levels: v1.levels, sh: v1.sh, scale: v1.meta.scale, spawn: v1.spawn, box: v1.meta.boundingBox, v1,
    envBox: v1.meta.attributes?.find((a) => a.name === "position"),
    summary: `${v1.name}: ${v1.cells.length} cells, ${v1.levels} levels`,
  };
}

async function open(source: LccSource, sample?: LccSample) {
  const request = ++openRequest;
  opening = sample?.label ?? (source.kind === "url" ? source.meta : "dropped folder");
  try {
    const opened = await openScene(source);
    if (request !== openRequest) {
      return;
    }
    current?.streamer.dispose();
    current?.collision?.dispose();
    walker.setCollision(undefined);
    overlay.attach(undefined);
    // Releases the old scene's objects, which frees their arrays
    splats.collection = SplatCollection.EMPTY;
    page.ready = false;

    place(opened, sample);
    const { v1, v2 } = opened;
    const lod = params.get("lod") ?? sample?.lodDistance;
    settings.lodDistance = Number(lod ?? (v1 ? Math.max(v1.meta.cellLengthX, v1.meta.cellLengthY) / 2 : lodDistanceOf(v2!)));
    if (settings.level !== "auto") {
      settings.level = Math.min(settings.level, opened.levels - 1);
    }
    const streamer: LccStream = v1
      ? new LccStreamer({ renderer, scene: v1, decoders, generator: lccGenerator({ sh: v1.sh }), matrixWorld: model.matrixWorld, settings })
      : new Lcc2Streamer({ renderer, scene: v2!, decoders, matrixWorld: model.matrixWorld, settings });
    streamer.onChange = (collection) => (splats.collection = collection);
    streamer.onError = showError;
    const entry: NonNullable<typeof current> = { scene: opened, streamer, sample, collisionState: "looking" };
    current = entry;
    Object.assign(state.walk, DEFAULT_WALK, sample?.walk || undefined);
    resetView();
    gui.refresh();
    void openCollision(entry);
  } catch (error) {
    page.error = errorText(error);
    showError(`${opening}: ${page.error}`);
  } finally {
    if (request === openRequest) {
      opening = "";
    }
  }
}

// The scene's collision (collision.lci, or LCC2 meshes), when it has any;
// ?camera=walk starts walking once the scene shows
async function openCollision(entry: NonNullable<typeof current>) {
  let collision: CollisionStream | undefined;
  try {
    collision = await CollisionStream.open(entry.scene, decoders);
  } catch (error) {
    showError(`Collision: ${errorText(error)}`);
  }
  if (current !== entry) {
    collision?.dispose();
    return;
  }
  entry.collision = collision;
  entry.collisionState = collision ? `${collision.entries.length} chunks` : "none";
  if (collision) {
    collision.onError = showError;
    overlay.attach(collision);
    walker.setCollision(collision);
    if (params.get("camera") === "walk" && entry.sample?.walk !== false) {
      for (let i = 0; i < 600 && !page.ready && current === entry; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (current === entry) {
        await startWalk();
      }
    }
  }
}

// Walk on the collision mesh from the ground below the camera
async function startWalk() {
  if (!current?.collision) {
    showError("Walk: this scene has no collision mesh");
    return;
  }
  const { ok, message } = await walker.start();
  if (!ok && message) {
    showError(`Walk: ${message}`);
  }
}

const toggleWalk = (on = !walker.active) => (on ? void startWalk() : walker.stop());
addEventListener("keydown", (event) => {
  if (event.code === "KeyG" && !(event.target instanceof HTMLInputElement) && !event.ctrlKey && !event.metaKey) {
    toggleWalk();
  }
});

const openSample = (name: string) => {
  const sample = SAMPLES[name];
  if (sample) {
    void open({ kind: "url", meta: sampleUrl(sample) }, sample);
  }
};
const openUrl = (url: string) => void open({ kind: "url", meta: new URL(url, location.href).href });
const openFiles = (files: { path: string; file: File }[]) => {
  if (files.length > 0) {
    void open({ kind: "files", files });
  }
};

picker.addEventListener("change", () => {
  openFiles([...picker.files ?? []].map((file) => ({ path: file.webkitRelativePath || file.name, file })));
  picker.value = "";
});

// Every file under the dropped entries, with its path
async function filesOf(entries: FileSystemEntry[]) {
  const out: { path: string; file: File }[] = [];
  const visit = async (entry: FileSystemEntry): Promise<void> => {
    if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
      out.push({ path: entry.fullPath.replace(/^\//, ""), file });
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
  return out;
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
  const entries = [...event.dataTransfer?.items ?? []].map((item) => item.webkitGetAsEntry()).filter((entry): entry is FileSystemEntry => entry !== null);
  void filesOf(entries).then(openFiles, (error: unknown) => showError(`Drop: ${errorText(error)}`));
});

// --- Placing the scene and the camera ---

const Z_UP = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);

function place(opened: OpenScene, sample?: LccSample) {
  model.position.set(0, 0, 0);
  model.quaternion.copy(sample?.rotation ? new THREE.Quaternion(...sample.rotation) : Z_UP);
  const scale = opened.scale ?? [1, 1, 1];
  model.scale.set(scale[0] ?? 1, scale[1] ?? 1, scale[2] ?? 1);
  model.updateMatrixWorld(true);
  splats.objectParams.blurAmount = sample?.preBlur ? 0 : 0.3;
  splats.objectParams.preBlurAmount = sample?.preBlur ? 0.3 : 0;
  if (sample?.mode) {
    controls.mode = sample.mode;
  }
}

// The scene's box in the world
function worldBox(opened: OpenScene) {
  const { min, max } = opened.box;
  return new THREE.Box3(new THREE.Vector3().fromArray(min), new THREE.Vector3().fromArray(max)).applyMatrix4(model.matrixWorld);
}

// Near and far from the scene's size; far also past the environment, which
// can lie kilometers out (else it is cut first at the middle of the view,
// where depth is the whole distance)
function setClip(size: number) {
  const env = current?.scene.envBox;
  const envSize = env ? new THREE.Box3(new THREE.Vector3().fromArray(env.min), new THREE.Vector3().fromArray(env.max)).applyMatrix4(model.matrixWorld).getSize(new THREE.Vector3()).length() : 0;
  camera.near = Math.max(size / 2000, 0.005);
  camera.far = Math.max(size * 50, 100, envSize * 1.5);
  camera.updateProjectionMatrix();
}

// Looking at the scene's box from in front, far enough to see all of it
function frame() {
  if (!current) {
    return;
  }
  const box = worldBox(current.scene);
  const middle = box.getCenter(new THREE.Vector3());
  const size = Math.max(box.getSize(new THREE.Vector3()).length(), 1e-3);
  camera.fov = 60;
  setClip(size);
  camera.position.copy(middle).add(new THREE.Vector3(0, size * 0.2, size * 0.9));
  controls.lookAt(middle);
}

// The sample's start view, else the scene's spawn point, else framed
function resetView() {
  if (!current) {
    return;
  }
  const { scene: opened, sample } = current;
  const size = Math.max(worldBox(opened).getSize(new THREE.Vector3()).length(), 1e-3);
  if (sample?.view) {
    camera.fov = sample.view.fov ?? 60;
    setClip(size);
    camera.position.fromArray(sample.view.position);
    controls.lookAt(new THREE.Vector3(...sample.view.target));
  } else if (opened.spawn) {
    camera.fov = 60;
    setClip(size);
    camera.position.fromArray(opened.spawn.position).applyMatrix4(model.matrixWorld);
    const yaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), THREE.MathUtils.degToRad(sample?.spawnYaw ?? 0));
    const facing = yaw.multiply(model.quaternion).multiply(new THREE.Quaternion(...opened.spawn.rotation));
    controls.lookAt(camera.position.clone().add(new THREE.Vector3(0, 0, -2).applyQuaternion(facing)));
  } else {
    frame();
  }
}

// The streamer's boxes (cells, or the drawn nodes of LCC2), helpers reused
function updateCellBoxes() {
  cellBoxes.visible = state.showCells;
  if (!state.showCells || !current) {
    return;
  }
  const boxes = current.streamer.boxes();
  while (cellBoxes.children.length < boxes.length) {
    cellBoxes.add(new THREE.Box3Helper(new THREE.Box3(), new THREE.Color("#666666")));
  }
  cellBoxes.children.forEach((child, i) => {
    const helper = child as THREE.Box3Helper;
    const box = boxes[i];
    helper.visible = box !== undefined;
    if (box) {
      helper.box.min.fromArray(box.min as number[]);
      helper.box.max.fromArray(box.max as number[]);
      (helper.material as THREE.LineBasicMaterial).color.set(box.level < 0 ? "#444444" : LEVEL_COLORS[box.level % LEVEL_COLORS.length]);
    }
  });
}

// --- Export: the drawn blocks as ext splats, in the file's frame ---

let exporting = false;
async function exportFile() {
  if (!current || exporting) {
    return;
  }
  exporting = true;
  const name = `${current.scene.name}.${state.exportFormat === "compressed-ply" ? "compressed.ply" : state.exportFormat}`;
  try {
    const blocks = await current.streamer.drawnData();
    const total = blocks.reduce((sum, data) => sum + data.count, 0);
    const merged = Splats.make(total);
    let at = 0;
    for (const data of blocks) {
      merged.copyFrom(data as ArrayData, { bundles: ["extSplats"], dstStart: at });
      at += data.count;
    }
    const bytes = await writeSplats(merged, state.exportFormat, { worker: true });
    const url = URL.createObjectURL(new Blob([bytes]));
    Object.assign(document.createElement("a"), { href: url, download: name }).click();
    URL.revokeObjectURL(url);
  } catch (error) {
    showError(`Export: ${errorText(error)}`);
  } finally {
    exporting = false;
  }
}

// --- Panel and quick bar ---

const gui = makeGui({
  state, settings, hdr: caps.hdr, renderer, profiler, splats, controls,
  actions: {
    frame,
    resetView,
    exportFile: () => void exportFile(),
    toggleWalk: () => toggleWalk(),
  },
});
const bar = makeQuickBar(document.getElementById("bar")!, {
  state, settings, webgpu, splats, controls,
  sample: () => current?.sample,
  levels: () => current?.streamer.levels ?? 0,
  hasSh: () => current?.scene.sh ?? false,
  hasEnvironment: () => (current?.streamer.environmentState ?? "none") !== "none",
  walk: { active: () => walker.active || walker.state === "waiting", available: () => current?.collision !== undefined, set: (on) => toggleWalk(on) },
  actions: { pickFolder: () => picker.click(), openUrl, openSample },
});

// --- Frame loop ---

let frames = 0;
let lastReport = performance.now();
let lastLevel = settings.level;

function report() {
  const now = performance.now();
  const streamer = current?.streamer;
  const stats = streamer?.stats;
  const drawn = stats?.drawn ?? 0;
  bar.monitor((frames * 1000) / (now - lastReport), drawn);
  const show = (visible: number) => gui.monitor({ drawn: `${formatCount(drawn)} (${formatCount(visible)})` });
  if (splats.sortMode === "gpu") {
    void splats.readSortedCount().then(show);
  } else {
    const order = splats.views.get(camera)?.order;
    show(order?.collection === splats.collection ? order.visible : 0);
  }
  if (current && stats) {
    const d = decoders.stats;
    const v2 = current.scene.kind === "lcc2" ? current.streamer as Lcc2Streamer : undefined;
    gui.monitor({
      scene: current.scene.summary,
      levels: stats.drawnPerLevel.map((n, i) => `L${i} ${formatCount(n)}`).join(" · "),
      blocks: `${stats.resident} ${v2 ? "files" : "blocks"} resident, ${stats.loading} loading${stats.failed ? `, ${stats.failed} failed` : ""}${v2 ? `; cut ${v2.stats.nodes} nodes, ${formatCount(v2.stats.selected)}` : ""}`,
      cache: `${(stats.residentBytes / 1e6).toFixed(0)} of ${(settings.cacheBytes / 1e6).toFixed(0)} MB`,
      decode: `${d.decoded} blocks, ${(d.bytes / 1e6).toFixed(0)} MB, last ${d.lastMs.toFixed(0)} ms (${decoders.size} workers)`,
      sh: current.scene.sh ? (state.sh.enabled ? `degree ${state.sh.degree}` : "off") : "none (Portable)",
      environment: current.streamer.environmentState,
      collision: current.collision
        ? `${current.collision.stats.loaded} of ${current.collision.stats.known} chunks, ${formatCount(current.collision.stats.triangles)} triangles${current.collision.stats.loading ? ", loading" : ""}`
        : current.collisionState,
      walk: walker.state,
    });
  }
  void profiler?.collect().then((profile) => gui.profile(profile));
  frames = 0;
  lastReport = now;
}

const before = new THREE.Vector3();
const eyeInFile = new THREE.Vector3();
const toFile = new THREE.Matrix4();
let lastFrame = performance.now();

renderer.setAnimationLoop(() => {
  gui.frameBegin();
  profiler?.beginFrame();
  if (renderer.getPixelRatio() !== pixelRatio()) {
    renderer.setPixelRatio(pixelRatio());
  }
  const now = performance.now();
  const dt = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;
  before.copy(camera.position);
  controls.update();
  walker.step(dt, before);
  camera.updateMatrixWorld();
  bar.refresh();

  // Collision near the camera, in the file's frame
  const collision = current?.collision;
  if (collision) {
    eyeInFile.copy(camera.position).applyMatrix4(toFile.copy(model.matrixWorld).invert());
    collision.radius = state.collision.radius / Math.max(model.scale.x, 1e-9);
    collision.update(walker.active ? walker.feet : eyeInFile);
    overlay.update(state.collision, eyeInFile, walker.active ? walker.capsule : undefined);
  } else {
    overlay.group.visible = false;
  }
  if (settings.level !== lastLevel) {
    lastLevel = settings.level;
    gui.refresh();
  }

  scene.background = background.setRGB(state.background.r, state.background.g, state.background.b, THREE.SRGBColorSpace);
  splats.objectParams.maxShDegree = state.sh.enabled ? state.sh.degree : 0;
  current?.streamer.setDegree(state.sh.enabled ? state.sh.degree : 0);
  current?.streamer.update(camera);
  updateCellBoxes();

  const draw = () => renderer.render(scene, camera);
  if (profiler) {
    profiler.phase("draw", draw);
  } else {
    draw();
  }

  const count = splats.collection.count;
  if (!page.ready && count > 0 && (splats.sortMode === "gpu" || splats.views.get(camera)?.order?.collection === splats.collection)) {
    page.ready = true;
  }

  frames += 1;
  if (performance.now() - lastReport > 500) {
    report();
  }
  const stats = current?.streamer.stats;
  const unit = current?.scene.kind === "lcc2" ? "file" : "block";
  status.textContent = opening ? `Opening ${opening}...` : stats && stats.loading > 0 ? `Loading ${stats.loading} ${unit}${stats.loading > 1 ? "s" : ""}...` : current ? "" : "Drop an LCC or LCC2 scene folder anywhere, or Open folder...";
  gui.frameEnd();
});

addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// The initial scene: ?url=, else ?scene=, else the showroom
const url = params.get("url");
if (url) {
  openUrl(url);
} else {
  openSample(SAMPLES[params.get("scene") ?? ""] ? params.get("scene")! : "showroom2");
}

Object.assign(window, {
  radixLcc: Object.assign(page, {
    renderer, scene, camera, controls, splats, model, decoders, settings, state, gui, bar, walker, overlay,
    open, openUrl, openSample, frame, resetView, exportFile, startWalk, toggleWalk, collision: () => current?.collision,
    lcc: () => current?.scene.v1 ?? current?.scene.v2, opened: () => current?.scene, streamer: () => current?.streamer,
  }),
});
