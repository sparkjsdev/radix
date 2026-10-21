import { ArrayData } from "./ArrayData";
import { Compression, type BytesInput } from "./compress";
import { SplatMath } from "./math";
import { counter, type Progress } from "./progress";
import { Sh, type ShTarget } from "./sh";
import { Splats, type LoadedSplats, type SplatData, type SplatLayout, type SplatReadOptions, type SplatTarget } from "./splats";

export const SH_C0 = 0.28209479177387814;
const HEADER_MAX_BYTES = 64 * 1024;
const POINT_SCALE = 0.001;

// Older files stop after the scales, and their colors span 0 to 1
export const COMPRESSED_CHUNK_SIZE = 256;
export const COMPRESSED_CHUNK_PROPERTIES = [
  "min_x", "min_y", "min_z", "max_x", "max_y", "max_z",
  "min_scale_x", "min_scale_y", "min_scale_z", "max_scale_x", "max_scale_y", "max_scale_z",
  "min_r", "min_g", "min_b", "max_r", "max_g", "max_b",
];
export const COMPRESSED_VERTEX_PROPERTIES = ["packed_position", "packed_rotation", "packed_scale", "packed_color"];
const COMPRESSED_REQUIRED = 12;
const COLOR_DEFAULTS = [0, 0, 0, 1, 1, 1];

type PlyType = "char" | "uchar" | "short" | "ushort" | "int" | "uint" | "float" | "double";

const TYPES: Record<PlyType, { bytes: number; scale: number }> = {
  char: { bytes: 1, scale: 127 },
  uchar: { bytes: 1, scale: 255 },
  short: { bytes: 2, scale: 32767 },
  ushort: { bytes: 2, scale: 65535 },
  int: { bytes: 4, scale: 2147483647 },
  uint: { bytes: 4, scale: 4294967295 },
  float: { bytes: 4, scale: 1 },
  double: { bytes: 8, scale: 1 },
};

interface PlyProperty {
  name: string;
  type: PlyType;
  // Set for list properties, whose entries have type
  countType?: PlyType;
  offset: number;
}

interface PlyElement {
  name: string;
  count: number;
  properties: PlyProperty[];
  recordSize: number;
}

