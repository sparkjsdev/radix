// World Labs threeviewer ("Looking Glass") effects, ported from the viewer's
// effects/*.glsl, lighting.glsl, pixelDepth.glsl and splatterPreFragment.glsl
// with the parameters its "Generating Worlds" blog demos use. The viewer
// runs some of these per quad vertex or per pixel; here they run once per
// splat at its center, which matches for the small splats of a scene.
//
// The viewer's world is y-down with the camera starting at the origin
// looking along +z. Nodes whose math depends on absolute position take an
// `origin` (where that viewer origin sits in this space, e.g. the start
// camera) and use p_wl = (p.x - o.x, o.y - p.y, o.z - p.z); offsets are
// turned back the same way.
import { TSL,              } from "@sparkjsdev/radix";
                                                                 

const { abs, clamp, cos, dot, exp, float, length, log2, max, min, mix, mod, normalize, radians, select, sin, smoothstep, vec3 } = TSL;

export const WORLD_LABS             = {
  name: "World Labs threeviewer effects (effects/*.glsl)",
  url: "wlt/apps/threeviewer/src/effects",
  license: "World Labs internal, ported with the author's permission",
};

const PI = Math.PI;
const f = (value        , min         , max         ) => ({ type: "float"            , default: value, min, max });
const v3 = (value          , min         , max         ) => ({ type: "vec3"            , default: value, min, max });
const position = { type: "vec3"            , default: [0, 0, 0] };
const origin = v3([0, 0, 3.2], -10, 10);

const toWorldLabs = (p         , o         ) => vec3(p.x.sub(o.x), o.y.sub(p.y), o.z.sub(p.z));
const fromWorldLabs = (d         ) => vec3(d.x, d.y.negate(), d.z.negate());

// colormaps.js: 32 sRGB colors per palette, base64 of 96 bytes
const PALETTE_DATA                         = {
  torch: "AAAAAgMFBAoVBBMnAxs7ASJTAyVvGSWMMSWYQyuYUzKVYTmScD+QfkSOjEmMm02JqlGFulWAyVl42V5v52Rk821Z+3lP/4lN/ptW+6xp+L2A9cya9Nq19OfQ9/Tp////",
  magma: "AAAEAwMSCggiEw00HhFJKhFcOBBsRRB3VBN9YBiAbR2BeSKCiCeBlCyAoTB+rjR7vTl3yj5y1kVs4k1m7Fhg82Vc+HRc+4Nf/ZRn/qNv/rJ6/sGF/tGU/eCh/O6w/P2/",
  ember: "AAAAAgIECAcPEwwaHxEkKxUtOBc0RRk6Uxo/YBpCbhlFfBdGixRFmQ9Dpws+tAo4vxIxyR8p0i0h2Twa3koT41gM6GUF63MC7oEB8Y4E8psM86kV9Lcf88Qp8tIz8eE+",
  ocean: "HABBIAtKIxZTJSBcJilkJzJsJztzJkR6JUx/JVWEJV2JJmaNKG6RK3aUL3+XNIebO4+eQpehS5+jVKemX6+pbLese76visS0msu7qtLCudjLyN/V1uff5O7p8vb0////",
  voltage: "AAAABAIDEAYNHQsYKg8kNhMwQxQ+UBVOXBNgaBB0cg6KehGgfxy0girFgzrUg0nggVnqfWfxeXb3dYT8cZL+bp/+cKz8d7f5hMH1lcvxp9Pwudzwy+Tx3e317vb5////",
  sunburst: "AAAABAIEDwYOHQsYKhAhOBMoRhUuVRYyYxY0chY1gRU0kBIxnw8trQ4nuxIexh4Tzi8J1EIH2FMP22Mb3XMq3oI535BJ4J5a4Kxt4LqA4MeV4tOr5t/B6+rY9PXt////",
};
const PALETTES = Object.fromEntries(Object.entries(PALETTE_DATA).map(([name, data]) => {
  const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
  return [name, Array.from({ length: 32 }, (_, i) => [bytes[i * 3] / 255, bytes[i * 3 + 1] / 255, bytes[i * 3 + 2] / 255])];
}));
const PALETTE_CHOICES = Object.keys(PALETTES).flatMap((name) => [name, `${name}_reverse`]);

