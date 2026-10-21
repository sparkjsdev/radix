import { ArrayData } from "./ArrayData";
import { Axes, type AxesConverter, type CoordinateSystem } from "./axes";
import { ByteReader, Compression, type BytesInput } from "./compress";
import { Encoding } from "./encoding";
import { SplatMath, type Quat } from "./math";
import { SH_C0 } from "./ply";
import { counter, span, type Progress } from "./progress";
import { Sh, type ShDegree } from "./sh";
import { Splats, type LoadedSplats, type SplatData, type SplatLayout, type SplatReadOptions } from "./splats";
import { Zstd } from "./zstd";

export const SPZ_MAGIC = 0x5053474e; // "NGSP"
const GZIP_LATEST = 4;
const NGSP_VERSION = 4;
const FLAG_ANTIALIASED = 0x01;
const FLAG_EXTENSIONS = 0x02;
const FLAG_PBR = 0x40;
const FLAG_LOD = 0x80;

const RECORD_SAFE_ORBIT = 0xadbe0002;
const RECORD_COORDINATE_SYSTEM = 0xadbe0003;
const RECORD_LOD = 0x52580001;
const RECORD_PBR = 0x52580002;

const LOD_BYTES = 6;
const PBR_BYTES = 5;

const COLOR_SCALE = SH_C0 / 0.15;
const SH_VECTORS: Record<number, number> = { 0: 0, 1: 3, 2: 8, 3: 15, 4: 24 };

/** The options of SpzFile.write. */
export interface SpzWriteOptions {
  /**
   * The version, where 2 and 3 use the gzip container and 4 SPZ 4's.
   *
   * @default 3
   */
  version?: 2 | 3 | 4;
  /**
   * Fraction bits of the 24-bit fixed-point centers.
   *
   * @default 12
   */
  fractionalBits?: number;
  /**
   * The file's antialiasing flag.
   *
   * @default true
   */
  antialiased?: boolean;
  /**
   * Whether to write ext splats' normals, roughness and metallic.
   *
   * @default false
   */
  pbr?: boolean;
  /**
   * Whether to write the lodTree bundle, whose child counts must be below 2^16.
   *
   * @default true when the data has a lodTree
   */
  lod?: boolean;
  /**
   * Whether to write the SH bundle.
   *
   * @default true
   */
  sh?: boolean;
  /**
   * The system to record in version 4. The data is not converted.
   *
   * @default meta.coordinateSystem
   */
  coordinateSystem?: CoordinateSystem;
  /**
   * Node's zstd level for version 4, from 1 to 22.
   *
   * @default 12
   */
  zstdLevel?: number;
  progress?: Progress;
}

/** An extension record of an SPZ file. */
export interface SpzExtension {
  type: number;
  data: Uint8Array<ArrayBuffer>;
}

/** An SPZ file's header and byte columns, before decoding. */
export interface SpzUnpacked {
  /** The container, where ngsp is SPZ 4's. */
  container: "gzip" | "ngsp";
  version: number;
  count: number;
  /** The SH degree, from 0 to 4. */
  shDegree: number;
  /** Fraction bits of the 24-bit fixed-point centers. */
  fractionalBits: number;
  flags: number;
  /** The centers, 9 bytes per splat, or 6 in version 1. */
  centers: Uint8Array<ArrayBuffer>;
  /** The opacities, 1 byte per splat. */
  alphas: Uint8Array<ArrayBuffer>;
  /** The colors, 3 bytes per splat. */
  colors: Uint8Array<ArrayBuffer>;
  /** The scales, 3 bytes per splat. */
  scales: Uint8Array<ArrayBuffer>;
  /** The rotations, 4 bytes per splat from version 3, or 3 before. */
  rotations: Uint8Array<ArrayBuffer>;
  /** The SH, 3 bytes per coefficient, or undefined at degree 0 or with sh: false. */
  sh?: Uint8Array<ArrayBuffer>;
  /** Radix's LoD tree, 6 bytes per splat. */
  lodTree?: Uint8Array<ArrayBuffer>;
  /** Radix's PBR data, 5 bytes per splat. */
  pbr?: Uint8Array<ArrayBuffer>;
  /** The other extension records, in file order. */
  extensions: SpzExtension[];
}

