// One projection method as an object: the words it writes per splat (head
// words, then each eye's, in uint32x4 channels w0, w1, ... with a uint32x2
// last one for 1 or 2 words), the TSL that projects one head-space splat
// node into them, the writer body that does it for every splat and writes
// its sort key, and the draw-side decoding of the words. Also the key-only
// writer the CPU sort reads (the same for every method).
import { defineBundle, type BundleDef } from "../core/bundles";
import type { ArrayFormat } from "../core/formats";
import { SortKeys } from "../core/sort";
import { GpuArrayReader } from "../gpu/GpuArrayReader";
import { GpuSortKeys } from "../gpu/sortKey.tsl";
import { TSL, type TslNode } from "../gpu/tsl";
import {
  cullInvisible, headFrame, inSortGuard, prepareSplat, splatInView, type PreparedSplat, type SplatForm, type SplatInView, type SplatNodeOf, type SplatVaryings,
} from "./projection.tsl";
import { PROJECTIONS, type ProjectionDef, type ProjectionInputs, type ProjectionMethod, type SplatLook } from "./projections.tsl";
import type { EyeNodes } from "./splatCamera";
import { SplatParams, type SplatParamNodes } from "./splatParams";

const { length, select, uint, uniform, uvec2, uvec4 } = TSL;

// The key width (16, 24 or 32), and whether splats culled in every eye get
// the invalid key (else only invisible ones and those outside
// params.sortGuard do): uniforms of every projection, set per dispatch
const sortBits = uniform(32, "uint");
const cullKeys = uniform(1, "uint");

// The bundles a projection writes: `projected` (its words) and `sortKeys`
export interface ProjectedSchema {
  [name: string]: BundleDef;
  projected: BundleDef;
  sortKeys: typeof SortKeys.KEYS;
}

// What a projection writer's write(index, out) fills
export interface ProjectionOutputs {
  projected: Record<string, TslNode>;
  sortKeys: { key: TslNode };
}

// The key-only writer's outputs
export interface KeyOutputs {
  sortKeys: { key: TslNode };
}

// Components of each word channel: uint32x4, and a uint32x2 last one when
// only 1 or 2 words remain
function wordChannels(words: number): number[] {
  const channels: number[] = [];
  for (let left = words; left > 0; left -= 4) {
    channels.push(left > 2 ? 4 : 2);
  }
  return channels;
}

// Inside params.sortGuard (always, when that is 0)
const guarded = (prepared: PreparedSplat, head: SplatInView, params: SplatParamNodes) =>
  params.sortGuard.lessThanEqual(0.0).or(inSortGuard(prepared, head, params.sortGuard, params));

const instances = new Map<ProjectionMethod, SplatProjection>();

export class SplatProjection<F extends SplatForm = SplatForm> {
  static readonly METHODS: readonly ProjectionMethod[] = ["ewa", "3dgut", "htgs", "raygs"];

  readonly method: ProjectionMethod;
  // The splat form project() takes: "cov" (ewa) or "splat"
  readonly input: F;
  readonly headWords: number;
  readonly eyeWords: number;
  // The varyings the draw's vertex stage fills and density() reads
  readonly varyings: readonly (keyof SplatVaryings)[];
  private def: ProjectionDef<F>;

  private constructor(method: ProjectionMethod, def: ProjectionDef<F>) {
    this.method = method;
    this.def = def;
    this.input = def.input;
    this.headWords = def.headWords;
    this.eyeWords = def.eyeWords;
    this.varyings = def.varyings;
  }

  // The projection of a method (one object per method)
  static get<M extends ProjectionMethod>(method: M): SplatProjection<ProjectionInputs[M]> {
    let projection = instances.get(method);
    if (!projection) {
      projection = new SplatProjection(method, PROJECTIONS[method] as ProjectionDef);
      instances.set(method, projection);
    }
    return projection as unknown as SplatProjection<ProjectionInputs[M]>;
  }

  // Words per splat for `eyes` eyes
  words(eyes: number) {
    return this.headWords + this.eyeWords * eyes;
  }

  // The `projected` bundle for `eyes`: channels w0, w1, ...
  bundle(eyes: number): BundleDef {
    const channels: Record<string, ArrayFormat> = {};
    wordChannels(this.words(eyes)).forEach((components, c) => {
      channels[`w${c}`] = components === 4 ? "uint32x4" : "uint32x2";
    });
    return defineBundle(channels, { serialize: false });
  }

