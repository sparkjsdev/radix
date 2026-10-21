import * as THREE from "three";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import type { WebGPURenderer } from "three/webgpu";
import {
  GpuSplats, SplatGenerator, SplatCollection, SplatRenderer, Splats, TSL,
  type AnySplatObject, type ArrayData, type CameraControls, type GpuArrays, type SplatNode, type SplatRendererOptions,
} from "@sparkjsdev/radix";

const { abs, clamp, cos, exp, float, length, mix, sin, uint, uniform, vec3, vec4 } = TSL;

export interface SceneContext {
  renderer: WebGPURenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: CameraControls;
  // The loaded file, and the matrix that centers it at the origin, about a unit in radius
  data: ArrayData;
  splats: GpuArrays;
  fit: THREE.Matrix4;
  webgpu: boolean;
  // Seconds since the page started
  time: ReturnType<typeof uniform>;
  // A splat renderer in the page's sort mode, which the sort buttons switch
  splatRenderer(options: Omit<SplatRendererOptions, "renderer">): SplatRenderer;
  // A button in the bar, lit while active returns true
  button(label: string, onClick: () => void, active?: () => boolean): void;
}

export interface Demo {
  // Every frame, before the render (seconds)
  frame?(time: number): void;
  // Instead of rendering the scene from the camera
  render?(): void;
  status?(): string;
}

// The Object3D takes a gizmo, and the splat object's matrixWorld is its fitted child's
function place(ctx: SceneContext, position: [number, number, number]) {
  const object = new THREE.Object3D();
  object.position.set(...position);
  const fitted = new THREE.Object3D();
  fitted.matrixAutoUpdate = false;
  fitted.matrix.copy(ctx.fit);
  object.add(fitted);
  ctx.scene.add(object);
  return { object, matrixWorld: fitted.matrixWorld };
}

function ring(ctx: SceneContext, matrixWorld: AnySplatObject["matrixWorld"] = new THREE.Matrix4().makeScale(1.4, 1.4, 1.4)): AnySplatObject {
  const count = 4000;
  const time = ctx.time;
  const generator: SplatGenerator = {
    generateSplat: (index) => {
      const t = float(index).div(count);
      const angle = t.mul(Math.PI * 2).add(time.mul(0.3));
      const ripple = sin(t.mul(Math.PI * 24).add(time.mul(2))).mul(0.06);
      const center = vec3(cos(angle), ripple, sin(angle));
      const rgb = vec3(t, sin(t.mul(Math.PI)), float(1).sub(t));
      return GpuSplats.Splat(center, vec3(0.008, 0.008, 0.004), vec4(0, 0, 0, 1), rgb, float(0.9), uint(index));
    },
  };
  return { generator, count, matrixWorld };
}

function gizmoOf(ctx: SceneContext) {
  const gizmo = new TransformControls(ctx.camera, ctx.renderer.domElement);
  gizmo.addEventListener("dragging-changed", (event) => (ctx.controls.enabled = !event.value));
  ctx.scene.add(gizmo.getHelper());
  return gizmo;
}

// A modifier setting rgb, made once since each modifier is its own program
const tint = (rgb: (s: SplatNode) => unknown) => (s: SplatNode): SplatNode => {
  const out = s.toVar();
  out.get("rgb").assign(rgb(s) as never);
  return out;
};

function multi(ctx: SceneContext): Demo {
  const left = place(ctx, [-0.8, 0, 0]);
  const right = place(ctx, [0.8, 0, 0]);
  // The ring's matrixWorld is a function, read every render
  const ringMatrix = new THREE.Matrix4();
  const tilt = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.15);
  const bob = new THREE.Vector3();
  const scale = new THREE.Vector3(1.6, 1.6, 1.6);
  const ringAt = () => ringMatrix.compose(bob.set(0, Math.sin(ctx.time.value as number) * 0.15, 0), tilt, scale);

  // Two objects of the same arrays share one program
  const splatRenderer = ctx.splatRenderer({
    collection: new SplatCollection([
      SplatCollection.arrays(ctx.splats, { matrixWorld: left.matrixWorld }),
      SplatCollection.arrays(ctx.splats, { matrixWorld: right.matrixWorld }),
      ring(ctx, ringAt),
    ]),
  });
  ctx.scene.add(splatRenderer);

  // Scaling one axis takes the covariance path
  const gizmo = gizmoOf(ctx);
  gizmo.attach(right.object);
  gizmo.setMode("scale");
  for (const mode of ["translate", "rotate", "scale"] as const) {
    ctx.button(mode, () => gizmo.setMode(mode), () => gizmo.mode === mode);
  }
  ctx.button("squash", () => right.object.scale.set(1, 0.35, 1.6));

  return {
    frame(seconds) {
      left.object.rotation.y = seconds * 0.4;
    },
    status: () => `${splatRenderer.collection.objects.length} objects, ${splatRenderer.collection.count.toLocaleString()} splats in one sort`,
  };
}