const le32 = (bytes: Uint8Array, at: number) => (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0;

// [u32 type][u32 byteLength][payload], to the end
function parseRecords(bytes: Uint8Array<ArrayBuffer>): SpzExtension[] {
  const records: SpzExtension[] = [];
  let at = 0;
  while (at + 8 <= bytes.byteLength) {
    const type = le32(bytes, at);
    const length = le32(bytes, at + 4);
    if (at + 8 + length > bytes.byteLength) {
      throw new Error(`SPZ extension record 0x${type.toString(16)} runs past its end`);
    }
    records.push({ type, data: bytes.subarray(at + 8, at + 8 + length) });
    at += 8 + length;
  }
  return records;
}

async function splitRecords(records: SpzExtension[], count: number, out: Pick<SpzUnpacked, "lodTree" | "pbr" | "extensions">) {
  for (const record of records) {
    if (record.type === RECORD_LOD) {
      out.lodTree = await Zstd.decompress(record.data, count * LOD_BYTES);
    } else if (record.type === RECORD_PBR) {
      out.pbr = await Zstd.decompress(record.data, count * PBR_BYTES);
    } else {
      out.extensions.push(record);
    }
  }
}

function checkHeader(version: number, shDegree: number, latest: number) {
  if (version < 1 || version > latest || !(shDegree in SH_VECTORS)) {
    throw new Error(`Unsupported SPZ version ${version} or SH degree ${shDegree}`);
  }
}

async function unpackGzip(r: ByteReader, sh: boolean): Promise<SpzUnpacked> {
  const head = await r.read(16);
  if (le32(head, 0) !== SPZ_MAGIC) {
    throw new Error("Invalid SPZ file");
  }
  const version = le32(head, 4);
  const count = le32(head, 8);
  const [shDegree, fractionalBits, flags] = [head[12], head[13], head[14]];
  // Version 4 in gzip is version 3's layout
  checkHeader(version, shDegree, GZIP_LATEST);
  const shBytes = count * SH_VECTORS[shDegree] * 3;
  const out: SpzUnpacked = {
    container: "gzip", version, count, shDegree, fractionalBits, flags,
    centers: await r.read(count * (version === 1 ? 6 : 9)),
    alphas: await r.read(count),
    colors: await r.read(count * 3),
    scales: await r.read(count * 3),
    rotations: await r.read(count * (version >= 3 ? 4 : 3)),
    extensions: [],
  };
  if (sh && shBytes > 0) {
    out.sh = await r.read(shBytes);
  } else {
    await r.skip(shBytes);
  }
  if (flags & FLAG_LOD) {
    out.lodTree = await r.read(count * LOD_BYTES);
  }
  if (flags & FLAG_PBR) {
    out.pbr = await r.read(count * PBR_BYTES);
  }
  if (flags & FLAG_EXTENSIONS) {
    await splitRecords(parseRecords(await r.rest()), count, out);
  } else {
    r.cancel();
  }
  return out;
}

async function unpackNgsp(r: ByteReader, sh: boolean): Promise<SpzUnpacked> {
  const head = await r.read(32);
  const version = le32(head, 4);
  const count = le32(head, 8);
  const [shDegree, fractionalBits, flags, numStreams] = [head[12], head[13], head[14], head[15]];
  const tocByteOffset = le32(head, 16);
  if (version !== NGSP_VERSION) {
    throw new Error(`Unsupported SPZ version ${version} in the NGSP container`);
  }
  checkHeader(version, shDegree, NGSP_VERSION);
  if (count > 0x7fffffff) {
    throw new Error(`Invalid SPZ point count ${count}`);
  }
  if (tocByteOffset < 32) {
    throw new Error("SPZ 4 table of contents inside the header");
  }
  const records = await r.read(tocByteOffset - 32);
  // Bytes per splat of centers, alphas, colors, scales, rotations and SH
  const sizes = [9, 1, 3, 3, 4, SH_VECTORS[shDegree] * 3].map((bytes) => count * bytes);
  const present = sizes.flatMap((size, i) => (size > 0 ? [i] : []));
  if (numStreams !== present.length) {
    throw new Error(`SPZ 4 file with ${numStreams} streams, ${present.length} expected`);
  }
  const toc = await r.read(numStreams * 16);
  const compressed: number[] = [];
  let total = tocByteOffset + toc.byteLength;
  for (let k = 0; k < numStreams; k += 1) {
    const [low, high, sizeLow, sizeHigh] = [0, 4, 8, 12].map((at) => le32(toc, k * 16 + at));
    if (high >= 1 << 21 || sizeHigh !== 0 || sizeLow !== sizes[present[k]]) {
      throw new Error(`SPZ 4 stream ${k} sizes don't match its header`);
    }
    compressed.push(high * 2 ** 32 + low);
    total += compressed[k];
  }
  // Upstream's bound
  if (count * 9 > total * 1024) {
    throw new Error(`Invalid SPZ point count ${count} for ${total} bytes`);
  }
  const columns: Uint8Array<ArrayBuffer>[] = sizes.map(() => new Uint8Array(0));
  let complete = true;
  for (let k = 0; k < numStreams; k += 1) {
    if (present[k] === 5 && !sh) {
      r.cancel();
      complete = false;
      break;
    }
    columns[present[k]] = await Zstd.decompress(await r.read(compressed[k]), sizes[present[k]]);
  }
  if (complete && !(await r.atEnd())) {
    throw new Error("SPZ 4 file has bytes after its last stream");
  }
  const out: SpzUnpacked = {
    container: "ngsp", version, count, shDegree, fractionalBits, flags,
    centers: columns[0], alphas: columns[1], colors: columns[2], scales: columns[3], rotations: columns[4],
    sh: sh && columns[5].byteLength > 0 ? columns[5] : undefined,
    extensions: [],
  };
  if (flags & FLAG_EXTENSIONS) {
    await splitRecords(parseRecords(records), count, out);
  }
  return out;
}

// Reads in order, so a stream decodes as it arrives
async function unpackSpz(input: BytesInput, { sh = true }: { sh?: boolean } = {}): Promise<SpzUnpacked> {
  const raw = new ByteReader(input, "SPZ file");
  const head = await raw.peek(4);
  if (head.byteLength === 4 && le32(head, 0) === SPZ_MAGIC) {
    return unpackNgsp(raw, sh);
  }
  if (head[0] !== 0x1f || head[1] !== 0x8b) {
    raw.cancel();
    throw new Error("Invalid SPZ file");
  }
  return unpackGzip(new ByteReader(raw.stream().pipeThrough(new DecompressionStream("gzip")), "SPZ file"), sh);
}

async function readSpz<L extends SplatLayout = "extSplats">(input: BytesInput, {
  progress, sh: shTarget, coordinateSystem, ...target
}: SplatReadOptions<L> = {}): Promise<LoadedSplats<L>> {
  const u = await unpackSpz(input, { sh: shTarget !== false });
  const { version, count, shDegree } = u;
  const meta: Record<string, unknown> = { format: "spz", version, container: u.container, antialiased: (u.flags & FLAG_ANTIALIASED) !== 0 };
  let stored: CoordinateSystem = "RUB";
  const skipped: number[] = [];
  for (const { type, data: bytes } of u.extensions) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (type === RECORD_SAFE_ORBIT && bytes.byteLength >= 12) {
      meta.safeOrbitCamera = { elevationMin: view.getFloat32(0, true), elevationMax: view.getFloat32(4, true), radiusMin: view.getFloat32(8, true) };
    } else if (type === RECORD_COORDINATE_SYSTEM && bytes.byteLength >= 4) {
      const code = view.getUint32(0, true);
      if (code > Axes.SYSTEMS.length) {
        throw new Error(`Unknown SPZ coordinate system ${code}`);
      }
      stored = code === 0 ? "RUB" : Axes.SYSTEMS[code - 1];
    } else {
      skipped.push(type);
    }
  }
  if (skipped.length > 0) {
    meta.skippedExtensions = skipped;
  }
  meta.coordinateSystem = coordinateSystem ?? stored;
  const convert: AxesConverter | undefined = coordinateSystem && coordinateSystem !== stored ? Axes.converter(stored, coordinateSystem) : undefined;

  const data = new ArrayData({ count, meta });
  const encode = Splats.encoder(Splats.add(data, target));
  const encodeSh = Sh.prepare(data, shDegree, shTarget);
  const shValues = SH_VECTORS[shDegree] * 3;
  const coeffs = new Float32Array(Sh.VALUES);

  const { centers, alphas, colors, scales, rotations, sh, pbr } = u;
  const centerView = new DataView(centers.buffer, centers.byteOffset, centers.byteLength);
  const rotationView = new DataView(rotations.buffer, rotations.byteOffset, rotations.byteLength);
  const fixed = 1 / (1 << u.fractionalBits);
  const int24 = (at: number) => ((centers[at] | (centers[at + 1] << 8) | (centers[at + 2] << 16)) << 8) >> 8;
  // Reused, so the loop allocates nothing
  const s = Splats.makeExtSplat();
  const color = (byte: number) => (byte / 255 - 0.5) * COLOR_SCALE + 0.5;
  const scale = (byte: number) => Math.exp(byte / 16 - 10);
  const tick = counter(progress, count, "decoding");
  for (let i = 0; i < count; i += 1) {
    tick(i);
    if (version === 1) {
      s.center.x = Encoding.decodeHalf(centerView.getUint16(i * 6, true));
      s.center.y = Encoding.decodeHalf(centerView.getUint16(i * 6 + 2, true));
      s.center.z = Encoding.decodeHalf(centerView.getUint16(i * 6 + 4, true));
    } else {
      s.center.x = int24(i * 9) * fixed;
      s.center.y = int24(i * 9 + 3) * fixed;
      s.center.z = int24(i * 9 + 6) * fixed;
    }

    s.opacity = alphas[i] / 255;
    s.rgb.r = color(colors[i * 3]);
    s.rgb.g = color(colors[i * 3 + 1]);
    s.rgb.b = color(colors[i * 3 + 2]);
    s.scales.x = scale(scales[i * 3]);
    s.scales.y = scale(scales[i * 3 + 1]);
    s.scales.z = scale(scales[i * 3 + 2]);

    if (version >= 3) {
      decodeSmallestThree(rotationView.getUint32(i * 4, true), s.quaternion);
    } else {
      const x = rotations[i * 3] / 127.5 - 1;
      const y = rotations[i * 3 + 1] / 127.5 - 1;
      const z = rotations[i * 3 + 2] / 127.5 - 1;
      s.quaternion.x = x;
      s.quaternion.y = y;
      s.quaternion.z = z;
      s.quaternion.w = Math.sqrt(Math.max(0, 1 - x * x - y * y - z * z));
    }

    if (pbr) {
      Encoding.decodeOct24(pbr[i * 3] | (pbr[i * 3 + 1] << 8) | (pbr[i * 3 + 2] << 16), s.normal);
      s.roughness = pbr[count * 3 + i] / 255;
      s.metallic = pbr[count * 4 + i] / 255;
    }
    encode(i, convert ? convert.splat(s) : s);
    if (encodeSh && sh) {
      for (let v = 0; v < shValues; v += 1) {
        coeffs[v] = (sh[i * shValues + v] - 128) / 128;
      }
      encodeSh(i, convert ? convert.sh(coeffs, shDegree as ShDegree) : coeffs);
    }
  }

  if (u.lodTree) {
    const tree = new DataView(u.lodTree.buffer, u.lodTree.byteOffset, u.lodTree.byteLength);
    const nodes = data.addBundle("lodTree", Splats.LOD_TREE).bundles.lodTree.channels.node.data;
    for (let i = 0; i < count; i += 1) {
      nodes[i * 2] = tree.getUint16(i * 2, true);
      nodes[i * 2 + 1] = tree.getUint32(count * 2 + i * 4, true);
    }
  }
  return { splats: data as unknown as SplatData<L> };
}

