import { ArrayData, type ArrayBundle } from "./ArrayData";
import { defineBundle, type BundleDef } from "./bundles";
import { Encoding } from "./encoding";
import type { TypedArray } from "./formats";
import type { BundleLike } from "./splats";

// Spherical harmonics, bands 1-4 (the DC band is the splat's base color):
// 3 + 5 + 7 + 9 RGB coefficients in the 3DGS basis, coefficient-major RGB
// (value 3k + c is coefficient k's channel c). A codec turns an entry's
// coefficients into a stream of uint32 words with the bands in order, so a
// lower degree reads a prefix of a higher-degree entry; the stream is cut into
// uint32x4 texels. Storage:
//   per splat  bundle <codec>Sh beside the splat bundle, one uint32x4
//              channel per texel (<codec>ShA, <codec>ShB, ...);
//              meta { codec, degree }
//   palette    ShPalette: one table of entries, each `stride` texels side by
//              side in channel shEntries, and bundle shLabel (uint16) in the
//              splat table picking an entry per splat
// Built-in codecs (bytes and texels for degree 1 / 2 / 3 / 4):
//   ext        one Encoding.encodeExtRgb word per coefficient: 12 / 32 /
//              60 / 96 B, 1 / 2 / 4 / 6 texels
//   packed     per band a log scale byte (0: all zero, else the band's max
//              is 2^((code - 192) / 16), rounded up) then its sint8 codes
//              (value = code / 127 * max): 10 / 26 / 48 / 76 B, 1 / 2 / 3 /
//              5 texels
// The set is fixed, so a codec's name means the same on every thread.

export type ShDegree = 1 | 2 | 3 | 4;

export type ShCodecName = "ext" | "packed";

// What file readers do with SH: the codec to store it in, or false to skip
// it (meta.ignoredShDegree records the degree skipped). Readers default to
// "ext".
export type ShTarget = ShCodecName | false;

// A built-in codec (Sh.codec)
export interface ShCodec {
  // Names the per-splat bundle (<name>Sh) and its channels
  readonly name: ShCodecName;
  words(degree: ShDegree): number;
  // Channel suffixes of the per-splat bundle, one per texel
  channels(degree: ShDegree): string[];
  // Writes words(degree) words of `coeffs` (Sh.COEFFICIENTS[degree] * 3
  // values) at out[at]
  encode(coeffs: ArrayLike<number>, degree: ShDegree, out: Uint32Array, at: number): void;
  // Fills Sh.COEFFICIENTS[degree] * 3 values of `out` (Sh.VALUES fits every
  // degree)
  decode(words: Uint32Array, at: number, degree: ShDegree, out: Float32Array): Float32Array;
}

// What Sh.find found: a per-splat SH bundle
export interface FoundSh {
  name: string;
  codec: ShCodecName;
  degree: ShDegree;
}

const COEFFICIENTS = [0, 3, 8, 15, 24] as const;
const MAX_DEGREE = 4;
const VALUES = COEFFICIENTS[MAX_DEGREE] * 3;
const PACKED_BAND_BYTES = [10, 16, 22, 28];
const PACKED_BYTES = [0, 10, 26, 48, 76];
const EXT_CHANNELS: Record<ShDegree, string[]> = { 1: ["A"], 2: ["A", "B"], 3: ["A", "B", "C", "D"], 4: ["A", "B", "C", "D", "E", "F"] };
const PACKED_CHANNELS: Record<ShDegree, string[]> = { 1: ["A"], 2: ["A", "B"], 3: ["A", "B", "C"], 4: ["A", "B", "C", "D", "E"] };

const SCALE_BIAS = 192;
const SCALE_STEPS = 16;

// The packed scale byte of a band whose largest |value| is `max`, and back
export function encodeShScale(max: number) {
  if (!(max > 0)) {
    return 0;
  }
  let code = Math.max(1, Math.min(255, Math.ceil(Math.log2(max) * SCALE_STEPS) + SCALE_BIAS));
  while (code < 255 && decodeShScale(code) < max) {
    code += 1;
  }
  return code;
}

export function decodeShScale(code: number) {
  return code === 0 ? 0 : 2 ** ((code - SCALE_BIAS) / SCALE_STEPS);
}

const getByte = (words: Uint32Array, at: number, b: number) => (words[at + (b >> 2)] >>> ((b & 3) * 8)) & 0xff;

