// One splat file in an immersive-vr session, sorted on the GPU with WebGPU XR or
// on a worker with WebGL2 XR
//   ?url=           a splat file (default the butterfly)
//   ?layout=        extSplats (default) | covSplats | packedSplats
//   ?sh=            ext (default) | packed | 0 (skipped): how the file loads its SH
//   ?maxShDegree=   the highest SH degree drawn (default 4)
//   ?method=        ewa (default) | 3dgut | htgs | raygs
//   ?bits=          16 | 24 (default) | 32: the sort key width
//   ?sort=          gpu (default, WebGPU only) | cpu
//   ?gpu=           webgpu | webgpu-gl (default webgpu with the XR binding)
//   ?xrScale=       eye-buffer scale, read when a session starts (default 1)
//   ?multiview=1    both eyes in one draw (OVR_multiview2, WebGL2)
//   ?stereo=1       a desktop preview of both eyes
//   ?profile=1      GPU time per phase
//   ?threshold=     the worker sort's re-sort distance in meters (default 0.02)
//   ?guard=         the worker sort's objectParams.sortGuard (default 0: keeps all)
//   radixXr.configure(changes)  sets options in place, so an emulator-paired tab never reloads
//   radixXr.measure({ seconds = 6, turn = 360 })  turns the head through the given degrees and times it
//   radixXr.config, stats, build  the options, the stats and the renderer's objects
import * as THREE from "three";
import type { WebGPURenderer } from "three/webgpu";
import {
  CameraControls, GpuArrays, GpuProfiler, GpuShPalette, SplatCollection, SplatRenderer, createRenderer, getGpuCaps, loadSplatFile,
  type GpuBackend, type GpuProfile, type LoadedSplats, type ProjectionMethod, type ShTarget, type SortKeyBits, type SplatLayout,
} from "@sparkjsdev/radix";

const params = new URLSearchParams(location.search);
const hasGpuBinding = "XRGPUBinding" in globalThis && navigator.gpu !== undefined;

const config = {
  url: params.get("url") ?? "https://storage.googleapis.com/forge-dev-public/asundqui/radix/261009/rdx/butterfly-ai.rdx",
  layout: (params.get("layout") ?? "extSplats") as SplatLayout,
  sh: (params.get("sh") === "0" ? false : params.get("sh") === "packed" ? "packed" : "ext") as ShTarget,
  maxShDegree: Number(params.get("maxShDegree") ?? 4),
  method: (params.get("method") ?? "ewa") as ProjectionMethod,
  bits: Number(params.get("bits") ?? 24) as SortKeyBits,
  sort: (params.get("sort") ?? "gpu") as "gpu" | "cpu",
  gpu: (params.get("gpu") ?? (hasGpuBinding ? "webgpu" : "webgpu-gl")) as GpuBackend,
  xrScale: Number(params.get("xrScale") ?? 1),
  multiview: params.get("multiview") === "1",
  stereo: params.get("stereo") === "1",
  profile: params.get("profile") === "1",
  threshold: Number(params.get("threshold") ?? 0.02),
  guard: Number(params.get("guard") ?? 0),
  // Where the splats sit, in meters in local-floor space
  position: [0, 1.4, -1.5] as [number, number, number],
  scale: 1,
  // A half turn about x: captures are stored y-down
  flip: true,
};
type XrConfig = typeof config;

const status = document.getElementById("status")!;
const enterButton = document.getElementById("enter") as HTMLButtonElement;

// Errors go to the status line and measure()
const errors: string[] = [];
const consoleError = console.error.bind(console);
console.error = (...args: unknown[]) => {
  errors.push(args.map(String).join(" ").slice(0, 400));
  consoleError(...args);
};
addEventListener("error", (event) => errors.push(`error: ${event.message}`));
addEventListener("unhandledrejection", (event) => errors.push(`rejection: ${String(event.reason)}`));

const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.01, 1000);
camera.position.set(0, 1.6, 0);

