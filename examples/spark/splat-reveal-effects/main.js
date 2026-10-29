// Spark's splat-reveal-effects: five reveal animations (Magic, Spread,
// Unroll, Twister, Rain), Spark's GLSL rewritten in TSL as one object-space
// modifier per effect, made once and switched on the renderer. Spark plays
// Twister and Rain on Sutro, a SOGS zip Radix cannot read: here they play
// on the valley scan.
import GUI from "lil-gui";
import * as THREE from "three";
import { GpuSplatMath, TSL,                                                  } from "@sparkjsdev/radix";
import { asset } from "../js/assets.js";
import { SplatSet,                 } from "../js/objects.js";
import { examplePage, windowRenderer } from "../js/page.js";

const { abs, atan, clamp, cos, exp, floor, fract, length, max, min, mix, pow, select, sin, smoothstep, step, uniform, vec2, vec3, vec4 } = TSL;

const page = examplePage("splat-reveal-effects");

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 1000);

// createRenderer, sized to the window and added to the page; it follows
// window resizes, the camera's aspect too (js/page.ts)
const renderer = await windowRenderer(camera);

// Seconds since the effect started
const animateT = uniform(0);

const hash = (q         )          => {
  const p = fract(q.mul(0.3183099).add(0.1)).mul(17).toVar();
  return fract(vec3(p.x.mul(p.y).mul(p.z), p.x.add(p.y.mul(p.z)), p.x.mul(p.y).add(p.z)));
};

const noise = (p         )          => {
  const i = floor(p).toVar();
  const f0 = fract(p);
  const f = f0.mul(f0).mul(f0.mul(-2).add(3)).toVar();
  const n = (x        , y        , z        ) => hash(i.add(vec3(x, y, z)));
  const x0 = mix(n(0, 0, 0), n(1, 0, 0), f.x);
  const x1 = mix(n(0, 1, 0), n(1, 1, 0), f.x);
  const x2 = mix(n(0, 0, 1), n(1, 0, 1), f.x);
  const x3 = mix(n(0, 1, 1), n(1, 1, 1), f.x);
  return mix(mix(x0, x1, f.y), mix(x2, x3, f.y), f.z);
};

// v * mat2(c, -s, s, c) in GLSL's row-vector form
const rot = (v         , a         )          => {
  const s = sin(a).toVar();
  const c = cos(a).toVar();
  return vec2(c.mul(v.x).sub(s.mul(v.y)), s.mul(v.x).add(c.mul(v.y)));
};

const spin = (quaternion         , angle         )          => GpuSplatMath.quatMul(vec4(0, sin(angle.mul(0.5)), 0, cos(angle.mul(0.5))), quaternion);

// The splat as Spark's GLSL names it (l: distance from the y axis), and the
// fields an effect sets
                                                                                          
                                                                                          

