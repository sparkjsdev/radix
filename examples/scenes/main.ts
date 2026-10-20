// Scenes of Radix: several splat objects with their own transforms, TSL
// generators, per-camera views, modifiers, subsets and an offline still,
// one scene at a time (scenes.ts; each one is a usage example). A static
// page on the library bundle. Query parameters:
//   ?scene=    multi (default) | views | modifiers | subset | offline
//   ?sort=cpu  the WebGL2 fallback's CPU sort, also on WebGPU (the bar
//              switches it live)
//   ?gpu=      webgpu | webgpu-gl (the bar's backend buttons reload with it)
//   ?url=      the splat file (default the butterfly); ?flip=0 keeps it as stored
// `radixScenes` in the console holds the page.
import * as THREE from "three";
import {
  CameraControls, GpuArrays, SplatProjector, SplatRenderer, Splats, TSL, createRenderer, getGpuCaps, loadSplats, type ArrayData, type SplatRendererOptions,
} from "@sparkjsdev/radix";
import { SCENES } from "./scenes.js";

const params = new URLSearchParams(location.search);
const name = SCENES[params.get("scene") ?? ""] ? params.get("scene")! : "multi";
const status = document.getElementById("status")!;
const bar = document.getElementById("bar")!;

const renderer = await createRenderer();
const webgpu = getGpuCaps(renderer).backend === "webgpu";
renderer.setPixelRatio(devicePixelRatio);
renderer.setSize(innerWidth, innerHeight);
document.body.prepend(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x101014);
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.01, 1000);
camera.position.set(0, 0.6, 3.2);
const controls = new CameraControls({ canvas: renderer.domElement, object: camera, settings: { mode: "orbit" } });
controls.lookAt(new THREE.Vector3());

// Every splat renderer of the scene, in the page's sort mode
let sortMode: "gpu" | "cpu" = webgpu && params.get("sort") !== "cpu" ? "gpu" : "cpu";
const splatRenderers: SplatRenderer[] = [];
const splatRenderer = (options: Omit<SplatRendererOptions, "renderer">) => {
  const made = new SplatRenderer({ renderer, sortMode, ...options });
  splatRenderers.push(made);
  return made;
};

// --- The bar: the scene links, the sort (switched live: every splat
// renderer's sortMode, and the URL follows), the backend (a reload), then
// the scene's own buttons ---

const lit: (() => void)[] = [];
const refresh = () => lit.forEach((light) => light());
const button = (label: string, onClick: () => void, active?: () => boolean, { disabled = false, title = "" } = {}) => {
  const element = Object.assign(document.createElement("button"), { textContent: label, disabled, title });
  element.onclick = () => {
    onClick();
    refresh();
  };
  if (active) {
    lit.push(() => element.classList.toggle("active", active()));
  }
  bar.append(element);
  refresh();
};
const gap = () => bar.append(Object.assign(document.createElement("span"), { className: "gap" }));

// This page's URL with some parameters changed (undefined removes one)
const href = (changes: Record<string, string | undefined>) => {
  const next = new URLSearchParams(params);
  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined) {
      next.delete(key);
    } else {
      next.set(key, value);
    }
  }
  return `?${next}`;
};
const links = Object.keys(SCENES).map((scene) => {
  const link = Object.assign(document.createElement("a"), { textContent: scene });
  link.classList.toggle("active", scene === name);
  bar.append(link);
  return { link, scene };
});
lit.push(() => links.forEach(({ link, scene }) => (link.href = href({ scene }))));
gap();

for (const mode of ["gpu", "cpu"] as const) {
  button(`${mode} sort`, () => {
    sortMode = mode;
    splatRenderers.forEach((each) => (each.sortMode = mode));
    params.set("sort", mode);
    history.replaceState(null, "", href({}));
  }, () => sortMode === mode, { disabled: mode === "gpu" && !webgpu, title: mode === "gpu" ? "WgpuSplatSorter every frame (WebGPU)" : "the WebGL2 fallback's CPU sort: keys read back, sorted on a worker" });
}
for (const [backend, label] of [["webgpu", "WebGPU"], ["webgpu-gl", "WebGL2"]] as const) {
  button(label, () => (location.search = href({ gpu: backend, sort: backend === "webgpu-gl" ? undefined : params.get("sort") ?? undefined })), () => (backend === "webgpu") === webgpu, { title: "reloads the page on this backend" });
}
gap();

// --- The file, centered at the origin about a unit in radius, upright ---

// The 2nd to 98th percentile of sampled centers per axis, so floaters do
// not count
function fitMatrix(loaded: ArrayData, flip: boolean) {
  const { bundle } = Splats.get(loaded);
  const samples = Math.min(loaded.count, 65536);
  const axes = [new Float32Array(samples), new Float32Array(samples), new Float32Array(samples)];
  const c = { x: 0, y: 0, z: 0 };
  for (let s = 0; s < samples; s += 1) {
    Splats.loadCenter(bundle, Math.floor((s * loaded.count) / samples), c);
    [axes[0][s], axes[1][s], axes[2][s]] = [c.x, c.y, c.z];
  }
  const [lo, hi] = [new THREE.Vector3(), new THREE.Vector3()];
  axes.forEach((values, axis) => {
    values.sort();
    lo.setComponent(axis, values[Math.floor(samples * 0.02)]);
    hi.setComponent(axis, values[Math.min(samples - 1, Math.floor(samples * 0.98))]);
  });
  const box = new THREE.Box3(lo, hi);
  const center = box.getCenter(new THREE.Vector3());
  const scale = 2 / Math.max(box.getSize(new THREE.Vector3()).length(), 1e-6);
  return new THREE.Matrix4().makeScale(scale, scale, scale)
    .multiply(new THREE.Matrix4().makeRotationX(flip ? Math.PI : 0))
    .multiply(new THREE.Matrix4().makeTranslation(-center.x, -center.y, -center.z));
}

const url = params.get("url") ?? "https://storage.googleapis.com/forge-dev-public/asundqui/radix/261009/rdx/butterfly-ai.rdx";
status.textContent = `Loading ${url}...`;
const data = await loadSplats(url, { worker: true, onProgress: (fraction, stage) => (status.textContent = `${url}: ${stage} ${Math.round(fraction * 100)}%`) });
const splats = GpuArrays.fromData(renderer, data);
const fit = fitMatrix(data, params.get("flip") !== "0");

// --- The scene and the frame loop ---

const time = TSL.uniform(0);
const demo = SCENES[name]({ renderer, scene, camera, controls, data, splats, fit, webgpu, time, button, splatRenderer });

let frames = 0;
let fps = 0;
let last = performance.now();
renderer.setAnimationLoop((now) => {
  controls.update();
  time.value = now / 1000;
  demo.frame?.(now / 1000);
  if (demo.render) {
    demo.render();
  } else {
    renderer.render(scene, camera);
  }

  frames += 1;
  if (now - last > 500) {
    fps = (frames * 1000) / (now - last);
    frames = 0;
    last = now;
  }
  status.textContent = [
    `${name} | ${webgpu ? "WebGPU" : "WebGL2"} | ${sortMode} sort | ${data.count.toLocaleString()} splats in the file | ${SplatProjector.programs} programs | ${fps.toFixed(0)} fps`,
    demo.status?.() ?? "",
  ].join("\n");
});

addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

Object.assign(window, { radixScenes: { renderer, scene, camera, controls, data, splats, demo } });