// color.glsl sampleDepthPalette: linear between the 32 entries, as a sum of
// hat weights (no dynamic array indexing)
function samplePalette(name        , t         ) {
  const reverse = name.endsWith("_reverse");
  const colors = PALETTES[reverse ? name.slice(0, -"_reverse".length) : name] ?? PALETTES.torch;
  const ordered = reverse ? [...colors].reverse() : colors;
  const x = clamp(t, 0.0, 1.0).mul(31).toVar();
  let sum          = vec3(0);
  ordered.forEach((c, k) => {
    sum = sum.add(vec3(...c).mul(max(float(0), float(1).sub(abs(x.sub(k))))));
  });
  return sum;
}

// newEffects.glsl colorWave(rgba, p, t)
function colorWave(rgb         , alpha         , p         , t         ) {
  const len = length(p).toVar();
  const magnitude = sin(len.add(t).add(p.x.mul(1.7)).add(p.z.mul(2.3)))
    .mul(sin(len.mul(1.3).sub(t).add(p.y)))
    .mul(exp(len.mul(len).mul(-0.01))).toVar();
  const color = abs(p.div(max(len, 1e-6)));
  const k = float(1).sub(float(1).sub(magnitude).pow(2)).toVar();
  return { rgb: mix(rgb, color, k), alpha: mix(alpha, alpha.mul(magnitude), k) };
}

