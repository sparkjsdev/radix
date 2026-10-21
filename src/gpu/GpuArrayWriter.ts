import * as THREE from "three";
import { Node, NodeMaterial, OutputStructNode, type NodeBuilder, type StackNode } from "three/webgpu";
import type { Schema } from "../core/bundles";
import { ArrayFormats, type ArrayFormat } from "../core/formats";
import { TextureLayout } from "../core/layout";
import { isWebGPUBackend } from "./backend";
import type { GpuArrays } from "./GpuArrays";
import { gpuFormatInfo } from "./gpuFormats";
import { TSL, type TslNode } from "./tsl";

const { Discard, If, float, int, ivec4, mix, positionGeometry, uint, uniform, uvec2, uvec4, vec4 } = TSL;

// The WebGL2 baseline's 4 draw buffers and WebGPU's 64 bytes per sample
const MAX_WRITER_CHANNELS = 4;
const MAX_WRITER_BYTES = 64;

/** A TSL var per output channel. */
export type WriterOutputs<O extends Schema> = { [B in keyof O]: { [C in keyof O[B]["channels"]]: TslNode } };

/** The elements a writer writes. */
export interface WriteRange {
  /**
   * The first element, a multiple of the packing.
   *
   * @default 0
   */
  at?: number;
  /** The elements to write, rounded up to a multiple of the packing. */
  count: number;
  /**
   * The index write() gets for element at.
   *
   * @default 0
   */
  first?: number;
}

/** An output channel of a writer. */
export interface WriterOutput {
  bundle: string;
  channel: string;
  texelFormat: ArrayFormat;
}

/** A writer GpuArrays.write runs, a fragment GpuArrayWriter or a compute WgpuArrayWriter. */
export interface ArrayWriter<O extends Schema = Schema, Storage extends boolean = boolean> {
  readonly outputs: O;
  /** The elements per texel. */
  readonly packing: number;
  /** The channels in output order. */
  readonly channels: WriterOutput[];
  /** Whether it writes from compute, into storage arrays. */
  readonly storage: Storage;
  /**
   * Runs items of writers of this kind. It is one function per kind, so
   * writeBatch groups by it.
   */
  readonly run: (arrays: GpuArrays, items: WriteItem[]) => void;
}

/** A range and its writer. */
export interface WriteItem extends WriteRange {
  writer: ArrayWriter;
}

export function writerChannels(outputs: Schema): { channels: WriterOutput[]; packing: number } {
  const channels: WriterOutput[] = [];
  const packings = new Set<number>();
  for (const [bundle, def] of Object.entries(outputs)) {
    packings.add(def.packing);
    for (const [channel, format] of Object.entries(def.channels)) {
      const { scalar, components } = ArrayFormats.info(format);
      channels.push({ bundle, channel, texelFormat: ArrayFormats.make(scalar, components * def.packing) });
    }
  }
  if (channels.length === 0) {
    throw new Error("Writer has no output channels");
  }
  if (packings.size > 1) {
    throw new Error("Writer outputs must share one packing");
  }
  return { channels, packing: [...packings][0] };
}

// Zeroed, as write(index, out) receives them
export function writerVars(channels: WriterOutput[]) {
  const out: Record<string, Record<string, TslNode>> = {};
  const vars = channels.map(({ bundle, channel, texelFormat }) => {
    const value = TSL[gpuFormatInfo(texelFormat).node as keyof typeof TSL](0).toVar(`out_${bundle}_${channel}`);
    (out[bundle] ??= {})[channel] = value;
    return value;
  });
  return { out, vars };
}

// Validates an item, returning its range in texels
export function writeItemTexels(arrays: GpuArrays, item: WriteItem) {
  const { writer } = item;
  const at = item.at ?? 0;
  if (at % writer.packing !== 0) {
    throw new Error(`Write at ${at} is not a multiple of the packing ${writer.packing}`);
  }
  for (const { bundle, channel, texelFormat } of writer.channels) {
    if (arrays.bundle(bundle).channels[channel]?.texelFormat !== texelFormat) {
      throw new Error(`Writer output ${bundle}.${channel} does not match the arrays`);
    }
  }
  if (at + item.count > arrays.capacity) {
    throw new Error(`Write of ${item.count} elements at ${at} exceeds capacity ${arrays.capacity}`);
  }
  return { start: at / writer.packing, end: Math.ceil((at + item.count) / writer.packing) };
}

export function countWrites(arrays: GpuArrays, items: WriteItem[]) {
  for (const item of items) {
    if (item.count > 0) {
      arrays.count = Math.max(arrays.count, Math.min(arrays.capacity, (item.at ?? 0) + item.count));
    }
  }
}

