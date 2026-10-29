// Color operations. Splat colors are sRGB-encoded values; above 1 is allowed
// (the ext encoding keeps HDR) and reads as glow.
import { TSL } from "@sparkjsdev/radix";
                                           
import { IQ_PALETTE, cosinePalette } from "./iq.js";

const { hue, max, min, mix, saturation, vec3 } = TSL;

const THREE_COLOR = { name: "three.js ColorAdjustment", url: "https://github.com/mrdoob/three.js/blob/dev/src/nodes/display/ColorAdjustment.js", license: "MIT" };

// Matt Zucker, "Simple polynomial approximations of matplotlib colormaps"
// (shadertoy WlfXRN, CC0): degree-6 fits, t in [0, 1]
const ZUCKER = { name: "Matt Zucker, polynomial matplotlib colormaps", url: "https://www.shadertoy.com/view/WlfXRN", license: "CC0" };
const COLORMAPS                             = {
  magma: [[-0.002136485053939582, -0.000749655052795221, -0.005386127855323933], [0.2516605407371642, 0.6775232436837668, 2.494026599312351], [8.353717279216625, -3.577719514958484, 0.3144679030132573], [-27.66873308576866, 14.26473078096533, -13.64921318813922], [52.17613981234068, -27.94360607168351, 12.94416944238394], [-50.76852536473588, 29.04658282127291, 4.23415299384598], [18.65570506591883, -11.48977351997711, -5.601961508734096]],
  inferno: [[0.0002189403691192265, 0.001651004631001012, -0.01948089843709184], [0.1065134194856116, 0.5639564367884091, 3.932712388889277], [11.60249308247187, -3.972853965665698, -15.9423941062914], [-41.70399613139459, 17.43639888205313, 44.35414519872813], [77.162935699427, -33.40235894210092, -81.80730925738993], [-71.31942824499214, 32.62606426397723, 73.20951985803202], [25.13112622477341, -12.24266895238567, -23.07032500287172]],
  plasma: [[0.05873234392399702, 0.02333670892565664, 0.5433401826748754], [2.176514634195958, 0.2383834171260182, 0.7539604599784036], [-2.689460476458034, -7.455851135738909, 3.110799939717086], [6.130348345893603, 42.3461881477227, -28.51885465332158], [-11.10743619062271, -82.66631109428045, 60.13984767418263], [10.02306557647065, 71.41361770095349, -54.07218655560067], [-3.658713842777788, -22.93153465461149, 18.19190778539828]],
  viridis: [[0.2777273272234177, 0.005407344544966578, 0.3340998053353061], [0.1050930431085774, 1.404613529898575, 1.384590162594685], [-0.3308618287255563, 0.214847559468213, 0.09509516302823659], [-4.634230498983486, -5.799100973351585, -19.33244095627987], [6.228269936347081, 14.17993336680509, 56.69055260068105], [4.776384997670288, -13.74514537774601, -65.35303263337234], [-5.435455855934631, 4.645852612178535, 26.3124352495832]],
};

export const colorNodes            = [
  {
    id: "color.colormap",
    label: "Colormap",
    description: "A perceptual color ramp for a 0..1 number (magma, inferno, plasma, viridis)",
    category: "color",
    inputs: { t: { type: "float", default: 0.5, min: 0, max: 1 } },
    options: { map: { default: "magma", choices: Object.keys(COLORMAPS) } },
    outputs: { value: "color" },
    source: ZUCKER,
    build: ({ t }, ctx) => {
      const c = COLORMAPS[String(ctx.option("map"))] ?? COLORMAPS.magma;
      const x = t.clamp(0, 1).toVar();
      let acc = vec3(...c[6]);
      for (let i = 5; i >= 0; i -= 1) {
        acc = vec3(...c[i]).add(x.mul(acc));
      }
      return { value: acc.max(0) };
    },
  },
  {
    id: "color.hsvAdjust",
    label: "Hue / saturation / value",
    description: "Turns the hue, scales saturation and brightness",
    category: "color",
    inputs: {
      rgb: { type: "color", default: [1, 1, 1] },
      hue: { type: "float", default: 0, min: -0.5, max: 0.5, label: "hue (turns)" },
      saturation: { type: "float", default: 1, min: 0, max: 3 },
      value: { type: "float", default: 1, min: 0, max: 4 },
    },
    outputs: { value: "color" },
    source: THREE_COLOR,
    build: ({ rgb, hue: turns, saturation: s, value }) => ({ value: saturation(hue(rgb, turns.mul(2 * Math.PI)), s).mul(value) }),
  },
  {
    id: "color.cosinePalette",
    label: "Cosine palette",
    description: "A smooth color ramp from a number (Inigo Quilez)",
    category: "color",
    inputs: {
      t: { type: "float", default: 0, min: 0, max: 1 },
      a: { type: "color", default: [0.5, 0.5, 0.5] },
      b: { type: "color", default: [0.5, 0.5, 0.5] },
      c: { type: "color", default: [1, 1, 1] },
      d: { type: "color", default: [0, 0.33, 0.67] },
    },
    outputs: { value: "color" },
    source: IQ_PALETTE,
    build: ({ t, a, b, c, d }) => ({ value: cosinePalette(t, a, b, c, d) }),
  },
  {
    id: "color.tint",
    label: "Tint",
    description: "Blends a color toward another (intensity above 1 glows)",
    category: "color",
    inputs: {
      rgb: { type: "color", default: [1, 1, 1] },
      color: { type: "color", default: [1, 0.5, 0.2] },
      intensity: { type: "float", default: 1, min: 0, max: 8 },
      amount: { type: "float", default: 1, min: 0, max: 1 },
    },
    // mix(rgb, color * intensity, amount)
    outputs: { value: "color" },
    build: ({ rgb, color, intensity, amount }) => ({ value: mix(rgb, color.mul(intensity), amount) }),
  },
  {
    id: "color.blend",
    label: "Blend",
    description: "Combines two colors like a paint layer (multiply, add, screen, …), faded in by amount",
    category: "color",
    inputs: {
      base: { type: "color", default: [1, 1, 1] },
      color: { type: "color", default: [1, 1, 1] },
      amount: { type: "float", default: 1, min: 0, max: 1 },
    },
    options: { mode: { default: "multiply", choices: ["multiply", "add", "screen", "darken", "lighten", "replace"] } },
    outputs: { value: "color" },
    build: ({ base, color, amount }, ctx) => {
      const mode = ctx.option("mode");
      const layer = mode === "add" ? base.add(color)
        : mode === "screen" ? vec3(1).sub(vec3(1).sub(base).mul(vec3(1).sub(color)))
        : mode === "darken" ? min(base, color)
        : mode === "lighten" ? max(base, color)
        : mode === "replace" ? color
        : base.mul(color);
      return { value: mix(base, layer, amount) };
    },
  },
];


//# sourceURL=examples/fxedit/fx/nodes/color.ts