  // What a projection writes: bundles `projected` and `sortKeys`
  outputs(eyes: number): ProjectedSchema {
    return { projected: this.bundle(eyes), sortKeys: SortKeys.KEYS };
  }

  // A reader of the projected bundle (bind it to arrays, bundle "projected")
  reader(eyes: number): GpuArrayReader {
    return new GpuArrayReader(this.bundle(eyes));
  }

  // All words of element `index`
  loadWords(reader: GpuArrayReader, eyes: number, index: TslNode): TslNode[] {
    const words: TslNode[] = [];
    wordChannels(this.words(eyes)).forEach((components, c) => {
      const texel = reader.load(`w${c}`, index).toVar();
      words.push(...["x", "y", "z", "w"].slice(0, components).map((k) => texel[k]));
    });
    return words.slice(0, this.words(eyes));
  }

  // The words of one head-space splat for the camera's eyes, whether any
  // eye shows it, whether it is invisible anyway (zero opacity or size),
  // whether it is inside params.sortGuard (always, when that is 0), and
  // its distance from the head (the sort distance)
  project(splat: SplatNodeOf<F>, eyes: number) {
    const params = SplatParams.nodes;
    const prepared = prepareSplat(splat, this.input, params);
    const head = splatInView(prepared, headFrame(), params);
    const { words, visible } = this.def.project({ splat: prepared, head, eyes, params });
    return { words, visible, invisible: cullInvisible(prepared, params), guarded: guarded(prepared, head, params), distance: length(head.center) };
  }

  // write(index, out) for a GpuArrayWriter / WgpuArrayWriter with outputs
  // outputs(eyes): projects head-space splat `splat(index)` and writes its key
  write(splat: (index: TslNode) => SplatNodeOf<F>, eyes: number) {
    return (index: TslNode, out: ProjectionOutputs) => {
      const { words, visible, invisible, guarded, distance } = this.project(splat(index), eyes);

      wordChannels(words.length).forEach((components, c) => {
        const w = (i: number) => words[c * 4 + i] ?? uint(0);
        out.projected[`w${c}`].assign(components === 4 ? uvec4(w(0), w(1), w(2), w(3)) : uvec2(w(0), w(1)));
      });

      const keyed = select(cullKeys.equal(uint(1)), visible, invisible.not().and(guarded));
      out.sortKeys.key.assign(GpuSortKeys.pack(select(keyed, GpuSortKeys.compute(distance, sortBits), GpuSortKeys.invalid(sortBits))));
    };
  }

  // The uniforms every projection reads: the key width, and whether keys
  // of splats culled in every eye are invalid
  static setKeys(bits: number, cull: boolean) {
    sortBits.value = bits;
    cullKeys.value = cull ? 1 : 0;
  }

  // write(index, out) for a writer with outputs { sortKeys: SortKeys.KEYS }:
  // only the key of head-space splat `splat(index)` of `form` (any method;
  // invisible splats and those outside params.sortGuard get the invalid one)
  static writeKeys<F extends SplatForm>(splat: (index: TslNode) => SplatNodeOf<F>, form: F) {
    return (index: TslNode, out: KeyOutputs) => {
      const params = SplatParams.nodes;
      const prepared = prepareSplat(splat(index), form, params);
      const head = splatInView(prepared, headFrame(), params);
      const keyed = cullInvisible(prepared, params).not().and(guarded(prepared, head, params));
      out.sortKeys.key.assign(GpuSortKeys.pack(select(keyed, GpuSortKeys.compute(length(head.center), sortBits), GpuSortKeys.invalid(sortBits))));
    };
  }

  // --- The draw's side ---

  // What one eye's draw decodes from the head words and that eye's
  look(head: TslNode[], eye: TslNode[]): SplatLook {
    return this.def.look(head, eye);
  }

  // Fills the draw's vertex struct `out` for a quad corner in [-1, 1]^2
  vertex(head: TslNode[], eye: TslNode[], view: EyeNodes, corner: TslNode, boundStdDev: TslNode, cutoffStdDev: TslNode, out: TslNode) {
    this.def.vertex(head, eye, view, corner, boundStdDev, cutoffStdDev, out);
  }

  // Squared Mahalanobis distance at a fragment
  density(varyings: SplatVaryings): TslNode {
    return this.def.density(varyings);
  }
}
