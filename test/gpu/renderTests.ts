// Checks of sorting, projection and drawing: WgpuRadixSort, WgpuCompact and
// WgpuSplatSorter against the CPU sort (WebGPU), the projection methods on
// every splat layout with 1 and 2 eyes (writer parity, stereo against mono,
// a CPU EWA reference, culling, keys), sortSplatKeys on a worker, and
// rendered images from a SplatRenderer (both backends)
import * as THREE from "three";
import { MeshBasicNodeMaterial, type WebGPURenderer } from "three/webgpu";
import {
  ArrayData, Encoding, GpuArrayReader, GpuArrays, GpuArrayWriter, GpuSortKeys, GpuSplatReader, Hdr, SortKeys, SplatCollection,
  WgpuBuffer, WgpuCompact, WgpuRadixSort, WgpuSplatSorter, createRenderer, getGpuCaps, sortSplatKeys,
  type ExtSplat, type ProjectionMethod, type SortKeyBits, type SplatGenerator, type SplatLayout,
} from "@sparkjsdev/radix";
import { programOf } from "../../src/render/SplatProjector";
import {
  SplatProjection, H, W, decodeBound, drawSplats, eyeCulled, eyeWords, headWords, makeCamera, makeSplats, collectionOf, meanAbsDiff, pixelAt, project,
  randomSplats, readProjection, readSortKeys, renderPixels, rng, setCamera, splat, splatData, type Check,
} from "./renderUtils";

const METHODS = SplatProjection.METHODS;
const LAYOUTS: SplatLayout[] = ["extSplats", "covSplats", "packedSplats"];
const BITS: SortKeyBits[] = [16, 24, 32];

