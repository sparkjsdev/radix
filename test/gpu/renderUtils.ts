import * as THREE from "three";
import type { WebGPURenderer } from "three/webgpu";
import {
  ArrayData, GpuArrays, SplatCollection, SplatRenderer, Splats, getGpuCaps,
  type ExtSplat, type ProjectionMethod, type SplatLayout, type SplatRendererOptions, type SplatView,
} from "@sparkjsdev/radix";
import { SplatCamera } from "../../src/render/splatCamera";
import { SplatProjection } from "../../src/render/SplatProjection";
import { projectCollection, readSortKeys } from "../../src/render/SplatProjector";

export { SplatCamera, SplatProjection, readSortKeys };

export type Check = (name: string, fn: () => Promise<string | undefined | "skip">) => Promise<void>;

// Rows of 512 bytes: WebGPU reads render targets back in rows aligned to 256
export const W = 128;
export const H = 64;

// Deterministic random numbers (mulberry32)
export function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function splat(center: [number, number, number], scale: number | [number, number, number], rgb: [number, number, number] = [1, 1, 1], opacity = 1): ExtSplat {
  const s = Splats.makeExtSplat();
  const scales = typeof scale === "number" ? [scale, scale, scale] : scale;
  s.center = { x: center[0], y: center[1], z: center[2] };
  s.scales = { x: scales[0], y: scales[1], z: scales[2] };
  s.rgb = { r: rgb[0], g: rgb[1], b: rgb[2] };
  s.opacity = opacity;
  return s;
}

// In front of a camera at the origin looking down -z
export function randomSplats(count: number, seed: number): ExtSplat[] {
  const random = rng(seed);
  return Array.from({ length: count }, () => {
    const s = splat([(random() - 0.5) * 4, (random() - 0.5) * 3, -2 - random() * 6], [0.01 + random() * 0.1, 0.01 + random() * 0.1, 0.01 + random() * 0.05],
      [random(), random(), random()], 0.2 + random() * 0.8);
    const axis = new THREE.Vector3(random() - 0.5, random() - 0.5, random() - 0.5).normalize();
    const q = new THREE.Quaternion().setFromAxisAngle(axis, random() * Math.PI * 2);
    s.quaternion = { x: q.x, y: q.y, z: q.z, w: q.w };
    return s;
  });
}

export function splatData(splats: ExtSplat[], layout: SplatLayout = "extSplats") {
  const data = new ArrayData({ count: splats.length });
  const encode = Splats.encoder(Splats.add(data, { layout }));
  splats.forEach((s, i) => encode(i, s));
  return data;
}

export function makeCamera(renderer: WebGPURenderer, position: [number, number, number] = [0, 0, 0], aspect = W / H) {
  const camera = new THREE.PerspectiveCamera(60, aspect, 0.1, 100);
  camera.coordinateSystem = renderer.coordinateSystem;
  camera.position.set(...position);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();
  return camera;
}

export function setCamera(renderer: WebGPURenderer, eyes: THREE.PerspectiveCamera[], head = eyes[0]) {
  SplatCamera.setViews({
    head: head.matrixWorldInverse,
    eyes: eyes.map((eye) => ({ view: eye.matrixWorldInverse, projection: eye.projectionMatrix })),
    size: new THREE.Vector2(W, H),
    ndcZMin: renderer.coordinateSystem === THREE.WebGPUCoordinateSystem ? 0 : -1,
  });
}

export const collectionOf = (...objects: (GpuArrays | [GpuArrays, THREE.Matrix4])[]) =>
  new SplatCollection(objects.map((e) => (e instanceof GpuArrays ? SplatCollection.arrays(e) : SplatCollection.arrays(e[0], { matrixWorld: e[1] }))));

export const webgpuOf = (renderer: WebGPURenderer) => getGpuCaps(renderer).backend === "webgpu";

export const makeSplats = (renderer: WebGPURenderer, options: Partial<SplatRendererOptions> = {}) => new SplatRenderer({ renderer, autoSort: false, ...options });

// For the camera set last by setCamera
export function project(renderer: WebGPURenderer, splats: SplatRenderer, collection: SplatCollection, { cullKeys = false, view }: { cullKeys?: boolean; view?: SplatView } = {}) {
  const arrays = new GpuArrays({ renderer, bundles: SplatProjection.get(splats.method).outputs(SplatCamera.eyes), storage: webgpuOf(renderer) });
  projectCollection({ renderer, settings: splats.settingsOf(view), collection, arrays, pass: "full", cullKeys });
  return arrays;
}

