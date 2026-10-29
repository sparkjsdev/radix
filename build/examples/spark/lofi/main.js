// Spark's lofi ("Lofi Worlds"): a hundred 500k-splat worlds that advance with
// the music ([ ] switch them), each morphing into the next, with rustling
// leaves, snow or rain, and in WebXR hands that push the splats around or
// (wrists tapped together) cast two spotlights.
//   - the last 10 worlds used stay loaded; an evicted world's arrays are freed
//     once no live collection draws it (its objects' release counts them)
//   - the morph: a generator reading splat i of both worlds, blended by a uniform
//   - one world-space modifier for the rustle, the ten fingertip forces and
//     the two spotlights, on the worlds and the snow
// Spark's sort360 / sort32: Radix's keys are distances from the head;
// sortBits 32 here.
import * as THREE from "three";
import GUI from "lil-gui";
import {
  CameraControls, GpuArrays, GpuSplatReader, GpuSplats, SplatCollection, SplatGenerator, SplatRenderer, TSL, loadSplats,
                                      
} from "@sparkjsdev/radix";
import { examplePage, windowRenderer } from "../js/page.js";
import { DEFAULT_RAIN, DEFAULT_SNOW, snowBox } from "../js/snow.js";
import { setupXr, xrBackend } from "../js/xr.js";
import { WORLDS, WORLD_EFFECT, WORLD_RUSTLE, WORLD_URL } from "./worlds.js";

const { abs, clamp, cos, dot, exp, float, length, mix, normalize, radians, select, sin, smoothstep, uniform, uniformArray, vec3, vec4 } = TSL;

const TRANSITION_MS = 1500;
const IDLE_BEE_START = 5;
const AUDIOS = [1, 2, 3, 4, 5, 6].map((i) => `https://wlt-ai-cdn.art/lofi/lofi-${i}.mp3`);

function shuffle   (array     ) {
  for (let i = array.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
}
shuffle(WORLDS);
shuffle(AUDIOS);

const page = examplePage("lofi");

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000000);
const camera = new THREE.PerspectiveCamera(65, innerWidth / innerHeight, 0.01, 1000);
const localFrame = new THREE.Group();
localFrame.add(camera);
scene.add(localFrame);

// createRenderer, sized to the window and added to the page; it follows
// window resizes, the camera's aspect too (js/page.ts)
const renderer = await windowRenderer(camera, { xr: true, backend: xrBackend() });

// The controls move the local frame (it carries the camera), in XR too; the
// idle bee drifts the worlds and the snow
const controls = new CameraControls({ canvas: renderer.domElement, object: localFrame, rig: localFrame, storageKey: "spark-lofi" });

const idleBee = new THREE.Group();
scene.add(idleBee);
const worldFrame = new THREE.Object3D();
worldFrame.quaternion.set(1, 0, 0, 0);
idleBee.add(worldFrame);

// --- Worlds: the last 10 used, least recently used first ---

                 
               
                           
                     
                            
               
                   
 
const worlds = new Map               ();

const maybeFree = (world       ) => world.evicted && world.refs === 0 && world.arrays?.dispose();

// The world `name`, loading it if needed
function getWorld(name        ) {
  let world = worlds.get(name);
  worlds.delete(name);
  if (!world) {
    const loading        = {
      name, refs: 0, evicted: false,
      loaded: loadSplats(WORLD_URL + name, { layout: "packedSplats", onProgress: page.progress(name.slice(0, 8)) }).then((data) => {
        loading.arrays = GpuArrays.fromData(renderer, data);
        page.status("");
        maybeFree(loading);
      }),
    };
    world = loading;
  }
  worlds.set(name, world);
  for (const [key, old] of worlds) {
    if (worlds.size <= 10) {
      break;
    }
    worlds.delete(key);
    old.evicted = true;
    maybeFree(old);
  }
  return world;
}

// --- Splat effects ---

const transitionT = uniform(0);
const idleBeeTranslate = uniform(0);
const rustleBlend = uniform(0);
const globalT = uniform(0);
const tips = Array.from({ length: 10 }, () => new THREE.Vector4());
const uTips = uniformArray(tips, "vec4");
// Per spotlight: origin and fov (0: off); direction
const spotlights = Array.from({ length: 2 }, () => new THREE.Vector4());
const spotlightDirs = Array.from({ length: 2 }, () => new THREE.Vector3());
const uSpotlights = uniformArray(spotlights, "vec4");
const uSpotlightDirs = uniformArray(spotlightDirs, "vec3");

