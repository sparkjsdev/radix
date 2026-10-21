import type { WebGPURenderer } from "three/webgpu";
import { SortKeys, type SortKeyBits } from "../core/sort";
import { isWebGPUBackend } from "../gpu/backend";
import type { GpuArrays } from "../gpu/GpuArrays";
import { GpuArrayWriter } from "../gpu/GpuArrayWriter";
import { generatorContext, modifierContext, type AnySplatGenerator, type CovSplatModifier, type SplatModifier } from "../gpu/splatGenerator";
import type { CovSplatNode, SplatNode } from "../gpu/splats.tsl";
import type { TslNode } from "../gpu/tsl";
import { WgpuArrayWriter } from "../wgpu/WgpuArrayWriter";
import type { SplatForm, SplatNodeOf } from "./projection.tsl";
import type { ProjectionMethod } from "./projections.tsl";
import { SplatCamera } from "./splatCamera";
import { SplatCollection } from "./SplatCollection";
import { SplatParams, type SplatObjectParams, type SplatViewParams } from "./splatParams";
import { SplatProjection } from "./SplatProjection";
import { convertForm, setTransforms, transformForm, transforms, type ModifierSpace } from "./splatTransform.tsl";

// "keys" writes only the keys, for the CPU sort
export type ProjectPass = "full" | "keys";

export interface ProjectSettings {
  method: ProjectionMethod;
  sortBits: SortKeyBits;
  params: SplatViewParams;
  objectParams: SplatObjectParams;
  modifier?: SplatModifier;
  covModifier?: CovSplatModifier;
  modifierSpace: ModifierSpace;
}

type Writer = GpuArrayWriter | WgpuArrayWriter;

// By modifier, cov modifier and pass key
interface Programs {
  all: Set<Writer>;
  byModifier: WeakMap<object, WeakMap<object, Map<string, Writer>>>;
}

const NONE = {};
const cache = new WeakMap<object, Programs>();

/** The projection program cache every renderer shares. */
export class SplatProjector {
  /** The number of programs built. */
  static programs = 0;

  /** Frees a generator's programs, once no live collection holds it. */
  static dispose(generator: object) {
    const programs = cache.get(generator);
    if (programs) {
      programs.all.forEach((writer) => writer.dispose());
      cache.delete(generator);
    }
  }
}

interface ProgramKey {
  pass: ProjectPass;
  method: ProjectionMethod;
  eyes: number;
  modifier?: SplatModifier;
  covModifier?: CovSplatModifier;
  webgpu: boolean;
}

export function programOf(generator: AnySplatGenerator, key: ProgramKey): Writer {
  let programs = cache.get(generator);
  if (!programs) {
    programs = { all: new Set(), byModifier: new WeakMap() };
    cache.set(generator, programs);
  }
  let byCov = programs.byModifier.get(key.modifier ?? NONE);
  if (!byCov) {
    byCov = new WeakMap();
    programs.byModifier.set(key.modifier ?? NONE, byCov);
  }
  let byKey = byCov.get(key.covModifier ?? NONE);
  if (!byKey) {
    byKey = new Map();
    byCov.set(key.covModifier ?? NONE, byKey);
  }
  const name = key.pass === "keys" ? `keys:${key.webgpu}` : `${key.method}:${key.eyes}:${key.webgpu}`;
  let writer = byKey.get(name);
  if (!writer) {
    writer = build(generator, key);
    byKey.set(name, writer);
    programs.all.add(writer);
    SplatProjector.programs += 1;
  }
  return writer;
}