export const worldLabsNodes            = [
  {
    id: "wl.depthColor",
    label: "Depth color",
    description: "The viewer's depth view: view depth on a log scale between near and far, through a 32-color palette",
    category: "effect",
    inputs: {
      position,
      cameraPosition: v3([0, 0, 3]),
      cameraForward: v3([0, 0, -1]),
      near: f(0.6, 0.01, 10),
      far: f(25, 0.1, 100),
      reverse: { type: "bool", default: false },
    },
    options: { palette: { default: "torch_reverse", choices: PALETTE_CHOICES } },
    outputs: { value: "color", t: "float" },
    source: WORLD_LABS,
    build: ({ position: p, cameraPosition, cameraForward, near, far, reverse }, ctx) => {
      // pixelDepth.glsl getDepthColor (depth = view depth, as getDepth(ndc.z))
      const depth = max(dot(p.sub(cameraPosition), normalize(cameraForward)), 0.0);
      const t = log2(depth.add(1)).sub(log2(near.add(1))).div(log2(far.add(1)).sub(log2(near.add(1)))).toVar();
      const u = select(reverse, float(1).sub(t), t).toVar();
      return { value: samplePalette(String(ctx.option("palette")), u), t: u };
    },
  },
  {
    id: "wl.focusBlur",
    label: "Focus blur",
    description: "The viewer's depth of field: a blur circle of diameter * |depth - focus| / depth pixels, as a world size",
    category: "effect",
    inputs: {
      position,
      cameraPosition: v3([0, 0, 3]),
      cameraForward: v3([0, 0, -1]),
      pixelSize: f(0.0015, 0, 0.01),
      focus: f(4, 0.1, 20),
      diameter: f(10, 0, 50),
    },
    // blur: world std-dev to add (splat.write blur); pixels: its radius on screen
    outputs: { blur: "float", pixels: "float" },
    source: WORLD_LABS,
    build: ({ position: p, cameraPosition, cameraForward, pixelSize, focus, diameter }) => {
      // splatterPreFragment.glsl: focusRadius = 0.5 * focalDiameter * |depth - focalDistance| / depth (px, <= 512)
      const depth = dot(p.sub(cameraPosition), normalize(cameraForward)).toVar();
      const pixels = select(depth.greaterThan(0), min(diameter.mul(0.5).mul(abs(depth.sub(focus)).div(depth)), 512.0), float(512)).toVar();
      return { blur: pixels.mul(max(depth, 0.0)).mul(pixelSize), pixels };
    },
  },
  {
    id: "wl.dollyZoom",
    label: "Dolly zoom",
    description: "The blog's dolly zoom: the camera moves in while the field of view widens so the subject keeps its size (as a warp of the splats)",
    category: "effect",
    inputs: {
      position,
      cameraPosition: v3([0, 0, 3]),
      cameraForward: v3([0, 0, -1]),
      subject: v3([0, 0, 0], -5, 5),
      dolly: f(1.5, 1, 2.5),
      minZ: f(1, -1, 5),
      subjectZ: f(4, 0, 10),
    },
    outputs: { value: "vec3", keep: "bool" },
    source: WORLD_LABS,
    build: ({ position: p, cameraPosition, cameraForward, subject, dolly, minZ, subjectZ }) => {
      // Camera at z = dolly with fov 2 atan((subjectZ - minZ) / (subjectZ - dolly) tan 45deg): relative to
      // the camera at minZ, a move in of (dolly - minZ) and focal (zf - move) / zf, zf the subject distance
      const forward = normalize(cameraForward).toVar();
      const zf = max(dot(subject.sub(cameraPosition), forward), 1e-3).toVar();
      const move = dolly.sub(minZ).div(max(subjectZ.sub(minZ), 1e-3)).mul(zf).toVar();
      const v = p.sub(cameraPosition).toVar();
      const z = dot(v, forward).toVar();
      const lateral = v.sub(forward.mul(z));
      const squeeze = z.mul(zf.sub(move)).div(max(z.sub(move), 1e-4).mul(zf));
      return { value: cameraPosition.add(forward.mul(z)).add(lateral.mul(squeeze)), keep: z.sub(move).greaterThan(0.02) };
    },
  },
  {
    id: "wl.ripple",
    label: "Ripple",
    description: "The viewer's click ripple: a decaying radial wave from the click that also brightens the crests",
    category: "effect",
    inputs: {
      position,
      rgb: { type: "color", default: [1, 1, 1] },
      center: v3([0, 0, 0]),
      age: f(10, 0, 10),
      scale: f(3, 0.1, 20),
      duration: f(3, 0.1, 10),
      outward: { type: "bool", default: false },
      // Scales the viewer's wave (1: as in the viewer)
      amplitude: f(1, 0, 2),
    },
    outputs: { offset: "vec3", rgb: "color" },
    source: WORLD_LABS,
    build: ({ position: p, rgb, center, age, scale, duration, outward, amplitude }) => {
      // ripple.glsl with RIPPLE_DECAY 15, AMPLITUDE 0.001, LENGTH 0.1, SPEED 0.4, EPSILON 0.001; dir = !outward
      const s = age.div(duration).toVar();
      const delta = p.sub(center).toVar();
      const r = length(delta).toVar();
      const x = r.div(scale).toVar();
      const inward = outward.not();
      const disperse = float(0.001).div(x.mul(x).add(0.001));
      const decay = exp(float(-15).mul(select(inward, float(0.5), float(1))).mul(s));
      const offset = s.mul(0.4).add(select(inward, x.negate(), x));
      const value = select(s.greaterThanEqual(0).and(s.lessThanEqual(1)), disperse.mul(decay).mul(sin(offset.mul(2 * PI).div(0.1))), float(0)).mul(amplitude).toVar();
      return { offset: delta.div(max(r, 1e-6)).mul(value), rgb: clamp(rgb.add(value.mul(10)), 0.0, 1.0) };
    },
  },
  {
    id: "wl.sonar",
    label: "Sonar",
    description: "The viewer's sonar: a gaussian pulse around the click and a ring wave running out at 3 units/s, lighting splats green",
    category: "effect",
    inputs: { position, rgb: { type: "color", default: [1, 1, 1] }, center: v3([0, 0, 0]), age: f(10, 0, 10), duration: f(1, 0.1, 10) },
    outputs: { rgb: "color", intensity: "float" },
    source: WORLD_LABS,
    build: ({ position: p, rgb, center, age, duration }) => {
      // sonar.glsl sonarPulse(s, pos, center, 1) and gaussianPulse
      const s = age.div(duration).toVar();
      const waveCycle = 2.0;
      const wavePeriod = 0.15;
      const toCenter = length(p.sub(center)).toVar();
      const timeToCenter = toCenter.div(3.0).toVar();
      const timeInEffect = max(s.sub(timeToCenter), 0.0);
      const amplitude = float(1).div(max(toCenter.div(5.0), 1.0));
      const within = mod(timeInEffect, waveCycle).toVar();
      const wave = select(within.lessThan(wavePeriod), max(amplitude.mul(sin(within.mul(2 * PI / wavePeriod))), 0.0), float(0));
      // gaussianPulse(timeToCenter, s, 4 * period, 2.5 * period)
      const maxTime = 4 * wavePeriod;
      const maxRadius = 2.5 * wavePeriod;
      const minRadius = maxRadius / 4;
      const tn = s.div(maxTime).toVar();
      const radius = select(tn.lessThan(0.5), mix(float(minRadius), float(maxRadius), tn.mul(2)), mix(float(maxRadius), float(minRadius), tn.sub(0.5).mul(2))).toVar();
      const gaussian = exp(timeToCenter.div(radius).div(0.1).pow(2).mul(-0.5));
      const pulseValue = gaussian.div(radius.mul(Math.sqrt(2 * PI) * 0.1));
      const pulse = select(s.greaterThan(maxTime).or(timeToCenter.greaterThan(radius)), float(0), pulseValue);
      const intensity = select(s.greaterThan(waveCycle), float(0), max(wave, pulse)).toVar();
      return { rgb: mix(rgb, vec3(1, 4, 1), intensity), intensity };
    },
  },
  {
    id: "wl.spotlight",
    label: "Spotlight",
    description: "The viewer's spotlight: a smooth cone from a lamp toward a target, falling off with distance squared, over a 0.25 floor",
    category: "effect",
    inputs: {
      position,
      rgb: { type: "color", default: [1, 1, 1] },
      lamp: v3([0, 6, -2], -10, 10),
      target: v3([0, 0, -2], -10, 10),
      fov: f(80, 1, 179),
      smooth: f(10, 0, 90),
      brightness: f(25, 0, 100),
      attenuation: f(0.5, 0.01, 10),
    },
    outputs: { rgb: "color", light: "float" },
    source: WORLD_LABS,
    build: ({ position: p, rgb, lamp, target, fov, smooth, brightness, attenuation }) => {
      // lighting.glsl computeSpotlight (effects.js passes s[2] = 25 as brightness, s[3] = 0.5 as attenuation)
      const toPoint = p.sub(lamp).toVar();
      const distance = length(toPoint).toVar();
      const cosAngle = dot(toPoint.div(max(distance, 1e-6)), normalize(target.sub(lamp)));
      const outer = radians(fov.mul(0.5)).toVar();
      const intensity = smoothstep(cos(outer), cos(outer.sub(radians(smooth))), cosAngle).mul(brightness.div(attenuation.mul(distance).mul(distance)));
      const light = intensity.add(0.25).toVar();
      return { rgb: rgb.mul(light), light };
    },
  },
  {
    id: "wl.colorWave",
    label: "Color wave",
    description: "The viewer's color wave: interfering radial waves from the viewer's origin recolor splats by direction and nudge them",
    category: "effect",
    inputs: { position, rgb: { type: "color", default: [1, 1, 1] }, opacity: f(1, 0, 1), time: f(0), origin },
    outputs: { rgb: "color", alpha: "float", offset: "vec3" },
    source: WORLD_LABS,
    build: ({ position: p, rgb, opacity, time, origin: o }) => {
      // pixelWorld: rgba = mix(rgba, colorWave(rgba, p, s), blend); vertexWorld (same inputs):
      // worldVertex += 0.02 * displace.xyz * (1 - displace.w)
      const wave = colorWave(rgb, opacity, toWorldLabs(p, o), time);
      const rgbOut = wave.rgb.toVar();
      const alpha = wave.alpha.toVar();
      return { rgb: rgbOut, alpha, offset: fromWorldLabs(rgbOut.mul(float(1).sub(alpha)).mul(0.02)) };
    },
  },
  {
    id: "wl.rustle",
    label: "Rustle",
    description: "The viewer's rustle: the color wave's field used only to nudge splats, like leaves in wind",
    category: "effect",
    inputs: { position, rgb: { type: "color", default: [1, 1, 1] }, opacity: f(1, 0, 1), time: f(0), origin },
    outputs: { offset: "vec3" },
    source: WORLD_LABS,
    build: ({ position: p, rgb, opacity, time, origin: o }) => {
      // vertexWorld: worldVertex += 0.02 * displace.xyz * displace.w
      const displace = colorWave(rgb, opacity, toWorldLabs(p, o), time);
      return { offset: fromWorldLabs(displace.rgb.mul(displace.alpha).mul(0.02)) };
    },
  },
  {
    id: "wl.waves",
    label: "Waves",
    description: "The viewer's waves: height += amplitude sin(dot(p, dir) - t), a plane wave rolling along a direction",
    category: "effect",
    inputs: { position, time: f(0), origin, direction: v3([-1, 0, 5], -10, 10), amplitude: f(0.3, 0, 2) },
    outputs: { offset: "vec3" },
    source: WORLD_LABS,
    build: ({ position: p, time, origin: o, direction, amplitude }) => {
      // newEffects.glsl waves (dir normalized in effects.js)
      const q = toWorldLabs(p, o);
      const a = amplitude.mul(sin(dot(q, normalize(direction)).sub(time)));
      return { offset: fromWorldLabs(vec3(0, a, 0)) };
    },
  },
];


//# sourceURL=examples/fxedit/fx/nodes/worldlabs.ts