async function readPly<L extends SplatLayout = "extSplats">(input: BytesInput, { progress, sh, ...target }: SplatReadOptions<L> = {}): Promise<LoadedSplats<L>> {
  const bytes = await Compression.readBytes(input);
  const header = parseHeader(bytes);
  const { headerLength, littleEndian, elements, comments } = header;

  const vertex = elements.find((element) => element.name === "vertex");
  if (!vertex) {
    throw new Error("PLY has no vertex element");
  }

  const prop = (name: string) => vertex.properties.find((p) => p.name === name && !p.countType);
  const has = (name: string) => prop(name) !== undefined;
  const chunk = elements.find((element) => element.name === "chunk");
  if (chunk && COMPRESSED_VERTEX_PROPERTIES.every(has)) {
    return { splats: readCompressed({ bytes, header, vertex, chunk, target, sh, progress }) };
  }
  const standard = ["x", "y", "z", "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3", "opacity", "f_dc_0", "f_dc_1", "f_dc_2"];
  const pointCloud = ["x", "y", "z", "red", "green", "blue"];
  const isStandard = standard.every(has);
  if (!isStandard && !pointCloud.every(has)) {
    throw new Error(`PLY vertex lacks ${(standard.some(has) ? standard : pointCloud).filter((name) => !has(name)).join(", ")}`);
  }
  if (vertex.properties.some((p) => p.countType)) {
    throw new Error("PLY vertex list properties are not supported");
  }

  let shRest = 0;
  while (has(`f_rest_${shRest}`)) {
    shRest += 1;
  }
  const normals = has("nx") && has("ny") && has("nz");
  const metallic = prop("metallic") ?? prop("metalness");
  const roughness = prop("roughness");

  const data = new ArrayData({ count: vertex.count, meta: { format: "ply", comments } });
  const encode = Splats.encoder(Splats.add(data, target));
  const degree = shDegree(shRest);
  const encodeSh = Sh.prepare(data, degree, sh);

  const offset = elementOffset(bytes, headerLength, elements, vertex);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const reader = (property: PlyProperty | undefined, normalized = false) => property && propertyReader(view, property, littleEndian, normalized);
  const r = (name: string, normalized = false) => reader(prop(name), normalized)!;
  const [x, y, z] = [r("x"), r("y"), r("z")];
  const normal = normals ? [r("nx"), r("ny"), r("nz")] : undefined;
  const metal = reader(metallic, true);
  const rough = reader(roughness, true);
  const scale = isStandard ? ["scale_0", "scale_1", "scale_2"].map((name) => r(name)) : [];
  const rot = isStandard ? ["rot_1", "rot_2", "rot_3", "rot_0"].map((name) => r(name)) : [];
  const opacity = isStandard ? r("opacity") : reader(prop("alpha"), true);
  const color = isStandard ? ["f_dc_0", "f_dc_1", "f_dc_2"].map((name) => r(name)) : ["red", "green", "blue"].map((name) => r(name, true));
  // f_rest_{c * N + k} is channel-major, coeffs 3k + c coefficient-major
  const perChannel = shRest / 3;
  const shValues = Sh.COEFFICIENTS[degree] * 3;
  const rest = Array.from({ length: shValues }, (_, v) => r(`f_rest_${(v % 3) * perChannel + Math.floor(v / 3)}`));
  const coeffs = new Float32Array(Sh.VALUES);

  // Reused, so the loop allocates nothing
  const s = Splats.makeExtSplat();
  const q = { x: 0, y: 0, z: 0, w: 1 };
  const tick = counter(progress, vertex.count, "decoding");
  for (let i = 0; i < vertex.count; i += 1) {
    tick(i);
    const base = offset + i * vertex.recordSize;
    s.center.x = x(base);
    s.center.y = y(base);
    s.center.z = z(base);
    s.normal.x = normal ? normal[0](base) : 0;
    s.normal.y = normal ? normal[1](base) : 0;
    s.normal.z = normal ? normal[2](base) : 0;
    s.roughness = rough ? rough(base) : 1;
    s.metallic = metal ? metal(base) : 0;

    if (isStandard) {
      s.scales.x = Math.exp(scale[0](base));
      s.scales.y = Math.exp(scale[1](base));
      s.scales.z = Math.exp(scale[2](base));
      q.x = rot[0](base);
      q.y = rot[1](base);
      q.z = rot[2](base);
      q.w = rot[3](base);
      SplatMath.normalizeQuat(q, s.quaternion);
      s.opacity = 1 / (1 + Math.exp(-opacity!(base)));
      s.rgb.r = 0.5 + SH_C0 * color[0](base);
      s.rgb.g = 0.5 + SH_C0 * color[1](base);
      s.rgb.b = 0.5 + SH_C0 * color[2](base);
    } else {
      s.scales.x = POINT_SCALE;
      s.scales.y = POINT_SCALE;
      s.scales.z = POINT_SCALE;
      s.opacity = opacity ? opacity(base) : 1;
      s.rgb.r = color[0](base);
      s.rgb.g = color[1](base);
      s.rgb.b = color[2](base);
    }
    encode(i, s);
    if (encodeSh) {
      for (let v = 0; v < shValues; v += 1) {
        coeffs[v] = rest[v](base);
      }
      encodeSh(i, coeffs);
    }
  }
  return { splats: data as unknown as SplatData<L> };
}

type PlyHeader = ReturnType<typeof parseHeader>;