// Bytes written in order into whole words (the last one zero-padded):
// startBytes, putByte per byte, endBytes
const bytes: { out: Uint32Array; at: number; word: number; shift: number } = { out: new Uint32Array(0), at: 0, word: 0, shift: 0 };
const startBytes = (out: Uint32Array, at: number) => {
  bytes.out = out;
  bytes.at = at;
  bytes.word = 0;
  bytes.shift = 0;
};
const putByte = (value: number) => {
  bytes.word |= (value & 0xff) << bytes.shift;
  bytes.shift += 8;
  if (bytes.shift === 32) {
    bytes.out[bytes.at++] = bytes.word >>> 0;
    bytes.word = 0;
    bytes.shift = 0;
  }
};
const endBytes = () => {
  if (bytes.shift > 0) {
    bytes.out[bytes.at++] = bytes.word >>> 0;
  }
};

const rgb = { r: 0, g: 0, b: 0 };

const ext: ShCodec = {
  name: "ext",
  words: (degree) => COEFFICIENTS[degree],
  channels: (degree) => EXT_CHANNELS[degree],
  encode(coeffs, degree, out, at) {
    for (let k = 0; k < COEFFICIENTS[degree]; k += 1) {
      rgb.r = coeffs[k * 3];
      rgb.g = coeffs[k * 3 + 1];
      rgb.b = coeffs[k * 3 + 2];
      out[at + k] = Encoding.encodeExtRgb(rgb);
    }
  },
  decode(words, at, degree, out) {
    for (let k = 0; k < COEFFICIENTS[degree]; k += 1) {
      Encoding.decodeExtRgb(words[at + k], rgb);
      out[k * 3] = rgb.r;
      out[k * 3 + 1] = rgb.g;
      out[k * 3 + 2] = rgb.b;
    }
    return out;
  },
};

const packed: ShCodec = {
  name: "packed",
  words: (degree) => Math.ceil(PACKED_BYTES[degree] / 4),
  channels: (degree) => PACKED_CHANNELS[degree],
  // Bands are contiguous (each its scale byte and values), so the bytes
  // go out in order
  encode(coeffs, degree, out, at) {
    startBytes(out, at);
    for (let band = 0; band < degree; band += 1) {
      const first = COEFFICIENTS[band] * 3;
      const end = COEFFICIENTS[band + 1] * 3;
      let max = 0;
      for (let v = first; v < end; v += 1) {
        max = Math.max(max, Math.abs(coeffs[v]));
      }
      const code = encodeShScale(max);
      const scale = decodeShScale(code);
      putByte(code);
      for (let v = first; v < end; v += 1) {
        putByte(scale > 0 ? Math.max(-127, Math.min(127, Math.round((coeffs[v] / scale) * 127))) : 0);
      }
    }
    endBytes();
  },
  decode(words, at, degree, out) {
    let byte = 0;
    for (let band = 0; band < degree; band += 1) {
      const first = COEFFICIENTS[band] * 3;
      const end = COEFFICIENTS[band + 1] * 3;
      const scale = decodeShScale(getByte(words, at, byte)) / 127;
      for (let v = first; v < end; v += 1) {
        out[v] = ((getByte(words, at, byte + 1 + v - first) << 24) >> 24) * scale;
      }
      byte += PACKED_BAND_BYTES[band];
    }
    return out;
  },
};

const CODECS: Record<ShCodecName, ShCodec> = { ext, packed };

// For Sh.find: each channel label's codec and the degrees whose bundle has
// it (bit d), and each codec's channel count per degree
const channelLookup = new Map<string, { codec: ShCodecName; degrees: number }>();
const channelCounts = {} as Record<ShCodecName, number[]>;
for (const codec of Object.values(CODECS)) {
  channelCounts[codec.name] = [0, 0, 0, 0, 0];
  for (const degree of [1, 2, 3, 4] as const) {
    const suffixes = codec.channels(degree);
    channelCounts[codec.name][degree] = suffixes.length;
    for (const suffix of suffixes) {
      const label = `${codec.name}Sh${suffix}`;
      const entry = channelLookup.get(label);
      if (entry) {
        entry.degrees |= 1 << degree;
      } else {
        channelLookup.set(label, { codec: codec.name, degrees: 1 << degree });
      }
    }
  }
}

const shDegreeOf = (n: number): ShDegree | undefined => (n === 1 || n === 2 || n === 3 || n === 4 ? n : undefined);

// Spherical harmonics: codecs, per-splat bundles and the CPU evaluator.
// GpuSh is the TSL twin.
export class Sh {
  // RGB coefficients per degree, the DC band excluded
  static readonly COEFFICIENTS = COEFFICIENTS;
  static readonly MAX_DEGREE = MAX_DEGREE;
  // Values of the highest degree's entry: a coefficient array that fits
  // any degree
  static readonly VALUES = VALUES;
  static readonly LABEL = defineBundle({ label: "uint16" });

