// Spark's render-cube-depth: the fireplace and a duck rendered into a cube
// map and read back (logged). With "Depth" on, splats are flat discs
// (falloff 0, maxStdDev 2) colored by their depth from the main camera,
// packed into RGB by a world-space modifier, the duck by the same packing in
// its own material, and the read-back faces are unpacked into distances.
// Spark renders the cube with a second SparkRenderer; here the cube faces
// draw through the page's renderer, whose settings the toggle changes.
import * as THREE from "three";
import { MeshBasicNodeMaterial,                       } from "three/webgpu";
import { CameraControls, TSL,                                  } from "@sparkjsdev/radix";
import { asset, loadGlb } from "../js/assets.js";
import { readCubeTargets, renderCubeMap } from "../js/cube.js";
import { SplatSet } from "../js/objects.js";
import { examplePage, windowRenderer } from "../js/page.js";

const { Fn, float, floor, fract, positionWorld, select, uniform, vec3, vec4 } = TSL;

const page = examplePage("render-cube-depth");
const legend = page.legend("<label><input type=\"checkbox\" autocomplete=\"off\"> Depth</label>");

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.1, 1000);
camera.position.set(0, 0.5, 0);

// createRenderer, sized to the window and added to the page; it follows
// window resizes, the camera's aspect too (js/page.ts)
const renderer = await windowRenderer(camera, { directCanvas: false });
const controls = new CameraControls({ canvas: renderer.domElement, object: camera, storageKey: "spark-render-cube-depth" });

const splats = new SplatSet({ renderer, scene });
const fireplace = await splats.load(asset("fireplace.spz"), { onProgress: page.progress("fireplace") });
fireplace.rotation.x = Math.PI;
fireplace.position.set(0.5, 0, -1);
fireplace.scale.setScalar(0.5);

const duck = await loadGlb("rubberduck.glb");
duck.position.set(0, 0.45, -0.4);
scene.add(duck, new THREE.AmbientLight(0xffffff, 1), new THREE.DirectionalLight(0xffffff, 1));

// three's packDepthToRGB of a depth in [0, 1]
const packDepthToRGB = Fn(([v]           ) => {
  const scaled = v.mul(256 * 256).toVar();
  const b = fract(scaled);
  const rest = floor(scaled).mul(1 / 256).toVar();
  const g = fract(rest).mul(256 / 255);
  const r = floor(rest).mul(1 / 255);
  return select(v.lessThanEqual(0), vec3(0), select(v.greaterThanEqual(1), vec3(1), vec3(r, g, b)));
});

// The main camera's world to clip transform, set every frame
const worldToClip = uniform(new THREE.Matrix4());
const depth01 = (world         ) => {
  const clip = worldToClip.mul(vec4(world, 1)).toVar();
  return clip.z.div(clip.w).mul(0.5).add(0.5);
};

const encodeDepth                = (s) => {
  const out = s.toVar();
  out.get("rgb").assign(packDepthToRGB(depth01(s.get("center"))));
  out.get("opacity").assign(select(s.get("opacity").greaterThan(0.1), float(1), float(0)));
  return out;
};

// The inverse of packDepthToRGB, then of the perspective depth
function unpackDistance(pixels                   , i        ) {
  const [r, g, b] = [pixels[i * 4], pixels[i * 4 + 1], pixels[i * 4 + 2]];
  if (r === 0 && g === 0 && b === 0) {
    return Infinity;
  }
  const depth = (r * 256 + g + b / 255) / 65536;
  return (2 * camera.near * camera.far) / (camera.far + camera.near - depth * (camera.far - camera.near));
}

const depthMaterial = new MeshBasicNodeMaterial();
depthMaterial.colorNode = packDepthToRGB(depth01(positionWorld));
const duckMaterials = new Map                                               ();
duck.traverse((child) => {
  if (child instanceof THREE.Mesh) {
    duckMaterials.set(child, child.material);
  }
});

let cubeTarget                              ;

async function renderCube(depth         ) {
  splats.renderer.modifier = depth ? encodeDepth : undefined;
  splats.renderer.modifierSpace = "world";
  Object.assign(splats.renderer.params, depth ? { falloff: 0, maxStdDev: 2 } : { falloff: 1, maxStdDev: Math.sqrt(8) });
  duckMaterials.forEach((material, mesh) => (mesh.material = depth ? depthMaterial : material));

  scene.updateMatrixWorld(true);
  cubeTarget = await renderCubeMap({ renderer, scene, splatRenderer: splats.renderer, worldCenter: camera.position, size: 512, target: cubeTarget });
  const faces = await readCubeTargets(renderer, cubeTarget);
  const size = `${cubeTarget.width}x${cubeTarget.height}`;
  if (!depth) {
    console.log("cubePixels", faces);
    page.status(`Read 6 cube faces of ${size} (console: cubePixels)`);
    return;
  }

  const distances = faces.map((pixels) => Float32Array.from({ length: pixels.length / 4 }, (_, i) => unpackDistance(pixels, i)));
  console.log("faceDistances", distances);
  const nearest = Math.min(...distances.map((face) => face.reduce((a, b) => Math.min(a, b), Infinity)));
  page.status(`Read 6 cube faces of ${size}; nearest packed distance ${nearest.toFixed(3)} (console: faceDistances)`);
}

legend.querySelector("input") .addEventListener("change", (event) => renderCube((event.target                    ).checked).catch(page.fail));
page.ready(renderer);

let last                    ;
renderer.setAnimationLoop((time) => {
  const delta = last === undefined ? 0 : Math.min((time - last) / 1000, 0.1);
  last = time;
  controls.update();
  duck.rotation.y += delta * 0.4;
  camera.updateMatrixWorld();
  worldToClip.value.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  renderer.render(scene, camera);
});


//# sourceURL=examples/spark/render-cube-depth/main.ts