function views(ctx: SceneContext): Demo {
  const leftObject = SplatCollection.arrays(ctx.splats, { matrixWorld: place(ctx, [-0.6, 0, 0]).matrixWorld });
  const rightObject = SplatCollection.arrays(ctx.splats, { matrixWorld: place(ctx, [0.6, 0, 0.3]).matrixWorld });
  const ringObject = ring(ctx, new THREE.Matrix4().makeScale(1.5, 1.5, 1.5));

  // A render draws its camera's view, or the renderer's settings when it has none
  const splatRenderer = ctx.splatRenderer({ collection: new SplatCollection([leftObject, rightObject, ringObject]) });
  ctx.scene.add(splatRenderer);
  const other = new THREE.PerspectiveCamera(60, 1, 0.01, 1000);
  const otherView = splatRenderer.viewFor(other, {
    collection: new SplatCollection([rightObject, ringObject]),
    modifier: tint((s) => mix(s.get("rgb"), vec3(1, 0.55, 0.15), 0.5)),
  });
  for (const method of ["ewa", "3dgut", "htgs"] as const) {
    ctx.button(method, () => (splatRenderer.method = method), () => splatRenderer.method === method);
  }

  const size = new THREE.Vector2();
  const half = (x: number, camera: THREE.PerspectiveCamera) => {
    camera.aspect = size.x / 2 / size.y;
    camera.updateProjectionMatrix();
    ctx.renderer.setViewport(x * size.x / 2, 0, size.x / 2, size.y);
    ctx.renderer.setScissor(x * size.x / 2, 0, size.x / 2, size.y);
    ctx.renderer.render(ctx.scene, camera);
  };
  const orderOf = (camera: THREE.Camera) => (splatRenderer.sortMode === "cpu" ? `, order of ${splatRenderer.views.get(camera)?.order?.visible ?? 0}` : "");

  return {
    frame(seconds) {
      other.position.set(Math.sin(seconds * 0.3) * 3, 1.2, Math.cos(seconds * 0.3) * 3);
      other.lookAt(0, 0, 0);
      other.updateMatrixWorld();
    },
    render() {
      // On WebGPU a background clears the whole canvas in each render, scissor or not
      const renderer = ctx.renderer;
      const background = ctx.scene.background;
      renderer.getSize(size);
      ctx.scene.background = null;
      renderer.setClearColor(background as THREE.Color);
      renderer.autoClear = false;
      renderer.clear();
      renderer.setScissorTest(true);
      half(0, ctx.camera);
      half(1, other);
      renderer.setScissorTest(false);
      renderer.setViewport(0, 0, size.x, size.y);
      renderer.autoClear = true;
      ctx.scene.background = background;
    },
    status: () => `${splatRenderer.method} | left: your camera, the renderer's collection${orderOf(ctx.camera)} | right: orbiting, its view's collection of ${otherView.collection?.objects.length} objects, tinted${orderOf(other)}`,
  };
}