let build: Build | undefined;
let data: LoadedSplats<SplatLayout> | undefined;
let dataKey = "";
let session: XRSession | undefined;
let busy = Promise.resolve();

const stats = {
  frames: 0, fps: 0, cpuMs: 0, gpu: undefined as GpuProfile | undefined,
  // Worker sort: keys and readback, sort round trip, upload; the drawn order's age
  readMs: 0, sortMs: 0, uploadMs: 0, sortedAtFrame: -1, orderAge: 0, sorts: 0, visible: 0,
};

// One build per renderer: rebuilt when the backend, multiview or profiling changes
type Build = Awaited<ReturnType<typeof makeBuild>>;
const rendererKey = () => `${config.gpu}|${config.multiview}|${config.profile}`;

async function makeBuild() {
  const renderer = await createRenderer({ backend: config.gpu, xr: true, multiview: config.multiview, profile: config.profile });
  renderer.setPixelRatio(devicePixelRatio);
  renderer.setSize(innerWidth, innerHeight);
  renderer.xr.setReferenceSpaceType("local-floor");
  patchGpuProjectionLayer(renderer);
  patchNullXrFramebuffer(renderer);
  document.body.append(renderer.domElement);

  const scene = new THREE.Scene();
  const rig = new THREE.Group();
  rig.add(camera);
  const controls = new CameraControls({
    canvas: renderer.domElement, object: camera, settings: { mode: "orbit" }, xr: renderer.xr, rig,
  });

  // One view for the head: the desktop, stereo and XR cameras share its sort
  const model = new THREE.Object3D();
  const splatRenderer = new SplatRenderer({ renderer, autoSort: false });
  const view = (splatRenderer.view = splatRenderer.viewFor("head"));
  const profiler = renderer.inspector instanceof GpuProfiler ? renderer.inspector : undefined;
  if (profiler) {
    splatRenderer.phase = (name, run) => profiler.phase(name, run);
  }
  scene.add(rig, model, splatRenderer);

  const backend = getGpuCaps(renderer).backend;
  const splats = undefined as GpuArrays | undefined;
  return { renderer, backend, gpuSort: false, profiler, scene, rig, controls, model, splatRenderer, view, splats, key: rendererKey() };
}

async function setSplats(b: Build) {
  const key = `${config.url}|${config.layout}|${config.sh}`;
  if (!data || dataKey !== key) {
    status.textContent = `Loading ${config.url}...`;
    data = await loadSplatFile(config.url, {
      worker: true, layout: config.layout, sh: config.sh,
      onProgress: (fraction, stage) => (status.textContent = `${config.url}: ${stage} ${Math.round(fraction * 100)}%`),
    });
    dataKey = key;
    b.splats = undefined;
  }
  if (!b.splats) {
    const splats = (b.splats = GpuArrays.fromData(b.renderer, data.splats));
    const shPalette = data.shPalette && GpuShPalette.upload(b.renderer, data.shPalette);
    const release = () => {
      splats.dispose();
      shPalette?.dispose();
    };
    const object = SplatCollection.arrays(splats, { matrixWorld: b.model.matrixWorld, shPalette, release });
    b.splatRenderer.collection = new SplatCollection([object]);
  }

  const r = b.splatRenderer;
  b.gpuSort = b.backend === "webgpu" && config.sort === "gpu";
  r.method = config.method;
  r.sortBits = config.bits;
  r.sortMode = b.gpuSort ? "gpu" : "cpu";
  r.objectParams.sortGuard = b.gpuSort ? 0 : config.guard;
  r.objectParams.maxShDegree = config.maxShDegree;

  b.model.position.set(...config.position);
  b.model.scale.setScalar(config.scale);
  b.model.rotation.x = config.flip ? Math.PI : 0;
  b.controls.lookAt(b.rig.worldToLocal(b.model.position.clone()));
  sortedAt.set(Infinity, 0, 0);
}