/** Writes bundles from TSL in a fragment pass, a whole texel per call starting at element index. */
export class GpuArrayWriter<O extends Schema = Schema> implements ArrayWriter<O, false> {
  static readonly MAX_CHANNELS = MAX_WRITER_CHANNELS;
  /** Bytes per texel, with rgba8unorm counted as 8. */
  static readonly MAX_BYTES = MAX_WRITER_BYTES;

  readonly outputs: O;
  /** The elements per texel. */
  readonly packing: number;
  /** The channels in attachment order. */
  readonly channels: WriterOutput[];
  readonly material: NodeMaterial;
  readonly storage = false;
  readonly run = runWriters;

  /**
   * Builds the fragment pass.
   *
   * @param options.write Assigns each output channel a texel for index.
   * @param [options.label] Names the pipeline in WebGPU errors and debuggers,
   *   by default after the channels.
   */
  constructor({ outputs, write, label }: {
    outputs: O;
    write: (index: TslNode, out: WriterOutputs<O>) => void;
    label?: string;
  }) {
    this.outputs = outputs;
    const { channels, packing } = writerChannels(outputs);
    this.channels = channels;
    this.packing = packing;

    let bytes = 0;
    for (const { bundle, channel, texelFormat } of channels) {
      const info = gpuFormatInfo(texelFormat);
      if (!info.renderable) {
        throw new Error(`Writer output ${bundle}.${channel}: ${texelFormat} is not renderable`);
      }
      // WebGPU counts rgba8unorm as 8 bytes per sample
      const normalized8x4 = info.components === 4 && info.kind === "float" && ArrayFormats.info(texelFormat).scalarBytes === 1;
      bytes += normalized8x4 ? 8 : ArrayFormats.info(texelFormat).bytes;
    }
    if (channels.length > MAX_WRITER_CHANNELS || bytes > MAX_WRITER_BYTES) {
      throw new Error(`Writer writes ${channels.length} channels, ${bytes} bytes per texel (1 to ${MAX_WRITER_CHANNELS}, at most ${MAX_WRITER_BYTES})`);
    }

    const range = (key: keyof DrawRange) => uniform(0, "uint").onObjectUpdate(({ object }: { object: THREE.Object3D }) => (object.userData as DrawRange)[key]);
    const r = { start: range("start"), end: range("end"), first: range("first"), layer: range("layer"), yBits: range("yBits") };
    const rowStart = range("rowStart");
    const rowEnd = range("rowEnd");
    const height = range("height");
    const flip = uniform(1).onObjectUpdate(({ object }: { object: THREE.Object3D }) => (object.userData as DrawRange).flip);

    // Fragment rows run top-down on WebGPU and bottom-up on WebGL, hence flip
    const row = mix(float(rowStart), float(rowEnd), positionGeometry.y);
    this.material = new NodeMaterial();
    this.material.name = label ?? `radix_write_${channels.map(({ bundle, channel }) => `${bundle}_${channel}`).join("_")}`;
    this.material.vertexNode = vec4(positionGeometry.x.mul(2).sub(1), flip.mul(float(1).sub(row.mul(2).div(float(height)))), 0, 1);

    this.material.fragmentNode = new WriterOutputNode(() => {
      const coord = uvec2(new FragCoordNode());
      const texel = r.layer.shiftLeft(r.yBits).bitOr(coord.y).shiftLeft(uint(Math.log2(TextureLayout.WIDTH))).bitOr(coord.x).toVar();
      If(texel.lessThan(r.start).or(texel.greaterThanEqual(r.end)), () => {
        Discard();
      });

      const { out, vars } = writerVars(channels);
      write(texel.sub(r.start).mul(uint(packing)).add(r.first), out as WriterOutputs<O>);
      return vars.map((value, i) => widen(channels[i].texelFormat, value));
    });

    this.material.blending = THREE.NoBlending;
    this.material.depthTest = false;
    this.material.depthWrite = false;
    this.material.side = THREE.DoubleSide;
  }

  dispose() {
    this.material.dispose();
  }
}

// Per-draw values in texels, read from mesh.userData
interface DrawRange {
  start: number;
  end: number;
  first: number;
  layer: number;
  height: number;
  yBits: number;
  rowStart: number;
  rowEnd: number;
  flip: number;
}

