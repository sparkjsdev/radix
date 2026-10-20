// Spark's splat-shader-effects: a turning cat with five effects (fractal
// colors, breathing, waves, disintegration, flares), Spark's GLSL rewritten
// in TSL. Each effect is its own modifier, made once: switching sets the
// renderer's modifier (object space) and compiles each only the first time.
import GUI from "lil-gui";
import * as THREE from "three";
import { CameraControls, SplatCollection, SplatRenderer, TSL, type SplatModifier, type SplatNode, type TslNode } from "@sparkjsdev/radix";
import { asset } from "../js/assets.js";
import { examplePage, windowRenderer } from "../js/page.js";
import { fileObject, loadSplatFile } from "../js/files.js";

const { abs, clamp, cos, dot, exp, float, fract, length, min, mix, sin, step, uniform, vec3, vec4 } = TSL;

const page = examplePage("splat-shader-effects");

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 1000);

// createRenderer, sized to the window and added to the page; it follows
// window resizes, the camera's aspect too (js/page.ts)
const renderer = await windowRenderer(camera);
const controls = new CameraControls({ canvas: renderer.domElement, object: camera });

const t = uniform(0);
const intensity = uniform(0.8);

const hash = (p: TslNode): TslNode => fract(sin(p.mul(123.456)).mul(123.456));

// (x, y) * mat2(c, -s, s, c) in GLSL's row-vector form
const rot = (x: TslNode, y: TslNode, a: TslNode): [TslNode, TslNode] => {
  const s = sin(a).toVar();
  const c = cos(a).toVar();
  return [c.mul(x).sub(s.mul(y)), s.mul(x).add(c.mul(y))];
};

// smoothstep for edges in either order
const smooth = (e0: number, e1: number, x: TslNode): TslNode => {
  const k = clamp(x.sub(e0).div(e1 - e0), 0, 1);
  return k.mul(k).mul(k.mul(-2).add(3));
};

const headMovement = (pos: TslNode): TslNode => {
  const [x, y] = rot(pos.x, pos.y, smooth(-1, -2, pos.y).mul(0.2).mul(sin(t.mul(2))));
  return vec3(x, y, pos.z);
};

const breathAnimation = (pos: TslNode): TslNode => {
  const b = sin(t.mul(1.5)).toVar();
  const [y, z] = rot(pos.y, pos.z, smooth(-1, -3, pos.y).mul(0.15).mul(b.negate()));
  const p = vec3(pos.x, y.add(1.2), z.add(0.3)).toVar();
  return p.mul(exp(length(p).mul(-3)).mul(b).add(1)).sub(vec3(0, 1.2, 0.3));
};

const fractal1 = (pos: TslNode): TslNode => {
  const m = float(100).toVar();
  const p = pos.mul(0.1).add(vec3(0, 0.5, 0)).toVar();
  for (let i = 0; i < 8; i += 1) {
    p.assign(abs(p).div(clamp(abs(p.x.mul(p.y)), 0.3, 3)).sub(1));
    // p.xy *= rot(radians(90)): (x, y) -> (-y, x)
    p.assign(vec3(p.y.negate(), p.x, p.z));
    if (i > 1) {
      m.assign(min(m, length(p.xy).add(step(0.3, fract(p.z.mul(0.5).add(t.mul(0.5)).add(i * 0.2))))));
    }
  }
  const glow = step(m, 0.5).mul(1.3).mul(intensity);
  return vec4(pos.y.mul(-0.3), 0.5, 0.7, 0.3).mul(intensity).add(glow);
};

const fractal2 = (center: TslNode, scales: TslNode, rgba: TslNode): TslNode => {
  const splatSize = length(scales).toVar();
  const p = center.mul(0.65).toVar();
  const posY = center.y.add(2).toVar();
  const c = float(0).toVar();
  const l2 = length(p).toVar();
  const m = float(100).toVar();
  for (let i = 0; i < 10; i += 1) {
    p.assign(abs(p).div(dot(p, p)).sub(0.8));
    const l = length(p).toVar();
    c.addAssign(exp(abs(l.sub(l2)).negate().mul(sin(t.mul(1.5).add(posY)).add(1))));
    l2.assign(l);
    m.assign(min(m, l));
  }
  const cc = smooth(0.3, 0.5, m.add(sin(t.mul(1.5).add(posY.mul(0.5))))).add(c.mul(0.1)).toVar();
  return vec4(vec3(length(rgba.xyz)).mul(vec3(cc, cc.mul(cc), cc.mul(cc).mul(cc))).mul(intensity), rgba.w.mul(exp(splatSize.mul(-20))).mul(m).mul(intensity));
};