// Apply a (partial) config, one call at a time
async function configure(changes: Partial<XrConfig> = {}) {
  Object.assign(config, changes);
  const run = busy.then(async () => {
    if (build && build.key !== rendererKey()) {
      await session?.end();
      build.renderer.setAnimationLoop(null);
      build.splatRenderer.dispose(); // its object's release disposes the splats
      build.controls.dispose();
      build.renderer.domElement.remove();
      build.renderer.dispose();
      build = undefined;
    }
    if (!build) {
      build = await makeBuild();
      build.renderer.setAnimationLoop(frame);
      offerSession(build);
    }
    await setSplats(build);
  });
  busy = run.catch((error) => console.error(error));
  return run;
}

// XR sessions: offered by the browser (the emulator's Enter XR) or the button

function sessionInit(): XRSessionInit {
  const required = build?.backend === "webgpu" ? ["webgpu", "local-floor"] : ["local-floor"];
  return { requiredFeatures: required, optionalFeatures: ["bounded-floor"] };
}

async function startSession(next: XRSession) {
  const b = build!;
  b.renderer.xr.setFramebufferScaleFactor(config.xrScale);
  next.addEventListener("end", () => {
    session = undefined;
    enterButton.hidden = false;
    enterButton.disabled = false;
    if (build) {
      offerSession(build);
    }
  });
  await b.renderer.xr.setSession(next);
  session = next;
  enterButton.hidden = true;
}

function offerSession(b: Build) {
  type OfferingXr = XRSystem & { offerSession?: (mode: XRSessionMode, init: XRSessionInit) => Promise<XRSession> };
  const xr = navigator.xr as OfferingXr | undefined;
  if (!xr?.offerSession || session) {
    return;
  }
  xr.offerSession("immersive-vr", sessionInit())
    .then((next) => (build === b ? startSession(next) : next.end()))
    .catch((error) => console.error("offerSession", error));
}

enterButton.addEventListener("click", async () => {
  enterButton.disabled = true;
  try {
    await startSession(await navigator.xr!.requestSession("immersive-vr", sessionInit()));
  } catch (error) {
    console.error("requestSession", error);
    enterButton.disabled = false;
  }
});

// Turns re-sort too, since the guard band follows the view direction
const sortedAt = new THREE.Vector3(Infinity, 0, 0);
const sortedDir = new THREE.Vector3();
const head = new THREE.Vector3();
const headDir = new THREE.Vector3();
const TURN_COS = Math.cos(THREE.MathUtils.degToRad(5));
let sorting = false;

async function workerSort(b: Build, view: THREE.Camera) {
  stats.orderAge = stats.sortedAtFrame < 0 ? -1 : frameNumber - stats.sortedAtFrame;
  view.getWorldPosition(head);
  view.getWorldDirection(headDir);
  const remapped = b.view.order?.collection !== b.splatRenderer.collection;
  if (sorting || !(remapped || head.distanceTo(sortedAt) > config.threshold || headDir.dot(sortedDir) < TURN_COS)) {
    return;
  }

  const startFrame = frameNumber;
  sorting = true;
  sortedAt.copy(head);
  sortedDir.copy(headDir);
  try {
    const order = await b.view.sort(view);
    if (build !== b) {
      return;
    }
    const t0 = performance.now();
    b.view.apply(order);
    Object.assign(stats, {
      readMs: order.keysMs, sortMs: order.sortMs, uploadMs: performance.now() - t0,
      sortedAtFrame: startFrame, visible: order.visible, sorts: stats.sorts + 1,
    });
  } finally {
    sorting = false;
  }
}

// ?stereo=1: two eyes 64 mm apart, side by side
const stereoEyes = [0, 1].map(() => Object.assign(new THREE.PerspectiveCamera(), { viewport: new THREE.Vector4() }));
const stereoCamera = new THREE.ArrayCamera(stereoEyes);
stereoCamera.add(...stereoEyes);

