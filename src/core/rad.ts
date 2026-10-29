// RAD splat files: a RAD0 header (JSON meta, padded to 8 bytes) then RADC
// chunks, each a JSON meta, a u64 payload size and a payload of column
// properties (optionally deflate / gzip compressed). Centers, alpha, rgb,
// scales, orientation and the LoD tree (child_count, child_start: the
// lodTree bundle) are read, and SH (sh1, sh2, sh3: 9, 15 and 21 values per
// splat, coefficient-major RGB, as f32, f16, s8 or s8_delta over +-max)
// into an SH bundle (default ext; `sh: false` skips it, degree in
// meta.ignoredShDegree). Clustered SH (Spark's build-lod --cluster-sh: the
// header's shCodeCount entries in chunk 0's sh1_code .. sh3_code, laid out
// as sh1 .. sh3 are, and an sh_label per splat in every chunk) reads into
// an ShPalette in the same codec and bundle shLabel; past 65,536 entries a
// label no longer fits shLabel, so they expand to per-splat SH. A
// standalone RADC chunk reads as a file of one chunk. External chunk files
// are not read.
//
// writeRad writes the plain subset readRad reads: embedded chunks of f32
// columns (u32 for the tree), each gzipped, and SH (degree 3 at most) as s8
// over each band's largest |value| in the chunk (or f16 / f32 with
// `radSh`); given an `shPalette` for the splats' shLabel, clustered SH
// (codes as s8 over each band's largest |value| in the palette, labels u16).
import { ArrayData } from "./ArrayData";
import { Compression, type BytesInput } from "./compress";
import { Encoding } from "./encoding";
import { counter, type Progress } from "./progress";
import { Sh, ShPalette, type ShDegree } from "./sh";
import { Splats, type ExtSplat, type LoadedSplats, type SplatLayout, type SplatReadOptions } from "./splats";

// Values per splat of RAD's SH properties (bands 1, 2, 3)
const SH_BANDS = [["sh1", 9], ["sh2", 15], ["sh3", 21]] as const;

export const RAD_MAGIC = 0x30444152; // "RAD0"
export const RAD_CHUNK_MAGIC = 0x43444152; // "RADC"
const RAD_CHUNK_SIZE = 65536;
const fromHalf = Encoding.decodeHalf;

interface RadProperty {
  offset: number;
  bytes: number;
  property: string;
  encoding: string;
  compression?: string;
  min?: number;
  max?: number;
}

interface RadChunkMeta {
  base: number;
  count: number;
  payloadBytes: number;
  lodTree: boolean;
  properties: RadProperty[];
}

const pad8 = (n: number) => (n + 7) & ~7;

// Clustered SH being read: the palette (filled from chunk 0's codes) and
// every splat's label
interface RadClusters {
  palette: ShPalette;
  labels: Uint32Array;
  read: boolean;
}

