// The output node: writes the splat. Every input is optional; an absent input
// leaves that part of the splat as it was. Writes are plain statements on the
// splat var (a Fn whose result is unused is never built), in this order:
// center (set), offset (add), scale (multiply), size / sizeMix (blend toward
// a sphere), blur (add a size in quadrature, keeping total weight), rgb
// (set), alpha (set), opacity (multiply), keep (false: opacity 0, which the
// projection culls before the sort).
import { TSL,              } from "@sparkjsdev/radix";
                                                     

const { float, max, select, sqrt } = TSL;

const optional = (type          , value                             , min         , max         ) => ({ type, default: value, optional: true, min, max });

export const splatNodes            = [
  {
    id: "splat.write",
    label: "Splat output",
    description: "Writes the splat: move it, recolor it, fade, resize or remove it",
    category: "splat",
    inputs: {
      center: optional("vec3", [0, 0, 0], -1, 1),
      offset: optional("vec3", [0, 0, 0], -1, 1),
      scale: optional("float", 1, 0, 4),
      size: optional("float", 0.01, 0, 0.2),
      sizeMix: optional("float", 1, 0, 1),
      blur: optional("float", 0, 0, 0.2),
      rgb: optional("color", [1, 1, 1]),
      alpha: optional("float", 1, 0, 1),
      opacity: optional("float", 1, 0, 1),
      keep: optional("bool", true),
    },
    outputs: {},
    output: true,
    build: ({ center, offset, scale, size, sizeMix, blur, rgb, alpha, opacity, keep }, { splat }) => {
      if (center) {
        splat.get("center").assign(center);
      }
      if (offset) {
        splat.get("center").addAssign(offset);
      }
      if (scale) {
        splat.get("scales").mulAssign(max(scale, 0.0));
      }
      if (sizeMix) {
        // Blend toward a sphere of radius `size` in quadrature
        const m = sizeMix.clamp(0, 1).toVar();
        const keepOwn = float(1).sub(m).pow(2).toVar();
        const target = (size ?? float(0.01)).max(1e-6).mul(m).pow(2).toVar();
        const scales = splat.get("scales");
        scales.assign(sqrt(scales.mul(scales).mul(keepOwn).add(target)));
      }
      let fade                     ;
      if (blur) {
        // Convolve with an isotropic gaussian of std-dev `blur`: variances
        // add, and opacity keeps the footprint's total weight (the ratio of
        // determinants over the two largest axes, as a 2D projection sees)
        const b2 = max(blur, 0.0).pow(2).toVar();
        const variance = splat.get("scales").mul(splat.get("scales")).toVar();
        const ratio = variance.div(variance.add(b2).max(1e-12)).toVar();
        fade = sqrt(ratio.x.mul(ratio.y).mul(ratio.z).div(ratio.x.min(ratio.y).min(ratio.z).max(1e-8))).toVar();
        splat.get("scales").assign(sqrt(variance.add(b2)));
      }
      if (rgb) {
        splat.get("rgb").assign(rgb);
      }
      if (alpha) {
        splat.get("opacity").assign(alpha.clamp(0, 1));
      }
      if (opacity) {
        splat.get("opacity").mulAssign(opacity);
      }
      if (fade) {
        splat.get("opacity").mulAssign(fade);
      }
      if (keep) {
        splat.get("opacity").assign(select(keep, splat.get("opacity"), float(0)));
      }
      return {};
    },
  },
];


//# sourceURL=examples/fxedit/fx/nodes/splat.ts