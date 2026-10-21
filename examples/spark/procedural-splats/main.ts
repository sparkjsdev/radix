// Spark's procedural-splats: a Sierpinski pyramid, stars, text and an image's
// pixels as splats made on the CPU. The text's color is baked into its splats
// where Spark tints them with recolor.
import * as THREE from "three";
import { CameraControls, GpuArrays, SplatCollection, SplatGenerator, SplatRenderer, TSL, type ArrayData, type SplatNode } from "@sparkjsdev/radix";
import { asset } from "../js/assets.js";
import { SplatBuilder, imageSplats, textSplats } from "../js/construct.js";
import { examplePage, windowRenderer } from "../js/page.js";

const { uniform } = TSL;

const page = examplePage("procedural-splats");

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.1, 1000);

const renderer = await windowRenderer(camera);
const controls = new CameraControls({ canvas: renderer.domElement, object: camera });

function points(count: number, size: number, place: (center: THREE.Vector3, color: THREE.Color) => void) {
  const builder = new SplatBuilder(count);
  const center = new THREE.Vector3();
  const scales = new THREE.Vector3().setScalar(size);
  const quaternion = new THREE.Quaternion();
  const color = new THREE.Color();
  for (let i = 0; i < count; i += 1) {
    place(center, color);
    builder.pushSplat(center, scales, quaternion, 1, color);
  }
  return builder.build();
}

function holder() {
  const object = new THREE.Object3D();
  scene.add(object);
  return object;
}

const CORNERS = [new THREE.Vector3(0, 1, -0.7), new THREE.Vector3(0, 0, 0), new THREE.Vector3(0.6, 1, 0.5), new THREE.Vector3(-0.6, 1, 0.5)];
const pyramidData = points(500000, 0.0005, (center, color) => {
  center.set(0, 0, 0);
  for (let i = 0; i < 15; i += 1) {
    center.add(CORNERS[Math.floor(Math.random() * 4)]).multiplyScalar(0.5);
  }
  color.setRGB(0.3 + center.x - center.z * 0.5, center.z * 1.5, 0.5 + center.z * 2);
});
const pyramid = holder();
pyramid.position.set(0, -0.5, -2);

const starsData = points(100000, 0.008, (center, color) => {
  center.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(50);
  color.setRGB(0.4 + Math.random() * 0.3, 0.5, 0.7 + Math.random() * 0.3);
});
const stars = holder();
stars.position.set(0, -0.5, -2);

const loveData = textSplats({ text: "I        GSplats!", font: "Arial", fontSize: 60, rgb: new THREE.Color(0xe420b7) }).data;
const love = holder();
love.scale.setScalar(0.5 / 80);
love.position.set(0.15, -1, -2);

const helpData = textSplats({ text: "WASD + mouse to move", font: "Verdana", fontSize: 30, rgb: new THREE.Color(0x49eaff) }).data;
const help = holder();
help.scale.setScalar(0.2 / 40);
help.position.set(0, 1, -2);

const imageData = await imageSplats({ url: asset("butterfly.png") });
const image = holder();
image.scale.setScalar(0.7 / 400);
image.position.set(-0.5, -1, -2);

const helpOpacity = uniform(1);
const fade = (s: SplatNode) => {
  const out = s.toVar();
  out.get("opacity").assign(s.get("opacity").mul(helpOpacity));
  return out;
};

// Five tables in one collection, so one sort
const upload = (data: ArrayData) => GpuArrays.fromData(renderer, data);
const helpArrays = upload(helpData);
const splats = new SplatRenderer({ renderer });
splats.collection = new SplatCollection([
  SplatCollection.arrays(upload(pyramidData), { matrixWorld: pyramid.matrixWorld }),
  SplatCollection.arrays(upload(starsData), { matrixWorld: stars.matrixWorld }),
  SplatCollection.arrays(upload(loveData), { matrixWorld: love.matrixWorld }),
  SplatCollection.object({
    generator: SplatGenerator.fromSplats({ layout: "extSplats", modifiers: [fade] }),
    data: { splats: helpArrays },
    count: helpArrays.count,
    matrixWorld: help.matrixWorld,
  }),
  SplatCollection.arrays(upload(imageData), { matrixWorld: image.matrixWorld }),
]);
scene.add(splats);
page.ready(renderer);

renderer.setAnimationLoop((time) => {
  controls.update();
  pyramid.rotation.y = time / 5000;
  stars.position.z = Math.sin(time / 10000) * 10;
  image.rotation.set(-0.3 + 0.35 * Math.sin(time / 190), 0.35 * Math.sin(time / 390), 0.1 * Math.sin(time / 200));
  image.position.y = -0.9 + 0.04 * Math.sin(time / 330);
  helpOpacity.value = Math.abs(Math.sin(time / 1000) * 0.3);
  renderer.render(scene, camera);
});