async function readRad<L extends SplatLayout = "extSplats">(input: BytesInput, { progress, sh, ...target }: SplatReadOptions<L> = {}): Promise<LoadedSplats<L>> {
  const bytes = await Compression.readBytes(input);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const json = (at: number, length: number) => JSON.parse(new TextDecoder().decode(bytes.subarray(at, at + length))) as Record<string, unknown>;

  const magic = view.getUint32(0, true);
  const meta = json(8, view.getUint32(4, true));
  let chunks: { at: number; standalone: boolean }[];
  if (magic === RAD_MAGIC) {
    if (meta.version !== 1 || meta.type !== "gsplat") {
      throw new Error(`Unsupported RAD version ${String(meta.version)} or type ${String(meta.type)}`);
    }
    const start = 8 + pad8(view.getUint32(4, true));
    chunks = (meta.chunks as { offset: number; filename?: string }[]).map((range) => {
      if (range.filename) {
        throw new Error("RAD external chunk files are not supported");
      }
      return { at: start + range.offset, standalone: false };
    });
  } else if (magic === RAD_CHUNK_MAGIC) {
    chunks = [{ at: 0, standalone: true }];
  } else {
    throw new Error(`Invalid RAD magic 0x${magic.toString(16)}`);
  }

  const count = meta.count as number;
  const lod = (meta.lodTree ?? meta.lod_tree) === true;
  const maxSh = Number(meta.maxSh ?? meta.max_sh ?? 0);
  const codeCount = Number(meta.shCodeCount ?? meta.sh_code_count ?? 0);
  const data = new ArrayData({ count, meta: { format: "rad" } });
  const encode = Splats.encoder(Splats.add(data, target));
  let clusters: RadClusters | undefined;
  let encodeSh: ((i: number, coeffs: ArrayLike<number>) => void) | undefined;
  if (codeCount > 0 && sh !== false && maxSh >= 1 && maxSh <= 3) {
    data.meta.ignoredShDegree = 0;
    clusters = { palette: ShPalette.create({ codec: sh ?? "ext", degree: maxSh as ShDegree, size: codeCount }), labels: new Uint32Array(count), read: false };
  } else {
    encodeSh = Sh.prepare(data, maxSh, sh);
  }
  const nodes = lod ? data.addBundle("lodTree", Splats.LOD_TREE).bundles.lodTree.channels.node.data : undefined;

  for (const [index, { at, standalone }] of chunks.entries()) {
    progress?.(index / chunks.length, "decoding");
    if (view.getUint32(at, true) !== RAD_CHUNK_MAGIC) {
      throw new Error("Invalid RAD chunk");
    }
    const length = view.getUint32(at + 4, true);
    const raw = json(at + 8, length);
    const chunk: RadChunkMeta = {
      base: standalone ? 0 : (raw.base as number),
      count: raw.count as number,
      payloadBytes: (raw.payloadBytes ?? raw.payload_bytes) as number,
      lodTree: (raw.lodTree ?? raw.lod_tree) === true,
      properties: raw.properties as RadProperty[],
    };
    const payloadAt = at + 8 + pad8(length) + 8;
    await decodeChunk(chunk, bytes.subarray(payloadAt, payloadAt + chunk.payloadBytes), encode, nodes, encodeSh && { encode: encodeSh, degree: maxSh }, clusters);
  }
  progress?.(1, "decoding");
  if (!clusters) {
    return { splats: data as unknown as LoadedSplats<L>["splats"] };
  }
  const { palette, labels } = clusters;
  if (!clusters.read) {
    throw new Error("RAD file with shCodeCount misses sh1_code");
  }
  for (let i = 0; i < count; i += 1) {
    if (labels[i] >= palette.size) {
      throw new Error(`RAD sh_label ${labels[i]} past shCodeCount ${palette.size}`);
    }
  }
  if (palette.size > 65536) {
    palette.expand(data, labels);
    return { splats: data as unknown as LoadedSplats<L>["splats"] };
  }
  data.addBundle("shLabel", Sh.LABEL).bundles.shLabel.channels.label.data.set(labels);
  return { splats: data as unknown as LoadedSplats<L>["splats"], shPalette: palette };
}