// The morph: splat i of the current world into splat i of the next
const readCurrent = GpuSplatReader.for("packedSplats");
const readNext = GpuSplatReader.for("packedSplats");
const morphGenerator                                                          = {
  generateSplat(index) {
    const a = readCurrent.loadSplat(index);
    const b = readNext.loadSplat(index);
    const t = smoothstep(0, 1, transitionT).toVar();
    const qa = a.get("quaternion").toVar();
    const qb = b.get("quaternion").toVar();
    // slerp by a normalized lerp along the shorter arc
    const quaternion = normalize(mix(qa, select(dot(qa, qb).lessThan(0), qb.negate(), qb), t));
    return GpuSplats.Splat(
      mix(a.get("center"), b.get("center").add(vec3(0, 0, idleBeeTranslate)), t),
      mix(a.get("scales"), b.get("scales"), t),
      quaternion,
      mix(a.get("rgb"), b.get("rgb"), t),
      mix(a.get("opacity"), b.get("opacity"), t),
      index,
    );
  },
  bind({ current, next }) {
    readCurrent.bind(current);
    readNext.bind(next);
  },
};
const plainGenerator = SplatGenerator.fromSplats({ layout: "packedSplats" });

function worldModifier(s           ) {
  const out = s.toVar();
  const center = s.get("center").toVar();
  const rgb = s.get("rgb").toVar();

  // Rustle: Spark's colorWave, used as a displacement
  const len = length(center).toVar();
  const magnitude = sin(len.add(globalT).add(center.x.mul(1.7)).add(center.z.mul(2.3)).add(center.y.mul(0.9)))
    .mul(sin(len.mul(1.3).sub(globalT.mul(0.88)).add(center.y.mul(0.9)))).mul(exp(len.mul(len).mul(-0.01))).toVar();
  const k = float(1).sub(magnitude);
  const wave = mix(vec4(rgb, s.get("opacity")), vec4(abs(center.div(len)), s.get("opacity").mul(magnitude)), float(1).sub(k.mul(k))).toVar();
  center.addAssign(wave.xyz.mul(float(1).sub(wave.w)).mul(rustleBlend));

  // Fingertips push splats away and tint them
  const force = vec4(0).toVar();
  for (let i = 0; i < tips.length; i += 1) {
    const tip = uTips.element(i);
    const radius = tip.w.mul(10).toVar();
    const delta = center.sub(tip.xyz).toVar();
    const distance = length(delta).toVar();
    const weight = float(1).sub(distance.div(radius));
    force.addAssign(select(tip.w.greaterThan(0).and(distance.lessThan(radius)), vec4(delta.div(distance).mul(weight), weight), vec4(0)));
  }
  const pushed = force.w.greaterThan(0);
  center.assign(select(pushed, center.add(force.xyz.mul(0.025)), center));
  rgb.assign(select(pushed, rgb.add(abs(force.xyz).mul(0.15)), rgb));

  // Spotlights from the palms
  const lighting = float(0).toVar();
  for (let i = 0; i < spotlights.length; i += 1) {
    const spot = uSpotlights.element(i);
    const toPoint = center.sub(spot.xyz).toVar();
    const distance = length(toPoint).toVar();
    const outer = radians(spot.w.mul(0.5)).toVar();
    const intensity = smoothstep(cos(outer), cos(outer.sub(radians(10))), dot(toPoint.div(distance), uSpotlightDirs.element(i)));
    lighting.addAssign(select(spot.w.greaterThan(0), clamp(intensity.div(distance.mul(distance).mul(0.05)), 0, 1), float(0)));
  }
  const lit = uSpotlights.element(0).w.greaterThan(0).or(uSpotlights.element(1).w.greaterThan(0));
  out.get("center").assign(center);
  out.get("rgb").assign(select(lit, rgb.mul(lighting), rgb));
  return out;
}

