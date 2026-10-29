// Transitions between two baked tables, splat for splat. Both tables are
// ordered the same way (sortWorker.ts: along a 3D Hilbert curve by default,
// so near samples pair with near samples) and drawn as pairs: draw slot j
// takes the sample at the same fraction of each table's visible order, so
// tables with different visible counts still pair everywhere (a sample
// shared by several slots shows in one of them at its end). Each pair
// travels a quadratic Bezier whose midpoint the style picks (straight,
// swirled, burst outward, through a sphere, through a spinning disk, over
// an arc), on its own clock (all at once, at random, swept bottom to top,
// rippling out from the center), blending size, shape, rotation and color,
// shrinking and glowing on the way if the style says so; "dissolve"
// switches each splat in place instead.
import type { WebGPURenderer } from "three/webgpu";
import { ArrayData, GpuArrayReader, GpuArrayWriter, GpuArrays, GpuSplats, SplatGenerator, TSL, defineBundle, type TslNode } from "@sparkjsdev/radix";
import { SAMPLES } from "./sample.js";
import { shadeSample, type LookUniforms } from "./shade.js";
import type { Pairing, SortRequest, SortResult } from "./sortWorker.js";

const { PI, atan, clamp, cos, dot, float, floor, fract, length, max, min, mix, normalize, select, sin, uint, uniform, unpackHalf2x16, uvec4, vec3, vec4 } = TSL;

export type { Pairing };

export interface TransitionStyle {
  // 0 straight, 1 swirl, 2 burst, 3 sphere, 4 disk, 5 arc, 6 dissolve
  path: number;
  // 0 together, 1 random, 2 bottom to top, 3 from the center out
  delay: number;
  // How much of the transition the delays spread over (0..0.9)
  spread: number;
  pairing: Pairing;
  // Size lost and glow gained halfway
  shrink: number;
  glow: number;
}

export const TRANSITIONS: Record<string, TransitionStyle> = {
  morph: { path: 0, delay: 1, spread: 0.15, pairing: "hilbert", shrink: 0, glow: 0 },
  swirl: { path: 1, delay: 3, spread: 0.35, pairing: "hilbert", shrink: 0.3, glow: 0.4 },
  burst: { path: 2, delay: 1, spread: 0.3, pairing: "hilbert", shrink: 0.5, glow: 0.5 },
  orb: { path: 3, delay: 1, spread: 0.25, pairing: "radial", shrink: 0.45, glow: 0.5 },
  galaxy: { path: 4, delay: 3, spread: 0.3, pairing: "spiral", shrink: 0.5, glow: 0.35 },
  fountain: { path: 5, delay: 2, spread: 0.5, pairing: "layers", shrink: 0.35, glow: 0.4 },
  stardust: { path: 0, delay: 1, spread: 0.35, pairing: "hilbert", shrink: 0.85, glow: 1 },
  swarm: { path: 0, delay: 1, spread: 0.3, pairing: "random", shrink: 0.4, glow: 0.5 },
  sweep: { path: 0, delay: 2, spread: 0.6, pairing: "layers", shrink: 0.1, glow: 0.3 },
  ripple: { path: 0, delay: 3, spread: 0.6, pairing: "radial", shrink: 0.2, glow: 0.4 },
  dissolve: { path: 6, delay: 1, spread: 0.85, pairing: "random", shrink: 0, glow: 0 },
};

// A table's order for transitions: its samples by pairing, visible first
export interface Ordered {
  order: GpuArrays;
  visible: number;
}

export interface MorphData {
  from: GpuArrays;
  to: GpuArrays;
  fromOrder: Ordered;
  toOrder: Ordered;
}

// Quantized positions (sortWorker.ts's codes), 4 per texel
const CODES = defineBundle({ code: "uint32" }, { packing: 4 });

// Orders tables: quantizes their positions on the GPU, reads the codes
// back and sorts them on a pool of workers (the least busy takes the next
// sort; the GPU half runs one table at a time, sorts overlap on the pool)
export class TableSorter {
  private readonly pool: { worker: Worker; busy: number }[];
  private readonly reader = new GpuArrayReader(SAMPLES);
  private readonly writer: GpuArrayWriter;
  private readonly renderer: WebGPURenderer;
  private codes: GpuArrays;
  private next = 0;
  private gpu: Promise<unknown> = Promise.resolve();
  private readonly waiting = new Map<number, (result: SortResult) => void>();

