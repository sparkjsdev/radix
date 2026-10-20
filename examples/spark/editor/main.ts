// Spark's editor, the parts Radix supports: open, drop or paste the URLs of
// several splat files (?url=, repeated; ?x= ?y= ?z= ?qx= ?qy= ?qz= ?qw= for
// the camera), each with its opacity, position, scale and rotation; a
// coordinate-system frame, auto-rotate, fly or orbit, a grid, bounding boxes,
// normal coloring and a clip box (one world modifier), the render params,
// the splat layout and packed ranges (on reload), frame stats and Radix's
// four projection methods. Files with a LoD tree draw their leaves.
// Left out (Radix lacks them): LoD building and traversal, spherical
// harmonics, .splat / .ksplat / .zip / .sog files.
import * as THREE from "three";
import GUI from "lil-gui";
import { CameraControls, GpuSplats, Splats, TSL, loadSplatFile, type SplatModifier } from "@sparkjsdev/radix";
import { constructGrid, textSplats } from "../js/construct.js";
import { SplatSet, type StoredModel } from "../js/objects.js";
import { examplePage, windowRenderer } from "../js/page.js";
import { fileOf, releaseFile } from "../js/files.js";

const { dot, float, max, select, uniform } = TSL;

const page = examplePage("editor", { note: "no LoD, no spherical harmonics, no .splat / .ksplat / .zip / .sog" });

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000000);
const camera = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.01, 1000);

// createRenderer, sized to the window and added to the page; it follows
// window resizes, the camera's aspect too (js/page.ts)
const renderer = await windowRenderer(camera, { pixelRatio: devicePixelRatio });
const controls = new CameraControls({ canvas: renderer.domElement, object: camera, settings: { mode: "fly" } });

// Files go in `frame` (the coordinate system's axes), turned by `spin`
const FRAMES: Record<string, [number, number, number, number]> = {
  OpenGL: [0, 0, 0, 1], OpenCV: [1, 0, 0, 0], "Z-up": [-Math.SQRT1_2, 0, 0, Math.SQRT1_2],
};
const spin = new THREE.Group();
const frame = new THREE.Group();
spin.add(frame);
scene.add(spin);

// The world modifier: normal coloring and the clip box
const cameraPosition = uniform(new THREE.Vector3());
const normalColor = uniform(0);
const clip = { enable: uniform(0), min: uniform(new THREE.Vector3(-5, -5, -5)), max: uniform(new THREE.Vector3(5, 5, 5)) };
const editorModifier: SplatModifier = (s) => {
  const out = s.toVar();
  const center = s.get("center").toVar();
  const normal = GpuSplats.normalOf(s).toVar();
  const facing = select(dot(center.sub(cameraPosition), normal).greaterThanEqual(0), normal.negate(), normal);
  out.get("rgb").assign(select(normalColor.greaterThan(0.5), facing.mul(0.5).add(0.5), s.get("rgb")));

  const outside = max(clip.min.sub(center), center.sub(clip.max));
  const within = max(outside.x, max(outside.y, outside.z)).lessThanEqual(0);
  out.get("opacity").assign(select(clip.enable.lessThan(0.5).or(within), s.get("opacity"), float(0)));
  return out;
};

// One renderer for every model: the files, the grid and the instructions
const splats = new SplatSet({ renderer, scene, modifier: editorModifier, modifierSpace: "world" });

const grid = splats.of(constructGrid({ extents: new THREE.Box3().setFromCenterAndSize(new THREE.Vector3(), new THREE.Vector3(20, 20, 20)) }).build());
grid.opacity = 0;
grid.visible = false;

const text = textSplats({ text: "Drag and Drop\na Gsplat file\nhere to view", textAlign: "center", fontSize: 64, objectScale: 0.1 / 64 });
const instructions = splats.of(text.data);
instructions.recolor = text.color;
spin.add(instructions);

const settings = {
  coordinates: "OpenGL", autoRotate: true, boundingBoxes: false, replace: true, loadOffset: 0, url: "",
  layout: "extSplats" as "extSplats" | "packedSplats", highDpi: true, stats: false, background: "#000000",
  open: () => fileInput.click(),
  reload: () => loadFiles(loaded.map(({ source }) => source), true),
  resetView: () => {
    camera.position.set(0, 0, 1);
    camera.quaternion.identity();
    camera.fov = 75;
    camera.updateProjectionMatrix();
  },
};
// Ranges of the packed layout's quantized colors and scales
const encoding = { ...Splats.DEFAULT_PACKED_ENCODING };

// A Box3Helper around a model's splat centers, in its own space
function boundingBox(model: StoredModel) {
  const box = new THREE.Box3();
  const { bundle } = Splats.get(model.data);
  const center = new THREE.Vector3();
  for (let i = 0; i < model.data.count; i += 1) {
    box.expandByPoint(Splats.loadCenter(bundle, i, center));
  }
  const helper = new THREE.Box3Helper(box, 0x00ff00);
  helper.visible = settings.boundingBoxes;
  return helper;
}