// Splat i is quantized in the ranges of chunk floor(i / 256)
function readCompressed<L extends SplatLayout>({ bytes, header: { headerLength, littleEndian, elements, comments }, vertex, chunk, target, sh: shTarget, progress }: {
  bytes: Uint8Array;
  header: PlyHeader;
  vertex: PlyElement;
  chunk: PlyElement;
  target: SplatTarget<L>;
  sh?: ShTarget;
  progress?: Progress;
}): SplatData<L> {
  for (const element of [chunk, vertex]) {
    if (element.properties.some((p) => p.countType)) {
      throw new Error(`PLY ${element.name} list properties are not supported`);
    }
  }
  const chunkProp = (name: string) => chunk.properties.find((p) => p.name === name);
  const missing = COMPRESSED_CHUNK_PROPERTIES.slice(0, COMPRESSED_REQUIRED).filter((name) => !chunkProp(name));
  if (missing.length > 0) {
    throw new Error(`PLY chunk lacks ${missing.join(", ")}`);
  }
  const chunks = Math.ceil(vertex.count / COMPRESSED_CHUNK_SIZE);
  if (chunk.count < chunks) {
    throw new Error(`PLY has ${chunk.count} chunks for ${vertex.count} splats`);
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const stride = COMPRESSED_CHUNK_PROPERTIES.length;
  const ranges = new Float32Array(chunks * stride);
  const chunkOffset = elementOffset(bytes, headerLength, elements, chunk);
  COMPRESSED_CHUNK_PROPERTIES.forEach((name, k) => {
    const property = chunkProp(name);
    const read = property && propertyReader(view, property, littleEndian);
    for (let c = 0; c < chunks; c += 1) {
      ranges[c * stride + k] = read ? read(chunkOffset + c * chunk.recordSize) : COLOR_DEFAULTS[k - COMPRESSED_REQUIRED];
    }
  });

  const sh = elements.find((element) => element.name === "sh");
  let shRest = 0;
  while (sh?.properties.some((p) => p.name === `f_rest_${shRest}`)) {
    shRest += 1;
  }

  const data = new ArrayData({ count: vertex.count, meta: { format: "ply", compressed: true, comments } });
  const encode = Splats.encoder(Splats.add(data, target));
  const degree = shDegree(shRest);
  const encodeSh = Sh.prepare(data, sh && sh.count >= vertex.count ? degree : 0, shTarget);
  // uchar f_rest_{c * N + k}, channel-major, over [-4, 4] as in splat-transform
  const shValues = Sh.COEFFICIENTS[degree] * 3;
  const shOffset = sh && encodeSh ? elementOffset(bytes, headerLength, elements, sh) : 0;
  const shBytes = Uint8Array.from({ length: shValues }, (_, v) => sh!.properties.find((p) => p.name === `f_rest_${(v % 3) * (shRest / 3) + Math.floor(v / 3)}`)?.offset ?? 0);
  const coeffs = new Float32Array(Sh.VALUES);

  const offset = elementOffset(bytes, headerLength, elements, vertex);
  const [position, rotation, scale, color] = COMPRESSED_VERTEX_PROPERTIES.map((name) =>
    propertyReader(view, vertex.properties.find((p) => p.name === name)!, littleEndian));
  const s = Splats.makeExtSplat();
  const q = { x: 0, y: 0, z: 0, w: 1 };
  const tick = counter(progress, vertex.count, "decoding");
  for (let i = 0; i < vertex.count; i += 1) {
    tick(i);
    const base = offset + i * vertex.recordSize;
    const at = Math.floor(i / COMPRESSED_CHUNK_SIZE) * stride;

    const p = position(base);
    s.center.x = ranges[at] + (ranges[at + 3] - ranges[at]) * (((p >>> 21) & 2047) / 2047);
    s.center.y = ranges[at + 1] + (ranges[at + 4] - ranges[at + 1]) * (((p >>> 11) & 1023) / 1023);
    s.center.z = ranges[at + 2] + (ranges[at + 5] - ranges[at + 2]) * ((p & 2047) / 2047);

    const l = scale(base);
    s.scales.x = Math.exp(ranges[at + 6] + (ranges[at + 9] - ranges[at + 6]) * (((l >>> 21) & 2047) / 2047));
    s.scales.y = Math.exp(ranges[at + 7] + (ranges[at + 10] - ranges[at + 7]) * (((l >>> 11) & 1023) / 1023));
    s.scales.z = Math.exp(ranges[at + 8] + (ranges[at + 11] - ranges[at + 8]) * ((l & 2047) / 2047));

    const r = rotation(base);
    const a = (((r >>> 20) & 1023) / 1023 - 0.5) * Math.SQRT2;
    const b = (((r >>> 10) & 1023) / 1023 - 0.5) * Math.SQRT2;
    const c = ((r & 1023) / 1023 - 0.5) * Math.SQRT2;
    const m = Math.sqrt(Math.max(0, 1 - a * a - b * b - c * c));
    const largest = r >>> 30;
    q.w = largest === 0 ? m : a;
    q.x = largest === 0 ? a : largest === 1 ? m : b;
    q.y = largest <= 1 ? b : largest === 2 ? m : c;
    q.z = largest <= 2 ? c : m;
    SplatMath.normalizeQuat(q, s.quaternion);

    const k = color(base);
    s.rgb.r = ranges[at + 12] + (ranges[at + 15] - ranges[at + 12]) * (((k >>> 24) & 255) / 255);
    s.rgb.g = ranges[at + 13] + (ranges[at + 16] - ranges[at + 13]) * (((k >>> 16) & 255) / 255);
    s.rgb.b = ranges[at + 14] + (ranges[at + 17] - ranges[at + 14]) * (((k >>> 8) & 255) / 255);
    s.opacity = (k & 255) / 255;
    encode(i, s);
    if (encodeSh) {
      const record = shOffset + i * sh!.recordSize;
      for (let v = 0; v < shValues; v += 1) {
        coeffs[v] = SH_BYTE_VALUES[bytes[record + shBytes[v]]];
      }
      encodeSh(i, coeffs);
    }
  }
  return data as unknown as SplatData<L>;
}

// splat-transform's SH byte mapping over [-4, 4]
export function decodeCompressedSh(byte: number) {
  return ((byte === 0 ? 0 : byte === 255 ? 1 : (byte + 0.5) / 256) - 0.5) * 8;
}
const SH_BYTE_VALUES = Float64Array.from({ length: 256 }, (_, byte) => decodeCompressedSh(byte));

export function encodeCompressedSh(value: number) {
  return Math.max(0, Math.min(255, Math.trunc((value / 8 + 0.5) * 256)));
}

function writePly(data: ArrayData, { pbr = false, compatibility = false, sh = true, progress }: {
  pbr?: boolean;
  compatibility?: boolean;
  sh?: boolean;
  progress?: Progress;
} = {}): Uint8Array<ArrayBuffer> {
  const decode = Splats.decoder(Splats.get(data).bundle);
  const found = sh ? Sh.find(data.bundles) : undefined;
  const decodeSh = found && Sh.decoder(data, found);
  const perChannel = found ? Sh.COEFFICIENTS[found.degree] : 0;
  const coeffs = new Float32Array(Sh.VALUES);

  const normals = pbr || compatibility;
  const names = ["x", "y", "z", ...(normals ? ["nx", "ny", "nz"] : []), "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3",
    "opacity", "f_dc_0", "f_dc_1", "f_dc_2", ...Array.from({ length: perChannel * 3 }, (_, k) => `f_rest_${k}`), ...(pbr ? ["roughness", "metallic"] : [])];
  const header = new TextEncoder().encode([
    "ply", "format binary_little_endian 1.0", `element vertex ${data.count}`,
    ...names.map((name) => `property float ${name}`), "end_header", "",
  ].join("\n"));

  const bytes = new Uint8Array(header.byteLength + data.count * names.length * 4);
  bytes.set(header);
  const floats = new DataView(bytes.buffer, header.byteLength);

  const s = Splats.makeExtSplat();
  const q = { x: 0, y: 0, z: 0, w: 1 };
  let at = 0;
  const put = (value: number) => {
    floats.setFloat32(at, value, true);
    at += 4;
  };
  const tick = counter(progress, data.count, "encoding");
  for (let i = 0; i < data.count; i += 1) {
    tick(i);
    decode(i, s);

    put(s.center.x);
    put(s.center.y);
    put(s.center.z);
    if (normals) {
      put(pbr ? s.normal.x : 0);
      put(pbr ? s.normal.y : 0);
      put(pbr ? s.normal.z : 0);
    }
    put(Math.log(Math.max(s.scales.x, 1e-12)));
    put(Math.log(Math.max(s.scales.y, 1e-12)));
    put(Math.log(Math.max(s.scales.z, 1e-12)));
    SplatMath.normalizeQuat(s.quaternion, q);
    put(q.w);
    put(q.x);
    put(q.y);
    put(q.z);

    const opacity = Math.max(1e-12, Math.min(1 - 1e-12, s.opacity));
    put(Math.max(-100, Math.min(100, Math.log(opacity / (1 - opacity)))));
    put((s.rgb.r - 0.5) / SH_C0);
    put((s.rgb.g - 0.5) / SH_C0);
    put((s.rgb.b - 0.5) / SH_C0);
    if (decodeSh) {
      decodeSh(i, coeffs);
      for (let c = 0; c < 3; c += 1) {
        for (let k = 0; k < perChannel; k += 1) {
          put(coeffs[k * 3 + c]);
        }
      }
    }
    if (pbr) {
      put(s.roughness);
      put(s.metallic);
    }
  }
  return bytes;
}

/** Reads and writes binary PLY splat files, and reads compressed PLY. */
export class PlyFile {
  /** Reads a binary PLY file of splats or points, or a compressed PLY file. */
  static readonly read = readPly;
  /**
   * Writes a table's splat bundle as standard 3DGS PLY.
   *
   * @param [options.pbr=false] Whether to write ext splats' normals, roughness
   *   and metallic.
   * @param [options.compatibility=false] Whether to write zero normals for
   *   tools that expect them.
   * @param [options.sh=true] Whether to write the SH bundle.
   */
  static readonly write = writePly;
}

function parseHeader(bytes: Uint8Array) {
  const text = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.byteLength, HEADER_MAX_BYTES)));
  const end = text.search(/end_header\r?\n/);
  if (!text.startsWith("ply") || end < 0) {
    throw new Error("Invalid PLY header");
  }
  const headerLength = new TextEncoder().encode(text.slice(0, end)).byteLength + text.slice(end).match(/end_header\r?\n/)![0].length;

  let littleEndian: boolean | undefined;
  const elements: PlyElement[] = [];
  const comments: string[] = [];
  for (const line of text.slice(0, end).split(/\r?\n/).slice(1)) {
    const fields = line.trim().split(/\s+/);
    if (fields[0] === "format") {
      if (fields[1] !== "binary_little_endian" && fields[1] !== "binary_big_endian") {
        throw new Error(`Unsupported PLY format ${fields[1]}`);
      }
      littleEndian = fields[1] === "binary_little_endian";
    } else if (fields[0] === "comment") {
      comments.push(line.trim().slice(8));
    } else if (fields[0] === "element") {
      elements.push({ name: fields[1], count: Number.parseInt(fields[2], 10), properties: [], recordSize: 0 });
    } else if (fields[0] === "property") {
      const element = elements.at(-1);
      if (!element) {
        throw new Error("PLY property outside an element");
      }
      if (fields[1] === "list") {
        element.properties.push({ name: fields[4], type: plyType(fields[3]), countType: plyType(fields[2]), offset: -1 });
      } else {
        const type = plyType(fields[1]);
        element.properties.push({ name: fields[2], type, offset: element.recordSize });
        element.recordSize += TYPES[type].bytes;
      }
    }
  }

  if (littleEndian === undefined) {
    throw new Error("PLY header has no format line");
  }
  return { headerLength, littleEndian, elements, comments };
}

