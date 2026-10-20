// Radix's SPZ example: reads Niantic SPZ files in every version Radix
// knows (v1 to v3 and version 4 in the gzip container, and SPZ 4's NGSP /
// zstd container) and writes the loaded splats back as SPZ v2, v3 or 4,
// downloaded by the browser; "open it" reads the written file back. Samples
// in catalog.ts; open, drop or paste a URL of any other splat file (a PLY
// written as SPZ converts it). The panel shows what the reader found:
// container, version, splats, SH degree, upstream records (safe orbit,
// coordinate system, skipped types) and the time to fetch and decode. A file
// whose coordinate-system record names other axes is turned to RUB (y up)
// with Axes.convert. Query parameters:
//   ?sample=   a catalog name (default seashell-v4); ?url= a file instead
//   ?spz=      the samples' folder (default the hosted one)
//   ?gpu=      webgpu | webgpu-gl
//   ?flip=1    files turned over (SPZ files without a record are often y-down)
// `radixSpz` in the console holds the page.
import * as THREE from "three";
import {
  Axes, CameraControls, GpuArrays, Sh, SplatCollection, SplatRenderer, Splats, createRenderer, getGpuCaps, loadSplats, writeSplats,
  type ArrayData, type CoordinateSystem,
} from "@sparkjsdev/radix";
import { SAMPLES, SPZ_ROOT, type Sample } from "./catalog.js";

const params = new URLSearchParams(location.search);
const status = document.getElementById("status")!;
const toast = document.getElementById("toast")!;
const drop = document.getElementById("drop")!;
const picker = document.getElementById("picker") as HTMLInputElement;
const panel = document.getElementById("panel")!;

const renderer = await createRenderer();
const webgpu = getGpuCaps(renderer).backend === "webgpu";
renderer.setPixelRatio(devicePixelRatio);
renderer.setSize(innerWidth, innerHeight);
document.body.prepend(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.01, 1000);
camera.position.set(0, 0, 3);
const controls = new CameraControls({ canvas: renderer.domElement, object: camera, settings: { mode: "orbit" } });
const model = new THREE.Object3D();
scene.add(model);
const splats = new SplatRenderer({
  renderer,
  sortMode: webgpu ? "gpu" : "cpu",
  autoSort: { distance: 0.05, angle: THREE.MathUtils.degToRad(5) },
});
scene.add(splats);

// --- The file shown and the last one written ---

interface Shown {
  name: string;
  sample?: Sample;
  fileBytes: number;
  fetchMs: number;
  decodeMs: number;
  // Its spherical-harmonics degree (0 without)
  shDegree: number;
  // The axes stored in the file, when it was turned to RUB
  turnedFrom?: CoordinateSystem;
}
let data: ArrayData | undefined;
let arrays: GpuArrays | undefined;
let shown: Shown | undefined;
let written: { name: string; bytes: Uint8Array<ArrayBuffer>; ms: number } | undefined;
let busy: string | undefined;
const writeOptions = { sh: true };