function record(type: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + payload.byteLength);
  const view = new DataView(out.buffer);
  view.setUint32(0, type, true);
  view.setUint32(4, payload.byteLength, true);
  out.set(payload, 8);
  return out;
}

const concat = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
};

async function writeSpz(data: ArrayData, {
  version = 3, fractionalBits = 12, antialiased = true, pbr = false, lod, sh = true, coordinateSystem, zstdLevel, progress,
}: SpzWriteOptions = {}): Promise<Uint8Array<ArrayBuffer>> {
  if (version !== 2 && version !== 3 && version !== 4) {
    throw new Error(`SPZ version ${String(version)} cannot be written (2, 3 or 4)`);
  }
  const decode = Splats.decoder(Splats.get(data).bundle);
  const tree = Splats.findLodTree(data);
  const withLod = lod ?? tree !== undefined;
  if (withLod && !tree) {
    throw new Error("SpzFile.write with lod needs a lodTree bundle");
  }
  const found = sh ? Sh.find(data.bundles) : undefined;
  const decodeSh = found && Sh.decoder(data, found);
  const shValues = found ? SH_VECTORS[found.degree] * 3 : 0;
  const coeffs = new Float32Array(Sh.VALUES);

  // Laid out as gzip, which SPZ 4 then splits into its streams
  const count = data.count;
  const rotationBytes = version === 2 ? 3 : 4;
  const alphas = 16 + count * 9;
  const colors = alphas + count;
  const scales = colors + count * 3;
  const rotations = scales + count * 3;
  const shStart = rotations + count * rotationBytes;
  const lodStart = shStart + count * shValues;
  const pbrStart = lodStart + (withLod ? count * LOD_BYTES : 0);
  const size = pbrStart + (pbr ? count * PBR_BYTES : 0);
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  const flags = (antialiased ? FLAG_ANTIALIASED : 0);
  view.setUint32(0, SPZ_MAGIC, true);
  view.setUint32(4, version, true);
  view.setUint32(8, count, true);
  view.setUint8(12, found?.degree ?? 0);
  view.setUint8(13, fractionalBits);
  view.setUint8(14, flags | (version < 4 ? (pbr ? FLAG_PBR : 0) | (withLod ? FLAG_LOD : 0) : 0));

  const fixed = 1 << fractionalBits;
  const byte = (value: number) => Math.round(Math.max(0, Math.min(255, value)));
  const colorByte = (value: number) => byte(((value - 0.5) / COLOR_SCALE + 0.5) * 255);
  const scaleByte = (value: number) => byte((Math.log(Math.max(value, Number.MIN_VALUE)) + 10) * 16);
  // 24-bit signed fixed point, little-endian
  const putCenter = (at: number, value: number) => {
    const code = Math.max(-0x7fffff, Math.min(0x7fffff, Math.round(value * fixed)));
    bytes[at] = code & 0xff;
    bytes[at + 1] = (code >> 8) & 0xff;
    bytes[at + 2] = (code >> 16) & 0xff;
  };
  const s = Splats.makeExtSplat();
  const q = { x: 0, y: 0, z: 0, w: 1 };
  const tick = counter(span(progress, 0, 0.8), count, "encoding");
  for (let i = 0; i < count; i += 1) {
    tick(i);
    decode(i, s);
    putCenter(16 + i * 9, s.center.x);
    putCenter(16 + i * 9 + 3, s.center.y);
    putCenter(16 + i * 9 + 6, s.center.z);
    bytes[colors + i * 3] = colorByte(s.rgb.r);
    bytes[colors + i * 3 + 1] = colorByte(s.rgb.g);
    bytes[colors + i * 3 + 2] = colorByte(s.rgb.b);
    bytes[scales + i * 3] = scaleByte(s.scales.x);
    bytes[scales + i * 3 + 1] = scaleByte(s.scales.y);
    bytes[scales + i * 3 + 2] = scaleByte(s.scales.z);
    bytes[alphas + i] = byte(s.opacity * 255);

    if (version === 2) {
      SplatMath.normalizeQuat(s.quaternion, q);
      const sign = q.w < 0 ? -1 : 1;
      bytes[rotations + i * 3] = byte((q.x * sign + 1) * 127.5);
      bytes[rotations + i * 3 + 1] = byte((q.y * sign + 1) * 127.5);
      bytes[rotations + i * 3 + 2] = byte((q.z * sign + 1) * 127.5);
    } else {
      view.setUint32(rotations + i * 4, encodeSmallestThree(s.quaternion), true);
    }
    if (decodeSh) {
      decodeSh(i, coeffs);
      for (let v = 0; v < shValues; v += 1) {
        bytes[shStart + i * shValues + v] = byte(coeffs[v] * 128 + 128);
      }
    }

    if (withLod) {
      const nodes = tree!.channels.node.data;
      view.setUint16(lodStart + i * 2, nodes[i * 2] & 0xffff, true);
      view.setUint32(lodStart + count * 2 + i * 4, nodes[i * 2 + 1], true);
    }
    if (pbr) {
      const normal = Encoding.encodeOct24(s.normal);
      bytes[pbrStart + i * 3] = normal & 0xff;
      bytes[pbrStart + i * 3 + 1] = (normal >> 8) & 0xff;
      bytes[pbrStart + i * 3 + 2] = (normal >> 16) & 0xff;
      bytes[pbrStart + count * 3 + i] = Encoding.encodeUnorm8(s.roughness);
      bytes[pbrStart + count * 4 + i] = Encoding.encodeUnorm8(s.metallic);
    }
  }

  progress?.(0.8, "compressing");
  if (version < 4) {
    const compressed = await Compression.gzip(bytes);
    progress?.(1, "compressing");
    return compressed;
  }

  const records: Uint8Array[] = [];
  const orbit = data.meta.safeOrbitCamera as { elevationMin: number; elevationMax: number; radiusMin: number } | undefined;
  if (orbit) {
    records.push(record(RECORD_SAFE_ORBIT, new Uint8Array(Float32Array.of(orbit.elevationMin, orbit.elevationMax, orbit.radiusMin).buffer)));
  }
  const system = coordinateSystem ?? (data.meta.coordinateSystem as CoordinateSystem | undefined);
  if (system && system !== "RUB") {
    const code = Axes.SYSTEMS.indexOf(system) + 1;
    if (code === 0) {
      throw new Error(`Unknown coordinate system ${system}`);
    }
    records.push(record(RECORD_COORDINATE_SYSTEM, new Uint8Array(Uint32Array.of(code).buffer)));
  }
  if (withLod) {
    records.push(record(RECORD_LOD, await Zstd.compress(bytes.subarray(lodStart, pbrStart), { level: zstdLevel })));
  }
  if (pbr) {
    records.push(record(RECORD_PBR, await Zstd.compress(bytes.subarray(pbrStart, size), { level: zstdLevel })));
  }
  const streams: Uint8Array[] = [];
  const sizes: number[] = [];
  const bounds = [16, alphas, colors, scales, rotations, shStart, lodStart];
  for (let k = 0; k < 6; k += 1) {
    if (bounds[k + 1] > bounds[k]) {
      streams.push(await Zstd.compress(bytes.subarray(bounds[k], bounds[k + 1]), { level: zstdLevel }));
      sizes.push(bounds[k + 1] - bounds[k]);
    }
  }
  const extensions = concat(records);
  const head = new Uint8Array(32 + extensions.byteLength + streams.length * 16);
  const headView = new DataView(head.buffer);
  headView.setUint32(0, SPZ_MAGIC, true);
  headView.setUint32(4, NGSP_VERSION, true);
  headView.setUint32(8, count, true);
  head[12] = found?.degree ?? 0;
  head[13] = fractionalBits;
  head[14] = flags | (records.length > 0 ? FLAG_EXTENSIONS : 0);
  head[15] = streams.length;
  headView.setUint32(16, 32 + extensions.byteLength, true);
  head.set(extensions, 32);
  for (let k = 0; k < streams.length; k += 1) {
    const at = 32 + extensions.byteLength + k * 16;
    headView.setUint32(at, streams[k].byteLength % 2 ** 32, true);
    headView.setUint32(at + 4, Math.floor(streams[k].byteLength / 2 ** 32), true);
    headView.setUint32(at + 8, sizes[k], true);
  }
  progress?.(1, "compressing");
  return concat([head, ...streams]) as Uint8Array<ArrayBuffer>;
}

