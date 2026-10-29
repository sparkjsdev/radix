// Spark's splat-transitions: four transition effects picked from a menu
// (Spherical, Explosion, Flow, Morph), each a module in effects/ whose init
// builds the effect in a group of its own. Spark's per-mesh world modifiers
// become one generator per effect (js/worldEffect.js); scans load once and
// are shared between effects.
import GUI from "lil-gui";
import * as THREE from "three";
                                                   
import { CameraControls } from "@sparkjsdev/radix";
import { asset } from "../js/assets.js";
import { SplatModel, SplatSet } from "../js/objects.js";
import { examplePage, windowRenderer } from "../js/page.js";
import { loadSplatFile,                 } from "../js/files.js";
import { effectModel, worldEffectGenerator,                    } from "../js/worldEffect.js";

                                                              

// What an effect's init gets
                                
                           
                                                                
                                  
                                                     
                           
                                                                  
                     
                                                                             
                                                                                                                
                                                   
                                              
 

                         
                           
                         
                   
 

const page = examplePage("splat-transitions");

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000000);
const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.01, 2000);

// createRenderer, sized to the window and added to the page; it follows
// window resizes, the camera's aspect too (js/page.ts)
const renderer = await windowRenderer(camera, { antialias: true, directCanvas: false, pixelRatio: devicePixelRatio });

// Only the Explosion effect enables them
const controls = new CameraControls({ canvas: renderer.domElement, object: camera, storageKey: "spark-splat-transitions", settings: { moveSpeed: 3 } });
controls.enabled = false;

const splats = new SplatSet({ renderer, scene, animate: true });

const loaded = new Map                             ();
function loadScan(file        ) {
  if (!loaded.has(file)) {
    loaded.set(file, loadSplatFile(renderer, asset(file), { onProgress: page.progress(file) }));
  }
  return loaded.get(file) ;
}

function contextFor(group             )                {
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
                                       

const gui = new GUI();
let active                                                                 ;
let switches = 0;

async function show(name            ) {
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
  const effect         = await (await EFFECTS[name]()).init(contextFor(group));
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

gui.add({ Effect: "Spherical" }, "Effect", Object.keys(EFFECTS)).onChange((name            ) => show(name));
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


//# sourceURL=examples/spark/splat-transitions/main.ts