  // A codec by name (a string from meta is checked)
  static codec(name: string): ShCodec {
    const codec = CODECS[name as ShCodecName];
    if (!codec) {
      throw new Error(`Unknown SH codec ${name}`);
    }
    return codec;
  }

  static texels(codec: ShCodecName, degree: ShDegree) {
    return Math.ceil(Sh.codec(codec).words(degree) / 4);
  }

  // The degree of `coefficients` RGB coefficients past DC (3, 8, 15, 24), else
  // undefined
  static degreeOf(coefficients: number): ShDegree | undefined {
    return shDegreeOf(COEFFICIENTS.indexOf(coefficients as never));
  }

  static bundleName(codec: ShCodecName) {
    return `${Sh.codec(codec).name}Sh`;
  }

  static bundle(codec: ShCodecName, degree: ShDegree): BundleDef {
    return defineBundle(Object.fromEntries(Sh.codec(codec).channels(degree).map((suffix) => [`${codec}Sh${suffix}`, "uint32x4" as const])));
  }

  // Adds an empty per-splat SH bundle to `data`
  static add(data: ArrayData, codec: ShCodecName, degree: ShDegree): ArrayBundle {
    data.addBundle(Sh.bundleName(codec), Sh.bundle(codec, degree), { meta: { codec, degree } });
    return data.bundles[Sh.bundleName(codec)];
  }

  // The per-splat SH bundle among `bundles` (of an ArrayData or GpuArrays):
  // a bundle whose channels are exactly a codec's for some degree.
  // Renderers call it per object per frame, so it allocates only the result.
  static find(bundles: Record<string, BundleLike & { meta?: Record<string, unknown> }>): FoundSh | undefined {
    for (const name in bundles) {
      const bundle = bundles[name];
      let codec: ShCodecName | undefined;
      let degrees = 0b11110;
      let count = 0;
      for (const label in bundle.channels) {
        const entry = channelLookup.get(label);
        if (!entry || bundle.channels[label]?.format !== "uint32x4" || (codec !== undefined && entry.codec !== codec)) {
          codec = undefined;
          break;
        }
        codec = entry.codec;
        degrees &= entry.degrees;
        count += 1;
      }
      if (codec === undefined) {
        continue;
      }
      const counts = channelCounts[codec];
      for (let degree = MAX_DEGREE; degree >= 1; degree -= 1) {
        if ((degrees & (1 << degree)) !== 0 && counts[degree] === count) {
          return { name, codec, degree: degree as ShDegree };
        }
      }
    }
    return undefined;
  }

  // For file readers: a bundle for a file's `degree` (0..4) of SH in
  // `target` (default ext) and its encoder, or undefined when there is none
  // or it is skipped (then meta.ignoredShDegree is the degree)
  static prepare(data: ArrayData, degree: number, target: ShTarget = "ext"): ((i: number, coeffs: ArrayLike<number>) => void) | undefined {
    const d = shDegreeOf(degree);
    data.meta.ignoredShDegree = d && target === false ? d : 0;
    if (!d || target === false) {
      return undefined;
    }
    Sh.add(data, target, d);
    return Sh.encoder(data);
  }

  // The encoder of a per-splat bundle: (i, coeffs) writes splat i
  static encoder(data: ArrayData, found = Sh.find(data.bundles)): (i: number, coeffs: ArrayLike<number>) => void {
    if (!found) {
      throw new Error("No SH bundle");
    }
    const { degree } = found;
    const codec = Sh.codec(found.codec);
    const channels = channelArrays(data.bundles[found.name]);
    const words = new Uint32Array(channels.length * 4);
    return (i, coeffs) => {
      codec.encode(coeffs, degree, words, 0);
      const at = i * 4;
      for (let t = 0; t < channels.length; t += 1) {
        const channel = channels[t];
        const w = t * 4;
        channel[at] = words[w];
        channel[at + 1] = words[w + 1];
        channel[at + 2] = words[w + 2];
        channel[at + 3] = words[w + 3];
      }
    };
  }