// --- Loading ---

const gui = new GUI({ title: "Settings" });
const files = gui.addFolder("Files");
let loaded: { source: string | File; model: StoredModel; folder: GUI }[] = [];

async function loadFiles(sources: (string | File)[], replace = settings.replace) {
  if (replace) {
    for (const { model, folder } of loaded) {
      splats.remove(model);
      model.removeFromParent();
      folder.destroy();
    }
    loaded = [];
  }
  instructions.visible = false;
  settings.autoRotate = false;
  spin.rotation.set(0, 0, 0);

  for (const [index, source] of sources.entries()) {
    const name = typeof source === "string" ? source.split("/").pop()!.split("?")[0] : source.name;
    try {
      const { splats: data, shPalette } = await loadSplatFile(source, { name, layout: settings.layout, encoding, onProgress: page.progress(name) });
      // Drawn through its LoD tree's leaves, if it has one
      const file = fileOf(renderer, data, shPalette);
      const model = splats.of(file, { release: () => releaseFile(file) });
      // Each file after the first is offset along a diagonal
      const offset = settings.loadOffset * index;
      model.position.set(offset, 0.5 * offset, 0.1 * offset);
      model.add(boundingBox(model));
      frame.add(model);
      loaded.push({ source, model, folder: fileFolder(name, model) });
      page.status("");
    } catch (error) {
      console.error(error);
      page.status(`Could not load ${name}: ${(error as Error).message}`);
    }
  }
}

function fileFolder(name: string, model: StoredModel) {
  const folder = files.addFolder(name).close();
  folder.add(model, "opacity", 0, 1, 0.01);
  folder.add({ scale: 1 }, "scale", 0.01, 4, 0.01).onChange((value: number) => model.scale.setScalar(value));
  poseControls(folder, model);
  return folder;
}

// Position and rotation sliders of an object (they follow other changes)
function poseControls(folder: GUI, object: THREE.Object3D) {
  for (const axis of ["x", "y", "z"] as const) {
    folder.add(object.position, axis, -10, 10, 0.01).name(`position ${axis}`).listen();
  }
  for (const axis of ["x", "y", "z"] as const) {
    folder.add(object.rotation, axis, -Math.PI, Math.PI, 0.01).name(`rotate ${axis}`).listen();
  }
}