function modifiers(ctx: SceneContext): Demo {
  const time = ctx.time;
  const depthRange = uniform(new THREE.Vector2(1, 4));
  const splatRenderer = ctx.splatRenderer({
    collection: new SplatCollection([SplatCollection.arrays(ctx.splats, { matrixWorld: place(ctx, [0, 0, 0]).matrixWorld }), ring(ctx)]),
  });
  ctx.scene.add(splatRenderer);

  // The wave's frame
  const frame = new THREE.Object3D();
  frame.position.set(0, -0.2, 0);
  ctx.scene.add(frame);
  const gizmo = gizmoOf(ctx);

  // Made once each, so switching compiles nothing after the first use
  const depth = tint((s) => vec3(float(1).sub(clamp(s.get("center").z.negate().sub(depthRange.x).div(depthRange.y.sub(depthRange.x)), 0, 1))));
  const choices: [string, SplatRenderer["modifier"], SplatRenderer["modifierSpace"]][] = [
    ["rgb", undefined, "view"],
    ["depth (view)", depth, "view"],
    ["normal (view)", tint((s) => abs(GpuSplats.normalOf(s))), "view"],
    ["height (world)", tint((s) => mix(vec3(0.1, 0.3, 1), vec3(1, 0.3, 0.1), clamp(s.get("center").y.mul(0.8).add(0.5), 0, 1))), "world"],
    ["wave (gizmo frame)", (s) => {
      const out = s.toVar();
      const c = s.get("center");
      const d = length(vec3(c.x, 0, c.z));
      const h = sin(d.mul(14).sub(time.mul(3))).mul(0.05).mul(exp(d.negate()));
      out.get("center").assign(c.add(vec3(0, h, 0)));
      out.get("rgb").assign(mix(s.get("rgb"), vec3(0.2, 0.7, 1), clamp(h.mul(12).add(0.3), 0, 1)));
      return out;
    }, frame.matrixWorld],
  ];
  let chosen = 0;
  const waving = () => choices[chosen][2] === frame.matrixWorld;
  choices.forEach(([label, modifier, space], i) => ctx.button(label, () => {
    chosen = i;
    splatRenderer.modifier = modifier;
    splatRenderer.modifierSpace = space;
    if (waving()) {
      gizmo.attach(frame);
    } else {
      gizmo.detach();
    }
  }, () => chosen === i));

  // Views of the app's own keys, drawn by setting splatRenderer.view. A null
  // modifier drops the renderer's.
  const thumbs = [
    splatRenderer.viewFor("thumb rgb", { modifier: null }),
    splatRenderer.viewFor("thumb depth", { modifier: depth, modifierSpace: "view" }),
  ];
  const targets = thumbs.map(() => new THREE.RenderTarget(384, 216, { type: THREE.HalfFloatType }));
  const hud = new THREE.Scene();
  const hudCamera = new THREE.OrthographicCamera(0, 1, 1, 0, -1, 1);
  const quads = targets.map((target) => {
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: target.texture }));
    hud.add(quad);
    return quad;
  });
  const thumbCamera = new THREE.PerspectiveCamera();

  return {
    frame() {
      const distance = ctx.camera.position.length();
      (depthRange.value as THREE.Vector2).set(Math.max(distance - 1.2, 0.01), distance + 1.2);
    },
    render() {
      const renderer = ctx.renderer;
      gizmo.getHelper().visible = false;
      thumbCamera.copy(ctx.camera);
      thumbCamera.aspect = 16 / 9;
      thumbCamera.updateProjectionMatrix();
      thumbs.forEach((view, i) => {
        splatRenderer.view = view;
        renderer.setRenderTarget(targets[i]);
        renderer.render(ctx.scene, thumbCamera);
      });
      splatRenderer.view = undefined;
      renderer.setRenderTarget(null);
      gizmo.getHelper().visible = waving();
      renderer.render(ctx.scene, ctx.camera);

      // 16:9 thumbnails a fifth of the width
      const [w, h] = [0.2, 0.2 * ctx.camera.aspect * (9 / 16)];
      quads.forEach((quad, i) => {
        quad.scale.set(w, h, 1);
        quad.position.set(1 - w / 2 - 0.01, 0.07 + h / 2 + i * (h + 0.01), 0);
      });
      renderer.autoClear = false;
      renderer.render(hud, hudCamera);
      renderer.autoClear = true;
    },
    status: () => `modifier: ${choices[chosen][0]}; thumbnails: rgb (bottom), depth (top), from one camera through two views`,
  };
}

