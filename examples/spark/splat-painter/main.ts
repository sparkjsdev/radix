// Spark's splat-painter: paint, erase and restore the splats of a scan with
// a brush (a cylinder along the pointer's ray), then export to SPZ. The
// renderer's world modifier previews the brush; a drag bakes it into the
// stored splats with a GpuArrayWriter (a fragment pass on both backends)
// that reads the current splats and writes a scratch copy, swapped in. The
// original splats stay on the GPU for the restore brush. Export reads the
// painted splats back, drops erased ones and writes SPZ.
import * as THREE from "three";
import { GUI, type Controller } from "lil-gui";
import {
  CameraControls, GpuArrayWriter, GpuArrays, GpuSplatReader, GpuSplats, Splats, TSL, loadSplats, writeSplats, type ExtSplats, type SplatNode, type TslNode,
} from "@sparkjsdev/radix";
import { asset } from "../js/assets.js";
import { SplatModel, SplatSet } from "../js/objects.js";
import { examplePage, windowRenderer } from "../js/page.js";

const { dot, float, length, select, uniform, vec3, vec4 } = TSL;

const page = examplePage("splat-painter");

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xaaffff);
const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.01, 1000);

// createRenderer, sized to the window and added to the page; it follows
// window resizes, the camera's aspect too (js/page.ts)
const renderer = await windowRenderer(camera);
const controls = new CameraControls({ canvas: renderer.domElement, object: camera, settings: { mode: "fly" } });

const MODES = ["View", "Paint", "Erase", "Restore"];
const mode = uniform(0);
const brushRadius = uniform(0.05);
const brushDepth = uniform(10);
const brushOrigin = uniform(new THREE.Vector3());
const brushDirection = uniform(new THREE.Vector3());
// lil-gui sets the hex's sRGB components as they are, as Spark's brush does
const brushColor = uniform(new THREE.Color(1, 0, 1));
const toWorld = uniform(new THREE.Matrix4());

const legend = page.legend("");
function showMode() {
  legend.innerHTML = `<b>${MODES[mode.value]}</b> | 1 paint, 2 erase, 3 restore, Esc view | +/- radius, [/] depth`;
}
showMode();

// The brush applied to a splat at a world-space center; original: a reader
// of the unpainted splats (the restore brush)
function brush(splat: SplatNode, worldCenter: TslNode, original: GpuSplatReader) {
  const along = dot(brushDirection, worldCenter.sub(brushOrigin)).toVar();
  const distance = length(brushOrigin.add(brushDirection.mul(along)).sub(worldCenter));
  const inside = distance.lessThan(brushRadius).and(along.greaterThan(0)).and(along.lessThan(brushDepth)).toVar();
  const rgb = splat.get("rgb").toVar();
  const luminanceOld = dot(rgb, vec3(1)).div(3).toVar();
  const painted = brushColor.mul(luminanceOld.div(dot(brushColor, vec3(1)).div(3)));
  const index = splat.get("index");
  const restore = mode.equal(3).and(inside);

  const out = splat.toVar();
  out.get("rgb").assign(select(restore, original.loadRgb(index), select(mode.equal(1).and(inside).and(luminanceOld.greaterThan(0.1)), painted, rgb)));
  out.get("opacity").assign(select(restore, original.loadOpacity(index), select(mode.equal(2).and(inside), float(0), splat.get("opacity"))));
  return out;
}

const previewOriginal = GpuSplatReader.for("extSplats");
const splats = new SplatSet({ renderer, scene, animate: true, modifier: (s) => brush(s, s.get("center"), previewOriginal), modifierSpace: "world" });

// The bake: current splats in, brushed splats out
const bakeCurrent = GpuSplatReader.for("extSplats");
const bakeOriginal = GpuSplatReader.for("extSplats");
const bakeWriter = new GpuArrayWriter({
  outputs: { extSplats: Splats.EXT },
  write: (index, out) => {
    const splat = bakeCurrent.loadSplat(index);
    const center = toWorld.mul(vec4(splat.get("center"), 1)).xyz;
    GpuSplats.storeExt(out.extSplats, brush(splat, center, bakeOriginal), bakeCurrent.loadPbr(index));
  },
});

// The painted splats, the unpainted ones and the bake's scratch copy, freed
// together once nothing draws the model
async function loadScan(source: string | File, name: string) {
  const data = await loadSplats(source, { name, onProgress: page.progress(name) });
  const arrays: GpuArrays = GpuArrays.fromData(renderer, data, { bundles: ["extSplats"] });
  const original = GpuArrays.fromData(renderer, data, { bundles: ["extSplats"] });
  const scratch: GpuArrays = new GpuArrays({ renderer, bundles: { extSplats: Splats.EXT }, capacity: arrays.capacity });
  const model = new SplatModel({ arrays, release: () => [arrays, original, scratch].forEach((each) => each.dispose()) });
  model.quaternion.set(1, 0, 0, 0);
  page.status("");
  return { model, arrays, original, scratch, name: name.split(".")[0] || "painted-splat" };
}