async function decodeChunk(
  chunk: RadChunkMeta, payload: Uint8Array, encode: (i: number, s: ExtSplat) => void, nodes?: Uint32Array,
  sh?: { encode: (i: number, coeffs: ArrayLike<number>) => void; degree: number }, clusters?: RadClusters,
) {
  const n = chunk.count;
  const columns: Record<string, Float32Array | Uint32Array> = {};
  const codes: Record<string, Float32Array> = {};
  for (const property of chunk.properties) {
    let bytes = payload.subarray(property.offset, property.offset + property.bytes);
    if (property.compression) {
      bytes = await decompress(bytes);
    }
    switch (property.property) {
      case "center":
      case "alpha":
      case "rgb":
      case "scales":
        columns[property.property] = decodeNumbers(property, bytes, property.property === "alpha" ? 1 : 3, n);
        break;
      case "orientation":
        columns.orientation = decodeOrientation(property, bytes, n);
        break;
      case "child_count":
      case "child_start":
        columns[property.property] = decodeUints(property, bytes, n);
        break;
      case "sh1":
      case "sh2":
      case "sh3":
        if (sh) {
          columns[property.property] = decodeNumbers(property, bytes, SH_BANDS.find(([name]) => name === property.property)![1], n);
        }
        break;
      case "sh1_code":
      case "sh2_code":
      case "sh3_code":
        if (clusters) {
          const band = property.property.slice(0, 3);
          codes[band] = decodeNumbers(property, bytes, SH_BANDS.find(([name]) => name === band)![1], clusters.palette.size);
        }
        break;
      case "sh_label":
        if (clusters) {
          clusters.labels.set(decodeUints(property, bytes, n), chunk.base);
        }
        break;
    }
  }
  for (const required of ["center", "alpha", "rgb", "scales", "orientation"]) {
    if (n > 0 && !columns[required]) {
      throw new Error(`RAD chunk misses ${required}`);
    }
  }

  const { center, alpha, rgb, scales, orientation, child_count: childCounts, child_start: childStarts } = columns;
  const s = Splats.makeExtSplat();
  // One record reused for every splat (no allocations in the loop)
  for (let i = 0; i < n; i += 1) {
    s.center.x = center[i * 3];
    s.center.y = center[i * 3 + 1];
    s.center.z = center[i * 3 + 2];
    s.opacity = alpha[i];
    s.rgb.r = rgb[i * 3];
    s.rgb.g = rgb[i * 3 + 1];
    s.rgb.b = rgb[i * 3 + 2];
    s.scales.x = scales[i * 3];
    s.scales.y = scales[i * 3 + 1];
    s.scales.z = scales[i * 3 + 2];
    s.quaternion.x = orientation[i * 4];
    s.quaternion.y = orientation[i * 4 + 1];
    s.quaternion.z = orientation[i * 4 + 2];
    s.quaternion.w = orientation[i * 4 + 3];
    encode(chunk.base + i, s);
  }
  if (sh) {
    gatherSh(n, sh.degree, columns, (i, coeffs) => sh.encode(chunk.base + i, coeffs));
  }
  if (clusters && codes.sh1) {
    const { palette } = clusters;
    gatherSh(palette.size, palette.degree, codes, (e, coeffs) => palette.set(e, coeffs));
    clusters.read = true;
  }
  if (nodes && chunk.lodTree) {
    if (!childCounts || !childStarts) {
      throw new Error("RAD chunk misses child_count or child_start");
    }
    for (let i = 0; i < n; i += 1) {
      nodes[(chunk.base + i) * 2] = childCounts[i];
      nodes[(chunk.base + i) * 2 + 1] = childStarts[i];
    }
  }
}

// Entries 0 .. n - 1 of interleaved band columns (sh1 .. sh3, missing ones
// zero) as coefficient-major RGB
function gatherSh(n: number, degree: number, columns: Record<string, ArrayLike<number> | undefined>, put: (i: number, coeffs: Float32Array) => void) {
  const coeffs = new Float32Array(Sh.VALUES);
  const bands = SH_BANDS.slice(0, degree).map(([name, values]) => ({ values, column: columns[name] }));
  for (let i = 0; i < n; i += 1) {
    let at = 0;
    for (let b = 0; b < bands.length; b += 1) {
      const { values, column } = bands[b];
      for (let v = 0; v < values; v += 1) {
        coeffs[at + v] = column ? column[i * values + v] : 0;
      }
      at += values;
    }
    put(i, coeffs);
  }
}

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);
const floatOfBits = (bits: number) => {
  u32[0] = bits;
  return f32[0];
};