// For the camera SplatCamera.set last set. With cullKeys, splats culled in
// every eye get the invalid key, for the GPU sort's same-frame order.
export function projectCollection({ renderer, settings, collection, arrays, pass, cullKeys = false }: {
  renderer: WebGPURenderer;
  settings: ProjectSettings;
  collection: SplatCollection;
  arrays: GpuArrays;
  pass: ProjectPass;
  cullKeys?: boolean;
}) {
  const webgpu = isWebGPUBackend(renderer);
  if (webgpu && !arrays.hasStorage()) {
    throw new Error("SplatProjector: on WebGPU the output needs storage: true");
  }
  arrays.ensureCapacity(collection.count);
  arrays.count = 0;

  const { method, modifier, covModifier, modifierSpace } = settings;
  SplatParams.setView(settings.params);
  SplatProjection.setKeys(settings.sortBits, cullKeys);
  const modified = modifier !== undefined || covModifier !== undefined;
  const key = { pass, method, eyes: SplatCamera.eyes, modifier, covModifier, webgpu };

  for (const { object, offset } of collection.objects) {
    if (object.count <= 0) {
      continue;
    }
    setTransforms(SplatCollection.matrixWorldOf(object), modified ? modifierSpace : undefined);
    SplatParams.setObject(settings.objectParams, object.params);
    if (object.data !== undefined) {
      (object.generator.bind as ((data: unknown, context: typeof generatorContext.values) => void) | undefined)?.(object.data, generatorContext.values);
    }
    arrays.write(programOf(object.generator, key) as never, { at: offset, count: object.count });
  }
  arrays.count = collection.count;
}

export async function readSortKeys(arrays: GpuArrays, count = arrays.count): Promise<Uint32Array<ArrayBuffer>> {
  const data = await arrays.read({ bundles: ["sortKeys"], count });
  const bytes = data.bundles.sortKeys.channels.key.data as Uint8Array<ArrayBuffer>;
  return new Uint32Array(bytes.buffer, bytes.byteOffset, count);
}

// Picks each step's form once, converting only where the generator's differs.
// Splat to cov is cheap, cov to splat an eigen decomposition.
function build(generator: AnySplatGenerator, { pass, method, eyes, modifier, covModifier, webgpu }: ProgramKey): Writer {
  const projection = SplatProjection.get(method);
  const want: SplatForm | undefined = pass === "full" ? projection.input : undefined;
  const modified = modifier !== undefined || covModifier !== undefined;
  const modifierForm: SplatForm | undefined = modifier && covModifier ? undefined : modifier ? "splat" : covModifier ? "cov" : undefined;
  const wantFirst = modified ? (modifierForm ?? want) : want;
  const has = { splat: generator.generateSplat !== undefined, cov: generator.generateCovSplat !== undefined };
  const start: SplatForm = wantFirst && has[wantFirst] ? wantFirst : has.splat ? "splat" : "cov";

  const after = (form: SplatForm, next?: SplatForm): SplatForm => (form === "cov" || next === "cov" ? "cov" : "splat");
  let form = after(start, wantFirst);
  if (modified) {
    form = after(modifierForm ?? form, want);
  }
  const end = want ?? form;

  const splatOf = (index: TslNode) => {
    const context = generatorContext.nodes;
    let node: SplatNode | CovSplatNode = start === "splat" ? generator.generateSplat!(index, context) : generator.generateCovSplat!(index, context);
    let f: SplatForm = start;
    ({ node, form: f } = transformForm(node, f, transforms.a, wantFirst));
    if (modified) {
      const use = modifierForm ?? f;
      node = convertForm(node, f, use);
      node = use === "splat" ? modifier!(node as SplatNode, modifierContext.nodes) : covModifier!(node as CovSplatNode, modifierContext.nodes);
      ({ node, form: f } = transformForm(node, use, transforms.b, want));
    }
    return convertForm(node, f, end) as SplatNodeOf<SplatForm>;
  };

  if (pass === "keys") {
    const outputs = { sortKeys: SortKeys.KEYS };
    const write = SplatProjection.writeKeys(splatOf, end);
    const label = "radix_splatKeys";
    return webgpu ? new WgpuArrayWriter({ outputs, write, label }) : new GpuArrayWriter({ outputs, write, label });
  }
  const outputs = projection.outputs(eyes);
  const write = projection.write(splatOf as never, eyes);
  const label = `radix_project_${method}`;
  return webgpu ? new WgpuArrayWriter({ outputs, write, label }) : new GpuArrayWriter({ outputs, write, label });
}