/** Reads and writes SPZ files, with SH up to degree 4. */
export class SpzFile {
  /** Reads versions 1 to 4 in the gzip container, and SPZ 4. */
  static readonly read = readSpz;
  /** Writes a table's splat bundle, in any layout. */
  static readonly write = writeSpz;
  /**
   * Reads the header and byte columns without decoding them.
   *
   * @param [options.sh=true] Whether to read the SH.
   */
  static readonly unpack = unpackSpz;
}

// The largest component's index in the top 2 bits, then the others in 10 bits:
// a sign and a 9-bit magnitude over sqrt(1/2)
function encodeSmallestThree(quaternion: Quat) {
  const n = SplatMath.normalizeQuat(quaternion, { x: 0, y: 0, z: 0, w: 1 });
  const q = [n.x, n.y, n.z, n.w];
  let largest = 0;
  for (let i = 1; i < 4; i += 1) {
    if (Math.abs(q[i]) > Math.abs(q[largest])) {
      largest = i;
    }
  }

  const negate = q[largest] < 0 ? 1 : 0;
  let packed = largest;
  for (let i = 0; i < 4; i += 1) {
    if (i !== largest) {
      const sign = (q[i] < 0 ? 1 : 0) ^ negate;
      const magnitude = Math.max(0, Math.min(511, Math.round((511 * Math.abs(q[i])) / Math.SQRT1_2)));
      packed = (packed << 10) | (sign << 9) | magnitude;
    }
  }
  return packed >>> 0;
}

function decodeSmallestThree(packed: number, out: Quat) {
  const largest = packed >>> 30;
  const q = [0, 0, 0, 0];
  let rest = packed;
  let sum = 0;
  for (let i = 3; i >= 0; i -= 1) {
    if (i !== largest) {
      const value = Math.SQRT1_2 * ((rest & 511) / 511) * ((rest >>> 9) & 1 ? -1 : 1);
      rest >>>= 10;
      q[i] = value;
      sum += value * value;
    }
  }
  q[largest] = Math.sqrt(Math.max(1 - sum, 0));
  [out.x, out.y, out.z, out.w] = q;
}