// Dimension-planar values (all x, then all y, ...) as interleaved float32
function decodeNumbers(property: RadProperty, bytes: Uint8Array, dims: number, n: number): Float32Array {
  const out = new Float32Array(dims * n);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const stride = dims * n;
  const min = property.min ?? 0;
  const max = property.max ?? 1;
  const signed = (byte: number) => (((byte << 24) >> 24) / 127) * max;
  for (let d = 0; d < dims; d += 1) {
    let last = 0;
    for (let i = 0; i < n; i += 1) {
      const k = d * n + i;
      let value: number;
      switch (property.encoding) {
        case "f32": value = view.getFloat32(k * 4, true); break;
        case "f16": value = fromHalf(view.getUint16(k * 2, true)); break;
        case "f32_lebytes": value = floatOfBits((bytes[k] | (bytes[k + stride] << 8) | (bytes[k + stride * 2] << 16) | (bytes[k + stride * 3] << 24)) >>> 0); break;
        case "f16_lebytes": value = fromHalf(bytes[k] | (bytes[k + stride] << 8)); break;
        case "r8": value = (bytes[k] / 255) * (max - min) + min; break;
        case "r8_delta": last = (last + bytes[k]) & 0xff; value = (last / 255) * (max - min) + min; break;
        case "s8": value = signed(bytes[k]); break;
        case "s8_delta": last = (last + bytes[k]) & 0xff; value = signed(last); break;
        case "ln_0r8": value = bytes[k] === 0 ? 0 : Math.exp(min + (bytes[k] - 1) * ((max - min) / 254)); break;
        case "ln_f16": value = Math.exp(fromHalf(view.getUint16(k * 2, true))); break;
        default: throw new Error(`Unsupported RAD ${property.property} encoding ${property.encoding}`);
      }
      out[i * dims + d] = value;
    }
  }
  return out;
}

// Quaternions (x, y, z, w) from oct88r8 or xyz values (w >= 0)
function decodeOrientation(property: RadProperty, bytes: Uint8Array, n: number): Float32Array {
  const out = new Float32Array(n * 4);
  if (property.encoding === "oct88r8") {
    const axis = { x: 0, y: 0, z: 0 };
    for (let i = 0; i < n; i += 1) {
      const code = bytes[i * 3] | (bytes[i * 3 + 1] << 8);
      // Code 0 is the (0, 0) corner, -Z, as in any other octahedral map
      if (code === 0) {
        Object.assign(axis, { x: 0, y: 0, z: -1 });
      } else {
        Encoding.decodeOct(code, 8, axis);
      }
      const angle = (bytes[i * 3 + 2] / 255) * Math.PI;
      const s = Math.sin(angle / 2);
      out[i * 4] = axis.x * s;
      out[i * 4 + 1] = axis.y * s;
      out[i * 4 + 2] = axis.z * s;
      out[i * 4 + 3] = Math.cos(angle / 2);
    }
    return out;
  }
  const xyz = decodeNumbers(property, bytes, 3, n);
  for (let i = 0; i < n; i += 1) {
    const x = xyz[i * 3];
    const y = xyz[i * 3 + 1];
    const z = xyz[i * 3 + 2];
    out[i * 4] = x;
    out[i * 4 + 1] = y;
    out[i * 4 + 2] = z;
    out[i * 4 + 3] = Math.sqrt(Math.max(0, 1 - x * x - y * y - z * z));
  }
  return out;
}