  // The decoder of a per-splat bundle: (i, out) fills out with splat i's
  // coefficients (out holds at least COEFFICIENTS[degree] * 3 values)
  static decoder(data: ArrayData, found = Sh.find(data.bundles)): (i: number, out: Float32Array) => Float32Array {
    if (!found) {
      throw new Error("No SH bundle");
    }
    const { degree } = found;
    const codec = Sh.codec(found.codec);
    const channels = channelArrays(data.bundles[found.name]);
    const words = new Uint32Array(channels.length * 4);
    return (i, out) => {
      const at = i * 4;
      for (let t = 0; t < channels.length; t += 1) {
        const channel = channels[t];
        const w = t * 4;
        words[w] = channel[at];
        words[w + 1] = channel[at + 1];
        words[w + 2] = channel[at + 2];
        words[w + 3] = channel[at + 3];
      }
      return codec.decode(words, 0, degree, out);
    };
  }

  // `data` with its SH in `codec` (at most `degree`): `data` itself when it
  // already is, else a new ArrayData sharing every other bundle's arrays
  static convert(data: ArrayData, codec: ShCodecName, { degree }: { degree?: ShDegree } = {}): ArrayData {
    const found = Sh.find(data.bundles);
    if (!found) {
      return data;
    }
    const to = Math.min(degree ?? found.degree, found.degree) as ShDegree;
    if (found.codec === codec && to === found.degree) {
      return data;
    }

    const out = shareBundles(data, found.name);
    Sh.add(out, codec, to);
    const decode = Sh.decoder(data, found);
    const encode = Sh.encoder(out);
    const coeffs = new Float32Array(VALUES);
    for (let i = 0; i < data.count; i += 1) {
      encode(i, decode(i, coeffs));
    }
    return out;
  }

  // The SH color of `coeffs` along unit `dir` (object space, from the view
  // to the splat) through `degree`, added to the base color by the caller
  static evaluate(coeffs: ArrayLike<number>, dir: { x: number; y: number; z: number }, degree: number, out = [0, 0, 0]) {
    Sh.basis(dir, basis);
    out[0] = 0;
    out[1] = 0;
    out[2] = 0;
    for (let k = 0; k < COEFFICIENTS[Math.max(0, Math.min(MAX_DEGREE, degree))]; k += 1) {
      out[0] += coeffs[k * 3] * basis[k];
      out[1] += coeffs[k * 3 + 1] * basis[k];
      out[2] += coeffs[k * 3 + 2] * basis[k];
    }
    return out;
  }

  // The 24 basis functions of bands 1-4 along unit `dir` (3DGS signs)
  static basis<T extends Float64Array | Float32Array | number[] = Float64Array>(dir: { x: number; y: number; z: number }, out: T = new Float64Array(COEFFICIENTS[MAX_DEGREE]) as T): T {
    const { x, y, z } = dir;
    const xx = x * x;
    const yy = y * y;
    const zz = z * z;
    out[0] = -0.4886025 * y;
    out[1] = 0.4886025 * z;
    out[2] = -0.4886025 * x;
    out[3] = 1.0925484 * x * y;
    out[4] = -1.0925484 * y * z;
    out[5] = 0.3153916 * (2 * zz - xx - yy);
    out[6] = -1.0925484 * x * z;
    out[7] = 0.5462742 * (xx - yy);
    out[8] = -0.5900436 * y * (3 * xx - yy);
    out[9] = 2.8906114 * x * y * z;
    out[10] = -0.4570458 * y * (4 * zz - xx - yy);
    out[11] = 0.3731763 * z * (2 * zz - 3 * xx - 3 * yy);
    out[12] = -0.4570458 * x * (4 * zz - xx - yy);
    out[13] = 1.4453057 * z * (xx - yy);
    out[14] = -0.5900436 * x * (xx - 3 * yy);
    // Band 4 uses xx + yy + zz = 1: `dir` must be unit
    out[15] = 2.5033429 * x * y * (xx - yy);
    out[16] = -1.7701308 * y * z * (3 * xx - yy);
    out[17] = 0.9461747 * x * y * (7 * zz - 1);
    out[18] = -0.6690465 * y * z * (7 * zz - 3);
    out[19] = 0.1057855 * (zz * (35 * zz - 30) + 3);
    out[20] = -0.6690465 * x * z * (7 * zz - 3);
    out[21] = 0.4730873 * (xx - yy) * (7 * zz - 1);
    out[22] = -1.7701308 * x * z * (xx - 3 * yy);
    out[23] = 0.6258357 * (xx * (xx - 3 * yy) - yy * (3 * xx - yy));
    return out;
  }
}

const basis = new Float64Array(COEFFICIENTS[MAX_DEGREE]);