  constructor(renderer: WebGPURenderer, capacity: number, workers = 1) {
    this.pool = Array.from({ length: Math.max(1, workers) }, () => ({ worker: new Worker(new URL("./sortWorker.js", import.meta.url), { type: "module" }), busy: 0 }));
    this.renderer = renderer;
    this.codes = new GpuArrays({ renderer, bundles: { codes: CODES }, capacity });
    const reader = this.reader;
    this.writer = new GpuArrayWriter({
      outputs: { codes: CODES },
      write: (index, out) => {
        const code = (k: number) => {
          const i = uint(index).add(uint(k));
          const pos = reader.load("pos", i);
          const alpha = unpackHalf2x16(reader.load("extra", i).y).y;
          const q = uvec4(clamp(pos.add(2).mul(1023 / 4), 0, 1023)).toVar();
          return select(alpha.greaterThan(0.004), q.x.bitOr(q.y.shiftLeft(uint(10))).bitOr(q.z.shiftLeft(uint(20))), uint(0xffffffff));
        };
        out.codes.code.assign(uvec4(code(0), code(1), code(2), code(3)));
      },
    });
    for (const { worker } of this.pool) {
      worker.addEventListener("message", (event: MessageEvent<SortResult>) => {
        this.waiting.get(event.data.id)?.(event.data);
        this.waiting.delete(event.data.id);
      });
    }
  }

  // Sorts under way or waiting
  get busy() {
    return this.pool.reduce((sum, slot) => sum + slot.busy, 0);
  }

  private async readCodes(table: GpuArrays, count: number) {
    if (this.codes.capacity < count) {
      this.codes.dispose();
      this.codes = new GpuArrays({ renderer: this.renderer, bundles: { codes: CODES }, capacity: count });
    }
    this.reader.bind(table, "samples");
    this.codes.write(this.writer, { at: 0, count });
    const data = await this.codes.read({ start: 0, count });
    return (data.bundles.codes.channels.code.data as Uint32Array).slice(0, count);
  }

  async sort(table: GpuArrays, count: number, pairing: Pairing, into?: GpuArrays): Promise<Ordered> {
    const slot = this.pool.reduce((a, b) => (b.busy < a.busy ? b : a));
    slot.busy += 1;
    try {
      const read = this.gpu.then(() => this.readCodes(table, count));
      this.gpu = read.catch(() => undefined);
      const codes = await read;
      const id = (this.next += 1);
      const result = await new Promise<SortResult>((resolve) => {
        this.waiting.set(id, resolve);
        const request: SortRequest = { codes, pairing, id };
        slot.worker.postMessage(request, [codes.buffer]);
      });
      return { order: SplatGenerator.indices(this.renderer, result.order, into), visible: result.visible };
    } finally {
      slot.busy -= 1;
    }
  }

  dispose() {
    this.pool.forEach((slot) => slot.worker.terminate());
    this.codes.dispose();
  }
}

export function makeMorphUniforms() {
  return {
    // 0..1 over the whole transition
    t: uniform(0),
    count: uniform(1),
    fromVisible: uniform(0),
    toVisible: uniform(0),
    path: uniform(0, "int"),
    delay: uniform(0, "int"),
    spread: uniform(0),
    shrink: uniform(0),
    glow: uniform(0),
  };
}
export type MorphUniforms = ReturnType<typeof makeMorphUniforms>;

export function setStyle(m: MorphUniforms, style: TransitionStyle) {
  m.path.value = style.path;
  m.delay.value = style.delay;
  m.spread.value = style.spread;
  m.shrink.value = style.shrink;
  m.glow.value = style.glow;
}

const rotateY = (p: TslNode, a: TslNode) => vec3(p.x.mul(cos(a)).sub(p.z.mul(sin(a))), p.y, p.x.mul(sin(a)).add(p.z.mul(cos(a))));

