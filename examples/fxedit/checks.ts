// GPU checks: one known splat through a graph in a fragment pass, so on both backends
import type { WebGPURenderer } from "three/webgpu";
import { GpuArrays, GpuArrayWriter, GpuSplats, Splats, TSL, type Splat } from "@sparkjsdev/radix";
import { buildGraphModifier, type Graph } from "./fx/index.js";

const { float, uint, vec3, vec4 } = TSL;

const SOURCE = { center: [0.1, 0.2, 0.3], scales: [0.02, 0.03, 0.04], rgb: [0.5, 0.25, 0.75], opacity: 0.8 };
const SENTINEL = 0xdeadbeef;

// SOURCE through graph, or undefined if the pass did not run
export async function runGraph(renderer: WebGPURenderer, graph: Graph): Promise<Splat | undefined> {
  const { modifier } = buildGraphModifier(graph);
  const init = Splats.make(1);
  init.bundles.extSplats.channels.extA.data.fill(SENTINEL);
  init.bundles.extSplats.channels.extB.data.fill(SENTINEL);
  const arrays = GpuArrays.fromData(renderer, init);
  const writer = new GpuArrayWriter({
    outputs: { extSplats: Splats.EXT },
    write: (_, out) => {
      const splat = GpuSplats.Splat(vec3(...SOURCE.center), vec3(...SOURCE.scales), vec4(0, 0, 0, 1), vec3(...SOURCE.rgb), float(SOURCE.opacity), uint(7));
      GpuSplats.storeExt(out.extSplats, modifier(splat));
    },
  });
  try {
    arrays.write(writer, { at: 0, count: 1 });
    const data = await arrays.read({ count: 1 });
    const { extA, extB } = data.bundles.extSplats.channels;
    if ([...extA.data.slice(0, 4), ...extB.data.slice(0, 4)].every((word) => word === SENTINEL)) {
      return undefined;
    }
    return Splats.load(Splats.get(data).bundle, 0, Splats.makeSplat());
  } finally {
    writer.dispose();
    arrays.dispose();
  }
}

export const finite = (s: Splat) => [s.center.x, s.center.y, s.center.z, s.scales.x, s.scales.y, s.scales.z, s.rgb.r, s.rgb.g, s.rgb.b, s.opacity].every(Number.isFinite);
const near = (a: number, b: number, tolerance: number) => Math.abs(a - b) <= tolerance;

// Graphs with known results
export const VALUE_CHECKS: [string, Graph, (s: Splat) => string | undefined][] = [
  ["pass-through (no writes)", {
    version: 1, nodes: { out: { type: "splat.write" } }, links: [],
  }, (s) => (near(s.center.x, 0.1, 1e-5) && near(s.rgb.b, 0.75, 0.01) && near(s.opacity, 0.8, 0.01) ? undefined : "splat changed")],
  ["offset from input.vec3", {
    version: 1, nodes: { v: { type: "input.vec3", inputs: { value: [0.5, 0, -0.25] } }, out: { type: "splat.write" } },
    links: [{ from: "v.value", to: "out.offset" }],
  }, (s) => (near(s.center.x, 0.6, 1e-5) && near(s.center.z, 0.05, 1e-5) ? undefined : `center ${s.center.x}, ${s.center.y}, ${s.center.z}`)],
  // splat.write moves the center before it writes rgb: rgb must still see the old center
  ["reads see the splat before writes", {
    version: 1, nodes: { c: { type: "input.center" }, out: { type: "splat.write" } },
    links: [{ from: "c.value", to: "out.offset" }, { from: "c.value", to: "out.rgb" }],
  }, (s) => (near(s.center.y, 0.4, 1e-5) && near(s.rgb.g, 0.2, 0.01) ? undefined : `center y ${s.center.y}, rgb g ${s.rgb.g}`)],
  ["tint", {
    version: 1,
    nodes: { rgb: { type: "input.rgb" }, tint: { type: "color.tint", inputs: { color: [0, 1, 0], amount: 0.5 } }, out: { type: "splat.write" } },
    links: [{ from: "rgb.value", to: "tint.rgb" }, { from: "tint.value", to: "out.rgb" }],
  }, (s) => (near(s.rgb.r, 0.25, 0.01) && near(s.rgb.g, 0.625, 0.01) ? undefined : `rgb ${s.rgb.r}, ${s.rgb.g}, ${s.rgb.b}`)],
  ["opacity scale from input.float", {
    version: 1, nodes: { f: { type: "input.float", inputs: { value: 0.5 } }, out: { type: "splat.write" } },
    links: [{ from: "f.value", to: "out.opacity" }],
  }, (s) => (near(s.opacity, 0.4, 0.01) ? undefined : `opacity ${s.opacity}`)],
  ["scale", {
    version: 1, nodes: { out: { type: "splat.write", inputs: { scale: 2 } } }, links: [],
  }, (s) => (near(s.scales.z, 0.08, 0.002) ? undefined : `scale z ${s.scales.z}`)],
  ["keep false hides the splat", {
    version: 1, nodes: { out: { type: "splat.write", inputs: { keep: false } } }, links: [],
  }, (s) => (s.opacity === 0 ? undefined : `opacity ${s.opacity}`)],
];