// The worlds' generators and the modifier move by uniforms the CPU sort
// cannot see: it sorts again every frame (the loop)
const splatRenderer = new SplatRenderer({ renderer, params: { maxStdDev: Math.sqrt(4) }, sortBits: 32, modifier: worldModifier, modifierSpace: "world" });
scene.add(splatRenderer);

// --- Snow and rain ---

const snow = snowBox({ density: 40, box: new THREE.Box3(new THREE.Vector3(-4, -1, -4), new THREE.Vector3(4, 5, 4)) });
snow.opacity.value = 0;
idleBee.add(snow.snow);

// As Spark: a world's own weather, else with bad weather on none, snow or
// rain at random, picked when a world comes in (?weather=snow | rain forces one)
const badWeather = { enable: false };
const forcedWeather = new URLSearchParams(location.search).get("weather");

function pickWeather(name        ) {
  const choices = [forcedWeather ?? WORLD_EFFECT[name] ?? (badWeather.enable ? ["", "snow", "rain"] : "")].flat();
  const weather = choices[Math.floor(Math.random() * choices.length)];
  snow.opacity.value = weather ? 1 : 0;
  if (!weather) {
    return;
  }
  const preset = weather === "snow" ? { ...DEFAULT_SNOW, fallVelocity: 0.05 } : DEFAULT_RAIN;
  snow.fallDirection.value.copy(preset.fallDirection).normalize();
  snow.fallVelocity.value = preset.fallVelocity;
  snow.wanderScale.value = preset.wanderScale;
  snow.wanderVariance.value = preset.wanderVariance;
  snow.color2.value.set(preset.color2.r, preset.color2.g, preset.color2.b);
  snow.minScale.value = preset.minScale;
  snow.maxScale.value = preset.maxScale;
  snow.anisoScale.value.copy(preset.anisoScale).normalize();
}

// --- What is drawn: one world (or the morph of two), and the snow when it shows ---

let shown                   ;
let worldSplats                            ;

function updateCollection() {
  splatRenderer.collection = new SplatCollection([worldSplats , ...(snow.opacity.value > 0 ? [snow.snow.splatObject] : [])]);
}

function show(current       , next        ) {
  const drawn = next ? [current, next] : [current];
  drawn.forEach((world) => (world.refs += 1));
  worldSplats = {
    generator: next ? morphGenerator : plainGenerator,
    data: next ? { current: current.arrays, next: next.arrays } : { splats: current.arrays },
    count: current.arrays .count,
    matrixWorld: worldFrame.matrixWorld,
    release: () => drawn.forEach((world) => {
      world.refs -= 1;
      maybeFree(world);
    }),
  };
  updateCollection();
}

// --- Audio, play button, settings ---

let audioIndex = 0;
const audio = new Audio(AUDIOS[audioIndex]);
audio.volume = 0.75;
audio.preload = "auto";
audio.addEventListener("ended", () => {
  audioIndex = (audioIndex + 1) % AUDIOS.length;
  audio.src = AUDIOS[audioIndex];
  audio.play().catch(console.error);
});

let idleBeeCountdown = IDLE_BEE_START;
// Seconds since the worlds last advanced
let sinceAdvance = 0;

function play() {
  audio.play().catch(console.error);
  idleBeeCountdown = 0;
  sinceAdvance = TRANSITION_MS / 2000;
  playButton.textContent = "Pause";
}

function pause() {
  audio.pause();
  idleBeeCountdown = IDLE_BEE_START;
  playButton.textContent = "Play";
}

const playButton = document.createElement("button");
playButton.textContent = "Play";
playButton.style.cssText = "position:fixed;bottom:90px;left:50%;transform:translateX(-50%);padding:20px 40px;border:2px solid #fff;border-radius:16px;background:rgba(0,0,0,0.1);color:#fff;font:bold 16px sans-serif";
playButton.addEventListener("click", () => (audio.paused ? play() : pause()));
document.body.append(playButton);
page.legend("WASD to move, drag to turn, <b>[ ]</b> to switch worlds; in VR, touch the world, tap wrists together to toggle spotlights");

setupXr(renderer, [splatRenderer], controls, {
  optionalFeatures: ["hand-tracking"],
  framebufferScale: 0.5,
  onSession: () => {
    play();
    idleBee.position.set(0, 0, 0);
    idleBee.quaternion.identity();
  },
  onEnd: pause,
});

