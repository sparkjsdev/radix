// Spark's particle-animation: a cloud layer of CPU-made splats drifting
// with the wind inside a sky sphere. Every frame moves each splat on the
// CPU, encodes them again and uploads the table (GpuArrays.upload), like
// Spark's forEachSplat / setSplat / needsUpdate. A setting change makes a
// new cloud; the old one's arrays are freed in its object's release.
import * as THREE from "three";
import GUI from "lil-gui";
import { CameraControls, GpuArrays } from "@sparkjsdev/radix";
import { asset } from "../js/assets.js";
import { SplatBuilder, writeSplats } from "../js/construct.js";
import { SplatModel, SplatSet } from "../js/objects.js";
import { examplePage, windowRenderer } from "../js/page.js";

const MIN = new THREE.Vector3(-8, -0.33, -8);
const MAX = new THREE.Vector3(8, 0.33, 10);
const noiseParams = { octaves: 4, frequency: 0.3, amplitude: 0.5, lacunarity: 2, persistence: 0.5, phase: 0.1 };

const WHITE = { color1: new THREE.Color(1, 1, 1), color2: new THREE.Color(0.87, 0.87, 0.87) };
const PRESETS = {
  "Partially Cloudy": { ...WHITE, particleCount: 10000, opacity: 0.3, windSpeed: -0.5, fluffiness: 0.5, turbulence: 0.5, cloudDensity: 0.5 },
  Cloudy: { ...WHITE, particleCount: 20000, opacity: 0.5, windSpeed: -0.3, fluffiness: 0.5, turbulence: 0.5, cloudDensity: 0.7 },
  Storm: { particleCount: 30000, color1: new THREE.Color(0.66, 0.66, 0.66), color2: new THREE.Color(0.44, 0.44, 0.44), opacity: 0.7, windSpeed: -0.7, fluffiness: 1, turbulence: 0.8, cloudDensity: 1 },
};
const params = { ...PRESETS.Cloudy };

function noise(x: number, y: number, z: number, t: number) {
  let value = 0;
  let amp = noiseParams.amplitude;
  let freq = noiseParams.frequency;
  for (let i = 0; i < noiseParams.octaves; i += 1) {
    const to = t * noiseParams.phase * (i + 1);
    value += amp * Math.sin(x * freq + to) * Math.sin(y * freq + to) * Math.sin(z * freq + to);
    freq *= noiseParams.lacunarity;
    amp *= noiseParams.persistence;
  }
  return value;
}

// A splat's pseudo-random number in (-1, 1) of its seed, per key
const hash = (seed: number, key: number) => (Math.sin(seed * key) * 43758.5453) % 1;
const wrap = (value: number, min: number, max: number) => ((((value - min) % (max - min)) + (max - min)) % (max - min)) + min;

const page = examplePage("particle-animation");

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x08a2d3);
const camera = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.1, 1000);

// createRenderer, sized to the window and added to the page; it follows
// window resizes, the camera's aspect too (js/page.ts)
const renderer = await windowRenderer(camera);
const controls = new CameraControls({ canvas: renderer.domElement, object: camera, settings: { mode: "fly" } });

const sky = new THREE.Mesh(
  new THREE.SphereGeometry(10, 60, 40),
  new THREE.MeshBasicMaterial({ map: new THREE.TextureLoader().load(asset("sky.jpeg")), side: THREE.BackSide, depthWrite: false }),
);
sky.scale.set(-1, 1, 1);
scene.add(sky);

// The clouds move every frame: on the CPU sort (WebGL2) it sorts again
// every render
const splats = new SplatSet({ renderer, scene, animate: true });

// A cloud: its builder's values (14 floats per splat), table and arrays
function makeClouds() {
  const count = Math.floor(params.particleCount * params.cloudDensity);
  const builder = new SplatBuilder(count);
  const center = new THREE.Vector3();
  const scales = new THREE.Vector3(0.12, 0.08, 0.12);
  const quaternion = new THREE.Quaternion();
  const color = new THREE.Color();
  const now = performance.now() * 0.001 * 0.2;
  for (let i = 0; i < count; i += 1) {
    const seed = i * 0.12345;
    const random = new THREE.Vector3(hash(seed, 12.9898), hash(seed, 78.233), hash(seed, 37.719)).multiplyScalar(0.5).addScalar(0.5);
    const w = hash(seed, 93.989) * 0.5 + 0.5;
    center.subVectors(MAX, MIN).multiply(random).add(MIN);
    const fluffiness = Math.sin(w * Math.PI * 2) * params.fluffiness * 0.5;
    center.y += fluffiness;
    center.x += Math.sin(w * Math.PI * 8) * params.turbulence * 0.3;
    center.y += noise(center.x, center.y, center.z, now) * params.fluffiness * 0.1;
    color.copy(params.color2).lerp(params.color1, THREE.MathUtils.clamp((center.y - MIN.y) / (MAX.y - MIN.y), 0, 1));
    center.set(wrap(center.x, MIN.x, MAX.x), wrap(center.y, MIN.y, MAX.y), wrap(center.z, MIN.z, MAX.z));
    builder.pushSplat(center, scales, quaternion, Math.max(0.1, params.opacity * (0.8 + 0.4 * Math.abs(fluffiness))), color);
  }

  const data = builder.build();
  const arrays = GpuArrays.fromData(renderer, data);
  const model = new SplatModel({ arrays, data, release: () => arrays.dispose() });
  model.position.set(0, -0.5, -2);
  return { model, builder, data, arrays };
}

let clouds = makeClouds();
splats.add(clouds.model);

function remakeClouds() {
  splats.remove(clouds.model);
  clouds.model.removeFromParent();
  clouds = makeClouds();
  splats.add(clouds.model);
}

// Spark's onFrame: each splat's z from its seed and the wind
function animateClouds(time: number) {
  const { builder, data, arrays } = clouds;
  for (let i = 0; i < builder.count; i += 1) {
    const z = THREE.MathUtils.lerp(MIN.z, MAX.z, Math.abs(hash(i * 0.12345, 37.719))) + params.windSpeed * time;
    builder.values[i * 14 + 2] = wrap(z, MIN.z, MAX.z);
  }
  writeSplats(data.bundles.extSplats, builder.values, 0, builder.count);
  arrays.upload(data);
}

const gui = new GUI({ title: "Clouds" });
gui.add(params, "windSpeed", -1, 1, 0.1).name("Wind speed");
gui.add(params, "opacity", 0.05, 1, 0.01).name("Thickness").onChange(remakeClouds);
gui.add(params, "fluffiness", 0, 2, 0.01).name("Fluffiness").onChange(remakeClouds);
gui.add(params, "turbulence", 0, 1, 0.01).name("Turbulence").onChange(remakeClouds);
gui.add(params, "cloudDensity", 0.1, 1, 0.01).name("Cloud density").onChange(remakeClouds);
const advanced = gui.addFolder("Advanced").close();
advanced.add(noiseParams, "octaves", 1, 8, 1).name("Noise octaves").onChange(remakeClouds);
advanced.add(noiseParams, "frequency", 0.1, 1, 0.01).name("Noise frequency").onChange(remakeClouds);
const weather = gui.addFolder("Weather");
for (const [name, preset] of Object.entries(PRESETS)) {
  weather.add({ [name]: () => {
    Object.assign(params, preset);
    remakeClouds();
    gui.controllersRecursive().forEach((controller) => controller.updateDisplay());
  } }, name);
}
page.ready(renderer);

renderer.setAnimationLoop((time) => {
  controls.update();
  animateClouds(time / 1000);
  renderer.render(scene, camera);
});
