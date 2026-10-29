import { ArrayFormats, type ArrayFormat } from "./formats";

export type BundleChannels = Record<string, ArrayFormat>;

// A named set of channels that belong together (one codec, reader or file
// section binds to all of them). Plain data: it travels through postMessage
// and RDX headers as is.
export interface BundleDef<C extends BundleChannels = BundleChannels> {
  channels: C;
  // Elements per GPU texel; CPU bytes are the same for every packing
  packing: 1 | 2 | 4;
  // false for data rebuilt after loading (skipped by RDX)
  serialize: boolean;
}

export type Schema = Record<string, BundleDef>;

export function defineBundle<const C extends BundleChannels>(
  channels: C,
  { packing = 1, serialize = true }: { packing?: 1 | 2 | 4; serialize?: boolean } = {},
): BundleDef<C> {
  for (const format of Object.values(channels)) {
    const texelComponents = ArrayFormats.info(format).components * packing;
    if (packing > 1 && ![1, 2, 4].includes(texelComponents)) {
      throw new Error(`Format ${format} cannot be packed ${packing} per texel`);
    }
  }
  return { channels, packing, serialize };
}