const channelArrays = (bundle: ArrayBundle) => Object.values(bundle.channels).map((channel) => channel.data as Uint32Array);
const channelRecord = (bundle: ArrayBundle) => Object.fromEntries(Object.entries(bundle.channels).map(([label, channel]) => [label, channel.data])) as Record<string, TypedArray>;

// A new ArrayData sharing every bundle of `data` but `without`
function shareBundles(data: ArrayData, without: string) {
  const out = new ArrayData({ count: data.count, capacity: data.capacity, meta: { ...data.meta } });
  for (const [name, bundle] of Object.entries(data.bundles)) {
    if (name !== without) {
      out.addBundle(name, bundle.def, { data: channelRecord(bundle), meta: bundle.meta });
    }
  }
  return out;
}

const PALETTE = defineBundle({ shEntries: "uint32x4" });

// A table of SH entries that splats pick by label (bundle shLabel in the
// splat table): entry n is `stride` texels, elements n * stride .. in
// channel shEntries, side by side in a texture row. The stride is the
// codec's texels rounded up to a power of two, unless given.
export class ShPalette {
  static readonly BUNDLE = PALETTE;
  readonly data: ArrayData<{ shPalette: typeof PALETTE }>;

  constructor(data: ArrayData) {
    if (data.bundles.shPalette?.channels.shEntries?.format !== "uint32x4") {
      throw new Error("Not an SH palette: no shPalette.shEntries channel");
    }
    this.data = data as ArrayData<{ shPalette: typeof PALETTE }>;
  }

  // The default stride of a codec's entries: its texels rounded up to a
  // power of two (1 / 2 / 4 / 8 for degree 1 / 2 / 3 / 4)
  static strideOf(codec: ShCodecName, degree: ShDegree) {
    return 2 ** Math.ceil(Math.log2(Sh.texels(codec, degree)));
  }

  static create({ codec, degree, size, stride }: {
    codec: ShCodecName;
    degree: ShDegree;
    size: number;
    stride?: number;
  }): ShPalette {
    const s = stride ?? ShPalette.strideOf(codec, degree);
    if (s < Sh.texels(codec, degree)) {
      throw new Error(`Palette stride ${s} below the codec's ${Sh.texels(codec, degree)} texels`);
    }
    const data = new ArrayData({ count: size * s, meta: {} });
    data.addBundle("shPalette", PALETTE, { meta: { codec, degree, size, stride: s } });
    return new ShPalette(data);
  }

  get meta() {
    return this.data.bundles.shPalette.meta;
  }

  get codec(): ShCodecName {
    return Sh.codec(this.meta.codec as string).name;
  }

  get degree(): ShDegree {
    return this.meta.degree as ShDegree;
  }

  get size(): number {
    return this.meta.size as number;
  }

  get stride(): number {
    return this.meta.stride as number;
  }

  private get words() {
    return this.data.bundles.shPalette.channels.shEntries.data;
  }

  set(n: number, coeffs: ArrayLike<number>) {
    Sh.codec(this.codec).encode(coeffs, this.degree, this.words, n * this.stride * 4);
  }

  get(n: number, out: Float32Array = new Float32Array(VALUES)): Float32Array {
    return Sh.codec(this.codec).decode(this.words, n * this.stride * 4, this.degree, out);
  }

  // The same entries in another codec
  convert(codec: ShCodecName, { stride }: { stride?: number } = {}): ShPalette {
    const out = ShPalette.create({ codec, degree: this.degree, size: this.size, stride });
    const coeffs = new Float32Array(VALUES);
    for (let n = 0; n < this.size; n += 1) {
      out.set(n, this.get(n, coeffs));
    }
    return out;
  }

  // Per-splat SH in `codec` for `labels` (one per splat), added to `data`
  expand(data: ArrayData, labels: ArrayLike<number>, codec: ShCodecName = this.codec) {
    Sh.add(data, codec, this.degree);
    const encode = Sh.encoder(data);
    const coeffs = new Float32Array(VALUES);
    for (let i = 0; i < labels.length; i += 1) {
      encode(i, this.get(labels[i], coeffs));
    }
    return data;
  }

  // `data` with per-splat SH in place of its shLabel bundle: a new
  // ArrayData sharing every other bundle's arrays (`data` itself when it
  // has no labels)
  expanded(data: ArrayData, codec: ShCodecName = this.codec): ArrayData {
    const labels = data.bundles.shLabel?.channels.label?.data;
    if (!labels) {
      return data;
    }
    return this.expand(shareBundles(data, "shLabel"), labels.subarray(0, data.count), codec);
  }
}
