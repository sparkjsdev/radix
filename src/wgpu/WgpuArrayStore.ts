import type * as THREE from "three";
import type { BundleDef, Schema } from "../core/bundles";
import { ArrayFormats, type ArrayFormat } from "../core/formats";
import { TextureLayout } from "../core/layout";
import { makeArrayTexture, type GpuArrays } from "../gpu/GpuArrays";
import { widen } from "../gpu/GpuArrayWriter";
import { gpuFormatInfo } from "../gpu/gpuFormats";
import { TSL, texelCoord, type TslNode } from "../gpu/tsl";

const { int, storageTexture, textureStore, uint, uniform, uvec2 } = TSL;

/**
 * Writes elements at any index from a compute kernel into one bundle of storage
 * arrays, on the WebGPU backend only. A kernel using it sets arrays.count
 * itself.
 */
export class WgpuArrayStore<D extends BundleDef = BundleDef> {
  readonly def: D;
  // log2 and mask of the bound layout's height
  private yBits: TslNode;
  private yMask: TslNode;
  private channels: Record<string, { format: ArrayFormat; texelFormat: ArrayFormat; node: TslNode }> = {};

  /** Builds the store's shader code from a bundle definition. */
  constructor(def: D) {
    this.def = def;
    this.yBits = uniform(0, "uint");
    this.yMask = uniform(0, "uint");

    for (const [label, format] of Object.entries(def.channels)) {
      const { scalar, components } = ArrayFormats.info(format);
      const texelFormat = ArrayFormats.make(scalar, components * def.packing);
      if (!gpuFormatInfo(texelFormat).storable) {
        throw new Error(`Channel ${label}: ${texelFormat} cannot be a storage texture`);
      }
      this.channels[label] = { format, texelFormat, node: storageTexture(placeholder(texelFormat)) };
    }
  }

  /**
   * Points the store at a bundle of arrays. Call it again after the arrays are
   * resized or swapped.
   *
   * @param name The bundle's name.
   */
  bind(arrays: GpuArrays<Schema, true>, name: string): this {
    const target = arrays.bundle(name);
    if (target.def.packing !== this.def.packing) {
      throw new Error(`Bundle ${name} has packing ${target.def.packing}, the store ${this.def.packing}`);
    }
    for (const [label, channel] of Object.entries(this.channels)) {
      const texture = target.channels[label];
      if (texture?.format !== channel.format) {
        throw new Error(`Channel ${name}.${label} missing or not ${channel.format}`);
      }
      if (!texture.storage) {
        throw new Error(`Channel ${name}.${label} is not a storage texture (GpuArrays with storage: true)`);
      }
      channel.node.value = texture.texture;
    }

    this.yBits.value = target.layout.yBits;
    this.yMask.value = target.layout.height - 1;
    return this;
  }

  /**
   * Stores one element of an unpacked bundle.
   *
   * @param index The element's index, a TSL uint.
   */
  store(channel: keyof D["channels"] & string, index: TslNode, value: TslNode) {
    if (this.def.packing !== 1) {
      throw new Error("store() writes unpacked bundles; use storeTexel() for whole packed texels");
    }
    this.storeTexel(channel, index, value);
  }

  /**
   * Stores a whole texel of a bundle.
   *
   * @param texel The texel's index, a TSL uint.
   * @param value A value of the texel format, so packing 2 of "uint32x2" takes
   *   a uvec4.
   */
  storeTexel(channel: keyof D["channels"] & string, texel: TslNode, value: TslNode) {
    const entry = this.channels[channel];
    if (!entry) {
      throw new Error(`Channel ${channel} not in the store's bundle`);
    }

    const { x, y, layer } = texelCoord(uint(texel), this.yBits, this.yMask);
    textureStore(entry.node.depth(int(layer)), uvec2(x, y), widen(entry.texelFormat, value));
  }
}

// Bound until the first bind()
const placeholders = new Map<string, THREE.DataArrayTexture>();

function placeholder(texelFormat: ArrayFormat) {
  let texture = placeholders.get(texelFormat);
  if (!texture) {
    texture = makeArrayTexture(`radix_storePlaceholder_${texelFormat}`, texelFormat, TextureLayout.for(1));
    Object.assign(texture, { isStorageTexture: true, isArrayTexture: true });
    placeholders.set(texelFormat, texture);
  }
  return texture;
}
