// Spark's splat-transitions: four transition effects picked from a menu. Spark's
// per-mesh world modifiers become one generator per effect, from js/worldEffect.ts.
import GUI from "lil-gui";
import * as THREE from "three";
import type { WebGPURenderer } from "three/webgpu";
import { CameraControls } from "@sparkjsdev/radix";
import { asset } from "../js/assets.js";
import { SplatModel, SplatSet } from "../js/objects.js";
import { examplePage, windowRenderer } from "../js/page.js";
import { loadSplatFile, type LoadedFile } from "../js/files.js";
import { effectModel, worldEffectGenerator, type EffectPayload } from "../js/worldEffect.js";

type WorldEffect = Parameters<typeof worldEffectGenerator>[0];

export interface EffectContext {
  renderer: WebGPURenderer;
  // Placed by the effect, and moved by it except in Explosion
  camera: THREE.PerspectiveCamera;
  // Disabled; only Explosion enables them
  controls: CameraControls;
  // In the scene while the effect is shown, with its splat models
  group: THREE.Group;
  // Scan i of files as object i of one world effect, upright, in the group
  scans(files: string[], effect: WorldEffect, perObject?: (data: EffectPayload) => void): Promise<SplatModel[]>;
  // A scan, loaded once for every effect
  loadScan(file: string): Promise<LoadedFile>;
}

export interface Effect {
  update(dt: number): void;
  gui(folder: GUI): void;
  dispose?(): void;
}

const page = examplePage("splat-transitions");

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000000);
const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.01, 2000);

const renderer = await windowRenderer(camera, { antialias: true, directCanvas: false, pixelRatio: devicePixelRatio });

const controls = new CameraControls({ canvas: renderer.domElement, object: camera, settings: { moveSpeed: 3 } });
controls.enabled = false;

const splats = new SplatSet({ renderer, scene, animate: true });

const loaded = new Map<string, Promise<LoadedFile>>();
function loadScan(file: string) {
  if (!loaded.has(file)) {
    loaded.set(file, loadSplatFile(renderer, asset(file), { onProgress: page.progress(file) }));
  }
  return loaded.get(file)!;
}

function contextFor(group: THREE.Group): EffectContext {
  return {
    renderer, camera, controls, group, loadScan,
    async scans(files, effect, perObject) {
      const generator = worldEffectGenerator(effect, { perObject });
      const scans = await Promise.all(files.map(loadScan));
      return scans.map(({ arrays }, i) => {
        const model = effectModel(generator, arrays, i);
        // Spark's scans are upside down
        model.rotation.x = Math.PI;
        group.add(model);
        return model;
      });
    },
  };
}

const EFFECTS = {
  Spherical: () => import("./effects/spheric.js"),
  Explosion: () => import("./effects/explosion.js"),
  Flow: () => import("./effects/flow.js"),
  Morph: () => import("./effects/morph.js"),
};
type EffectName = keyof typeof EFFECTS;

const gui = new GUI();
let active: { effect: Effect; group: THREE.Group; folder: GUI } | undefined;
let switches = 0;

async function show(name: EffectName) {
  const token = ++switches;
  page.status(`Loading ${name}...`);
  if (active) {
    active.effect.dispose?.();
    active.folder.destroy();
    scene.remove(active.group);
    splats.remove(...splats.models);
    active = undefined;
  }

  const group = new THREE.Group();
  const effect: Effect = await (await EFFECTS[name]()).init(contextFor(group));
  if (token !== switches) {
    effect.dispose?.();
    return;
  }

  scene.add(group);
  splats.add(...group.children.filter((child) => child instanceof SplatModel));
  const folder = gui.addFolder(name);
  effect.gui(folder);
  active = { effect, group, folder };
  page.status("");
}

gui.add({ Effect: "Spherical" }, "Effect", Object.keys(EFFECTS)).onChange((name: EffectName) => show(name));
await show("Spherical");
page.ready(renderer);

let last = 0;
renderer.setAnimationLoop((time) => {
  const delta = last ? Math.min((time - last) / 1000, 0.1) : 0;
  last = time;
  controls.update();
  active?.effect.update(delta);
  renderer.render(scene, camera);
});
