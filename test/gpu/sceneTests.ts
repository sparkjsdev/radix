// Checks of collections, renderers, views, modifiers, CPU orders and releases
import * as THREE from "three";
import type { WebGPURenderer } from "three/webgpu";
import {
  GpuArrays, GpuSplatReader, GpuSplats, SplatGenerator, SplatCollection, SplatMath, SplatProjector, SplatRenderer, TSL, WorkerPool, sortSplatKeys,
  type CovSplatNode, type ExtSplat, type ProjectionMethod, type SplatNode, type SplatView,
} from "@sparkjsdev/radix";
import {
  H, W, decodeBound, drawWith, eyeCulled, eyeWords, keyDistance, collectionOf, makeCamera, makeSplats, pixelAt, project, randomSplats,
  readProjection, renderPixels, setCamera, splat, splatData, SplatCamera, webgpuOf, type Check,
} from "./renderUtils";
import { isUniformScale } from "../../src/render/splatTransform.tsl";

const { float, fract, uint, vec3 } = TSL;

type Projection = Awaited<ReturnType<typeof readProjection>>;

// In float64, through the covariance so that any matrix works
function transformed(s: ExtSplat, m: THREE.Matrix4): ExtSplat {
  const out: ExtSplat = { ...s, center: new THREE.Vector3(s.center.x, s.center.y, s.center.z).applyMatrix4(m) };
  const cov = SplatMath.covFromScaleQuat(s.scales, s.quaternion, { xx: 0, yy: 0, zz: 0, xy: 0, xz: 0, yz: 0 });
  const S = new THREE.Matrix3().set(cov.xx, cov.xy, cov.xz, cov.xy, cov.yy, cov.yz, cov.xz, cov.yz, cov.zz);
  const M = new THREE.Matrix3().setFromMatrix4(m);
  const e = M.clone().multiply(S).multiply(M.clone().transpose()).elements;
  const { values, basis } = SplatMath.symEigens({ xx: e[0], yy: e[4], zz: e[8], xy: e[3], xz: e[6], yz: e[7] });
  out.scales = { x: Math.sqrt(Math.max(values.x, 0)), y: Math.sqrt(Math.max(values.y, 0)), z: Math.sqrt(Math.max(values.z, 0)) };
  out.quaternion = SplatMath.basisToQuat(basis, { x: 0, y: 0, z: 0, w: 1 });
  return out;
}

function extents({ ndc, angle, scales }: ReturnType<typeof decodeBound>) {
  const [c, s] = [Math.cos(angle), Math.sin(angle)];
  return { ndc, half: [Math.hypot(c * scales[0], s * scales[1]), Math.hypot(s * scales[0], c * scales[1])] };
}

// Differences beyond rounding, where 1% of culls may flip at the edges
function differ(method: ProjectionMethod, a: Projection, b: Projection): string | undefined {
  let flips = 0;
  for (let i = 0; i < a.count; i += 1) {
    const [ea, eb] = [eyeWords(method, a.words(i), 0), eyeWords(method, b.words(i), 0)];
    const [ca, cb] = [eyeCulled(method, ea), eyeCulled(method, eb)];
    if (ca !== cb) {
      flips += 1;
      continue;
    }
    const [da, db] = [keyDistance(a.keys[i]), keyDistance(b.keys[i])];
    if (Math.abs(da - db) > 1e-3 * Math.max(da, 1e-6)) {
      return `splat ${i}: distance ${da} vs ${db}`;
    }
    if (ca || method === "raygs") {
      continue;
    }
    // Half extents along x and y, since a near-round splat's axes may swap
    const [xa, xb] = [extents(decodeBound(method, ea)), extents(decodeBound(method, eb))];
    const pixel = 2 / W;
    const far = (k: number) => Math.abs(xa.half[k] - xb.half[k]) > 0.03 * Math.max(xa.half[k], xb.half[k]) + 0.05;
    if (Math.abs(xa.ndc[0] - xb.ndc[0]) > 1.5 * pixel || Math.abs(xa.ndc[1] - xb.ndc[1]) > 1.5 * pixel || far(0) || far(1)) {
      return `splat ${i}: ndc ${xa.ndc.map((x) => x.toFixed(4))} / ${xb.ndc.map((x) => x.toFixed(4))}, extents ${xa.half.map((x) => x.toFixed(2))} / ${xb.half.map((x) => x.toFixed(2))}`;
    }
  }
  return flips > a.count * 0.01 ? `${flips} of ${a.count} culls differ` : undefined;
}

// Type checks only, never called
export function typedEntries(splats: GpuArrays) {
  const stored = SplatGenerator.fromSplats();
  SplatCollection.object({ generator: stored, data: { splats }, count: 1 });
  // @ts-expect-error: a fromSplats generator's data is { splats, indices? }
  SplatCollection.object({ generator: stored, data: { colors: splats }, count: 1 });
  // @ts-expect-error: and not bare arrays
  SplatCollection.object({ generator: stored, data: splats, count: 1 });
}

const tint = <N extends SplatNode | CovSplatNode>(rgb: (s: N) => unknown) => (s: N): N => {
  const out = (s as SplatNode).toVar();
  out.get("rgb").assign(rgb(s) as never);
  return out as N;
};