type Scan = Awaited<ReturnType<typeof loadScan>>;

function show(next: Scan) {
  splats.remove(scan.model);
  scan.model.removeFromParent();
  scan = next;
  splats.add(scan.model);
  previewOriginal.bind(scan.original);
}

let scan = await loadScan(asset("greyscale-bedroom.spz"), "greyscale-bedroom.spz");
show(scan);
page.ready(renderer);

function bake() {
  const { model, arrays, original, scratch } = scan;
  model.updateMatrixWorld();
  toWorld.value.copy(model.matrixWorld);
  bakeCurrent.bind(arrays);
  bakeOriginal.bind(original);
  scratch.write(bakeWriter, { at: 0, count: arrays.count });
  arrays.swap(scratch);
}

async function saveSpz() {
  page.status("Reading back the painted splats...");
  const { arrays, name } = scan;
  const painted = await arrays.read();
  const decode = Splats.decoder(painted.bundles.extSplats as ExtSplats);
  const s = Splats.makeExtSplat();
  const kept: number[] = [];
  for (let i = 0; i < arrays.count; i += 1) {
    if (decode(i, s).opacity > 0) {
      kept.push(i);
    }
  }

  const out = Splats.make(kept.length);
  const encode = Splats.encoder(out.bundles.extSplats);
  kept.forEach((i, j) => encode(j, decode(i, s)));
  const bytes = await writeSplats(out, "spz", { version: 3 });
  const link = Object.assign(document.createElement("a"), { href: URL.createObjectURL(new Blob([bytes])), download: `${name}-painted.spz` });
  link.click();
  URL.revokeObjectURL(link.href);
  page.status(`Saved ${kept.length.toLocaleString()} splats`);
}

function openFile() {
  const input = Object.assign(document.createElement("input"), { type: "file", accept: ".spz,.ply,.rad,.rdx" });
  input.onchange = () => {
    const file = input.files?.[0];
    if (file) {
      loadScan(file, file.name).then(show, page.fail);
    }
  };
  input.click();
}

// The brush follows the pointer's ray
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let dragging = false;
const canvas = renderer.domElement;
canvas.addEventListener("pointermove", (event) => {
  pointer.set((event.clientX / innerWidth) * 2 - 1, -(event.clientY / innerHeight) * 2 + 1);
  raycaster.setFromCamera(pointer, camera);
  brushDirection.value.copy(raycaster.ray.direction).normalize();
  brushOrigin.value.copy(raycaster.ray.origin);
  if (dragging) {
    bake();
  }
});
canvas.addEventListener("pointerdown", () => {
  dragging = true;
  bake();
});
canvas.addEventListener("pointerup", () => (dragging = false));
canvas.addEventListener("pointerleave", () => (dragging = false));

const gui = new GUI();
const radius = gui.add(brushRadius, "value", 0.01, 0.25, 0.01).name("Brush radius");
const depth = gui.add(brushDepth, "value", 0.1, 100, 0.1).name("Brush depth");
gui.addColor(brushColor, "value").name("Brush color");
gui.add({ openFile }, "openFile").name("Load splats");
gui.add({ saveSpz }, "saveSpz").name("Save splats (SPZ)");

// Brush size keys: the controller, its step and range
const STEPS: Record<string, [Controller, number, number, number]> = {
  "=": [radius, 0.01, 0.01, 0.25], "+": [radius, 0.01, 0.01, 0.25], "-": [radius, -0.01, 0.01, 0.25], _: [radius, -0.01, 0.01, 0.25],
  "]": [depth, 0.5, 0.1, 100], "[": [depth, -0.5, 0.1, 100],
};
addEventListener("keydown", (event) => {
  const step = STEPS[event.key];
  if (step) {
    const [controller, by, min, max] = step;
    controller.setValue(THREE.MathUtils.clamp(controller.getValue() + by, min, max));
  } else if (["1", "2", "3", "Escape"].includes(event.key)) {
    mode.value = event.key === "Escape" ? 0 : Number(event.key);
    // Drags paint while a brush is on
    controls.enabled = mode.value === 0;
    showMode();
  }
});

renderer.setAnimationLoop(() => {
  controls.update();
  renderer.render(scene, camera);
});