const baseName = (name: string) => name.replace(/[?#].*$/, "").split("/").pop()!.replace(/\.\w+$/, "") || name;
const megabytes = (bytes: number) => `${(bytes / 1e6).toFixed(2)} MB`;
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

function showError(message: string) {
  const item = Object.assign(document.createElement("div"), { className: "toast-item", textContent: message });
  item.append(Object.assign(document.createElement("button"), { textContent: "×", title: "Dismiss", onclick: () => item.remove() }));
  toast.append(item);
  setTimeout(() => item.remove(), 12000);
}

// --- Reading ---

let loadRequest = 0;
async function open(name: string, source: string | Blob, sample?: Sample) {
  const request = ++loadRequest;
  busy = `Reading ${baseName(name)}...`;
  try {
    const start = performance.now();
    let bytes: Uint8Array<ArrayBuffer>;
    if (typeof source === "string") {
      const response = await fetch(source);
      if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText}`);
      }
      bytes = new Uint8Array(await response.arrayBuffer());
    } else {
      bytes = new Uint8Array(await source.arrayBuffer());
    }
    const fetched = performance.now();
    const fileBytes = bytes.byteLength;
    // On a worker: the bytes are transferred there
    const loaded = await loadSplats(bytes, {
      name, worker: true, onProgress: (f, stage) => {
        if (request === loadRequest) {
          busy = `Reading ${baseName(name)}: ${stage} ${Math.round(f * 100)}%`;
        }
      },
    });
    const decoded = performance.now();
    if (request !== loadRequest) {
      return;
    }
    const stored = loaded.meta.coordinateSystem as CoordinateSystem | undefined;
    const turnedFrom = stored && stored !== "RUB" ? stored : undefined;
    if (turnedFrom) {
      Axes.convert(loaded, "RUB");
    }
    data = loaded;
    const fileArrays = (arrays = GpuArrays.fromData(renderer, loaded));
    splats.collection = new SplatCollection([SplatCollection.arrays(fileArrays, { matrixWorld: model.matrixWorld, release: () => fileArrays.dispose() })]);
    shown = { name, sample, fileBytes, fetchMs: fetched - start, decodeMs: decoded - fetched, shDegree: Sh.find(loaded.bundles)?.degree ?? 0, turnedFrom };
    model.quaternion.copy(params.get("flip") === "1" ? new THREE.Quaternion(1, 0, 0, 0) : new THREE.Quaternion());
    frame();
  } catch (error) {
    showError(`${baseName(name)}: ${errorText(error)}`);
  } finally {
    if (request === loadRequest) {
      busy = undefined;
    }
    renderPanel();
  }
}

const openSample = async (key: string) => {
  const sample = SAMPLES[key];
  if (sample) {
    await open(sample.file, `${SPZ_ROOT}/${sample.file}`, sample);
  }
};

// --- Writing ---

async function write(version: 2 | 3 | 4) {
  if (!data || !shown || busy) {
    return;
  }
  const name = `${baseName(shown.name)}.v${version}.spz`;
  busy = `Writing ${name}...`;
  try {
    const start = performance.now();
    // On a worker: data's arrays travel there and back
    const bytes = await writeSplats(data, "spz", {
      version, sh: writeOptions.sh, worker: true, onProgress: (f, stage) => (busy = `Writing ${name}: ${stage} ${Math.round(f * 100)}%`),
    });
    written = { name, bytes, ms: performance.now() - start };
    const url = URL.createObjectURL(new Blob([bytes]));
    Object.assign(document.createElement("a"), { href: url, download: name }).click();
    URL.revokeObjectURL(url);
  } catch (error) {
    showError(`${name}: ${errorText(error)}`);
  } finally {
    busy = undefined;
    renderPanel();
  }
}

// --- The camera: in front of the bulk of the splats (2nd to 98th
// percentile of sampled centers, so floaters do not count) ---

function frame() {
  if (!data || data.count === 0) {
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
  camera.near = size / 1000;
  camera.far = size * 50;
  camera.updateProjectionMatrix();
  camera.position.copy(middle).add(new THREE.Vector3(0, size * 0.3, size * 1.1));
  controls.lookAt(middle);
}

// --- The bar: open, samples, SH degree drawn, camera, flip, stats ---

const bar = document.getElementById("bar")!;
const refreshers: (() => void)[] = [];
const group = (label = "") => {
  const element = Object.assign(document.createElement("div"), { className: "bar-group" });
  if (label) {
    element.append(Object.assign(document.createElement("span"), { className: "bar-label", textContent: label }));
  }
  bar.append(element);
  return element;
};
const button = (textContent: string, onclick: () => void, title = "") => Object.assign(document.createElement("button"), { textContent, onclick, title });
// The button matching get() is lit, those enabled() refuses are greyed out
const segmented = <T>(label: string, choices: [T, string][], get: () => T, set: (value: T) => void, title = "", enabled: (value: T) => boolean = () => true) => {
  const element = group(label);
  element.title = title;
  const buttons = choices.map(([value, text]) => {
    const b = button(text, () => set(value));
    element.append(b);
    return { b, value };
  });
  refreshers.push(() => buttons.forEach(({ b, value }) => {
    b.classList.toggle("active", value === get());
    b.disabled = !enabled(value);
  }));
};

const url = Object.assign(document.createElement("input"), { type: "url", placeholder: "URL + Enter" });
url.onkeydown = (event) => {
  if (event.key === "Enter" && url.value.trim()) {
    void open(url.value.trim(), url.value.trim());
    url.value = "";
    url.blur();
  }
};
group().append(button("Open...", () => picker.click(), "Open a splat file (or drop one anywhere)"), url);
const select = Object.assign(document.createElement("select"), { title: "Sample SPZ files (CC0)" });
select.append(...Object.entries(SAMPLES).map(([key, sample]) => new Option(sample.label, key)));
select.onchange = () => {
  void openSample(select.value);
  select.blur();
};
group("sample").append(select);
refreshers.push(() => {
  const index = shown?.sample ? Object.values(SAMPLES).indexOf(shown.sample) : -1;
  if (select.selectedIndex !== index) {
    select.selectedIndex = index;
  }
});
// Lit: the degree drawn (the highest allowed, up to the file's)
const fileSh = () => shown?.shDegree ?? 0;
segmented("SH", [[0, "0"], [1, "1"], [2, "2"], [3, "3"], [4, "4"]], () => Math.min(splats.objectParams.maxShDegree, fileSh()), (v) => (splats.objectParams.maxShDegree = v),
  "Highest spherical-harmonics degree drawn, up to the file's", (v) => v <= fileSh());
segmented("camera", [["orbit", "orbit"], ["fly", "fly"]] as const, () => controls.mode, (v) => (controls.mode = v), "F switches");
group().append(
  button("flip", () => model.quaternion.multiply(new THREE.Quaternion(1, 0, 0, 0)), "Half turn about x (for y-down files)"),
  button("frame", frame, "Look at the splats again"),
);
const stats = Object.assign(document.createElement("span"), { className: "bar-stats" });
group().append(stats);

// --- The panel: what the reader found, and the writer ---

function renderPanel() {
  panel.replaceChildren();
  const section = (title: string) => {
    const element = Object.assign(document.createElement("section"), {});
    element.append(Object.assign(document.createElement("h2"), { textContent: title }));
    panel.append(element);
    return element;
  };
  const rows = (parent: HTMLElement, entries: [string, string][]) => {
    const table = document.createElement("dl");
    for (const [key, value] of entries) {
      table.append(Object.assign(document.createElement("dt"), { textContent: key }), Object.assign(document.createElement("dd"), { textContent: value }));
    }
    parent.append(table);
  };

  const read = section("Read");
  if (data && shown) {
    const meta = data.meta as Record<string, unknown>;
    const sh = Sh.find(data.bundles);
    const orbit = meta.safeOrbitCamera as { elevationMin: number; elevationMax: number; radiusMin: number } | undefined;
    const degrees = (radians: number) => `${((radians * 180) / Math.PI).toFixed(1)}°`;
    const format = meta.format !== "spz" ? String(meta.format ?? "?").toUpperCase()
      : meta.container === "ngsp" ? "SPZ 4 (NGSP header, zstd streams)"
        : meta.version === 4 ? "SPZ gzip, version 4 (version 3's layout)" : `SPZ v${String(meta.version)} (gzip)`;
    if (shown.sample) {
      read.append(Object.assign(document.createElement("p"), { className: "note", textContent: shown.sample.note }));
    }
    rows(read, [
      ["file", baseName(shown.name)],
      ["size", megabytes(shown.fileBytes)],
      ["format", format],
      ["splats", data.count.toLocaleString()],
      ["SH", sh ? `degree ${sh.degree} (${sh.codec})` : "none"],
      ...(meta.format === "spz" ? [
        ["antialiased", meta.antialiased ? "yes" : "no"],
        ["axes", shown.turnedFrom ? `${shown.turnedFrom}, shown as RUB` : String(meta.coordinateSystem ?? "RUB")],
        ["safe orbit", orbit ? `elevation ${degrees(orbit.elevationMin)} to ${degrees(orbit.elevationMax)}, radius ≥ ${orbit.radiusMin.toFixed(2)}` : "none"],
        ["other records", (meta.skippedExtensions as number[] | undefined)?.map((t) => `0x${t.toString(16)}`).join(", ") ?? "none"],
      ] as [string, string][] : []),
      ["read in", `fetch ${shown.fetchMs.toFixed(0)} ms · decode ${shown.decodeMs.toFixed(0)} ms`],
    ]);
  } else {
    read.append(Object.assign(document.createElement("p"), { className: "note", textContent: busy ?? "No file" }));
  }

  const writer = section("Write SPZ");
  const versions = Object.assign(document.createElement("div"), { className: "row" });
  for (const version of [2, 3, 4] as const) {
    const b = button(`v${version}`, () => void write(version), version === 4 ? "SPZ 4: NGSP header, zstd streams" : `gzip, version ${version}`);
    b.disabled = !data || busy !== undefined;
    versions.append(b);
  }
  const shBox = Object.assign(document.createElement("input"), { type: "checkbox", checked: writeOptions.sh, onchange: () => (writeOptions.sh = shBox.checked) });
  const shLabel = Object.assign(document.createElement("label"), { title: "Write the spherical harmonics" });
  shLabel.append(shBox, " SH");
  versions.append(shLabel);
  writer.append(versions);
  writer.append(Object.assign(document.createElement("p"), {
    className: "note",
    textContent: "Writes the splats as loaded and downloads the file. In a browser, v4's zstd streams come from Radix's own encoder (literals only, a few % larger than gzip); Node writes them with native zstd.",
  }));
  if (written) {
    const result = Object.assign(document.createElement("div"), { className: "row" });
    result.append(
      Object.assign(document.createElement("span"), { className: "mono", textContent: `${written.name} · ${megabytes(written.bytes.byteLength)} · ${(written.ms / 1000).toFixed(2)} s` }),
      button("open it", () => written && void open(written.name, new Blob([written.bytes])), "Read the written file back"),
    );
    writer.append(result);
  }
}

// --- Files from the picker or dropped ---

picker.addEventListener("change", () => {
  const file = picker.files?.[0];
  if (file) {
    void open(file.name, file);
  }
  picker.value = "";
});
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

// --- Frame loop ---

let frames = 0;
let lastReport = performance.now();
renderer.setAnimationLoop(() => {
  controls.update();
  refreshers.forEach((refresh) => refresh());
  renderer.render(scene, camera);
  frames += 1;
  const now = performance.now();
  if (now - lastReport > 500) {
    stats.textContent = `${Math.round((frames * 1000) / (now - lastReport))} fps · ${(arrays?.count ?? 0).toLocaleString()} splats`;
    frames = 0;
    lastReport = now;
  }
  status.textContent = busy ?? (arrays ? "" : "Drop a splat file anywhere, or Open...");
});
addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

renderPanel();
const startUrl = params.get("url");
if (startUrl) {
  void open(startUrl, startUrl);
} else {
  void openSample(SAMPLES[params.get("sample") ?? ""] ? params.get("sample")! : "seashell-v4");
}

Object.assign(window, {
  radixSpz: { renderer, scene, camera, controls, splats, model, open, openSample, write, frame, data: () => data, arrays: () => arrays, written: () => written },
});
