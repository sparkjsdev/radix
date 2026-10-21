import { ArrayFormats, type ArrayFormat } from "./formats";

/** Channel formats, by channel name. */
export type BundleChannels = Record<string, ArrayFormat>;

/** A named set of channels that belong together. */
export interface BundleDef<C extends BundleChannels = BundleChannels> {
  channels: C;
  /** Elements per GPU texel, which leaves the CPU arrays unchanged. */
  packing: 1 | 2 | 4;
  /** Whether RDX files save the bundle, false for data rebuilt after loading. */
  serialize: boolean;
}

/** Bundle definitions, by bundle name. */
export type Schema = Record<string, BundleDef>;

/**
 * Defines a bundle of channels.
 *
 * @param [options.packing=1] Elements per GPU texel.
 * @param [options.serialize=true] Whether RDX files save the bundle.
 */
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