const sin3D = (p: TslNode): TslNode => vec4(exp(length(sin(p.mul(5).add(t.mul(3)))).mul(-2)).mul(5)).add(0.3);

const disintegrate = (pos: TslNode): TslNode => {
  const p = pos.add(hash(pos).mul(2).sub(1).mul(intensity)).toVar();
  const tt = smooth(-1, 0.5, sin(t.sub(pos.y.mul(0.5))).negate()).toVar();
  const [x, z] = rot(p.x, p.z, tt.mul(2).add(p.y.mul(2).mul(tt)));
  return vec4(mix(vec3(x, p.y, z), pos, tt), tt);
};

const flare = (pos: TslNode): TslNode => {
  const k = smooth(-1, 0.5, sin(t.add(hash(pos).x))).toVar();
  const tt = k.mul(k).toVar();
  const p = vec3(sin(t.mul(2)).mul(tt), float(-1.5).add(sin(t).mul(tt)), sin(t.mul(2)).mul(tt));
  return vec4(mix(pos, p, tt), tt);
};

// One modifier per effect: apply(center, scales, rgba) returns the fields to set
function effect(apply: (pos: TslNode, scales: TslNode, rgba: TslNode) => Partial<Record<"center" | "scales" | "rgba", TslNode>>): SplatModifier {
  return (s: SplatNode) => {
    const out = s.toVar();
    const rgba = vec4(s.get("rgb"), s.get("opacity")).toVar();
    const result = apply(s.get("center").toVar(), s.get("scales"), rgba);
    for (const field of ["center", "scales"] as const) {
      if (result[field]) {
        out.get(field).assign(result[field]);
      }
    }
    if (result.rgba) {
      const color = result.rgba.toVar();
      out.get("rgb").assign(color.xyz);
      // Above 1 would read as a merged LoD splat and grow it (lodInflate)
      out.get("opacity").assign(clamp(color.w, 0, 1));
    }
    return out;
  };
}

const EFFECTS = {
  Electronic: effect((pos, scales, rgba) => ({ center: headMovement(pos), rgba: mix(rgba, rgba.mul(fractal1(pos)), intensity) })),
  "Deep Meditation": effect((pos, scales, rgba) => ({ rgba: mix(rgba, fractal2(pos, scales, rgba), intensity), center: breathAnimation(pos) })),
  Waves: effect((pos, scales, rgba) => {
    const e = sin3D(pos).toVar();
    return { rgba: mix(rgba, rgba.mul(e), intensity), center: pos.add(vec3(0, 1, 0)).mul(e.x.mul(0.05).mul(intensity).add(1)).sub(vec3(0, 1, 0)) };
  }),
  Flare: effect((pos, scales, rgba) => {
    const e = flare(pos).toVar();
    return { center: e.xyz, rgba: vec4(mix(rgba.xyz, vec3(1), abs(e.w)), mix(rgba.w, 0.3, abs(e.w))) };
  }),
  Disintegrate: effect((pos, scales) => {
    const e = disintegrate(pos).toVar();
    return { center: e.xyz, scales: mix(vec3(0.01), scales, e.w) };
  }),
};

const splats = new SplatRenderer({ renderer, modifier: EFFECTS.Disintegrate, modifierSpace: "object" });
scene.add(splats);

const gui = new GUI({ title: "Fractal Effects" });
gui.add({ effect: "Disintegrate" }, "effect", Object.keys(EFFECTS)).name("Effect Type")
  .onChange((name: keyof typeof EFFECTS) => (splats.modifier = EFFECTS[name]));
gui.add(intensity, "value", 0, 1, 0.01).name("Intensity");

const cat = new THREE.Object3D();
cat.scale.setScalar(0.5);
cat.position.set(0, -0.7, -2.5);
cat.rotation.x = Math.PI;
scene.add(cat);

const file = await loadSplatFile(renderer, asset("cat.spz"), { onProgress: page.progress("cat") });
splats.collection = new SplatCollection([fileObject(file, { matrixWorld: cat.matrixWorld })]);
page.ready(renderer);

renderer.setAnimationLoop((time) => {
  controls.update();
  t.value = time / 1000;
  cat.rotation.y = time / 2000;
  // The effects move splats by uniforms the CPU sort cannot see
  if (splats.sortMode === "cpu") {
    splats.requestSort();
  }
  renderer.render(scene, camera);
});