function decodeUints(property: RadProperty, bytes: Uint8Array, n: number): Uint32Array {
  if (property.encoding !== "u16" && property.encoding !== "u32") {
    throw new Error(`Unsupported RAD ${property.property} encoding ${property.encoding}`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Uint32Array(n);
  for (let i = 0; i < n; i += 1) {
    out[i] = property.encoding === "u16" ? view.getUint16(i * 2, true) : view.getUint32(i * 4, true);
  }
  return out;
}

// "gz" properties: zlib, raw deflate or gzip (early files kept raw bytes)
async function decompress(bytes: Uint8Array): Promise<Uint8Array> {
  for (const format of ["deflate", "deflate-raw", "gzip"] as const) {
    try {
      const stream = new Blob([bytes.slice()]).stream().pipeThrough(new DecompressionStream(format));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch {
      // the next wrapper format
    }
  }
  return bytes;
}

// RAD splat files
export class RadFile {
  // { splats, shPalette? }: the bundle of the asked layout (default
  // extSplats), plus lodTree, and the palette of clustered SH
  static readonly read = readRad;
  // One RAD0 file of the splat bundle of `data` (any layout) and its
  // lodTree when it has one, in chunks of `chunkSize` splats
  static readonly write = writeRad;
}

type RadColumn = [string, string, Uint8Array<ArrayBuffer>, { min?: number; max?: number }?];

const bytesOf = (values: Float32Array<ArrayBuffer> | Uint32Array<ArrayBuffer> | Uint16Array<ArrayBuffer>) => new Uint8Array(values.buffer, values.byteOffset, values.byteLength);

async function writeRad(data: ArrayData, { chunkSize = RAD_CHUNK_SIZE, sh = true, radSh = "s8", shPalette, progress }: {
  chunkSize?: number;
  // The SH bundle (default true when the data has one), as s8 (over each
  // band's largest |value| in the chunk), f16 or f32
  sh?: boolean;
  radSh?: "s8" | "f16" | "f32";
  // The palette of the splats' shLabel bundle: written as clustered SH
  shPalette?: ShPalette;
  progress?: Progress;
} = {}): Promise<Uint8Array<ArrayBuffer>> {
  const decode = Splats.decoder(Splats.get(data).bundle);
  const tree = Splats.findLodTree(data);
  const labels = sh && shPalette ? data.bundles.shLabel?.channels.label?.data : undefined;
  const found = sh && !labels ? Sh.find(data.bundles) : undefined;
  const decodeSh = found && Sh.decoder(data, found);
  // RAD stops at sh3: higher degrees write their first 3 bands
  const maxSh = Math.min(labels ? shPalette!.degree : (found?.degree ?? 0), 3);
  const bandMax = [0, 0, 0];
  const encoder = new TextEncoder();
  const s = Splats.makeExtSplat();

  // The bands of `n` entries from get(i, coeffs), as columns sh1 .. sh3
  // plus `suffix`
  const shColumns = (n: number, suffix: string, get: (i: number, coeffs: Float32Array) => void) => {
    // Dimension-planar: all of value 0, then all of value 1, ...
    const coeffs = new Float32Array(Sh.VALUES);
    const bands = SH_BANDS.slice(0, maxSh).map(([, values]) => new Float32Array(values * n));
    for (let i = 0; i < n; i += 1) {
      get(i, coeffs);
      let at = 0;
      for (let b = 0; b < bands.length; b += 1) {
        const band = bands[b];
        const values = SH_BANDS[b][1];
        for (let v = 0; v < values; v += 1) {
          band[v * n + i] = coeffs[at + v];
        }
        at += values;
      }
    }
    return bands.map((band, b): RadColumn => {
      const name = SH_BANDS[b][0] + suffix;
      if (radSh === "f32") {
        return [name, "f32", bytesOf(band)];
      }
      if (radSh === "f16") {
        const halves = new Uint16Array(band.length);
        for (let k = 0; k < band.length; k += 1) {
          halves[k] = Encoding.encodeHalf(band[k]);
        }
        return [name, "f16", bytesOf(halves)];
      }
      let max = 0;
      for (let k = 0; k < band.length; k += 1) {
        max = Math.max(max, Math.abs(band[k]));
      }
      max ||= 1;
      bandMax[b] = Math.max(bandMax[b], max);
      const codes = new Uint8Array(band.length);
      for (let k = 0; k < band.length; k += 1) {
        codes[k] = Math.max(-127, Math.min(127, Math.round((band[k] / max) * 127))) & 0xff;
      }
      return [name, "s8", codes, { min: -max, max }];
    });
  };

  const chunks: Uint8Array<ArrayBuffer>[] = [];
  const ranges: { offset: number; bytes: number }[] = [];
  let offset = 0;
  const tick = counter(progress, data.count, "encoding");
  for (let base = 0; base < data.count; base += chunkSize) {
    const n = Math.min(chunkSize, data.count - base);
    const center = new Float32Array(n * 3);
    const alpha = new Float32Array(n);
    const rgb = new Float32Array(n * 3);
    const scales = new Float32Array(n * 3);
    const orientation = new Float32Array(n * 3);
    for (let i = 0; i < n; i += 1) {
      tick(base + i);
      decode(base + i, s);
      const q = s.quaternion;
      const sign = q.w < 0 ? -1 : 1;
      // Dimension-planar columns: all x, then all y, then all z
      center[i] = s.center.x;
      center[n + i] = s.center.y;
      center[2 * n + i] = s.center.z;
      rgb[i] = s.rgb.r;
      rgb[n + i] = s.rgb.g;
      rgb[2 * n + i] = s.rgb.b;
      scales[i] = s.scales.x;
      scales[n + i] = s.scales.y;
      scales[2 * n + i] = s.scales.z;
      orientation[i] = q.x * sign;
      orientation[n + i] = q.y * sign;
      orientation[2 * n + i] = q.z * sign;
      alpha[i] = s.opacity;
    }

    const columns: RadColumn[] = [
      ["center", "f32", bytesOf(center)], ["alpha", "f32", bytesOf(alpha)], ["rgb", "f32", bytesOf(rgb)], ["scales", "f32", bytesOf(scales)],
      ["orientation", "f32", bytesOf(orientation)],
    ];
    if (decodeSh) {
      columns.push(...shColumns(n, "", (i, coeffs) => decodeSh(base + i, coeffs)));
    }
    if (labels) {
      if (base === 0) {
        columns.push(...shColumns(shPalette!.size, "_code", (e, coeffs) => shPalette!.get(e, coeffs)));
      }
      columns.push(["sh_label", "u16", bytesOf(Uint16Array.from(labels.subarray(base, base + n)))]);
    }
    if (tree) {
      const nodes = tree.channels.node.data;
      const counts = new Uint32Array(n);
      const starts = new Uint32Array(n);
      for (let i = 0; i < n; i += 1) {
        counts[i] = nodes[(base + i) * 2];
        starts[i] = nodes[(base + i) * 2 + 1];
      }
      columns.push(["child_count", "u32", bytesOf(counts)], ["child_start", "u32", bytesOf(starts)]);
    }

    const payloads = await Promise.all(columns.map(([, , bytes]) => Compression.gzip(bytes)));
    const properties: RadProperty[] = [];
    let payloadBytes = 0;
    columns.forEach(([property, encoding, , range], c) => {
      properties.push({ offset: payloadBytes, bytes: payloads[c].byteLength, property, encoding, compression: "gz", ...range });
      payloadBytes += pad8(payloads[c].byteLength);
    });

    const meta = encoder.encode(JSON.stringify({ version: 1, base, count: n, payloadBytes, maxSh, lodTree: tree !== undefined, properties }));
    const chunk = new Uint8Array(8 + pad8(meta.byteLength) + 8 + payloadBytes);
    const view = new DataView(chunk.buffer);
    view.setUint32(0, RAD_CHUNK_MAGIC, true);
    view.setUint32(4, meta.byteLength, true);
    chunk.set(meta, 8);
    const payloadAt = 8 + pad8(meta.byteLength);
    view.setUint32(payloadAt, payloadBytes, true);
    properties.forEach((property, c) => chunk.set(payloads[c], payloadAt + 8 + property.offset));

    chunks.push(chunk);
    ranges.push({ offset, bytes: chunk.byteLength });
    offset += chunk.byteLength;
  }

  // Spark sizes its packed SH from splatEncoding's sh*Max
  const splatEncoding = maxSh > 0 && radSh === "s8" ? { sh1Max: bandMax[0] || 1, sh2Max: bandMax[1] || 1, sh3Max: bandMax[2] || 1 } : undefined;
  const header = encoder.encode(JSON.stringify({
    version: 1, type: "gsplat", count: data.count, maxSh, lodTree: tree !== undefined, chunkSize, chunks: ranges, splatEncoding,
    shCodeCount: labels ? shPalette!.size : undefined,
  }));
  const file = new Uint8Array(8 + pad8(header.byteLength) + offset);
  const view = new DataView(file.buffer);
  view.setUint32(0, RAD_MAGIC, true);
  view.setUint32(4, header.byteLength, true);
  file.set(header, 8);
  let at = 8 + pad8(header.byteLength);
  for (const chunk of chunks) {
    file.set(chunk, at);
    at += chunk.byteLength;
  }
  progress?.(1, "encoding");
  return file;
}