export async function readProjection(arrays: GpuArrays, method: ProjectionMethod, eyes: number) {
  const data = await arrays.read();
  const n = SplatProjection.get(method).words(eyes);
  const channels = Object.keys(data.bundles.projected.channels).sort().map((name) => data.bundles.projected.channels[name].data as Uint32Array);
  const words = (i: number) => {
    const out: number[] = [];
    for (const channel of channels) {
      const components = channel.length / data.capacity;
      out.push(...channel.subarray(i * components, (i + 1) * components));
    }
    return out.slice(0, n);
  };
  const bytes = data.bundles.sortKeys.channels.key.data as Uint8Array<ArrayBuffer>;
  return { words, keys: new Uint32Array(bytes.buffer, 0, data.count), count: data.count };
}

// Each eye's words follow the head words
const HEAD_WORDS: Record<ProjectionMethod, number> = { ewa: 0, "3dgut": 6, htgs: 6, raygs: 4 };
const EYE_WORDS: Record<ProjectionMethod, number> = { ewa: 4, "3dgut": 2, htgs: 2, raygs: 3 };
export const eyeWords = (method: ProjectionMethod, words: number[], v: number) => words.slice(HEAD_WORDS[method] + v * EYE_WORDS[method], HEAD_WORDS[method] + (v + 1) * EYE_WORDS[method]);
export const headWords = (method: ProjectionMethod, words: number[]) => words.slice(0, HEAD_WORDS[method]);
export const eyeCulled = (method: ProjectionMethod, eye: number[]) => (method === "ewa" ? (eye[3] & 0xff) === 0 : eye[1] === 0);

// The bound decodes of render/projection.tsl.ts, on the CPU
const fixed16 = (code: number) => (code / 65535) * 4 - 2;
const logScale = (code: number, bits: number) => 2 ** (((code - 1) / (2 ** bits - 2)) * 16 - 4);
export function decodeBound(method: ProjectionMethod, eye: number[]) {
  if (method === "ewa") {
    return { ndc: [fixed16(eye[0] & 0xffff), fixed16(eye[0] >>> 16)], angle: ((eye[1] >>> 20) / 4096) * Math.PI, scales: [logScale((eye[3] >>> 8) & 0xfff, 12), logScale(eye[3] >>> 20, 12)] };
  }
  return { ndc: [fixed16(eye[0] & 0xffff), fixed16(eye[0] >>> 16)], angle: ((eye[1] & 1023) / 1024) * Math.PI, scales: [logScale((eye[1] >>> 10) & 0x7ff, 11), logScale(eye[1] >>> 21, 11)] };
}

// 32-bit keys only
export const keyDistance = (key: number) => new Float32Array(new Uint32Array([~key >>> 0]).buffer)[0];

export async function renderPixels(renderer: WebGPURenderer, scene: THREE.Scene, camera: THREE.Camera, width = W, height = H) {
  const target = new THREE.RenderTarget(width, height, { type: THREE.UnsignedByteType });
  try {
    renderer.setRenderTarget(target);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);
    return await renderer.readRenderTargetPixelsAsync(target, 0, 0, width, height) as Uint8Array;
  } finally {
    target.dispose();
  }
}

export const meanAbsDiff = (a: ArrayLike<number>, b: ArrayLike<number>) => {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) {
    sum += Math.abs(a[i] - b[i]);
  }
  return sum / a.length;
};

export const pixelAt = (pixels: Uint8Array, x: number, y: number, width = W) => [...pixels.subarray((y * width + x) * 4, (y * width + x) * 4 + 4)];

// In cpu mode the first render draws nothing, as the view has no order yet
export async function drawWith(renderer: WebGPURenderer, splats: SplatRenderer, camera: THREE.Camera, { width = W, height = H, order }: {
  width?: number;
  height?: number;
  order?: (sorted: Uint32Array<ArrayBuffer>) => Uint32Array<ArrayBuffer>;
} = {}) {
  const scene = new THREE.Scene().add(splats);
  try {
    let pixels = await renderPixels(renderer, scene, camera, width, height);
    if (splats.sortMode === "cpu") {
      const view = splats.viewFor(camera);
      const sorted = await view.sort(camera);
      view.apply(order ? { ...sorted, ordering: order(sorted.ordering.slice(0, sorted.visible)) } : sorted);
      pixels = await renderPixels(renderer, scene, camera, width, height);
    }
    return pixels;
  } finally {
    scene.remove(splats);
  }
}

export async function drawSplats(renderer: WebGPURenderer, splats: ExtSplat[], options: Partial<SplatRendererOptions>, camera: THREE.Camera = makeCamera(renderer), draw?: Parameters<typeof drawWith>[3]) {
  const arrays = GpuArrays.fromData(renderer, splatData(splats));
  const splatRenderer = makeSplats(renderer, { collection: collectionOf(arrays), ...options });
  try {
    return await drawWith(renderer, splatRenderer, camera, draw);
  } finally {
    splatRenderer.dispose();
    arrays.dispose();
  }
}