// The splat file URLs in some text
const urlsIn = (text: string) => text.split(/[\s,;]+/).filter((part) => /^https?:\/\//.test(part) && /\.(ply|spz|rad|rdx)/i.test(part));

const fileInput = Object.assign(document.createElement("input"), { type: "file", accept: ".ply,.spz,.rad,.rdx", multiple: true });
fileInput.onchange = () => loadFiles([...fileInput.files ?? []]);

const canvas = renderer.domElement;
canvas.addEventListener("dragover", (event) => {
  event.preventDefault();
  canvas.style.opacity = "0.5";
});
canvas.addEventListener("dragleave", () => (canvas.style.opacity = "1"));
canvas.addEventListener("drop", (event) => {
  event.preventDefault();
  canvas.style.opacity = "1";
  const urls = urlsIn(event.dataTransfer?.getData("text/plain") ?? "");
  const dropped = [...event.dataTransfer?.files ?? []].filter((file) => /\.(ply|spz|rad|rdx)$/i.test(file.name));
  if (urls.length || dropped.length) {
    loadFiles(urls.length ? urls : dropped);
  }
});

// --- GUI ---

files.add(settings, "open").name("Open files");
files.add(settings, "url").name("Paste URL(s)").onFinishChange((value: string) => {
  const urls = urlsIn(value);
  if (urls.length) {
    settings.url = "";
    loadFiles(urls);
  }
});
files.add(settings, "replace").name("Replace on load");
files.add(settings, "loadOffset", -2, 2, 0.01).name("Loading offset");
files.add(settings, "layout", ["extSplats", "packedSplats"]).name("Layout (on reload)");
const packed = files.addFolder("Packed ranges (on reload)").close();
packed.add(encoding, "rgbMin", -1, 1, 0.1).name("RGB min");
packed.add(encoding, "rgbMax", 0, 4, 0.1).name("RGB max");
packed.add(encoding, "lnScaleMin", -14, -2.5, 0.1).name("ln scale min");
packed.add(encoding, "lnScaleMax", -14, 14, 0.1).name("ln scale max");
files.add(settings, "reload").name("Reload files");

const view = gui.addFolder("View");
view.add(splats.renderer, "method", ["ewa", "3dgut", "htgs", "raygs"]).name("Projection method");
view.add(controls, "mode", ["fly", "orbit"]).name("Controls").listen();
view.add({ invert: false }, "invert").name("Reverse pointer").onChange((value: boolean) => controls.set({ invertLookX: value, invertLookY: value }));
view.add(settings, "resetView").name("Reset view");
view.add(camera, "fov", 1, 179, 1).listen().onChange(() => camera.updateProjectionMatrix());
poseControls(view.addFolder("Camera pose").close(), camera);
view.add(settings, "highDpi").name("High DPI").onChange((value: boolean) => renderer.setPixelRatio(value ? devicePixelRatio : 1));
view.add(settings, "stats").name("Frame stats").onChange((value: boolean) => value || page.status(""));
view.addColor(settings, "background").name("Background").onChange((value: string) => (scene.background as THREE.Color).set(value));
view.add(settings, "coordinates", Object.keys(FRAMES)).name("Coordinate system").onChange((key: string) => frame.quaternion.set(...FRAMES[key]));
view.add(settings, "autoRotate").name("Auto rotate").listen();
view.add(grid, "opacity", 0, 1, 0.01).name("Grid opacity").onChange((value: number) => (grid.visible = value > 0));
view.add(settings, "boundingBoxes").name("Bounding boxes").onChange((value: boolean) => {
  frame.traverse((child) => child instanceof THREE.Box3Helper && (child.visible = value));
});
view.add({ normalColor: false }, "normalColor").name("Normal color").onChange((value: boolean) => (normalColor.value = value ? 1 : 0));

const { params, objectParams } = splats.renderer;
const render = gui.addFolder("Render").close();
render.add({ focus: 0 }, "focus", -2, 2, 0.01).name("ln(focal distance)").onChange((value: number) => (objectParams.focalDistance = Math.exp(value)));
render.add({ aperture: 0 }, "aperture", 0, 0.01 * Math.PI, 0.001).name("Aperture angle").onChange((value: number) => (objectParams.apertureTan = Math.tan(value / 2)));
render.add(params, "maxStdDev", 0.1, 3, 0.01).name("Max stddev");
render.add(params, "falloff", 0, 1, 0.01).name("Gaussian falloff");
render.add(params, "minAlpha", 0, 1, 0.001).name("Min alpha");
render.add(objectParams, "preBlurAmount", 0, 2, 0.1).name("Blur (no AA)").listen();
render.add(objectParams, "blurAmount", 0, 2, 0.1).name("Blur (AA)").listen();
render.add({ nonAA: () => Object.assign(objectParams, { preBlurAmount: 0.3, blurAmount: 0 }) }, "nonAA").name("Non-AA preset");
render.add({ AA: () => Object.assign(objectParams, { preBlurAmount: 0, blurAmount: 0.3 }) }, "AA").name("AA preset");
render.add(objectParams, "minPixelRadius", 0, 16, 0.1).name("Min pixel radius");
render.add(objectParams, "maxPixelRadius", 1, 1024, 1).name("Max pixel radius");
render.add(objectParams, "lodInflate").name("Soften LoD splats");

const clipFolder = gui.addFolder("Clip box").close();
clipFolder.add({ enable: false }, "enable").onChange((value: boolean) => (clip.enable.value = value ? 1 : 0));
for (const axis of ["x", "y", "z"]) {
  clipFolder.add(clip.min.value, axis, -50, 50, 0.01).name(`min ${axis}`);
  clipFolder.add(clip.max.value, axis, -50, 50, 0.01).name(`max ${axis}`);
}

// --- Start ---

const query = new URLSearchParams(location.search);
const number = (key: string, fallback: number) => (query.has(key) ? parseFloat(query.get(key)!) : fallback);
camera.position.set(number("x", 0), number("y", 0), number("z", 1));
if (["qx", "qy", "qz", "qw"].some((key) => query.has(key))) {
  camera.quaternion.set(number("qx", 0), number("qy", 0), number("qz", 0), number("qw", 1)).normalize();
}

const urls = query.getAll("url");
if (urls.length) {
  loadFiles(urls).then(() => page.ready(renderer));
} else {
  page.ready(renderer);
}

// Frames per second over half-second windows
let frames = 0;
let since = performance.now();
let last = 0;

renderer.setAnimationLoop((time) => {
  const delta = Math.min((time - last) / 1000, 0.1);
  last = time;
  controls.update();
  if (settings.autoRotate) {
    spin.rotation.y -= delta / 5;
  }
  cameraPosition.value.copy(camera.position);

  frames += 1;
  const now = performance.now();
  if (now - since > 500) {
    if (settings.stats) {
      const fps = (frames * 1000) / (now - since);
      page.status(`${fps.toFixed(0)} fps | ${splats.renderer.collection.count.toLocaleString()} splats | ${splats.renderer.method}`);
    }
    frames = 0;
    since = now;
  }
  renderer.render(scene, camera);
});
