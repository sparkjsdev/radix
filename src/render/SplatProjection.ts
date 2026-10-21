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

// Set per dispatch. Without cullKeys, only invisible splats and those outside
// sortGuard get the invalid key.
const sortBits = uniform(32, "uint");
const cullKeys = uniform(1, "uint");

export interface ProjectedSchema {
  [name: string]: BundleDef;
  projected: BundleDef;
  sortKeys: typeof SortKeys.KEYS;
}

export interface ProjectionOutputs {
  projected: Record<string, TslNode>;
  sortKeys: { key: TslNode };
}

export interface KeyOutputs {
  sortKeys: { key: TslNode };
}

// 4 components per channel, 2 in the last when 1 or 2 words remain
function wordChannels(words: number): number[] {
  const channels: number[] = [];
  for (let left = words; left > 0; left -= 4) {
    channels.push(left > 2 ? 4 : 2);
  }
  return channels;
}

// Always true when sortGuard is 0
const guarded = (prepared: PreparedSplat, head: SplatInView, params: SplatParamNodes) =>
  params.sortGuard.lessThanEqual(0.0).or(inSortGuard(prepared, head, params.sortGuard, params));

const instances = new Map<ProjectionMethod, SplatProjection>();

export class SplatProjection<F extends SplatForm = SplatForm> {
  static readonly METHODS: readonly ProjectionMethod[] = ["ewa", "3dgut", "htgs", "raygs"];

  readonly method: ProjectionMethod;
  readonly input: F;
  readonly headWords: number;
  readonly eyeWords: number;
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

  static get<M extends ProjectionMethod>(method: M): SplatProjection<ProjectionInputs[M]> {
    let projection = instances.get(method);
    if (!projection) {
      projection = new SplatProjection(method, PROJECTIONS[method] as ProjectionDef);
      instances.set(method, projection);
    }
    return projection as unknown as SplatProjection<ProjectionInputs[M]>;
  }

  words(eyes: number) {
    return this.headWords + this.eyeWords * eyes;
  }

  bundle(eyes: number): BundleDef {
    const channels: Record<string, ArrayFormat> = {};
    wordChannels(this.words(eyes)).forEach((components, c) => {
      channels[`w${c}`] = components === 4 ? "uint32x4" : "uint32x2";
    });
    return defineBundle(channels, { serialize: false });
  }

  outputs(eyes: number): ProjectedSchema {
    return { projected: this.bundle(eyes), sortKeys: SortKeys.KEYS };
  }

  reader(eyes: number): GpuArrayReader {
    return new GpuArrayReader(this.bundle(eyes));
  }

  loadWords(reader: GpuArrayReader, eyes: number, index: TslNode): TslNode[] {
    const words: TslNode[] = [];
    wordChannels(this.words(eyes)).forEach((components, c) => {
      const texel = reader.load(`w${c}`, index).toVar();
      words.push(...["x", "y", "z", "w"].slice(0, components).map((k) => texel[k]));
    });
    return words.slice(0, this.words(eyes));
  }

  project(splat: SplatNodeOf<F>, eyes: number) {
    const params = SplatParams.nodes;
    const prepared = prepareSplat(splat, this.input, params);
    const head = splatInView(prepared, headFrame(), params);
    const { words, visible } = this.def.project({ splat: prepared, head, eyes, params });
    return { words, visible, invisible: cullInvisible(prepared, params), guarded: guarded(prepared, head, params), distance: length(head.center) };
  }

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

  static setKeys(bits: number, cull: boolean) {
    sortBits.value = bits;
    cullKeys.value = cull ? 1 : 0;
  }

  // A key-only writer body for any method. Invisible splats and those outside
  // sortGuard get the invalid key.
  static writeKeys<F extends SplatForm>(splat: (index: TslNode) => SplatNodeOf<F>, form: F) {
    return (index: TslNode, out: KeyOutputs) => {
      const params = SplatParams.nodes;
      const prepared = prepareSplat(splat(index), form, params);
      const head = splatInView(prepared, headFrame(), params);
      const keyed = cullInvisible(prepared, params).not().and(guarded(prepared, head, params));
      out.sortKeys.key.assign(GpuSortKeys.pack(select(keyed, GpuSortKeys.compute(length(head.center), sortBits), GpuSortKeys.invalid(sortBits))));
    };
  }

  look(head: TslNode[], eye: TslNode[]): SplatLook {
    return this.def.look(head, eye);
  }

  // corner is in [-1, 1]^2
  vertex(head: TslNode[], eye: TslNode[], view: EyeNodes, corner: TslNode, boundStdDev: TslNode, cutoffStdDev: TslNode, out: TslNode) {
    this.def.vertex(head, eye, view, corner, boundStdDev, cutoffStdDev, out);
  }

  // Squared Mahalanobis distance at a fragment
  density(varyings: SplatVaryings): TslNode {
    return this.def.density(varyings);
  }
}