function plyType(name: string): PlyType {
  const aliases: Record<string, PlyType> = {
    int8: "char", uint8: "uchar", int16: "short", uint16: "ushort", int32: "int", uint32: "uint", float32: "float", float64: "double",
  };
  const type = (aliases[name] ?? name) as PlyType;
  if (!TYPES[type]) {
    throw new Error(`Unsupported PLY property type ${name}`);
  }
  return type;
}

function shDegree(shRest: number) {
  return shRest >= 72 ? 4 : shRest >= 45 ? 3 : shRest >= 24 ? 2 : shRest > 0 ? 1 : 0;
}

function elementOffset(bytes: Uint8Array, headerLength: number, elements: PlyElement[], element: PlyElement) {
  let offset = headerLength;
  for (const before of elements) {
    if (before === element) {
      break;
    }
    if (before.properties.some((p) => p.countType)) {
      throw new Error(`PLY element ${before.name} before ${element.name} has list properties`);
    }
    offset += before.count * before.recordSize;
  }
  if (offset + element.count * element.recordSize > bytes.byteLength) {
    throw new Error("PLY file ended unexpectedly");
  }
  return offset;
}

// normalized maps integers to [0, 1] or [-1, 1]
function propertyReader(view: DataView, { offset: at, type }: PlyProperty, littleEndian: boolean, normalized = false) {
  if (type === "float") {
    return (base: number) => view.getFloat32(base + at, littleEndian);
  }
  if (type === "uint" && !normalized) {
    return (base: number) => view.getUint32(base + at, littleEndian);
  }
  const scale = normalized ? TYPES[type].scale : 1;
  return (base: number) => readScalar(view, base + at, type, littleEndian) / scale;
}

function readScalar(view: DataView, offset: number, type: PlyType, littleEndian: boolean) {
  switch (type) {
    case "char": return view.getInt8(offset);
    case "uchar": return view.getUint8(offset);
    case "short": return view.getInt16(offset, littleEndian);
    case "ushort": return view.getUint16(offset, littleEndian);
    case "int": return view.getInt32(offset, littleEndian);
    case "uint": return view.getUint32(offset, littleEndian);
    case "float": return view.getFloat32(offset, littleEndian);
    case "double": return view.getFloat64(offset, littleEndian);
  }
}
