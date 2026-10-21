import type * as THREE from "three";
import { TextureNode, type NodeBuilder } from "three/webgpu";
import type { BundleDef } from "../core/bundles";
import { ArrayFormats, type ArrayFormat } from "../core/formats";
import { TextureLayout } from "../core/layout";
import { makeArrayTexture, type GpuArrays } from "./GpuArrays";
import { gpuFormatInfo } from "./gpuFormats";
import { TSL, texelCoord, type TslNode } from "./tsl";

const { int, ivec2, nodeObject, select, uint, uniform } = TSL;

// For raw texel loads, without TextureNode's WebGL y-flip and per-clone UV
// uniform. clone() passes uv, level and bias through this constructor.
class ArrayTextureNode extends TextureNode {
  constructor(value: THREE.Texture, uvNode?: TslNode, levelNode?: TslNode, biasNode?: TslNode) {
    super(value, uvNode, levelNode, biasNode);
    this.updateMatrix = false;
  }

  setupUV(_builder: NodeBuilder, uvNode: TslNode): TslNode {
    return uvNode;
  }
}

/** TSL reads of one bundle, bound to any GpuArrays without rebuilding the shader. */
export class GpuArrayReader<D extends BundleDef = BundleDef> {
  readonly def: D;
  /** A uint uniform, past which load() reads zero. */
  readonly count: TslNode;
  // log2 and mask of the bound layout's height
  private yBits: TslNode;
  private yMask: TslNode;
  private channels: Record<string, { format: ArrayFormat; texelFormat: ArrayFormat; node: TslNode }> = {};

  /** Builds the reads of a bundle, bound to nothing. */
  constructor(def: D) {
    this.def = def;
    this.count = uniform(0, "uint");
    this.yBits = uniform(0, "uint");
    this.yMask = uniform(0, "uint");

    for (const [label, format] of Object.entries(def.channels)) {
      const { scalar, components } = ArrayFormats.info(format);
      const texelFormat = ArrayFormats.make(scalar, components * def.packing);
      this.channels[label] = { format, texelFormat, node: nodeObject(new ArrayTextureNode(placeholder(texelFormat))) };
    }
  }

  /**
   * Reads a bundle of arrays from now on. Rebind after the arrays' count or
   * capacity changes.
   *
   * @param [arrays] The arrays, or none to read zero.
   */
  bind(arrays?: GpuArrays, name?: string): this {
    if (!arrays || !name) {
      this.count.value = 0;
      for (const label in this.channels) {
        const channel = this.channels[label];
        channel.node.value = placeholder(channel.texelFormat);
      }
      return this;
    }

    const source = arrays.bundle(name);
    if (source.def.packing !== this.def.packing) {
      throw new Error(`Bundle ${name} has packing ${source.def.packing}, the reader ${this.def.packing}`);
    }
    for (const label in this.channels) {
      const channel = this.channels[label];
      const texture = source.channels[label];
      if (texture?.format !== channel.format) {
        throw new Error(`Channel ${name}.${label} missing or not ${channel.format}`);
      }
      channel.node.value = texture.texture;
    }

    this.count.value = arrays.count;
    this.yBits.value = source.layout.yBits;
    this.yMask.value = source.layout.height - 1;
    return this;
  }

  /** Reads an element, typed by the channel's format, or zero past count. */
  load(channel: keyof D["channels"] & string, index: TslNode): TslNode {
    const { node } = gpuFormatInfo(this.channel(channel).format);
    return select(index.lessThan(this.count), this.fetch(channel, index), TSL[node as keyof typeof TSL](0));
  }

  /** Reads an element without a bounds check. */
  fetch(channel: keyof D["channels"] & string, index: TslNode): TslNode {
    const { format, node } = this.channel(channel);
    const components = ArrayFormats.info(format).components;
    const packing = this.def.packing;

    const { x, y, layer } = texelCoord(packing === 1 ? index : index.shiftRight(uint(Math.log2(packing))), this.yBits, this.yMask);
    const texel = node.load(ivec2(int(x), int(y))).depth(int(layer)).toVar();
    if (packing === 1) {
      return components === 1 ? texel.x : components === 2 ? texel.xy : texel;
    }

    const slot = index.bitAnd(uint(packing - 1));
    return components === 1 ? texel.element(slot) : select(slot.equal(uint(0)), texel.xy, texel.zw);
  }

  private channel(label: string) {
    const channel = this.channels[label];
    if (!channel) {
      throw new Error(`Channel ${label} not in the reader's bundle`);
    }
    return channel;
  }
}

// Bound while no arrays are
const placeholders = new Map<string, THREE.DataArrayTexture>();

function placeholder(texelFormat: ArrayFormat) {
  let texture = placeholders.get(texelFormat);
  if (!texture) {
    texture = makeArrayTexture(`radix_readerPlaceholder_${texelFormat}`, texelFormat, TextureLayout.for(1));
    placeholders.set(texelFormat, texture);
  }
  return texture;
}