function updateStereoCamera() {
  camera.getWorldPosition(stereoCamera.position);
  camera.getWorldQuaternion(stereoCamera.quaternion);
  const width = innerWidth / 2;
  stereoEyes.forEach((eye, i) => {
    eye.position.set((i * 2 - 1) * 0.032, 0, 0);
    eye.viewport.set(i * width, 0, width, innerHeight);
    Object.assign(eye, { fov: camera.fov, near: camera.near, far: camera.far, aspect: width / innerHeight });
    eye.updateProjectionMatrix();
  });
  stereoCamera.updateMatrixWorld();
  return stereoCamera;
}

// The eyes the latest frame projected for: their count and one eye's size
const projected = { count: 0, size: [0, 0] };

function recordEyes(renderer: WebGPURenderer, view: THREE.Camera) {
  const cameras = (view as THREE.ArrayCamera).isArrayCamera ? (view as THREE.ArrayCamera).cameras : [];
  const viewport = (cameras[0] as { viewport?: THREE.Vector4 } | undefined)?.viewport;
  const buffer = renderer.getDrawingBufferSize(new THREE.Vector2());
  projected.count = cameras.length > 0 ? Math.min(cameras.length, 2) : 1;
  projected.size = viewport ? [viewport.z, viewport.w] : [buffer.x, buffer.y];
}

let frameNumber = 0;
let frameErrors = 0;
let cpuTotal = 0;

function frame() {
  try {
    if (build) {
      drawFrame(build);
    }
  } catch (error) {
    frameErrors += 1;
    if (frameErrors <= 5) {
      console.error("frame", error instanceof Error ? `${error.message}\n${error.stack}` : error);
    }
  }
}

function drawFrame(b: Build) {
  const start = performance.now();
  frameNumber += 1;
  const { renderer, scene, profiler } = b;
  const presenting = renderer.xr.isPresenting;
  if (turnHead) {
    turnHead(start, presenting);
  } else {
    b.controls.update();
  }

  let view: THREE.Camera = camera;
  if (presenting) {
    renderer.xr.updateCamera(camera);
    view = renderer.xr.getCamera();
  } else if (config.stereo) {
    view = updateStereoCamera();
  }

  // Project before the render, outside its passes, so WebGL2 timer queries do not nest
  profiler?.beginFrame();
  scene.updateMatrixWorld();
  b.splatRenderer.prepare(view);
  recordEyes(renderer, view);
  if (profiler) {
    profiler.label = "draw";
  }
  renderer.render(scene, presenting ? camera : view);

  if (!b.gpuSort && b.splats) {
    void workerSort(b, view);
  }
  cpuTotal += performance.now() - start;
}

let turnHead: ((now: number, presenting: boolean) => void) | undefined;

async function measure({ seconds = 6, turn = 360 }: { seconds?: number; turn?: number } = {}) {
  const b = build!;
  const device = (window as { iwerDevice?: { quaternion: { set(x: number, y: number, z: number, w: number): unknown } } }).iwerDevice;
  await b.profiler?.collect();
  const start = { time: performance.now(), frame: frameNumber, cpu: cpuTotal, sorts: stats.sorts };
  const base = camera.quaternion.clone();
  const yaw = new THREE.Quaternion();
  let ages = 0;
  let ageFrames = 0;
  turnHead = (now, presenting) => {
    const angle = THREE.MathUtils.degToRad(turn) * Math.min(1, (now - start.time) / (seconds * 1000));
    yaw.setFromAxisAngle(new THREE.Vector3(0, 1, 0), angle);
    if (presenting) {
      device?.quaternion.set(yaw.x, yaw.y, yaw.z, yaw.w);
    } else {
      camera.quaternion.copy(yaw).multiply(base);
    }
    if (!b.gpuSort && stats.orderAge >= 0) {
      ages += stats.orderAge;
      ageFrames += 1;
    }
  };
  await sleep(seconds * 1000);
  turnHead = undefined;
  const frames = frameNumber - start.frame;
  const cpu = cpuTotal - start.cpu;
  await sleep(100);
  const gpu = (await b.profiler?.collect())?.gpu;
  return {
    config: { ...config }, backend: b.backend, gpuSort: b.gpuSort, presenting: b.renderer.xr.isPresenting,
    eyes: projected.count, eyeSize: projected.size, seconds, frames, fps: frames / seconds,
    cpuMs: frames > 0 ? cpu / frames : 0, gpu,
    sorts: stats.sorts - start.sorts, readMs: stats.readMs, sortMs: stats.sortMs, uploadMs: stats.uploadMs,
    orderAge: ageFrames > 0 ? ages / ageFrames : undefined,
    errors: errors.slice(-5),
  };
}