const quadPosition = new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0], 3);
quadPosition.name = "radix_writerQuadPosition";
const quadIndex = new THREE.Uint16BufferAttribute([0, 1, 2, 2, 1, 3], 1);
quadIndex.name = "radix_writerQuadIndex";

const quad = new THREE.BufferGeometry();
quad.setAttribute("position", quadPosition);
quad.setIndex(quadIndex);

const scene = new THREE.Scene();
const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const meshes: THREE.Mesh[] = [];

// One render pass per layer and output set. Items should not overlap.
export function runWriters(arrays: GpuArrays, items: WriteItem[]) {
  const renderer = arrays.renderer;
  const flip = isWebGPUBackend(renderer) ? 1 : -1;

  const groups = new Map<THREE.RenderTarget, DrawItem[]>();
  for (const item of items) {
    if (item.count <= 0) {
      continue;
    }
    const writer = item.writer as GpuArrayWriter;
    const { start, end } = writeItemTexels(arrays, item);
    const target = arrays.renderTarget(writer.channels);
    groups.set(target, [...(groups.get(target) ?? []), { writer, start, end, first: item.first ?? 0 }]);
  }

  const saved = {
    target: renderer.getRenderTarget(),
    layer: renderer.getActiveCubeFace(),
    level: renderer.getActiveMipmapLevel(),
    autoClear: renderer.autoClear,
    xr: renderer.xr.enabled,
  };
  renderer.autoClear = false;
  renderer.xr.enabled = false;

  try {
    for (const [target, group] of groups) {
      const { width, height, yBits } = arrays.bundle(group[0].writer.channels[0].bundle).layout;
      const layerSize = width * height;
      const firstLayer = Math.min(...group.map((item) => Math.floor(item.start / layerSize)));
      const lastLayer = Math.max(...group.map((item) => Math.floor((item.end - 1) / layerSize)));

      for (let layer = firstLayer; layer <= lastLayer; layer += 1) {
        scene.clear();
        for (const item of group) {
          const start = Math.max(item.start, layer * layerSize);
          const end = Math.min(item.end, (layer + 1) * layerSize);
          if (start >= end) {
            continue;
          }

          const mesh = meshes[scene.children.length] ??= Object.assign(new THREE.Mesh(quad), { frustumCulled: false });
          mesh.material = item.writer.material;
          const range: DrawRange = {
            start: item.start, end: item.end, first: item.first, layer, height, yBits, flip,
            rowStart: Math.floor((start - layer * layerSize) / width),
            rowEnd: Math.ceil((end - layer * layerSize) / width),
          };
          mesh.userData = range;
          scene.add(mesh);
        }

        renderer.setRenderTarget(target, layer);
        renderer.render(scene, camera);
      }
    }
  } finally {
    scene.clear();
    renderer.setRenderTarget(saved.target, saved.layer, saved.level);
    renderer.autoClear = saved.autoClear;
    renderer.xr.enabled = saved.xr;
  }

  countWrites(arrays, items);
}

// An item in texels
interface DrawItem {
  writer: GpuArrayWriter;
  start: number;
  end: number;
  first: number;
}

// Fragment outputs and storage writes take 4 components
export function widen(texelFormat: ArrayFormat, value: TslNode): TslNode {
  const { components, kind } = gpuFormatInfo(texelFormat);
  if (components === 4) {
    return value;
  }
  const make = kind === "uint" ? uvec4 : kind === "sint" ? ivec4 : vec4;
  const zero = kind === "uint" ? uint(0) : kind === "sint" ? int(0) : float(0);
  return components === 1 ? make(value, zero, zero, zero) : make(value, zero, zero);
}

// gl_FragCoord.xy without TSL's y-flip, so y is the texture row on both backends
class FragCoordNode extends Node {
  constructor() {
    super("vec2");
  }

  generate(builder: NodeBuilder) {
    return (builder as unknown as { getFragCoord(): string }).getFragCoord();
  }
}

// Builders detect MRT by fragmentNode.isOutputStructNode, so the struct must
// be the fragmentNode, not in a Fn, and mrt() would coerce members to vec4.
// The body runs in a stack that becomes the first member, so it comes first.
class WriterOutputNode extends OutputStructNode {
  private body: () => TslNode[];
  constructor(body: () => TslNode[]) {
    super();
    this.body = body;
  }

  setup(builder: NodeBuilder) {
    const stacks = builder as unknown as { addStack(): StackNode; removeStack(): StackNode };
    const stack = stacks.addStack();
    const members = this.body();
    stacks.removeStack();

    stack.outputNode = members[0];
    this.members = [stack, ...members.slice(1)];
    return super.setup(builder);
  }
}