const gui = new GUI({ title: "Settings" }).close();
const interval = { seconds: 12 };
gui.add(interval, "seconds", 1, 20, 1).name("Transition interval");
// Spark waits for the next world; here the current one picks again at once
gui.add(badWeather, "enable").name("Bad weather").onChange(() => {
  if (shown) {
    pickWeather(shown.name);
    updateCollection();
  }
});

// --- World switching: the target moves on with the music or a key ---

let targetWorld = 0;
let direction = 1;
let transition                                          ;

function stepWorld(step        ) {
  targetWorld = (targetWorld + step + WORLDS.length) % WORLDS.length;
  getWorld(WORLDS[targetWorld]).loaded.catch(page.fail);
}

addEventListener("keydown", (event) => {
  if (event.key === "[" || event.key === "]") {
    direction = event.key === "]" ? 1 : -1;
    sinceAdvance = 0;
    stepWorld(direction);
  }
});

await getWorld(WORLDS[targetWorld]).loaded;

function updateWorlds(time        ) {
  if (transition) {
    const t = Math.min(1, (time - transition.start) / TRANSITION_MS);
    transitionT.value = t;
    if (t < 1) {
      return;
    }
    shown = transition.to;
    transition = undefined;
    show(shown);
    idleBee.position.z -= renderer.xr.isPresenting ? idleBeeTranslate.value : 0;
    // Prefetch the one after
    getWorld(WORLDS[(targetWorld + direction + WORLDS.length) % WORLDS.length]).loaded.catch(page.fail);
  }

  const next = getWorld(WORLDS[targetWorld]);
  if (next === shown || !next.arrays) {
    return;
  }
  pickWeather(next.name);
  if (!shown) {
    shown = next;
    show(next);
    page.ready(renderer);
  } else {
    transitionT.value = 0;
    idleBeeTranslate.value = renderer.xr.isPresenting ? idleBee.position.z : 0;
    transition = { to: next, start: time };
    show(shown, next);
  }
}

// --- Idle drift: after a while without input the view eases home and drifts ---

let idleBeeTime = 0;
let idleBeeBlend = 0;

function updateIdleBee(delta        ) {
  idleBeeTime += delta;
  idleBeeCountdown -= delta;
  if (idleBeeCountdown < 0) {
    idleBeeBlend = Math.min(1, idleBeeBlend + delta / 2);
    localFrame.position.multiplyScalar(Math.exp(-delta));
    localFrame.quaternion.slerp(new THREE.Quaternion(), Math.exp(-delta) / 500);
  } else {
    idleBeeBlend = Math.max(0, idleBeeBlend - delta);
  }
  const blend = THREE.MathUtils.smoothstep(idleBeeBlend, 0, 1);
  const t = idleBeeTime;
  idleBee.position.set(Math.sin(t * 0.3), Math.sin(t * 0.2), Math.sin(t * 0.5)).multiplyScalar(0.2 * blend);
  idleBee.quaternion.setFromEuler(new THREE.Euler(0, 0.1 * Math.sin(t * 0.37) * blend, 0, "YXZ"));
}

// --- Hands (WebXR): fingertip forces, or spotlights from the palms ---

const TIPS = ["thumb-tip", "index-finger-tip", "middle-finger-tip", "ring-finger-tip", "pinky-finger-tip"];
const jointMeshes = new Map                    ();
let spotlightMode = false;
let wristsTouching = false;
const point = new THREE.Vector3();
const palmQuaternion = new THREE.Quaternion();

// A colored ellipsoid per joint, posed in the local frame (the reference space)
function jointMesh(key        ) {
  let mesh = jointMeshes.get(key);
  if (!mesh) {
    mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 16), new THREE.MeshBasicMaterial({ color: new THREE.Color(Math.random(), Math.random(), Math.random()) }));
    localFrame.add(mesh);
    jointMeshes.set(key, mesh);
  }
  return mesh;
}