export async function runSceneTests(renderer: WebGPURenderer, check: Check) {
  const webgpu = webgpuOf(renderer);
  const sortMode = webgpu ? "gpu" as const : "cpu" as const;
  const camera = makeCamera(renderer);
  const scene = randomSplats(600, 21);
  const arrays = GpuArrays.fromData(renderer, splatData(scene));

  const projectWith = async (collection: SplatCollection, options: Parameters<typeof makeSplats>[1] = {}) => {
    const splats = makeSplats(renderer, options);
    setCamera(renderer, [camera]);
    const projected = project(renderer, splats, collection);
    const result = await readProjection(projected, splats.method, 1);
    projected.dispose();
    splats.dispose();
    return result;
  };

  await check("isUniformScale: rotations times a uniform scale pass; shear, non-uniform scale and mirrors fail", async () => {
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 2, 3).normalize(), 0.8);
    const uniform = new THREE.Matrix4().compose(new THREE.Vector3(1, -2, 3), q, new THREE.Vector3(2.5, 2.5, 2.5));
    const products = new THREE.Matrix4().makeRotationY(0.3).multiply(uniform).multiply(new THREE.Matrix4().makeRotationX(-1.1).scale(new THREE.Vector3(0.4, 0.4, 0.4)));
    const passes = [new THREE.Matrix4(), uniform, products];
    const fails = [
      new THREE.Matrix4().compose(new THREE.Vector3(), q, new THREE.Vector3(1, 2, 1)),
      new THREE.Matrix4().makeShear(0.2, 0, 0, 0, 0, 0),
      new THREE.Matrix4().makeScale(-1, 1, 1),
      new THREE.Matrix4().makeScale(0, 0, 0),
    ];
    const wrong = [...passes.filter((m) => !isUniformScale(m)), ...fails.filter((m) => isUniformScale(m))];
    return wrong.length === 0 ? undefined : `${wrong.length} misjudged`;
  });

  await check("transforms: an object's matrix equals the splats pre-transformed by it (uniform, non-uniform, mirrored), every method", async () => {
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0.3, 1, 0.2).normalize(), 0.6);
    const matrices: [string, THREE.Matrix4][] = [
      ["uniform", new THREE.Matrix4().compose(new THREE.Vector3(0.2, -0.1, -1), q, new THREE.Vector3(1.4, 1.4, 1.4))],
      ["non-uniform", new THREE.Matrix4().compose(new THREE.Vector3(0.1, 0.2, -0.5), q, new THREE.Vector3(1, 1.8, 0.6))],
      ["mirrored", new THREE.Matrix4().makeScale(-1, 1, 1).premultiply(new THREE.Matrix4().makeRotationY(0.2)).setPosition(0, 0.1, -0.3)],
    ];
    for (const [name, m] of matrices) {
      const pre = GpuArrays.fromData(renderer, splatData(scene.map((s) => transformed(s, m))));
      for (const method of ["ewa", "3dgut", "htgs", "raygs"] as ProjectionMethod[]) {
        const a = await projectWith(collectionOf([arrays, m]), { method });
        const b = await projectWith(collectionOf(pre), { method });
        const problem = differ(method, a, b);
        if (problem) {
          pre.dispose();
          return `${name} ${method}: ${problem}`;
        }
      }
      pre.dispose();
    }
    return undefined;
  });

  await check("static uniforms: one program dispatched twice in a frame with two matrices equals each alone", async () => {
    const m1 = new THREE.Matrix4().makeTranslation(0.3, 0, 0);
    const m2 = new THREE.Matrix4().makeRotationZ(0.4).setPosition(-0.2, 0.1, -0.5);
    for (const method of ["ewa", "htgs"] as ProjectionMethod[]) {
      const both = await projectWith(collectionOf([arrays, m1], [arrays, m2]), { method });
      const one = await projectWith(collectionOf([arrays, m1]), { method });
      const two = await projectWith(collectionOf([arrays, m2]), { method });
      for (let i = 0; i < scene.length; i += 1) {
        if (both.words(i).some((w, k) => w !== one.words(i)[k]) || both.words(scene.length + i).some((w, k) => w !== two.words(i)[k])) {
          return `${method}: splat ${i} differs`;
        }
      }
    }
    return undefined;
  });

  await check("static uniforms: two SplatRenderers in one render each draw their own", async () => {
    const left = GpuArrays.fromData(renderer, splatData([splat([-1, 0, -4], 0.3, [1, 0, 0], 1)]));
    const right = GpuArrays.fromData(renderer, splatData([splat([1, 0, -4], 0.3, [0, 0, 1], 1)]));
    const ra = makeSplats(renderer, { collection: collectionOf(left), sortMode, method: "3dgut" });
    const rb = makeSplats(renderer, { collection: collectionOf(right), sortMode, method: "ewa", params: { falloff: 0 } });
    const both = new THREE.Scene().add(ra, rb);
    try {
      if (sortMode === "cpu") {
        for (const r of [ra, rb]) {
          const view = r.viewFor(camera);
          view.apply(await view.sort(camera));
        }
      }
      const pixels = await renderPixels(renderer, both, camera);
      const alone = await renderPixels(renderer, new THREE.Scene().add(rb), camera);
      const at = (p: Uint8Array, x: number) => pixelAt(p, Math.round((x * 0.5 + 0.5) * W), H / 2);
      const xl = new THREE.Vector3(-1, 0, -4).project(camera).x;
      const xr = new THREE.Vector3(1, 0, -4).project(camera).x;
      const [red, blue, blueAlone] = [at(pixels, xl), at(pixels, xr), at(alone, xr)];
      if (red[0] < 150 || red[2] > 30 || blue[2] < 150 || blue[0] > 30 || blue.some((c, k) => Math.abs(c - blueAlone[k]) > 2)) {
        return `left ${red}, right ${blue} (alone ${blueAlone})`;
      }
      return undefined;
    } finally {
      [ra, rb, left, right].forEach((x) => x.dispose());
    }
  });

  await check("program cache: one program per generator over frames and renderers; modifiers 2 then none; data, space and frame none; disposed ones rebuilt", async () => {
    const generator = SplatGenerator.fromSplats();
    const other = GpuArrays.fromData(renderer, splatData(scene.slice(0, 100)));
    const listFor = (splats: GpuArrays) => new SplatCollection([{ generator, data: { splats }, count: splats.count }]);
    const programs = SplatProjector.programs;
    const delta = () => SplatProjector.programs - programs;
    await projectWith(listFor(arrays));
    await projectWith(listFor(arrays));
    await projectWith(listFor(arrays), { objectParams: { blurAmount: 0 } });
    if (delta() !== 1) {
      return `${delta()} programs for one generator`;
    }

    const red = tint<SplatNode>(() => vec3(1, 0, 0));
    const green = tint<SplatNode>(() => vec3(0, 1, 0));
    for (const modifier of [red, green, red, green]) {
      await projectWith(listFor(arrays), { modifier });
    }
    if (delta() !== 3) {
      return `${delta() - 1} programs for two modifiers`;
    }

    const frame = new THREE.Matrix4().makeTranslation(1, 2, 3);
    await projectWith(listFor(other), { modifier: red });
    for (const modifierSpace of ["world", "object", frame] as const) {
      await projectWith(listFor(arrays), { modifier: red, modifierSpace });
    }
    frame.makeRotationY(1);
    await projectWith(listFor(arrays), { modifier: red, modifierSpace: frame });
    if (delta() !== 3) {
      return `${delta() - 3} programs for new data, spaces or a frame`;
    }

    SplatProjector.dispose(generator);
    await projectWith(listFor(arrays));
    other.dispose();
    return delta() === 4 ? undefined : "a disposed generator's program was not rebuilt";
  });

  await check("form selection: a covariance-only generator never diagonalizes under ewa; 3dgut does", async () => {
    const reader = GpuSplatReader.from(arrays);
    const fromCov = GpuSplats.fromCov;
    let calls = 0;
    (GpuSplats as { fromCov: typeof fromCov }).fromCov = (c) => {
      calls += 1;
      return fromCov(c);
    };
    try {
      const counts: Record<string, number> = {};
      for (const method of ["ewa", "3dgut"] as ProjectionMethod[]) {
        calls = 0;
        await projectWith(new SplatCollection([{ generator: { generateCovSplat: (i) => reader.loadCovSplat(i) }, count: scene.length }]), { method });
        counts[method] = calls;
      }
      return counts.ewa === 0 && counts["3dgut"] > 0 ? undefined : `fromCov calls: ewa ${counts.ewa}, 3dgut ${counts["3dgut"]}`;
    } finally {
      (GpuSplats as { fromCov: typeof fromCov }).fromCov = fromCov;
    }
  });

  const one = GpuArrays.fromData(renderer, splatData([splat([0, 0, -4], 0.25, [1, 1, 1], 1)]));
  const center = async (options: Parameters<typeof makeSplats>[1]) => {
    const splats = makeSplats(renderer, { collection: collectionOf(one), sortMode, ...options });
    try {
      return pixelAt(await drawWith(renderer, splats, camera), W / 2, H / 2);
    } finally {
      splats.dispose();
    }
  };

  await check("modifiers: the one matching the form runs (cov for ewa, splat for 3dgut); a view-space depth modifier colors by depth", async () => {
    const modifier = tint<SplatNode>(() => vec3(1, 0, 0));
    const covModifier = tint<CovSplatNode>(() => vec3(0, 1, 0));
    const [ewa, gut] = [await center({ method: "ewa", modifier, covModifier }), await center({ method: "3dgut", modifier, covModifier })];
    if (ewa[1] < 200 || ewa[0] > 20 || gut[0] < 200 || gut[1] > 20) {
      return `ewa ${ewa}, 3dgut ${gut}`;
    }
    const depth = await center({ method: "htgs", modifier: tint<SplatNode>((s) => vec3(s.get("center").z.negate().div(10))) });
    return Math.abs(depth[0] - 102) <= 10 ? undefined : `depth 4 colors ${depth[0]}, expected about 102`;
  });

  await check("modifier space: an identity modifier in each space projects like none; a world height modifier colors objects by world height", async () => {
    const frame = new THREE.Matrix4().compose(new THREE.Vector3(1, 2, -3), new THREE.Quaternion().setFromEuler(new THREE.Euler(0.3, -0.5, 0.2)), new THREE.Vector3(2, 2, 2));
    const m = new THREE.Matrix4().makeRotationX(0.2).setPosition(0.1, 0, 0);
    for (const method of ["ewa", "3dgut"] as ProjectionMethod[]) {
      const none = await projectWith(collectionOf([arrays, m]), { method });
      for (const modifierSpace of ["object", "world", frame, "view"] as const) {
        const identity = await projectWith(collectionOf([arrays, m]), { method, modifier: (s) => s, modifierSpace });
        const problem = differ(method, none, identity);
        if (problem) {
          return `${method} ${typeof modifierSpace === "string" ? modifierSpace : "frame"}: ${problem}`;
        }
      }
    }

    const dot = GpuArrays.fromData(renderer, splatData([splat([0, 0, 0], 0.15, [1, 1, 1], 1)]));
    const low = new THREE.Matrix4().makeTranslation(-1, 0.25, -4);
    const high = new THREE.Matrix4().makeTranslation(1, 0.75, -4);
    const splats = makeSplats(renderer, { collection: collectionOf([dot, low], [dot, high]), sortMode, modifierSpace: "world", modifier: tint<SplatNode>((s) => vec3(s.get("center").y)) });
    try {
      const pixels = await drawWith(renderer, splats, camera);
      const brightest = (x0: number) => {
        let best = [0, 0, 0, 0];
        for (let y = 0; y < H; y += 1) {
          for (let x = x0; x < x0 + W / 2; x += 1) {
            const p = pixelAt(pixels, x, y);
            best = p[3] > best[3] ? p : best;
          }
        }
        return (best[0] * 255) / Math.max(best[3], 1);
      };
      const [a, b] = [brightest(0), brightest(W / 2)];
      return Math.abs(a - 64) <= 12 && Math.abs(b - 191) <= 12 ? undefined : `heights 0.25 and 0.75 color ${a} and ${b}`;
    } finally {
      splats.dispose();
      dot.dispose();
    }
  });

  await check("SplatGenerator.fromSplats: an index list or a TSL remap equals reading those splats; new index lists compile nothing; splat.index stays the source's; modifiers in order", async () => {
    const listed = SplatGenerator.fromSplats({ remap: "indices" });
    const pick = Array.from({ length: 150 }, (_, k) => (k * 37) % scene.length);
    const collections = [SplatGenerator.indices(renderer, pick), SplatGenerator.indices(renderer, pick.slice().reverse())];
    const expected = GpuArrays.fromData(renderer, splatData(pick.map((i) => scene[i])));
    try {
      const want = await projectWith(collectionOf(expected));
      const got = await projectWith(new SplatCollection([{ generator: listed, data: { splats: arrays, indices: collections[0] }, count: pick.length }]));
      if (got.count !== pick.length || pick.some((_, k) => got.words(k).some((w, j) => w !== want.words(k)[j]))) {
        return "an index list projects other words";
      }
      const programs = SplatProjector.programs;
      await projectWith(new SplatCollection([{ generator: listed, data: { splats: arrays, indices: collections[1] }, count: pick.length }]));
      if (SplatProjector.programs !== programs) {
        return "a new index list compiled a program";
      }

      const evens = GpuArrays.fromData(renderer, splatData(scene.filter((_, i) => i % 2 === 0)));
      const even = await projectWith(collectionOf(evens));
      const mapped = await projectWith(new SplatCollection([{ generator: SplatGenerator.fromSplats({ remap: (i) => i.mul(uint(2)) }), data: { splats: arrays }, count: evens.count }]));
      evens.dispose();
      if (Array.from({ length: even.count }, (_, k) => k).some((k) => mapped.words(k).some((w, j) => w !== even.words(k)[j]))) {
        return "a procedural remap projects other words";
      }

      const hashed = tint<SplatNode>((s) => vec3(fract(float(s.get("index")).mul(0.618))));
      const full = await projectWith(collectionOf(arrays), { modifier: hashed });
      const subset = await projectWith(new SplatCollection([{ generator: listed, data: { splats: arrays, indices: collections[0] }, count: pick.length }]), { modifier: hashed });
      const moved = pick.findIndex((i, k) => eyeWords("ewa", subset.words(k), 0)[2] !== eyeWords("ewa", full.words(i), 0)[2]);
      if (moved >= 0) {
        return `subset splat ${moved} colored unlike source splat ${pick[moved]}`;
      }

      // The second modifier sees the first's rgb
      const red = tint<SplatNode>(() => vec3(1, 0, 0));
      const plusBlue = tint<SplatNode>((s) => s.get("rgb").add(vec3(0, 0, 1)));
      const both = await projectWith(new SplatCollection([{ generator: SplatGenerator.fromSplats({ modifiers: [red, plusBlue] }), data: { splats: arrays }, count: arrays.count }]));
      const magenta = await projectWith(collectionOf(arrays), { modifier: tint<SplatNode>(() => vec3(1, 0, 1)), modifierSpace: "object" });
      const at = Array.from({ length: scene.length }, (_, i) => i).findIndex((i) => eyeWords("ewa", both.words(i), 0)[2] !== eyeWords("ewa", magenta.words(i), 0)[2]);
      return at < 0 ? undefined : `splat ${at}: the modifiers did not run in turn`;
    } finally {
      [...collections, expected].forEach((x) => x.dispose());
    }
  });

  const colored = (rgb: [number, number, number]) => GpuArrays.fromData(renderer, splatData([splat([0, 0, -4], 0.3, rgb, 1)]));

  const same = (a: Projection, b: Projection) => a.count === b.count && Array.from({ length: a.count }, (_, i) => i).every((i) => a.keys[i] === b.keys[i] && a.words(i).every((w, k) => w === b.words(i)[k]));

  await check("views: a view's settings over its renderer's project like a renderer of those settings; unset ones follow the renderer; a null modifier drops its modifier", async () => {
    const red = tint<SplatNode>(() => vec3(1, 0, 0));
    const m = new THREE.Matrix4().makeTranslation(0.2, 0, -0.5);
    const base = makeSplats(renderer, { collection: collectionOf(arrays), modifier: red, objectParams: { blurAmount: 0.3 } });
    const own = base.viewFor("own", { collection: collectionOf([arrays, m]), objectParams: { blurAmount: 0 }, modifier: null, sortBits: 16 });
    const follows = base.viewFor("follows", { params: { maxStdDev: 2 } });
    const viaView = async (view: SplatView) => {
      setCamera(renderer, [camera]);
      const projected = project(renderer, base, view.collection ?? base.collection, { view });
      const result = await readProjection(projected, base.method, 1);
      projected.dispose();
      return result;
    };
    try {
      if (base.viewFor("own") !== own || base.views.size !== 2) {
        return "viewFor made a second view of a key";
      }
      if (!same(await viaView(own), await projectWith(collectionOf([arrays, m]), { objectParams: { blurAmount: 0 }, sortBits: 16 }))) {
        return "a view's own collection, objectParams, null modifier and sortBits project otherwise";
      }
      base.objectParams.blurAmount = 0.1;
      if (!same(await viaView(follows), await projectWith(collectionOf(arrays), { modifier: red, objectParams: { blurAmount: 0.1 }, params: { maxStdDev: 2 } }))) {
        return "a view's unset settings do not follow the renderer";
      }
      follows.dispose();
      return base.views.has("follows") ? "a disposed view stayed on its renderer" : undefined;
    } finally {
      base.dispose();
    }
  });

  await check("views: a render draws the renderer's settings, its camera's view, or the explicit view", async () => {
    const [red, blue, green] = [colored([1, 0, 0]), colored([0, 0, 1]), colored([0, 1, 0])];
    const splats = makeSplats(renderer, { collection: collectionOf(red), sortMode });
    const twin = camera.clone();
    splats.viewFor(twin, { collection: collectionOf(blue) });
    const explicit = splats.viewFor("explicit", { collection: collectionOf(green) });
    const drawn = new THREE.Scene().add(splats);
    const middle = async (from: THREE.Camera) => {
      if (sortMode === "cpu") {
        const view = splats.view ?? splats.viewFor(from);
        view.apply(await view.sort(from));
      }
      return pixelAt(await renderPixels(renderer, drawn, from), W / 2, H / 2);
    };
    try {
      const [a, b] = [await middle(camera), await middle(twin)];
      splats.view = explicit;
      const c = await middle(camera);
      const views = sortMode === "cpu" ? 3 : 2;
      if (a[0] < 150 || b[2] < 150 || c[1] < 150 || splats.views.size !== views) {
        return `drew ${a} | ${b} | ${c}, ${splats.views.size} views`;
      }
      return undefined;
    } finally {
      [splats, red, blue, green].forEach((x) => x.dispose());
    }
  });

  await check("viewKey: renders from cameras made anew share the view of their key; by default each camera makes one (cpu mode)", async () => {
    const red = colored([1, 0, 0]);
    const splats = makeSplats(renderer, { collection: collectionOf(red), sortMode: "cpu", viewKey: () => "main" });
    const drawn = new THREE.Scene().add(splats);
    try {
      for (let k = 0; k < 3; k += 1) {
        await renderPixels(renderer, drawn, camera.clone());
      }
      const keys = [...splats.views.keys()].join();
      splats.viewKey = (each) => each;
      await renderPixels(renderer, drawn, camera.clone());
      return keys === "main" && splats.views.size === 2 ? undefined : `views ${keys}, then ${splats.views.size}`;
    } finally {
      [splats, red].forEach((x) => x.dispose());
    }
  });

  await check("CPU sort: nothing drawn before an order; apply skips older versions; a newer order shows its own collection while the renderer's moved on", async () => {
    const [red, blue, green] = [colored([1, 0, 0]), colored([0, 0, 1]), colored([0, 1, 0])];
    const m1 = collectionOf(red);
    const splatRenderer = makeSplats(renderer, { collection: m1, sortMode: "cpu" });
    const view = splatRenderer.viewFor(camera);
    const scene3 = new THREE.Scene().add(splatRenderer);
    const middle = async () => pixelAt(await renderPixels(renderer, scene3, camera), W / 2, H / 2);
    try {
      if ((await middle())[3] !== 0) {
        return "drew before any order";
      }
      const o1 = await view.sort(camera);
      const o2 = await view.sort(camera);
      if (o1.collection !== m1 || !view.apply(o2) || view.apply(o1)) {
        return "versions not respected";
      }
      if ((await middle())[0] < 150) {
        return "the applied order's collection is not drawn";
      }
      splatRenderer.collection = collectionOf(blue);
      if ((await middle())[0] < 150) {
        return "a new collection drew before its order";
      }
      const pending = view.sort(camera);
      splatRenderer.collection = collectionOf(green);
      view.apply(await pending);
      const [r, g, b] = await middle();
      return b > 150 && r < 30 && g < 30 ? undefined : `drew ${r} ${g} ${b}, expected the blue collection's order`;
    } finally {
      [splatRenderer, red, blue, green].forEach((x) => x.dispose());
    }
  });

  await check("object release: once, when no live collection of any renderer holds the object; kept objects and other renderers hold; a view's collection, shown and in-flight collections hold; a release may change renderers", async () => {
    const released = new Map<string, number>();
    const generator = SplatGenerator.fromSplats();
    const objectOf = (name: string) => ({ generator, count: 1, release: () => released.set(name, (released.get(name) ?? 0) + 1) });
    const [a, b] = [makeSplats(renderer), makeSplats(renderer)];
    const owners = [a, b];
    try {
      const x = objectOf("x");
      a.collection = new SplatCollection([x]);
      if (released.has("x")) {
        return "released while a renderer holds it";
      }
      a.collection = SplatCollection.EMPTY;
      a.collection = new SplatCollection([{ generator, count: 1 }]);
      if (released.get("x") !== 1) {
        return `released ${released.get("x") ?? 0} times once retired`;
      }

      const [y, other] = [objectOf("y"), objectOf("other")];
      a.collection = new SplatCollection([y, other]);
      a.collection = new SplatCollection([y]);
      if (released.has("y") || released.get("other") !== 1) {
        return "a kept object released, or a dropped one not";
      }

      b.collection = a.collection;
      a.collection = SplatCollection.EMPTY;
      if (released.has("y")) {
        return "released while another renderer holds it";
      }
      b.collection = SplatCollection.EMPTY;
      if (released.get("y") !== 1) {
        return "not released once no renderer holds it";
      }

      const w = objectOf("w");
      const c = makeSplats(renderer, { collection: new SplatCollection([w]) });
      c.dispose();
      if (released.get("w") !== 1) {
        return "not released by the renderer's dispose";
      }

      const view = a.viewFor("own", { collection: new SplatCollection([objectOf("own")]) });
      if (released.has("own")) {
        return "released while a view holds it";
      }
      view.dispose();
      if (released.get("own") !== 1) {
        return "not released by the view's dispose";
      }

      const next = new SplatCollection([objectOf("next")]);
      a.collection = new SplatCollection([{ ...objectOf("reentrant"), release: () => (b.collection = next) }]);
      a.collection = SplatCollection.EMPTY;
      if (b.collection !== next) {
        return "a release could not set a renderer's collection";
      }
      b.collection = SplatCollection.EMPTY;

      const held = GpuArrays.fromData(renderer, splatData(scene.slice(0, 10)));
      let gone = false;
      const d = makeSplats(renderer, { collection: new SplatCollection([SplatCollection.arrays(held, { release: () => (gone = true) })]), sortMode: "cpu" });
      owners.push(d);
      const dv = d.viewFor(camera);
      const pending = dv.sort(camera);
      d.collection = SplatCollection.EMPTY;
      if (gone) {
        return "released while being sorted";
      }
      dv.apply(await pending);
      if (gone) {
        return "released while shown";
      }
      dv.apply(await dv.sort(camera));
      held.dispose();
      return gone ? undefined : "not released once its order was replaced";
    } finally {
      owners.forEach((owner) => owner.dispose());
    }
  });

  await check("sort workers: cpu renderers and their views share SplatRenderer.sortPool (4 workers), in parallel; gpu mode refuses; a given pool is used instead; both outlive their renderers", async () => {
    const pool = new WorkerPool({ size: 1 });
    const [a, b] = [makeSplats(renderer, { collection: collectionOf(arrays), sortMode: "cpu" }), makeSplats(renderer, { collection: collectionOf(arrays), sortMode: "cpu", sortWorker: pool })];
    const c = makeSplats(renderer, { collection: collectionOf(arrays), sortMode: "cpu" });
    const g = makeSplats(renderer, { collection: collectionOf(arrays), sortMode: "gpu" });
    const shared = SplatRenderer.sortPool;
    const sortOf = (splats: SplatRenderer, key: unknown = camera) => splats.viewFor(key).sort(camera);
    try {
      const [oa, ob, oc, od] = await Promise.all([sortOf(a), sortOf(b), sortOf(a, "second"), sortOf(c)]);
      if (oa.visible === 0 || oa.visible !== ob.visible || oc.visible !== oa.visible || od.visible !== oa.visible) {
        return `visible ${oa.visible} ${ob.visible} ${oc.visible} ${od.visible}`;
      }
      // Three sorts on the shared pool start as many workers as overlapped, b's on its own
      if (shared !== SplatRenderer.sortPool || shared.size !== 4 || shared.workerCount < 1 || shared.workerCount > shared.size || pool.workerCount !== 1) {
        return `shared pool ${shared.workerCount}/${shared.size} workers, given pool ${pool.workerCount}`;
      }
      const refused = await sortOf(g).then(() => false, () => true);
      if (!refused) {
        return "a gpu-mode renderer sorted on the CPU";
      }
      const workers = shared.workerCount;
      c.sortMode = "gpu";
      a.dispose();
      b.dispose();
      const after = await sortSplatKeys(new Uint32Array([3, 1, 2]), { bits: 32, worker: pool });
      const again = await sortSplatKeys(new Uint32Array([3, 1, 2]), { bits: 32, worker: shared });
      return shared.workerCount === workers && after.visible === 3 && again.visible === 3 ? undefined : "the shared or the given pool did not outlive its renderers";
    } finally {
      [c, g].forEach((splats) => splats.dispose());
      pool.dispose();
    }
  });

  await check("CPU orders: a later landed order supersedes an earlier one; a switch to gpu drops the orders (releasing their objects), and apply refuses in gpu mode", async () => {
    let released = 0;
    const releases = () => released;
    const splatRenderer = makeSplats(renderer, { sortMode: "cpu" });
    const view = splatRenderer.viewFor(camera);
    try {
      splatRenderer.collection = new SplatCollection([SplatCollection.arrays(arrays, { release: () => (released += 1) })]);
      const [o1, o2] = [await view.sort(camera), await view.sort(camera)];
      if (view.apply(o1) || !view.apply(o2)) {
        return "an order applied after a later one landed, or the later one not";
      }
      splatRenderer.collection = SplatCollection.EMPTY;
      const pending = view.sort(camera);
      if (releases() !== 0) {
        return "released while its order is shown";
      }
      splatRenderer.sortMode = "gpu";
      if (releases() !== 1) {
        return "a switch to gpu kept the shown order's objects";
      }
      const late = await pending;
      if (view.apply(late)) {
        return "applied in gpu mode";
      }
      splatRenderer.sortMode = "cpu";
      return view.order === undefined && !view.apply(late) ? undefined : "an order survived a switch to gpu";
    } finally {
      splatRenderer.dispose();
    }
  });

  await check("dispose during a sort: the sort rejects, keeps no key arrays and no views, and leaves the shared sort pool working", async () => {
    const splatRenderer = makeSplats(renderer, { collection: collectionOf(arrays), sortMode: "cpu" });
    const view = splatRenderer.viewFor(camera);
    const pending = view.sort(camera);
    splatRenderer.dispose();
    const rejected = await pending.then(() => false, () => true);
    const keyArrays = (view as unknown as { keyArrays: GpuArrays[] }).keyArrays;
    const shared = await sortSplatKeys(new Uint32Array([3, 1, 2]), { bits: 32, worker: SplatRenderer.sortPool });
    return rejected && keyArrays.length === 0 && splatRenderer.views.size === 0 && shared.visible === 3 ? undefined
      : `rejected ${rejected}, key arrays ${keyArrays.length}, views ${splatRenderer.views.size}, shared pool sorted ${shared.visible}`;
  });

  await check("a disposed renderer left in the scene draws nothing, makes no textures and throws nothing, prepare too; its sortKeys and a disposed pool reject", async () => {
    for (const mode of webgpu ? (["gpu", "cpu"] as const) : (["cpu"] as const)) {
      const splatRenderer = makeSplats(renderer, { collection: collectionOf(arrays), sortMode: mode });
      const drawn = new THREE.Scene().add(splatRenderer);
      await renderPixels(renderer, drawn, camera);
      if (mode === "cpu") {
        const view = splatRenderer.viewFor(camera);
        view.apply(await view.sort(camera));
      }
      if (!(await renderPixels(renderer, drawn, camera)).some((v, i) => i % 4 === 3 && v > 0)) {
        return `${mode}: nothing drawn before dispose`;
      }
      splatRenderer.dispose();
      const textures = renderer.info.memory.textures;
      splatRenderer.prepare(camera);
      let pixels: Uint8Array = new Uint8Array(0);
      for (let frame = 0; frame < 3; frame += 1) {
        pixels = await renderPixels(renderer, drawn, camera);
      }
      if (pixels.some((v, i) => i % 4 === 3 && v > 0) || renderer.info.memory.textures !== textures) {
        return `${mode}: drew after dispose, or textures ${textures} became ${renderer.info.memory.textures}`;
      }
      const refused = await splatRenderer.sortKeys(new Uint32Array(4), 24).then(() => false, () => true);
      if (!refused || await splatRenderer.readSortedCount() !== 0) {
        return `${mode}: sortKeys or readSortedCount after dispose`;
      }
    }
    const pool = new WorkerPool({ size: 1 });
    pool.dispose();
    const rejected = await sortSplatKeys(new Uint32Array([3, 1, 2]), { bits: 32, worker: pool }).then(() => false, () => true);
    return rejected && pool.workerCount === 0 ? undefined : "a disposed pool ran a call";
  });

  await check("SplatRenderer: a view of another renderer is refused; a render not following its prepare projects anew", async () => {
    const [red, blue] = [colored([1, 0, 0]), colored([0, 0, 1])];
    const splatRenderer = makeSplats(renderer, { collection: collectionOf(red), sortMode });
    const other = makeSplats(renderer);
    splatRenderer.view = other.viewFor("foreign");
    const drawn = new THREE.Scene().add(splatRenderer);
    try {
      const refused = (() => {
        try {
          splatRenderer.prepare(camera);
          return false;
        } catch {
          return true;
        }
      })();
      if (!refused) {
        return "drew a view of another renderer";
      }
      splatRenderer.view = undefined;
      if (!webgpu) {
        return undefined;
      }
      splatRenderer.prepare(camera);
      await renderPixels(renderer, new THREE.Scene(), camera);
      splatRenderer.collection = collectionOf(blue);
      const [r, , b] = pixelAt(await renderPixels(renderer, drawn, camera), W / 2, H / 2);
      return b > 150 && r < 30 ? undefined : `drew ${r} ${b}: the prepared projection of an earlier frame`;
    } finally {
      [splatRenderer, other, red, blue].forEach((x) => x.dispose());
    }
  });

  await check("SplatCamera: a camera in the other clip convention projects like one in the renderer's, unchanged", async () => {
    const other = webgpu ? THREE.WebGLCoordinateSystem : THREE.WebGPUCoordinateSystem;
    const foreign = new THREE.PerspectiveCamera(60, W / H, 0.1, 100);
    foreign.coordinateSystem = other;
    foreign.updateProjectionMatrix();
    foreign.updateMatrixWorld();
    const before = [...foreign.projectionMatrix.elements];
    const splats = makeSplats(renderer);
    const collection = collectionOf(arrays);
    try {
      const results: Projection[] = [];
      for (const eye of [foreign, camera]) {
        SplatCamera.set(renderer, eye);
        const projected = project(renderer, splats, collection);
        results.push(await readProjection(projected, splats.method, 1));
        projected.dispose();
      }
      const unchanged = foreign.coordinateSystem === other && foreign.projectionMatrix.elements.every((v, k) => v === before[k]);
      return unchanged ? differ(splats.method, results[0], results[1]) : "the camera was changed";
    } finally {
      splats.dispose();
    }
  });

  // A render's autoSort step, then the version of the order its sort applies
  const autoStep = async (view: SplatView, lens: THREE.Camera) => {
    const busy = () => (view as unknown as { autoSorting: boolean }).autoSorting;
    view.drawn(lens);
    for (let k = 0; k < 400 && busy(); k += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return view.order?.version ?? 0;
  };

  await check("autoSort: with a sortGuard a lens change re-sorts, without one it does not; requestSort() re-sorts, also after a sort in flight", async () => {
    for (const sortGuard of [0.5, 0]) {
      const splats = makeSplats(renderer, { collection: collectionOf(arrays), sortMode: "cpu", autoSort: { distance: 1e9, angle: 1e9 }, objectParams: { sortGuard } });
      const lens = makeCamera(renderer);
      const view = splats.viewFor(lens);
      const step = () => autoStep(view, lens);
      try {
        const [first, still] = [await step(), await step()];
        lens.fov = 40;
        lens.updateProjectionMatrix();
        const changed = await step();
        const wanted = sortGuard > 0 ? changed > still : changed === still;
        if (first === 0 || still !== first || !wanted) {
          return `sortGuard ${sortGuard}: versions ${first}, ${still}, ${changed}`;
        }

        view.requestSort();
        const requested = await step();
        // Requested while a sort is in flight: one more sort after it
        view.requestSort();
        view.drawn(lens);
        view.requestSort();
        const [during, after, idle] = [await step(), await step(), await step()];
        if (requested !== changed + 1 || after !== during + 1 || idle !== after) {
          return `sortGuard ${sortGuard}: requestSort versions ${changed} -> ${requested}; in flight ${during}, ${after}, ${idle}`;
        }
      } finally {
        splats.dispose();
      }
    }
    return undefined;
  });

  await check("requestSort with autoSort off: a sort only when asked; onInvalidate for a request and an applied order, and for every view on the renderer's request", async () => {
    const invalidated: (string | undefined)[] = [];
    const splats = makeSplats(renderer, { collection: collectionOf(arrays), sortMode: "cpu", autoSort: false, onInvalidate: (view) => invalidated.push(view && String(view.key)) });
    const view = splats.viewFor("lens");
    const lens = makeCamera(renderer);
    try {
      const none = await autoStep(view, lens);
      view.requestSort();
      const asked = await autoStep(view, lens);
      const idle = await autoStep(view, lens);
      splats.requestSort();
      const again = await autoStep(view, lens);
      const calls = invalidated.map((key) => key ?? "all").join();
      return none === 0 && asked === 1 && idle === 1 && again === 2 && calls === "lens,lens,all,lens" ? undefined
        : `versions ${none}, ${asked}, ${idle}, ${again}; onInvalidate ${calls}`;
    } finally {
      splats.dispose();
    }
  });

  one.dispose();
  arrays.dispose();
}
