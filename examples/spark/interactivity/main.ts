// Spark's interactivity ("Tipatat's Splat Restaurant"): food scans fading in
// and out over a table lit by a spotlight
import * as THREE from "three";
import { CameraControls } from "@sparkjsdev/radix";
import { asset, loadGlb } from "../js/assets.js";
import { SplatSet, type SplatModel } from "../js/objects.js";
import { examplePage, windowRenderer } from "../js/page.js";

const FOODS = [
  { name: "Branzino Amarin", file: "branzino-amarin.spz", scale: 0.3, shadowSize: 1 },
  { name: "Iberico Sandwich", file: "iberico-sandwich-by-reserve.spz", scale: 0.6, shadowSize: 0, offsetY: -0.05 },
  { name: "Coral Caviar", file: "coral-caviar.spz", scale: 0.4, shadowSize: 0.7 },
  { name: "Pad Thai", file: "pad-thai.spz", scale: 0.2, shadowSize: 1 },
  { name: "Prime Rib", file: "primerib-tamos.spz", scale: 0.3, shadowSize: 1.1 },
  { name: "Double-Double", file: "double-double-from-InNOut.spz", scale: 0.5, shadowSize: 0.6, offsetY: 0.03 },
  { name: "Gyro Kebab", file: "gyro.spz", scale: 0.13, shadowSize: 0, offsetY: -0.13 },
  { name: "Mels Steak Sandwich", file: "steaksandwich-mels.spz", scale: 0.3, shadowSize: 0, offsetY: 0.08 },
  { name: "Clams and Caviar", file: "clams-and-caviar-by-ikoyi.spz", scale: 0.4, shadowSize: 0.72 },
  { name: "Tomahawk Niku", file: "tomahawk-niku.spz", scale: 0.3, shadowSize: 1 },
  { name: "Dh Burger", file: "burger-from-amboy.spz", scale: 0.4, shadowSize: 0.6, offsetY: 0.04 },
];

const page = examplePage("interactivity");

const IS_MOBILE = "ontouchstart" in window || navigator.maxTouchPoints > 0;
const menu = document.getElementById("menu")!;
const menuList = document.getElementById("menu_list")!;
const mobileButton = document.getElementById("mobile_button")!;
mobileButton.addEventListener("click", () => menu.classList.toggle("visible"));

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(65, innerWidth / innerHeight, 0.1, 1000);
camera.position.set(0, 0.9, -1.2);

// The lit meshes need three's sRGB output pass
const renderer = await windowRenderer(camera, { directCanvas: false });
renderer.shadowMap.enabled = true;

const controls = new CameraControls({
  canvas: renderer.domElement, object: camera,
  settings: { mode: "orbit", minDistance: 0.8, maxDistance: 2.3 },
});
controls.lookAt(new THREE.Vector3(0.2, 0, 0));

const table = await loadGlb("table.glb");
table.children.find((item) => item.name === "cover")!.receiveShadow = true;
scene.add(table);

// Every scan up front (Spark's preloadSplats), out of the scene until shown
const splats = new SplatSet({ renderer, scene });
let loaded = 0;
const foods = await Promise.all(FOODS.map(async (food) => {
  const model = await splats.load(asset(food.file), { onProgress: page.progress(food.file), opacity: 0 });
  scene.remove(model);
  model.rotation.x = Math.PI;
  model.position.y = food.offsetY ?? 0;
  model.scale.setScalar(food.scale);
  page.status(`Loaded ${++loaded} of ${FOODS.length} food scans`);
  return { ...food, model };
}));

const spotLight = new THREE.SpotLight(0xffcc88, 3, 0, 0.9, 1);
spotLight.position.set(0, 1, 0);
spotLight.castShadow = true;
spotLight.shadow.mapSize.set(1024, 1024);
spotLight.shadow.camera.near = 0.1;
spotLight.shadow.camera.far = 5;
scene.add(spotLight);

const fillLight = new THREE.PointLight(0xffcc88, 0.2);
fillLight.position.set(0, 0, -3);
scene.add(fillLight);

// Splats cast no shadows: an invisible cylinder fakes one
const shadow = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.45, 0.04, 40, 1), new THREE.MeshPhongMaterial({ colorWrite: false, depthWrite: false }));
shadow.visible = false;
shadow.castShadow = true;
shadow.position.set(0, 0.1, 0);
scene.add(shadow);

const floor = new THREE.Mesh(new THREE.PlaneGeometry(10, 10), new THREE.MeshPhongMaterial({ color: 0x777777 }));
floor.rotation.x = -Math.PI / 2;
floor.position.set(0, -1.397, 0);
scene.add(floor);

// A switch fades the shown food out over FADE frames, then the next one in
const FADE = IS_MOBILE ? 30 : 60;
const easeInOutSine = (x: number) => -(Math.cos(Math.PI * x) - 1) / 2;
let shown: SplatModel | undefined;
let next: (typeof foods)[number] | undefined;
let frame = 0;

function switchTo(index: number) {
  if (next) {
    return;
  }
  next = foods[index];
  next.model.opacity = 0;
  scene.add(next.model);
  shadow.visible = false;
  frame = 0;

  [...menuList.children].forEach((link, i) => link.classList.toggle("active", i === index));
  if (IS_MOBILE) {
    menu.classList.remove("visible");
  }
}

foods.forEach(({ name }, i) => {
  const link = Object.assign(document.createElement("a"), { textContent: name, href: "javascript:;" });
  link.addEventListener("click", () => switchTo(i));
  menuList.append(link);
});
menu.classList.add("visible");
mobileButton.classList.toggle("visible", IS_MOBILE);
switchTo(0);
page.ready(renderer);

function fade() {
  if (!next) {
    return;
  }
  frame += 1;
  if (frame <= FADE) {
    if (shown) {
      shown.opacity = 1 - easeInOutSine(frame / FADE);
    }
    if (frame === FADE) {
      shadow.scale.setScalar(next.shadowSize);
      shadow.visible = true;
      // Spark keeps faded food in the scene at opacity 0; dropping it draws less
      if (shown && shown !== next.model) {
        scene.remove(shown);
      }
    }
  } else {
    next.model.opacity = easeInOutSine(Math.min((frame - FADE) / FADE, 1));
    if (frame === 2 * FADE) {
      shown = next.model;
      next = undefined;
    }
  }
}

renderer.setAnimationLoop((time) => {
  controls.update();
  const rotation = time / 10000;
  table.rotation.y = rotation;
  for (const model of [shown, next?.model]) {
    if (model) {
      model.rotation.y = -rotation;
    }
  }
  fade();
  renderer.render(scene, camera);
});