function updateHands(xrFrame          ) {
  tips.forEach((tip) => tip.set(0, 0, 0, 0));
  spotlights.forEach((spot) => spot.set(0, 0, 0, 0));
  jointMeshes.forEach((mesh) => (mesh.visible = false));
  const referenceSpace = renderer.xr.getReferenceSpace();
  if (!xrFrame || !referenceSpace) {
    return;
  }

  // The tracked joints of each hand (scale.x is a joint's radius)
  const hands                                             = {};
  for (const source of xrFrame.session.inputSources) {
    if (!source.hand) {
      continue;
    }
    const joints                             = (hands[source.handedness] = {});
    for (const [name, space] of source.hand.entries()) {
      const pose = xrFrame.getJointPose (space, referenceSpace);
      if (pose) {
        const { position: p, orientation: q } = pose.transform;
        const radius = pose.radius ?? 0.01;
        const mesh = jointMesh(`${source.handedness}-${name}`);
        mesh.position.set(p.x, p.y, p.z);
        mesh.quaternion.set(q.x, q.y, q.z, q.w);
        mesh.scale.set(radius, 0.75 * radius, 1.5 * radius);
        mesh.visible = true;
        joints[name] = mesh;
      }
    }
  }

  // Wrists tapped together toggle the spotlights
  const [left, right] = [hands.left?.wrist, hands.right?.wrist];
  const touching = !!left && !!right && left.position.distanceTo(right.position) < (wristsTouching ? 0.125 : 0.075);
  if (touching && !wristsTouching) {
    spotlightMode = !spotlightMode;
  }
  wristsTouching = touching;

  let tipIndex = 0;
  ["left", "right"].forEach((handedness, i) => {
    const joints = hands[handedness];
    if (!joints) {
      return;
    }
    if (!spotlightMode) {
      for (const tip of TIPS) {
        if (joints[tip] && tipIndex < tips.length) {
          joints[tip].getWorldPosition(point);
          tips[tipIndex++].set(point.x, point.y, point.z, joints[tip].scale.x);
        }
      }
      return;
    }
    const palm = joints["middle-finger-metacarpal"];
    const thumb = joints["thumb-tip"];
    if (palm && thumb) {
      palm.getWorldPosition(point);
      spotlightDirs[i].set(0, -1, 0).applyQuaternion(palm.getWorldQuaternion(palmQuaternion));
      // The fov opens as the fingers spread from the thumb
      const distances = TIPS.slice(1).filter((tip) => joints[tip]).map((tip) => thumb.position.distanceTo(joints[tip].position));
      const average = distances.reduce((a, b) => a + b, 0) / Math.max(distances.length, 1);
      spotlights[i].set(point.x, point.y, point.z, THREE.MathUtils.clamp(average * 1000, 11, 170));
    }
  });
}

// --- Frame loop ---

const lastCameraPos = new THREE.Vector3();
let lastTime                    ;

renderer.setAnimationLoop((time, xrFrame) => {
  const delta = lastTime === undefined ? 0 : Math.min((time - lastTime) / 1000, 0.1);
  lastTime = time;
  if (controls.update()) {
    idleBeeCountdown = IDLE_BEE_START;
  }

  updateHands(xrFrame);
  globalT.value = time / 1000;
  if (shown) {
    const rustle = WORLD_RUSTLE[shown.name] ?? 0;
    rustleBlend.value += THREE.MathUtils.clamp(rustle - rustleBlend.value, -delta / 100, delta / 100);
  }

  if (!renderer.xr.isPresenting) {
    updateIdleBee(delta);
  } else if (!audio.paused) {
    idleBee.position.z += delta / interval.seconds;
  }

  if (!audio.paused) {
    sinceAdvance += delta;
    if (sinceAdvance >= interval.seconds) {
      sinceAdvance -= interval.seconds;
      stepWorld(direction);
    }
  }

  // A large jump of the head (a new session's origin) moves the frame back
  if (lastCameraPos.distanceTo(camera.position) > 0.5) {
    localFrame.position.sub(camera.position);
  }
  lastCameraPos.copy(camera.position);

  updateWorlds(time);
  snow.update(time / 1000, delta);

  if (splatRenderer.sortMode === "cpu") {
    splatRenderer.requestSort();
  }
  renderer.render(scene, camera);
});


//# sourceURL=examples/spark/lofi/main.ts