function subset(ctx: SceneContext): Demo {
  const object = place(ctx, [0, 0, 0]);
  const { data, splats, renderer } = ctx;
  const n = Math.max(1, Math.floor(splats.count * 0.3));

  const centers = new Float32Array(data.count * 3);
  const { bundle } = Splats.get(data);
  const c = { x: 0, y: 0, z: 0 };
  for (let i = 0; i < data.count; i += 1) {
    Splats.loadCenter(bundle, i, c);
    centers.set([c.x, c.y, c.z], i * 3);
  }

  // One generator for every index list: splat i is splats[indices[i]]
  const listed = SplatGenerator.fromSplats({ remap: "indices" });
  const everyFourth = SplatGenerator.fromSplats({ remap: (i) => i.mul(uint(4)) });

  const splatRenderer = ctx.splatRenderer({});
  ctx.scene.add(splatRenderer);

  // An object's release runs once nothing draws or sorts it, and returns its index list
  const pool: GpuArrays[] = [];
  let made = 0;
  const inverse = new THREE.Matrix4();
  const eye = new THREE.Vector3();
  const chosenAt = new THREE.Vector3(Infinity, 0, 0);
  const nearest = new Uint32Array(n);
  let procedural = false;

  function choose() {
    inverse.copy(object.matrixWorld).invert();
    eye.copy(ctx.camera.position).applyMatrix4(inverse);
    const d2 = (i: number) => (centers[i * 3] - eye.x) ** 2 + (centers[i * 3 + 1] - eye.y) ** 2 + (centers[i * 3 + 2] - eye.z) ** 2;
    // The n-th nearest distance from a sample, then everything closer
    const sample = Float32Array.from({ length: 4096 }, () => d2(Math.floor(Math.random() * data.count))).sort();
    const threshold = sample[Math.min(4095, Math.floor((n / data.count) * 4096))];
    let count = 0;
    for (let i = 0; i < data.count && count < n; i += 1) {
      if (d2(i) <= threshold) {
        nearest[count++] = i;
      }
    }

    made += pool.length === 0 ? 1 : 0;
    const indices = SplatGenerator.indices(renderer, nearest.subarray(0, count), pool.pop());
    // object() checks the data against the generator's (StoredSplats)
    splatRenderer.collection = new SplatCollection([SplatCollection.object({ generator: listed, data: { splats, indices }, count, matrixWorld: object.matrixWorld, release: () => pool.push(indices) })]);
  }

  ctx.button("nearest 30%", () => {
    procedural = false;
    chosenAt.set(Infinity, 0, 0);
  }, () => !procedural);
  ctx.button("every 4th", () => {
    procedural = true;
    splatRenderer.collection = new SplatCollection([{ generator: everyFourth, data: { splats }, count: Math.floor(splats.count / 4), matrixWorld: object.matrixWorld }]);
  }, () => procedural);

  let chosenTime = -Infinity;
  return {
    frame(seconds) {
      object.object.updateMatrixWorld();
      if (!procedural && ctx.camera.position.distanceTo(chosenAt) > 0.05 && seconds - chosenTime > 0.25) {
        chosenAt.copy(ctx.camera.position);
        chosenTime = seconds;
        choose();
      }
    },
    status: () => procedural ? `every 4th splat: ${splatRenderer.collection.count.toLocaleString()}` : `the nearest ${splatRenderer.collection.count.toLocaleString()} splats; ${made} index lists made, ${pool.length} back in the pool`,
  };
}

function offline(ctx: SceneContext): Demo {
  const collection = new SplatCollection([SplatCollection.arrays(ctx.splats, { matrixWorld: place(ctx, [0, 0, 0]).matrixWorld }), ring(ctx)]);
  ctx.scene.add(ctx.splatRenderer({ collection }));
  const preview = document.getElementById("preview") as HTMLImageElement;
  preview.onclick = () => (preview.hidden = true);

  // Its own renderer, with an exact CPU order for its camera on either backend
  async function still(width = 1920, height = 1080) {
    const renderer = ctx.renderer;
    const camera = ctx.camera.clone();
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    const stillSplats = new SplatRenderer({ renderer, collection, sortMode: "cpu", autoSort: false, method: "htgs" });
    const stillScene = new THREE.Scene().add(stillSplats);
    stillScene.background = ctx.scene.background;
    const target = new THREE.RenderTarget(width, height, { type: THREE.UnsignedByteType });
    try {
      const view = stillSplats.viewFor(camera);
      view.apply(await view.sort(camera));
      renderer.setRenderTarget(target);
      renderer.render(stillScene, camera);
      renderer.setRenderTarget(null);
      const pixels = await renderer.readRenderTargetPixelsAsync(target, 0, 0, width, height) as Uint8Array;
      const image = new ImageData(width, height);
      for (let y = 0; y < height; y += 1) {
        // WebGL2 reads rows bottom up
        const row = ctx.webgpu ? y : height - 1 - y;
        image.data.set(pixels.subarray(row * width * 4, (row + 1) * width * 4), y * width * 4);
      }
      const canvas = Object.assign(document.createElement("canvas"), { width, height });
      canvas.getContext("2d")!.putImageData(image, 0, 0);
      preview.src = canvas.toDataURL("image/png");
      preview.hidden = false;
    } finally {
      target.dispose();
      stillSplats.dispose();
    }
  }
  let rendering = false;
  ctx.button("render a 1920x1080 still", () => {
    if (!rendering) {
      rendering = true;
      void still().finally(() => (rendering = false));
    }
  });

  return {
    status: () => (rendering ? "rendering the still..." : "the still is sorted for its own camera, then read back"),
  };
}

export const SCENES: Record<string, (ctx: SceneContext) => Demo> = { multi, views, modifiers, subset, offline };