// The status line, every second even when no frames come
let last = { time: performance.now(), frame: 0, cpu: 0 };
setInterval(() => {
  const now = { time: performance.now(), frame: frameNumber, cpu: cpuTotal };
  const frames = now.frame - last.frame;
  Object.assign(stats, { frames: now.frame, fps: (frames * 1000) / (now.time - last.time), cpuMs: frames > 0 ? (now.cpu - last.cpu) / frames : 0 });
  last = now;
  if (build) {
    void report(build);
  }
}, 1000);

async function report(b: Build) {
  if (b.profiler) {
    stats.gpu = (await b.profiler.collect()) ?? stats.gpu;
  }
  const presenting = b.renderer.xr.isPresenting;
  const splats = data?.splats.count ?? 0;
  const mode = presenting ? `XR ${projected.count} eyes ${projected.size.join("x")}` : config.stereo ? "stereo preview" : "desktop";
  status.textContent = [
    `${config.url} | ${splats.toLocaleString()} splats | ${stats.fps.toFixed(0)} fps | cpu ${stats.cpuMs.toFixed(2)} ms`,
    `${b.backend}${config.multiview ? " multiview" : ""} | ${config.method} | ${b.gpuSort ? "GPU sort" : "worker sort"} ${config.bits}b | ${mode}`,
    b.gpuSort ? "" : `sort: read ${stats.readMs.toFixed(1)} + sort ${stats.sortMs.toFixed(1)} + upload ${stats.uploadMs.toFixed(1)} ms, order ${stats.orderAge} frames old, ${stats.sorts} sorts`,
    stats.gpu ? GpuProfiler.format(stats.gpu) : "",
    errors.length > 0 ? `errors: ${errors.length}, last: ${errors[errors.length - 1]}` : "",
  ].filter(Boolean).join("\n");
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// three creates the WebGPU XR projection layer without the framebuffer scale
function patchGpuProjectionLayer(renderer: WebGPURenderer) {
  type Binding = { createProjectionLayer(init?: { colorFormat?: string; scaleFactor?: number }): unknown };
  const xr = renderer.xr;
  const getBinding = xr.getWebGPUBinding.bind(xr);
  const patched = new WeakSet<Binding>();
  xr.getWebGPUBinding = () => {
    const binding = getBinding() as unknown as Binding | null;
    if (binding && !patched.has(binding)) {
      const create = binding.createProjectionLayer.bind(binding);
      binding.createProjectionLayer = (init) => create({ ...init, scaleFactor: xr.getFramebufferScaleFactor() });
      patched.add(binding);
    }
    return binding as unknown as ReturnType<typeof getBinding>;
  };
}

// An emulated XRWebGLLayer has a null framebuffer, and three keys draw buffers
// by framebuffer in a WeakMap, which takes no null
function patchNullXrFramebuffer(renderer: WebGPURenderer) {
  type State = { currentDrawbuffers: WeakMap<object, number[]> };
  const state = (renderer.backend as unknown as { state?: State }).state;
  if (!state?.currentDrawbuffers) {
    return;
  }
  const map = state.currentDrawbuffers;
  const nullKey = {};
  state.currentDrawbuffers = {
    get: (key: object | null) => map.get(key ?? nullKey),
    set(key: object | null, value: number[]) {
      map.set(key ?? nullKey, value);
      return this;
    },
  } as unknown as WeakMap<object, number[]>;
}

addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  build?.renderer.setSize(innerWidth, innerHeight);
});

enterButton.hidden = !navigator.xr;
await configure();

Object.assign(window, { radixXr: { configure, measure, config, stats, get build() { return build; } } });