// One modifier per effect: apply(inputs) returns the fields to set
function effect(apply                                        )                {
  return (splat           ) => {
    const out = splat.toVar();
    const pos = splat.get("center").toVar();
    const rgba = vec4(splat.get("rgb"), splat.get("opacity")).toVar();
    const result = apply({ t: animateT, pos, scales: splat.get("scales"), rgba, quaternion: splat.get("quaternion"), l: length(pos.xz).toVar() });
    for (const field of ["center", "scales", "quaternion"]         ) {
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
  Magic: effect(({ t, pos, scales, rgba, l }) => {
    const s = smoothstep(0, 10, t.sub(4.5)).mul(10).toVar();
    const border = abs(s.sub(l).sub(0.5)).toVar();
    const p = pos.mul(exp(border.mul(-20)).mul(-0.2).add(1)).toVar();
    const edge = smoothstep(s.sub(0.5), s, l.add(0.5)).toVar();
    const at = atan(p.x, p.z).div(3.1416).toVar();
    const color = rgba.mul(step(at, t.sub(3.1416))).add(exp(border.mul(-20)).add(exp(abs(t.sub(at).sub(3.1416)).mul(-50)).mul(0.5)));
    return { center: p.add(noise(p.mul(2).add(t.mul(0.5))).mul(0.1).mul(edge)), scales: mix(scales, vec3(0.002), edge), rgba: color };
  }),
  Spread: effect(({ t, pos, scales, rgba, l }) => {
    const tt = t.mul(t).mul(0.4).add(0.5).toVar();
    const xz = pos.xz.mul(min(1, max(0, tt.mul(0.05)).add(0.3)));
    const grown = max(mix(vec3(0), scales, min(tt.sub(7).sub(l.mul(2.5)), 1)), mix(vec3(0), scales.mul(0.2), min(tt.sub(1).sub(l.mul(2)), 1)));
    // Spark lets this go negative; zero hides the splat until it grows
    return { center: vec3(xz.x, pos.y, xz.y), scales: max(grown, vec3(0)), rgba: mix(vec4(0.3), rgba, clamp(tt.sub(l.mul(2.5)).sub(3), 0, 1)) };
  }),
  Unroll: effect(({ t, pos, scales, rgba }) => {
    const xz = rot(pos.xz, pos.y.mul(50).sub(20).mul(exp(t.negate())));
    return {
      center: vec3(xz.x, pos.y, xz.y).mul(exp(t.negate()).mul(-2).add(1)),
      scales: mix(vec3(0.002), scales, smoothstep(0.3, 0.7, t.add(pos.y).sub(2))),
      rgba: rgba.mul(step(0, t.mul(0.5).add(pos.y).sub(0.5))),
    };
  }),
  Twister: effect(({ t, pos, scales, quaternion, l }) => {
    const h = hash(pos).toVar();
    const s = smoothstep(0, 8, t.mul(t).mul(0.1).sub(l.mul(2)).add(2)).toVar();
    const k = pow(s, h.x.mul(2)).toVar();
    const y = select(length(scales).lessThan(0.05), mix(-10, pos.y, k), pos.y).toVar();
    const xz = mix(pos.xz.mul(0.5), pos.xz, k).toVar();
    const turned = rot(xz, t.mul(s.oneMinus()).mul(0.2).add(y.mul(20).mul(s.oneMinus()).mul(exp(length(xz).negate()))));
    const w = s.mul(s).mul(s).mul(s).toVar();
    return { center: vec3(turned.x, y, turned.y), scales: mix(vec3(0.002), scales, pow(w, 12)), quaternion: spin(quaternion, t.mul(-0.3).mul(w.oneMinus())) };
  }),
  Rain: effect(({ t, pos, scales, quaternion, l }) => {
    const h = hash(pos).toVar();
    const s = pow(smoothstep(0, 5, t.mul(t).mul(0.1).sub(l.mul(2)).add(1)), h.x.add(0.5)).toVar();
    const y = min(s.mul(15).sub(10), pos.y).toVar();
    const xz = rot(mix(pos.xz.mul(0.3), pos.xz, s), t.mul(0.3));
    const w = smoothstep(-10, pos.y, y);
    return { center: vec3(xz.x, y, xz.y), scales: mix(vec3(0.005), scales, pow(w, 30)), quaternion: spin(quaternion, t.mul(-0.3)) };
  }),
};

                                       

const SCANS                                                                                          = {
  Magic: { file: "primerib-tamos.spz", position: [0, 0, 0], scale: 1 },
  Spread: { file: "valley.spz", position: [0, 1, 1], scale: 1 },
  Unroll: { file: "burger-from-amboy.spz", position: [0, 0, 0], scale: 1.5 },
  Twister: { file: "valley.spz", position: [0, -1, 1], scale: 0.8 },
  Rain: { file: "valley.spz", position: [0, -1, 1], scale: 0.8 },
};

const splats = new SplatSet({ renderer, scene, modifierSpace: "object", animate: true });
const params                         = { effect: "Magic" };
const scans = new Map                             ();

// The effect's scan, placed, with the effect from its start
async function show(effect            ) {
  splats.remove(...splats.models);
  const { file, position, scale } = SCANS[effect];
  if (!scans.has(file)) {
    scans.set(file, splats.load(asset(file), { onProgress: page.progress(file) }));
  }
  const model = await scans.get(file) ;
  // load adds the model to the set; a later switch shows its own
  if (effect !== params.effect) {
    splats.remove(model);
    return;
  }
  page.status("");
  model.rotation.set(Math.PI, 0, 0);
  model.position.set(...position);
  model.scale.setScalar(scale);
  splats.renderer.modifier = EFFECTS[effect];
  splats.add(model);
  animateT.value = 0;
}

const gui = new GUI();
gui.add(params, "effect", Object.keys(EFFECTS)).name("Effect Type").onChange(show);
gui.add({ resetTime: () => (animateT.value = 0) }, "resetTime").name("Reset Time");

await show(params.effect);
page.ready(renderer);

// The camera circles the scan, except in the weather effects
let cameraAngle = 0;
let last = 0;
renderer.setAnimationLoop((time) => {
  const delta = last ? Math.min((time - last) / 1000, 0.1) : 0;
  last = time;
  animateT.value += delta;
  const weather = params.effect === "Twister" || params.effect === "Rain";
  cameraAngle = weather ? 0 : cameraAngle + 0.2 * delta;
  camera.position.set(Math.cos(cameraAngle) * 3, 2, Math.sin(cameraAngle) * 3);
  camera.lookAt(0, params.effect === "Spread" ? 1 : 0, 0);
  renderer.render(scene, camera);
});


//# sourceURL=examples/spark/splat-reveal-effects/main.ts