// Spark's debug-color: one butterfly colored by its world normals (turned
// toward the camera), one by its view depth (Spark's modifiers
// setWorldNormalColor and setDepthColor). Spark sets a world modifier per
// mesh; a Radix renderer has one modifier, so each butterfly gets its own
// renderer (they do not overlap, so two sorts blend correctly).
import * as THREE from "three";
import { GpuSplats, SplatCollection, SplatRenderer, TSL,                } from "@sparkjsdev/radix";
import { asset } from "../js/assets.js";
import { examplePage, windowRenderer } from "../js/page.js";
import { fileObject, loadSplatFile } from "../js/files.js";

const { clamp, dot, float, log2, select, uniform, vec3 } = TSL;

const page = examplePage("debug-color");

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 1000);

// createRenderer, sized to the window and added to the page; it follows
// window resizes, the camera's aspect too (js/page.ts)
const renderer = await windowRenderer(camera);

// World normals, flipped to face the camera (world space)
const cameraPosition = uniform(new THREE.Vector3());
const normalColor = (s           ) => {
  const out = s.toVar();
  const normal = GpuSplats.normalOf(s).toVar();
  const away = dot(s.get("center").sub(cameraPosition), normal).greaterThanEqual(0);
  out.get("rgb").assign(select(away, normal.negate(), normal).mul(0.5).add(0.5));
  return out;
};

// Spark's normalizedDepth: log2 between near and far (view space)
const near = 1;
const far = 2;
const depthColor = (s           ) => {
  const out = s.toVar();
  const z = clamp(s.get("center").z.negate(), near, far);
  const depth = log2(z.add(1)).sub(Math.log2(near + 1)).div(Math.log2(far + 1) - Math.log2(near + 1));
  // reverse: near is white
  out.get("rgb").assign(vec3(float(1).sub(depth)));
  return out;
};

const butterfly = new THREE.Object3D();
butterfly.scale.setScalar(0.5);
butterfly.rotation.x = Math.PI;
butterfly.position.set(-0.5, 0, -1.5);
scene.add(butterfly);

const butterfly2 = new THREE.Object3D();
butterfly2.rotation.x = Math.PI;
butterfly2.position.set(0.5, 0, -1.5);
scene.add(butterfly2);

const [file, file2] = await Promise.all([
  loadSplatFile(renderer, asset("butterfly.spz"), { onProgress: page.progress("butterfly") }),
  loadSplatFile(renderer, asset("butterfly-ai.spz"), { onProgress: page.progress("butterfly-ai") }),
]);

// One renderer per modifier, one butterfly each
const normals = new SplatRenderer({ renderer, modifier: normalColor, modifierSpace: "world" });
normals.collection = new SplatCollection([fileObject(file, { matrixWorld: butterfly.matrixWorld })]);
scene.add(normals);

const depths = new SplatRenderer({ renderer, modifier: depthColor, modifierSpace: "view" });
depths.collection = new SplatCollection([fileObject(file2, { matrixWorld: butterfly2.matrixWorld })]);
scene.add(depths);
page.ready(renderer);

let last                    ;
renderer.setAnimationLoop((time) => {
  const delta = last === undefined ? 0 : Math.min((time - last) / 1000, 0.1);
  last = time;
  butterfly.rotation.y += delta * 0.4;
  butterfly2.rotation.x += delta * 0.4;
  cameraPosition.value.copy(camera.position);
  renderer.render(scene, camera);
});


//# sourceURL=examples/spark/debug-color/main.ts