export function morphGenerator(u: LookUniforms, m: MorphUniforms): SplatGenerator<MorphData> {
  const from = new GpuArrayReader(SAMPLES);
  const to = new GpuArrayReader(SAMPLES);
  const fromOrder = new GpuArrayReader(ArrayData.INDICES);
  const toOrder = new GpuArrayReader(ArrayData.INDICES);

  return {
    generateSplat: (index) => {
      const j = float(uint(index));
      // The slot's sample in each order, and whether this slot is the
      // first to hold it
      const slot = (visible: TslNode) => {
        const step = visible.div(max(m.count, 1));
        const at = floor(j.mul(step));
        return { at: uint(at), first: j.lessThan(0.5).or(floor(j.sub(1).mul(step)).notEqual(at)) };
      };
      const sa = slot(m.fromVisible);
      const sb = slot(m.toVisible);
      const a = shadeSample(u, from, fromOrder.load("index", sa.at), "from");
      const b = shadeSample(u, to, toOrder.load("index", sb.at), "to");
      const empty = m.fromVisible.lessThan(0.5);
      const pa = select(empty, b.center.mul(0.02), a.center).toVar();
      const pb = b.center.toVar();
      const alphaA = select(sa.first.and(empty.not()), a.opacity, float(0));
      const alphaB = select(sb.first, b.opacity, float(0));

      // This splat's clock
      const hash = fract(sin(j.mul(12.9898).add(78.233)).mul(43758.5453)).toVar();
      const where = mix(pa, pb, 0.5).toVar();
      const delays = [float(0), hash, clamp(where.y.add(1.2).div(2.4), 0, 1), clamp(length(where).div(1.5), 0, 1)];
      const delay = select(m.delay.equal(1), delays[1], select(m.delay.equal(2), delays[2], select(m.delay.equal(3), delays[3], delays[0])));
      const local = clamp(m.t.sub(delay.mul(m.spread)).div(float(1).sub(m.spread)), 0, 1);
      const e = local.mul(local).mul(float(3).sub(local.mul(2))).toVar();
      const arc = sin(e.mul(PI)).toVar();

      // The midpoint of the path
      const dir = normalize(vec3(fract(hash.mul(91.7)), fract(hash.mul(57.3)), fract(hash.mul(23.9))).sub(0.5).add(1e-4));
      const swirl = rotateY(where, float(2.4)).mul(1.15);
      const burst = where.add(normalize(where.add(dir.mul(0.4))).mul(0.9));
      const sphere = normalize(where.add(dir.mul(0.05))).mul(1.25);
      const angle = atan(where.z, where.x).add(2.2).add(hash.mul(0.4));
      const radius = length(where.xz).mul(1.3).add(0.15);
      const disk = vec3(cos(angle).mul(radius), where.y.mul(0.08), sin(angle).mul(radius));
      const fountain = where.add(vec3(0, 1.3, 0)).add(dir.mul(0.25));
      const middle = select(m.path.equal(1), swirl, select(m.path.equal(2), burst, select(m.path.equal(3), sphere,
        select(m.path.equal(4), disk, select(m.path.equal(5), fountain, where)))));
      const s = float(1).sub(e);
      const center = pa.mul(s.mul(s)).add(middle.mul(e.mul(s).mul(2))).add(pb.mul(e.mul(e)));

      const qb = b.quaternion.toVar();
      const qa = select(dot(a.quaternion, qb).lessThan(0), a.quaternion.negate(), a.quaternion);
      const quaternion = normalize(mix(qa, qb, e).add(vec4(0, 0, 0, 1e-5)));
      const scales = mix(select(empty, b.scales, a.scales), b.scales, e).mul(float(1).sub(m.shrink.mul(arc)));
      const rgb = mix(select(empty, b.rgb, a.rgb), b.rgb, e).mul(float(1).add(m.glow.mul(arc)));
      const opacity = mix(alphaA, alphaB, e);

      // Dissolve: each splat switches in place at its own moment
      const dissolve = m.path.equal(6);
      const before = local.lessThan(0.5);
      return GpuSplats.Splat(
        select(dissolve, select(before, pa, pb), center),
        select(dissolve, select(before, a.scales, b.scales), scales),
        select(dissolve, select(before, a.quaternion, b.quaternion), quaternion),
        select(dissolve, select(before, a.rgb, b.rgb), rgb),
        min(select(dissolve, select(before, alphaA.mul(float(1).sub(local.mul(2))), alphaB.mul(local.mul(2).sub(1))), opacity), 1),
        uint(index),
      );
    },
    bind: (data) => {
      from.bind(data.from, "samples");
      to.bind(data.to, "samples");
      fromOrder.bind(data.fromOrder.order, "indices");
      toOrder.bind(data.toOrder.order, "indices");
      m.fromVisible.value = data.fromOrder.visible;
      m.toVisible.value = data.toOrder.visible;
    },
  };
}