export async function runRenderTests(renderer: WebGPURenderer, check: Check) {
  const webgpu = getGpuCaps(renderer).backend === "webgpu";
  const onWebGPU = (fn: () => Promise<string | undefined>) => async () => (webgpu ? fn() : "skip" as const);
  const tiers = getGpuCaps(renderer).subgroups ? (["portable", "subgroup"] as const) : (["portable"] as const);
  const sortMode = webgpu ? "gpu" as const : "cpu" as const;

  // --- Sorting (WebGPU) ---

  await check("WgpuRadixSort equals sortKeys: 16/24/32 bits, every tier, counts 0, 1, block edges, large", onWebGPU(async () => {
    const random = rng(7);
    for (const tier of tiers) {
      for (const bits of BITS) {
        for (const count of [0, 1, 4095, 4096, 4097, 70000]) {
          const keys = new Uint32Array(Math.max(count, 1)).map(() => Math.floor(random() * 2 ** bits) >>> 0);
          const keyBuffer = new WgpuBuffer({ renderer, format: "uint32", count: Math.max(count, 1) });
          const valueBuffer = new WgpuBuffer({ renderer, format: "uint32", count: Math.max(count, 1) });
          keyBuffer.upload(keys);
          valueBuffer.upload(new Uint32Array(Math.max(count, 1)).map((_, i) => i));
          const sort = new WgpuRadixSort({ renderer, keys: keyBuffer, values: valueBuffer, tier });
          sort.sort(count, { bits });

          const expected = SortKeys.sort({ keys, count, bits }).ordering.subarray(0, count);
          const actual = count > 0 ? await valueBuffer.read(0, count) : new Uint32Array(0);
          sort.dispose();
          keyBuffer.dispose();
          valueBuffer.dispose();
          const at = expected.findIndex((value, i) => actual[i] !== value);
          if (at >= 0) {
            return `${tier} ${bits} bits, ${count} keys: index ${at} is ${actual[at]}, expected ${expected[at]}`;
          }
        }
      }
    }
    return undefined;
  }));

  await check("WgpuCompact from a texture key source, then sortIndirect, equals sortKeys", onWebGPU(async () => {
    const random = rng(11);
    for (const bits of BITS) {
      const count = 20000;
      const keys = new Uint32Array(count).map(() => (random() < 0.3 ? SortKeys.invalid(bits) : Math.floor(random() * 0xff * 2 ** (bits - 8))) >>> 0);
      const data = new ArrayData({ count }).addBundle("sortKeys", SortKeys.KEYS, { data: { key: new Uint8Array(keys.buffer) } });
      const arrays = GpuArrays.fromData(renderer, data);
      const reader = new GpuArrayReader(SortKeys.KEYS).bind(arrays, "sortKeys");

      const compact = new WgpuCompact({ renderer, key: (i) => GpuSortKeys.unpack(reader.load("key", i)) });
      compact.invalid.value = SortKeys.invalid(bits);
      compact.compact(count);
      const sort = new WgpuRadixSort({ renderer, keys: compact.keys, values: compact.values });
      sort.sortIndirect(compact.count, { bits });

      const { ordering, visible } = SortKeys.sort({ keys, count, bits });
      const gotCount = (await compact.count.read(0, 1))[0];
      const actual = await compact.values.read(0, visible);
      sort.dispose();
      compact.dispose();
      arrays.dispose();
      if (gotCount !== visible) {
        return `${bits} bits: ${gotCount} compacted, expected ${visible}`;
      }
      const at = ordering.subarray(0, visible).findIndex((value, i) => actual[i] !== value);
      if (at >= 0) {
        return `${bits} bits: index ${at} is ${actual[at]}, expected ${ordering[at]}`;
      }
    }
    return undefined;
  }));

  // --- Projection ---

  const cam0 = makeCamera(renderer, [-0.03, 0, 0]);
  const cam1 = makeCamera(renderer, [0.03, 0, 0]);
  const scene = randomSplats(3000, 3);

  // Words and keys of `collection` projected by a splat renderer of `method` (options on top)
  const projectWith = async (collection: SplatCollection, method: ProjectionMethod, eyes: THREE.PerspectiveCamera[], {
    head, cullKeys, setup,
  }: { head?: THREE.PerspectiveCamera; cullKeys?: boolean; setup?: (splats: ReturnType<typeof makeSplats>) => void } = {}) => {
    const splats = makeSplats(renderer, { method });
    setup?.(splats);
    setCamera(renderer, eyes, head);
    const projected = project(renderer, splats, collection, { cullKeys });
    const result = await readProjection(projected, method, eyes.length);
    projected.dispose();
    splats.dispose();
    return result;
  };

  await check("projection: every method and layout with 1 and 2 eyes draws most splats in view", async () => {
    for (const layout of LAYOUTS) {
      const splats = GpuArrays.fromData(renderer, splatData(scene, layout));
      for (const method of METHODS) {
        for (const eyes of [1, 2]) {
          const { words, count } = await projectWith(collectionOf(splats), method, eyes === 1 ? [cam0] : [cam0, cam1]);
          for (let v = 0; v < eyes; v += 1) {
            let drawn = 0;
            for (let i = 0; i < count; i += 1) {
              drawn += eyeCulled(method, eyeWords(method, words(i), v)) ? 0 : 1;
            }
            if (drawn < count * 0.5) {
              return `${layout} ${method} ${eyes} eyes: eye ${v} draws ${drawn} of ${count}`;
            }
          }
        }
      }
      splats.dispose();
    }
    return undefined;
  });

  await check("projection: compute and fragment writers give the same words and keys", onWebGPU(async () => {
    const splats = GpuArrays.fromData(renderer, splatData(scene));
    const collection = collectionOf(splats);
    const generator = collection.objects[0].object.generator;
    for (const method of METHODS) {
      for (const eyes of [1, 2]) {
        const splatRenderer = makeSplats(renderer, { method, sortBits: 24 });
        setCamera(renderer, eyes === 1 ? [cam0] : [cam0, cam1]);
        // The compute pass sets every uniform; the fragment writer reuses them
        const computed = project(renderer, splatRenderer, collection, { cullKeys: true });
        const outputs = SplatProjection.get(method).outputs(eyes);
        const drawn = new GpuArrays({ renderer, bundles: outputs, capacity: splats.count });
        const fragment = programOf(generator, { pass: "full", method, eyes, webgpu: false }) as GpuArrayWriter;
        drawn.write(fragment, { at: 0, count: splats.count });

        const a = await readProjection(computed, method, eyes);
        const b = await readProjection(drawn, method, eyes);
        [computed, drawn, splatRenderer].forEach((x) => x.dispose());
        let differ = 0;
        for (let i = 0; i < a.count; i += 1) {
          const wa = a.words(i);
          const wb = b.words(i);
          differ += wa.some((w, k) => w !== wb[k]) || a.keys[i] !== b.keys[i] ? 1 : 0;
        }
        if (differ > 0) {
          return `${method} ${eyes} eyes: ${differ} of ${a.count} splats differ`;
        }
      }
    }
    splats.dispose();
    return undefined;
  }));

  await check("projection: a TSL generator (either form) projects like the same splats from arrays", async () => {
    const splats = GpuArrays.fromData(renderer, splatData(scene));
    const reader = GpuSplatReader.from(splats);
    // Generators giving only one form: the pipeline converts to the one it reads
    const generators: [string, SplatGenerator][] = [
      ["splat", { generateSplat: (i) => reader.loadSplat(i) }],
      ["cov", { generateCovSplat: (i) => reader.loadCovSplat(i) }],
    ];
    for (const method of METHODS) {
      const a = await projectWith(collectionOf(splats), method, [cam0]);
      for (const [form, generator] of generators) {
        const b = await projectWith(new SplatCollection([{ generator, count: splats.count }]), method, [cam0]);
        // The arrays' path converts the same way for ewa (a covariance) and
        // reads splats for the others: those give the same bits. Covariances
        // diagonalized back sort the axes (other words for the same
        // ellipsoid), so they only keep the keys and nearly every cull.
        const exact = method === "ewa" || form === "splat";
        let differ = 0;
        let keys = 0;
        for (let i = 0; i < a.count; i += 1) {
          const wa = a.words(i);
          const wb = b.words(i);
          differ += exact ? (wa.some((w, k) => w !== wb[k]) ? 1 : 0) : (eyeCulled(method, eyeWords(method, wa, 0)) !== eyeCulled(method, eyeWords(method, wb, 0)) ? 1 : 0);
          keys += a.keys[i] !== b.keys[i] ? 1 : 0;
        }
        if (b.count !== a.count || keys > 0 || (exact ? differ > 0 : differ > a.count * 0.01)) {
          return `${method} from ${form}: count ${b.count}, ${differ} of ${a.count} splats differ, ${keys} keys`;
        }
      }
    }
    splats.dispose();
    return undefined;
  });

  await check("projection: two objects at offsets of one collection equal one object of both", async () => {
    const half = scene.length / 2;
    const first = GpuArrays.fromData(renderer, splatData(scene.slice(0, half)));
    const second = GpuArrays.fromData(renderer, splatData(scene.slice(half)));
    const whole = GpuArrays.fromData(renderer, splatData(scene));
    for (const method of METHODS) {
      const expected = await projectWith(collectionOf(whole), method, [cam0]);
      const actual = await projectWith(collectionOf(first, second), method, [cam0]);
      if (actual.count !== scene.length) {
        return `${method}: count ${actual.count}`;
      }
      for (let i = 0; i < scene.length; i += 1) {
        if (actual.words(i).some((w, k) => w !== expected.words(i)[k]) || actual.keys[i] !== expected.keys[i]) {
          return `${method}: splat ${i} differs`;
        }
      }
    }
    [first, second, whole].forEach((x) => x.dispose());
    return undefined;
  });

  await check("projection: stereo with the head at eye v equals mono from eye v", async () => {
    const splats = GpuArrays.fromData(renderer, splatData(scene));
    for (const method of METHODS) {
      for (const [v, eye] of [[0, cam0], [1, cam1]] as const) {
        const m = await projectWith(collectionOf(splats), method, [eye]);
        const s = await projectWith(collectionOf(splats), method, [cam0, cam1], { head: eye });
        // The two programs may round a float word (raygs' c^2) some ulps
        // apart: WebGL2 compilers fuse differently
        for (let i = 0; i < m.count; i += 1) {
          const expected = m.words(i);
          const actual = [...headWords(method, s.words(i)), ...eyeWords(method, s.words(i), v)];
          if (expected.some((w, k) => Math.abs(w - actual[k]) > 32) || m.keys[i] !== s.keys[i]) {
            return `${method} eye ${v}, splat ${i}: ${actual.join(" ")} vs ${expected.join(" ")}`;
          }
        }
      }
    }
    splats.dispose();
    return undefined;
  });

  await check("projection: ewa matches a CPU EWA reference", async () => {
    const splats = scene.slice(0, 200);
    const arrays = GpuArrays.fromData(renderer, splatData(splats));
    const { words } = await projectWith(collectionOf(arrays), "ewa", [cam0], { setup: (splats) => (splats.objectParams.blurAmount = 0) });
    arrays.dispose();

    const P = cam0.projectionMatrix.elements;
    const fx = (W / 2) * P[0];
    const fy = (H / 2) * P[5];
    const stdDev = Math.sqrt(8);
    for (let i = 0; i < splats.length; i += 1) {
      const eye = words(i);
      if (eyeCulled("ewa", eye)) {
        continue;
      }
      const s = splats[i];
      const c = new THREE.Vector3(s.center.x, s.center.y, s.center.z).applyMatrix4(cam0.matrixWorldInverse);
      const R = new THREE.Matrix3().setFromMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(new THREE.Quaternion(s.quaternion.x, s.quaternion.y, s.quaternion.z, s.quaternion.w)));
      const S = new THREE.Matrix3().set(s.scales.x, 0, 0, 0, s.scales.y, 0, 0, 0, s.scales.z);
      const M = new THREE.Matrix3().setFromMatrix4(cam0.matrixWorldInverse).multiply(R).multiply(S);
      const cov = M.clone().multiply(M.clone().transpose());
      const J = new THREE.Matrix3().set(fx / c.z, 0, -fx * c.x / (c.z * c.z), 0, fy / c.z, -fy * c.y / (c.z * c.z), 0, 0, 0);
      const cov2 = J.clone().multiply(cov).multiply(J.clone().transpose()).elements;
      const [a, b, d] = [cov2[0], cov2[3], cov2[4]];
      const avg = (a + d) / 2;
      const delta = Math.sqrt(Math.max(0, avg * avg - (a * d - b * b)));
      const major = stdDev * Math.sqrt(avg + delta);
      const minor = stdDev * Math.sqrt(Math.max(avg - delta, 0));

      const bound = decodeBound("ewa", eye);
      if (Math.abs(bound.scales[0] / major - 1) > 0.01 || Math.abs(bound.scales[1] / minor - 1) > 0.02) {
        return `splat ${i}: scales ${bound.scales.map((x) => x.toFixed(3))}, expected ${major.toFixed(3)} ${minor.toFixed(3)}`;
      }
    }
    return undefined;
  });

  await check("projection: ewa, 3dgut and htgs bounds agree for small distant splats", async () => {
    const random = rng(5);
    const far = Array.from({ length: 200 }, () => splat([(random() - 0.5) * 20, (random() - 0.5) * 12, -30 - random() * 20], 0.05 + random() * 0.05));
    const arrays = GpuArrays.fromData(renderer, splatData(far));
    const bounds: Record<string, ReturnType<typeof decodeBound>[]> = {};
    for (const method of ["ewa", "3dgut", "htgs"] as ProjectionMethod[]) {
      const { words } = await projectWith(collectionOf(arrays), method, [cam0], { setup: (splats) => (splats.objectParams.blurAmount = 0) });
      bounds[method] = far.map((_, i) => decodeBound(method, eyeWords(method, words(i), 0)));
    }
    arrays.dispose();
    for (let i = 0; i < far.length; i += 1) {
      const e = bounds.ewa[i];
      for (const method of ["3dgut", "htgs"]) {
        const o = bounds[method][i];
        const pixel = 2 / W;
        if (Math.abs(o.ndc[0] - e.ndc[0]) > pixel || Math.abs(o.ndc[1] - e.ndc[1]) > pixel || Math.abs(o.scales[0] / e.scales[0] - 1) > 0.06) {
          return `${method} splat ${i}: ndc ${o.ndc.map((x) => x.toFixed(4))} scale ${o.scales[0].toFixed(3)}, ewa ${e.ndc.map((x) => x.toFixed(4))} ${e.scales[0].toFixed(3)}`;
        }
      }
    }
    return undefined;
  });

  await check("projection: culling behind, off screen and under minAlpha; keys invalid only with cullKeys", async () => {
    const cases = [splat([0, 0, -3], 0.1), splat([0, 0, 3], 0.1), splat([40, 0, -3], 0.1), splat([0, 0, -3], 0.1, [1, 1, 1], 0.001)];
    const arrays = GpuArrays.fromData(renderer, splatData(cases));
    for (const method of METHODS) {
      for (const cullKeys of [true, false]) {
        const { words, keys } = await projectWith(collectionOf(arrays), method, [cam0], { cullKeys, setup: (splats) => (splats.sortBits = 32) });
        const culled = cases.map((_, i) => eyeCulled(method, eyeWords(method, words(i), 0)));
        if (culled.join() !== "false,true,true,true") {
          return `${method}: culled ${culled.join()}`;
        }
        const invalid = [...keys].map((key) => key === SortKeys.invalid(32));
        const expected = cullKeys ? "false,true,true,true" : "false,false,false,true";
        if (invalid.join() !== expected) {
          return `${method} cullKeys ${cullKeys}: invalid keys ${invalid.join()}`;
        }
      }
    }
    arrays.dispose();
    return undefined;
  });

  await check("projection: keys equal SortKeys.compute at 16, 24 and 32 bits, switched by the uniform", async () => {
    const splats = scene.slice(0, 500);
    const arrays = GpuArrays.fromData(renderer, splatData(splats));
    for (const bits of BITS) {
      const { keys } = await projectWith(collectionOf(arrays), "ewa", [cam0], { setup: (splats) => (splats.sortBits = bits) });
      for (let i = 0; i < splats.length; i += 1) {
        const c = splats[i].center;
        const distance = Math.hypot(c.x - cam0.position.x, c.y - cam0.position.y, c.z - cam0.position.z);
        const expected = SortKeys.compute(distance, bits);
        if (Math.abs(keys[i] - expected) > (bits === 32 ? 4 : 1)) {
          return `${bits} bits, splat ${i}: key ${keys[i]}, expected ${expected}`;
        }
      }
    }
    arrays.dispose();
    return undefined;
  });

  await check("projection: objectParams.sortGuard drops the keys of splats beyond the widened view, behind the head too", async () => {
    // Ahead; just past the right edge (NDC 1.2 at a 2:1 aspect); far to the
    // side; behind
    const splats = [splat([0, 0, -4], 0.05, [1, 1, 1], 1), splat([5.5, 0, -4], 0.05, [1, 1, 1], 1), splat([20, 0, -4], 0.05, [1, 1, 1], 1), splat([0, 0, 4], 0.05, [1, 1, 1], 1)];
    const arrays = GpuArrays.fromData(renderer, splatData(splats));
    const valid = async (guard: number) => {
      const { keys } = await projectWith(collectionOf(arrays), "ewa", [makeCamera(renderer)], {
        setup: (splats) => {
          splats.sortBits = 24;
          splats.objectParams.sortGuard = guard;
        },
      });
      return [...keys].map((key) => key !== SortKeys.invalid(24));
    };
    try {
      const all = await valid(0);
      const guarded = await valid(0.5);
      if (all.join() !== "true,true,true,true") {
        return `guard 0: valid ${all}`;
      }
      return guarded.join() === "true,true,false,false" ? undefined : `guard 0.5: valid ${guarded}`;
    } finally {
      arrays.dispose();
    }
  });

  // --- Sorters ---

  await check("WgpuSplatSorter: the order of sortKeys on the read-back keys", onWebGPU(async () => {
    const splats = GpuArrays.fromData(renderer, splatData(scene));
    const splatRenderer = makeSplats(renderer, { method: "htgs", sortBits: 24 });
    setCamera(renderer, [cam0]);
    const projected = project(renderer, splatRenderer, collectionOf(splats), { cullKeys: true });
    const sorter = new WgpuSplatSorter(renderer);
    sorter.sort(projected, projected.count, splatRenderer.sortBits);

    const keys = await readSortKeys(projected);
    const { ordering, visible } = SortKeys.sort({ keys, count: keys.length, bits: 24 });
    const count = await sorter.readCount();
    const values = await sorter.values.read(0, Math.max(1, count));
    const args = await sorter.indirect.read(0, 5);
    [sorter, projected, splatRenderer, splats].forEach((x) => x.dispose());
    const quads = WgpuSplatSorter.QUADS_PER_INSTANCE;
    const expected = [6 * quads, Math.ceil(visible / quads), 0, 0, 0];
    if (count !== visible || [...args].join() !== expected.join()) {
      return `count ${count}, drawIndexedIndirect arguments ${[...args]}, expected ${expected}`;
    }
    const at = ordering.subarray(0, visible).findIndex((value, i) => values[i] !== value);
    return at >= 0 ? `index ${at}: ${values[at]}, expected ${ordering[at]}` : undefined;
  }));

  await check("sortSplatKeys: a worker and this thread agree", async () => {
    const random = rng(9);
    const keys = new Uint32Array(50000).map(() => (random() < 0.1 ? 0xffffff : Math.floor(random() * 0xfeffff)));
    const here = await sortSplatKeys(keys.slice(), { bits: 24, worker: false });
    const there = await sortSplatKeys(keys.slice(), { bits: 24, worker: true });
    if (here.visible !== there.visible || here.ordering.length !== there.ordering.length) {
      return `visible ${here.visible} vs ${there.visible}`;
    }
    const at = here.ordering.findIndex((value, i) => there.ordering[i] !== value);
    return at >= 0 ? `index ${at}` : there.keys.length === keys.length ? undefined : "keys not returned";
  });

  await check("SplatView.sort: the order of sortKeys on the keys of a full projection (CPU sort)", async () => {
    const splats = GpuArrays.fromData(renderer, splatData(scene));
    const collection = collectionOf(splats);
    const splatRenderer = makeSplats(renderer, { method: "3dgut", sortBits: 24, sortMode: "cpu", collection });
    const camera = makeCamera(renderer);
    try {
      const order = await splatRenderer.viewFor(camera).sort(camera);
      setCamera(renderer, [camera]);
      const projected = project(renderer, splatRenderer, collection);
      const expected = SortKeys.sort({ keys: await readSortKeys(projected), count: collection.count, bits: 24 });
      projected.dispose();
      if (order.collection !== collection || order.visible !== expected.visible) {
        return `visible ${order.visible}, expected ${expected.visible}`;
      }
      const at = expected.ordering.subarray(0, expected.visible).findIndex((value, i) => order.ordering[i] !== value);
      return at >= 0 ? `index ${at}` : undefined;
    } finally {
      splatRenderer.dispose();
      splats.dispose();
    }
  });

  // --- Rendering ---

  const draw = (splats: ExtSplat[], method: ProjectionMethod, mode: "gpu" | "cpu" = sortMode, camera?: THREE.Camera, options?: Parameters<typeof drawSplats>[4]) =>
    drawSplats(renderer, splats, { method, sortMode: mode }, camera, options);

  await check("render: one splat is a centered, symmetric falloff for every method", async () => {
    for (const method of METHODS) {
      const pixels = await draw([splat([0, 0, -4], 0.25, [1, 1, 1], 1)], method);
      const cx = W / 2;
      const cy = H / 2;
      const center = pixelAt(pixels, cx, cy)[3];
      const left = pixelAt(pixels, cx - 8, cy)[3];
      const right = pixelAt(pixels, cx + 7, cy)[3];
      const up = pixelAt(pixels, cx, cy - 8)[3];
      const down = pixelAt(pixels, cx, cy + 7)[3];
      if (center < 200 || !(left < center && up < center) || Math.abs(left - right) > 24 || Math.abs(up - down) > 24 || pixelAt(pixels, 2, 2)[3] !== 0) {
        return `${method}: center ${center}, left ${left} right ${right} up ${up} down ${down}, corner ${pixelAt(pixels, 2, 2)[3]}`;
      }
    }
    return undefined;
  });

  const pair = [splat([0, 0, -6], 0.4, [0, 0, 1], 1), splat([0, 0, -3], 0.2, [1, 0, 0], 1)];

  // A 4 mm splat 10 m away through a 0.5 degree lens: a few pixels wide, as
  // a normal lens shows splats 2500 times their size away. The rays'
  // whitened origin is then 2500 long, which a float32 density must survive.
  await check("render: a small, far splat (zoomed in) has the exact Gaussian falloff for every method", async () => {
    const fov = 0.5;
    const [distance, scale] = [10, 0.004];
    const camera = new THREE.PerspectiveCamera(fov, W / H, 0.1, 100);
    camera.coordinateSystem = renderer.coordinateSystem;
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
    const tanY = Math.tan(THREE.MathUtils.degToRad(fov / 2));
    // exp(-z2 / 2) of the ray through pixel (x, y), from |c x d|^2 / |d|^2 in float64
    const expected = (x: number, y: number) => {
      const [dx, dy] = [((x + 0.5) / W * 2 - 1) * tanY * (W / H), (1 - (y + 0.5) / H * 2) * tanY];
      const z2 = (distance * distance * (dx * dx + dy * dy)) / (dx * dx + dy * dy + 1) / (scale * scale);
      return Math.exp(-z2 / 2);
    };

    for (const method of METHODS) {
      const arrays = GpuArrays.fromData(renderer, splatData([splat([0, 0, -distance], scale)]));
      const splatRenderer = makeSplats(renderer, { method, collection: collectionOf(arrays), sortMode: "cpu", objectParams: { blurAmount: 0 } });
      const view = splatRenderer.viewFor(camera);
      // Drawn even if the sort culled it
      view.apply({ ...(await view.sort(camera)), ordering: new Uint32Array([0]), visible: 1 });
      const pixels = await renderPixels(renderer, new THREE.Scene().add(splatRenderer), camera);
      splatRenderer.dispose();
      arrays.dispose();

      let worst = { error: 0, x: 0, y: 0, got: 0, want: 0 };
      for (let y = H / 2 - 12; y < H / 2 + 12; y += 1) {
        for (let x = W / 2 - 12; x < W / 2 + 12; x += 1) {
          const [got, want] = [pixels[(y * W + x) * 4 + 3] / 255, expected(x, y)];
          if (Math.abs(got - want) > worst.error) {
            worst = { error: Math.abs(got - want), x, y, got, want };
          }
        }
      }
      if (worst.error > 0.04) {
        return `${method}: alpha ${worst.got.toFixed(3)} at (${worst.x}, ${worst.y}), expected ${worst.want.toFixed(3)}`;
      }
    }
    return undefined;
  });

  await check("render: two splats blend back to front, and a reversed order blends the other way", async () => {
    for (const method of METHODS) {
      for (const mode of webgpu ? (["gpu", "cpu"] as const) : (["cpu"] as const)) {
        const [r, , b] = pixelAt(await draw(pair, method, mode), W / 2, H / 2);
        if (r < 200 || b > 40) {
          return `${method} ${mode} order: center rgb ${r}, ${b}`;
        }
      }
      const [r, , b] = pixelAt(await draw(pair, method, "cpu", undefined, { order: (sorted) => sorted.slice().reverse() }), W / 2, H / 2);
      if (b < 200 || r > 40) {
        return `${method} reversed: center rgb ${r}, ${b}`;
      }
    }
    return undefined;
  });

  await check("render: GPU and CPU orders give the same image", onWebGPU(async () => {
    for (const method of METHODS) {
      const diff = meanAbsDiff(await draw(scene, method, "gpu"), await draw(scene, method, "cpu"));
      if (diff > 0.01) {
        return `${method}: mean difference ${diff.toFixed(4)}`;
      }
    }
    return undefined;
  }));

  // Through three's output pass into a target, as it goes to the canvas
  await check("render: under Hdr tone mapping, a frame below the knee is the one without it (splats blend as trained)", async () => {
    const camera = makeCamera(renderer);
    const arrays = GpuArrays.fromData(renderer, splatData(scene));
    const splatRenderer = makeSplats(renderer, { collection: collectionOf(arrays), sortMode });
    const scene3 = new THREE.Scene().add(splatRenderer);
    const target = new THREE.RenderTarget(W, H, { type: THREE.UnsignedByteType });
    const frame = async () => {
      renderer.setOutputRenderTarget(target);
      renderer.render(scene3, camera);
      renderer.setOutputRenderTarget(null);
      return await renderer.readRenderTargetPixelsAsync(target, 0, 0, W, H) as Uint8Array;
    };
    // Three's framebuffer target takes the canvas size: the same as the
    // output's, so its output pass copies texel for texel
    const [size, ratio] = [renderer.getSize(new THREE.Vector2()), renderer.getPixelRatio()];
    renderer.setPixelRatio(1);
    renderer.setSize(W, H, false);

    try {
      // Opaque, as a page's background: three's output pass blends what it copies
      renderer.setClearColor(0x000000, 1);
      await frame();
      if (!webgpu) {
        const view = splatRenderer.viewFor(camera);
        view.apply(await view.sort(camera));
      }
      const plain = await frame();
      const toneMapping = Hdr.useToneMapping(renderer, { headroom: 16, knee: 0.9 });
      const mapped = await frame();
      toneMapping.enabled = false;

      // The plain frame blends in 8 bits, rounding at every splat; the mapped
      // one in three's half-float target: overlaps drift a few steps apart
      let worst = 0;
      for (let i = 0; i < plain.length; i += 1) {
        if (i % 4 !== 3) {
          worst = Math.max(worst, Math.abs(plain[i] - mapped[i]));
        }
      }
      return worst <= 4 ? undefined : `largest rgb difference ${worst} (mean ${meanAbsDiff(plain, mapped).toFixed(2)})`;
    } finally {
      renderer.setPixelRatio(ratio);
      renderer.setSize(size.x, size.y, false);
      target.dispose();
      splatRenderer.dispose();
      arrays.dispose();
    }
  });

  // A float target makes the draw decode sRGB, where a negative channel
  // would give NaN, and blends without clamping
  await check("render: a negative color draws as black into a half-float target, never NaN", async () => {
    const camera = makeCamera(renderer);
    const arrays = GpuArrays.fromData(renderer, splatData([splat([0, 0, -4], 0.25, [-0.5, 0.2, 0.2], 1)]));
    const splatRenderer = makeSplats(renderer, { collection: collectionOf(arrays), sortMode });
    const scene3 = new THREE.Scene().add(splatRenderer);
    const target = new THREE.RenderTarget(W, H, { type: THREE.HalfFloatType });
    const frame = async () => {
      renderer.setRenderTarget(target);
      renderer.setClearColor(0x808080, 1);
      renderer.clear();
      renderer.render(scene3, camera);
      renderer.setRenderTarget(null);
      const data = await renderer.readRenderTargetPixelsAsync(target, 0, 0, W, H) as Uint16Array | Float32Array;
      return data instanceof Uint16Array ? Float32Array.from(data, (h) => Encoding.decodeHalf(h)) : data;
    };
    try {
      await frame();
      if (!webgpu) {
        const view = splatRenderer.viewFor(camera);
        view.apply(await view.sort(camera));
      }
      const pixels = await frame();
      const bad = pixels.findIndex((v, i) => !Number.isFinite(v) || (i % 4 === 0 && v < -1e-3));
      if (bad >= 0) {
        return `pixel ${Math.floor(bad / 4)} channel ${bad % 4} is ${pixels[bad]}`;
      }
      const red = (x: number, y: number) => pixels[(y * W + x) * 4];
      const [center, background] = [red(W / 2, H / 2), red(2, 2)];
      return center < background * 0.5 ? undefined : `center red ${center}, background ${background}`;
    } finally {
      renderer.setRenderTarget(null);
      target.dispose();
      splatRenderer.dispose();
      arrays.dispose();
    }
  });

  await check("render: an opaque mesh in front of a splat hides it and one behind does not, with and without a logarithmic depth buffer", async () => {
    const logRenderer = await createRenderer({ backend: webgpu ? "webgpu" : "webgpu-gl", canvas: document.createElement("canvas"), logarithmicDepthBuffer: true });
    try {
      for (const r of [renderer, logRenderer]) {
        for (const [z, expected] of [[-3, "mesh"], [-5, "splat"]] as const) {
          const arrays = GpuArrays.fromData(r, splatData([splat([0, 0, -4], 0.25, [0, 0, 1], 1)]));
          const splatRenderer = makeSplats(r, { collection: collectionOf(arrays), sortMode });
          const plane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new MeshBasicNodeMaterial({ color: 0xff0000 }));
          plane.position.z = z;
          const camera = makeCamera(r);
          const scene3 = new THREE.Scene().add(plane, splatRenderer);
          try {
            await renderPixels(r, scene3, camera);
            if (!webgpu) {
              const view = splatRenderer.viewFor(camera);
              view.apply(await view.sort(camera));
            }
            const [red, , blue] = pixelAt(await renderPixels(r, scene3, camera), W / 2, H / 2);
            const shown = red > 200 && blue < 40 ? "mesh" : blue > red ? "splat" : `rgb ${red}, ${blue}`;
            if (shown !== expected) {
              return `${r === renderer ? "standard" : "logarithmic"} depth, plane at z ${z}: ${shown}, expected ${expected}`;
            }
          } finally {
            splatRenderer.dispose();
            arrays.dispose();
            plane.geometry.dispose();
            plane.material.dispose();
          }
        }
      }
      return undefined;
    } finally {
      logRenderer.dispose();
    }
  });

  await check("render: a renderer that drew nothing before its splats arrived draws them like a new one (CPU order)", async () => {
    for (const method of METHODS) {
      const camera = makeCamera(renderer);
      const splatRenderer = makeSplats(renderer, { method, sortMode: "cpu" });
      const scene3 = new THREE.Scene().add(splatRenderer);
      await renderPixels(renderer, scene3, camera);
      const arrays = GpuArrays.fromData(renderer, splatData(scene));
      splatRenderer.collection = collectionOf(arrays);
      await renderPixels(renderer, scene3, camera);
      const view = splatRenderer.viewFor(camera);
      view.apply(await view.sort(camera));
      const late = await renderPixels(renderer, scene3, camera);
      splatRenderer.dispose();
      arrays.dispose();
      const diff = meanAbsDiff(late, await draw(scene, method, "cpu"));
      if (diff > 0.01) {
        return `${method}: mean difference ${diff.toFixed(4)}`;
      }
    }
    return undefined;
  });

  await check("render: a two-eye ArrayCamera matches the mono renders of each eye", async () => {
    for (const method of METHODS) {
      const eyes = [makeCamera(renderer, [-0.03, 0, 0]), makeCamera(renderer, [0.03, 0, 0])];
      eyes.forEach((eye, v) => Object.assign(eye, { viewport: new THREE.Vector4(v * W, 0, W, H) }));
      const array = new THREE.ArrayCamera(eyes);
      array.coordinateSystem = renderer.coordinateSystem;
      array.updateMatrixWorld();

      const stereo = await draw(scene, method, sortMode, array, { width: 2 * W, height: H });
      for (let v = 0; v < 2; v += 1) {
        const mono = await draw(scene, method, sortMode, eyes[v]);
        const half = new Uint8Array(W * H * 4);
        for (let y = 0; y < H; y += 1) {
          half.set(stereo.subarray((y * 2 * W + v * W) * 4, (y * 2 * W + v * W + W) * 4), y * W * 4);
        }
        const diff = meanAbsDiff(half, mono);
        if (diff > 1.5) {
          return `${method} eye ${v}: mean difference ${diff.toFixed(3)}`;
        }
      }
    }
    return undefined;
  });
}
