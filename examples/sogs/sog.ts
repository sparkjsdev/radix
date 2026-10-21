// Decoding follows PlayCanvas's reference loader and Spark's spark-lib sogs.rs
import { ArrayData, Sh, ShPalette, SplatMath, Splats, type ShDegree, type SplatLayout } from "@sparkjsdev/radix";
import { decodePixels, type Pixels } from "./webp.js";
import { ZipArchive } from "./zip.js";

export const SH_C0 = 0.28209479177387814;

// Coefficients per color beyond the base color, by degree
export const SH_COEFFICIENTS = Sh.COEFFICIENTS;

export const LABEL_BUNDLE = Sh.LABEL;

export interface SogMeta {
  version: 1 | 2;
  count: number;
  means: { mins: number[]; maxs: number[]; files: string[] };
  scales: { mins?: number[]; maxs?: number[]; codebook?: number[]; files: string[] };
  quats: { files: string[] };
  sh0: { mins?: number[]; maxs?: number[]; codebook?: number[]; files: string[] };
  shN?: { mins?: number; maxs?: number; codebook?: number[]; files: string[] };
  // From v2's bands or v1's shN.shape, else from the centroid image when decoding
  degree?: number;
  paletteSize?: number;
}

interface RawMeta {
  version?: number;
  count?: number;
  means: { mins: number[]; maxs: number[]; files: string[]; shape?: number[] };
  scales: SogMeta["scales"];
  quats: { files: string[]; encoding?: string };
  sh0: SogMeta["sh0"];
  shN?: { mins?: number; maxs?: number; codebook?: (number | null)[]; files: string[]; count?: number; bands?: number; shape?: number[] };
}

// Codebooks may start with null: PlayCanvas extrapolates entry 0
function patchCodebook(codebook?: (number | null)[]): number[] | undefined {
  if (codebook && codebook[0] === null) {
    codebook[0] = codebook[1]! + (codebook[1]! - codebook[255]!) / 255;
  }
  return codebook as number[] | undefined;
}

export function isSogMeta(json: unknown): json is RawMeta {
  const meta = json as RawMeta;
  return typeof meta === "object" && meta !== null && Array.isArray(meta.means?.files) && Array.isArray(meta.quats?.files) && Array.isArray(meta.sh0?.files);
}

export function parseSogMeta(json: unknown): SogMeta {
  if (!isSogMeta(json)) {
    throw new Error("Not a SOG meta.json");
  }
  const raw = json;
  const version = raw.version === 2 ? 2 : 1;
  if (version === 1 && raw.quats.encoding && raw.quats.encoding !== "quaternion_packed") {
    throw new Error(`SOGS quaternion encoding ${raw.quats.encoding} is not supported`);
  }
  const count = version === 2 ? raw.count : raw.means.shape?.[0];
  if (!count) {
    throw new Error("SOG meta.json has no splat count");
  }

  const meta: SogMeta = {
    version,
    count,
    means: raw.means,
    scales: { ...raw.scales, codebook: patchCodebook(raw.scales.codebook) },
    quats: raw.quats,
    sh0: { ...raw.sh0, codebook: patchCodebook(raw.sh0.codebook) },
  };
  const shN = raw.shN;
  if (shN) {
    meta.shN = { ...shN, codebook: patchCodebook(shN.codebook) };
    if (version === 2 && shN.bands) {
      meta.degree = Math.min(3, shN.bands);
    } else if (version === 1 && shN.shape) {
      const values = shN.shape[1];
      meta.degree = values >= 42 ? 3 : values >= 24 ? 2 : values >= 9 ? 1 : undefined;
    }
    meta.paletteSize = version === 2 ? shN.count : undefined;
  }
  return meta;
}

export type Progress = (fraction: number, stage: string) => void;

// One SOG's meta and its files by the names meta.json gives
export interface SogSource {
  name: string;
  meta: SogMeta;
  getFile(name: string): Promise<Uint8Array<ArrayBuffer>>;
}

export type SogInput =
  | { kind: "sog"; source: SogSource }
  | { kind: "lod"; json: unknown; url: string };

export async function fetchBytes(url: string, onProgress?: Progress, stage = "downloading"): Promise<Uint8Array<ArrayBuffer>> {
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`${url}: HTTP ${response.status}`);
  }
  const total = Number(response.headers.get("content-length")) || 0;
  let read = 0;
  const counted = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      read += chunk.byteLength;
      onProgress?.(total ? Math.min(read / total, 1) : 0, stage);
      controller.enqueue(chunk);
    },
  }));
  return new Uint8Array(await new Response(counted).arrayBuffer());
}

const baseName = (path: string) => path.split(/[\\/]/).pop() ?? path;

// meta.json may sit in a folder of the archive, beside the files it names
async function archiveSource(bytes: Uint8Array<ArrayBuffer>, name: string): Promise<SogSource> {
  const zip = new ZipArchive(bytes);
  const metaName = [...zip.entries.keys()].filter((entry) => baseName(entry) === "meta.json").sort((a, b) => a.length - b.length)[0];
  if (!metaName) {
    throw new Error(`${name}: no meta.json in the archive`);
  }
  const prefix = metaName.slice(0, metaName.length - "meta.json".length);
  const metaBytes = await zip.read(metaName);
  return {
    name,
    meta: parseSogMeta(JSON.parse(new TextDecoder().decode(metaBytes))),
    getFile: (file) => zip.read(zip.entries.has(prefix + file) ? prefix + file : file),
  };
}

export function urlSource(url: string, json: unknown, onProgress?: Progress): SogSource {
  return {
    name: url,
    meta: parseSogMeta(json),
    getFile: (file) => fetchBytes(new URL(file, url).href, onProgress, `downloading ${file}`),
  };
}

// A URL of a meta.json, lod-meta.json, .sog or .zip, an archive, or a dropped folder's files
export async function openSogInput(input: string | Uint8Array<ArrayBuffer> | File | File[], { name, onProgress }: { name?: string; onProgress?: Progress } = {}): Promise<SogInput> {
  if (Array.isArray(input)) {
    const byName = new Map(input.map((file) => [baseName(file.webkitRelativePath || file.name), file]));
    const metaFile = byName.get("meta.json");
    if (!metaFile) {
      if (input.length === 1) {
        return openSogInput(input[0], { name, onProgress });
      }
      throw new Error("Dropped files have no meta.json");
    }
    return {
      kind: "sog",
      source: {
        name: name ?? metaFile.webkitRelativePath ?? metaFile.name,
        meta: parseSogMeta(JSON.parse(await metaFile.text())),
        getFile: async (file) => {
          const found = byName.get(baseName(file));
          if (!found) {
            throw new Error(`Dropped files lack ${file}`);
          }
          return new Uint8Array(await found.arrayBuffer());
        },
      },
    };
  }

  if (input instanceof File) {
    const bytes = new Uint8Array(await input.arrayBuffer());
    if (ZipArchive.isZip(bytes)) {
      return { kind: "sog", source: await archiveSource(bytes, name ?? input.name) };
    }
    throw new Error(`${input.name}: a lone meta.json needs its WebPs (drop the folder, or all its files)`);
  }

  if (input instanceof Uint8Array) {
    return { kind: "sog", source: await archiveSource(input, name ?? "archive") };
  }

  const url = new URL(input, location.href).href;
  const bytes = await fetchBytes(url, onProgress);
  if (ZipArchive.isZip(bytes)) {
    return { kind: "sog", source: await archiveSource(bytes, name ?? url) };
  }
  const json = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
  if ("lodLevels" in json && "tree" in json) {
    return { kind: "lod", json, url };
  }
  return { kind: "sog", source: urlSource(url, json, onProgress) };
}

export interface SogImages {
  meansL: Pixels;
  meansU: Pixels;
  quats: Pixels;
  scales: Pixels;
  sh0: Pixels;
  centroids?: Pixels;
  labels?: Pixels;
}

export async function loadImages(source: SogSource): Promise<SogImages> {
  const { meta } = source;
  const get = (name: string) => source.getFile(name).then(decodePixels);
  const [meansL, meansU, quats, scales, sh0, centroids, labels] = await Promise.all([
    get(meta.means.files[0]), get(meta.means.files[1]), get(meta.quats.files[0]), get(meta.scales.files[0]), get(meta.sh0.files[0]),
    meta.shN ? get(meta.shN.files[0]) : undefined, meta.shN ? get(meta.shN.files[1]) : undefined,
  ]);
  return { meansL, meansU, quats, scales, sh0, centroids, labels };
}

const table = (f: (b: number) => number) => Float32Array.from({ length: 256 }, (_, b) => f(b));
const lerp = (min: number, max: number, b: number) => min + ((max - min) * b) / 255;

export function scaleTables(meta: SogMeta): Float32Array[] {
  const { codebook, mins, maxs } = meta.scales;
  return [0, 1, 2].map((axis) => table((b) => Math.exp(codebook ? codebook[b] : lerp(mins![axis], maxs![axis], b))));
}

export function colorTables(meta: SogMeta): Float32Array[] {
  const { codebook, mins, maxs } = meta.sh0;
  return [0, 1, 2].map((c) => table((b) => 0.5 + SH_C0 * (codebook ? codebook[b] : lerp(mins![c], maxs![c], b))));
}

export function alphaTable(meta: SogMeta): Float32Array {
  const { mins, maxs } = meta.sh0;
  return table((b) => (meta.version === 2 ? b / 255 : 1 / (1 + Math.exp(-lerp(mins![3], maxs![3], b)))));
}

export function shTable(meta: SogMeta): Float32Array {
  const shN = meta.shN!;
  return table((b) => (shN.codebook ? shN.codebook[b] : lerp(shN.mins!, shN.maxs!, b)));
}

export function paletteShape(meta: SogMeta, centroids: { width: number; height: number }) {
  const degree = meta.degree ?? (SH_COEFFICIENTS as readonly number[]).indexOf(centroids.width / 64);
  if (degree < 1) {
    throw new Error(`SOG centroid image ${centroids.width} wide matches no SH degree`);
  }
  return { degree: degree as ShDegree, size: Math.min(meta.paletteSize ?? 64 * centroids.height, 64 * centroids.height) };
}

export function decodePalette(meta: SogMeta, centroids: Pixels): { palette: ShPalette; degree: ShDegree } {
  const { degree, size } = paletteShape(meta, centroids);
  const coefficients = SH_COEFFICIENTS[degree];
  const book = shTable(meta);
  const palette = ShPalette.create({ codec: "ext", degree, size });
  const coeffs = new Float32Array(Sh.VALUES);
  for (let n = 0; n < size; n += 1) {
    const texel = (n >> 6) * centroids.width + (n & 63) * coefficients;
    for (let k = 0; k < coefficients; k += 1) {
      for (let c = 0; c < 3; c += 1) {
        coeffs[k * 3 + c] = book[centroids.rgba[(texel + k) * 4 + c]];
      }
    }
    palette.set(n, coeffs);
  }
  return { palette, degree };
}

export interface DecodedSog {
  // Splats of the asked layout, plus bundle shLabel with SH
  data: ArrayData;
  palette?: ShPalette;
  degree: number;
  meta: SogMeta;
}

export async function decodeSog(source: SogSource, { layout = "extSplats", onProgress }: {
  layout?: SplatLayout;
  onProgress?: Progress;
} = {}): Promise<DecodedSog> {
  const { meta } = source;
  const images = await loadImages(source);
  onProgress?.(0, "decoding");

  const count = meta.count;
  const data = Splats.make(count, { layout }) as unknown as ArrayData;
  const encode = Splats.encoder(Splats.get(data).bundle);
  const { meansL, meansU, quats, scales, sh0, centroids, labels } = images;
  const [sx, sy, sz] = scaleTables(meta);
  const [cr, cg, cb] = colorTables(meta);
  const alpha = alphaTable(meta);
  const quat = table((b) => (b / 255 - 0.5) * Math.SQRT2);
  const { mins, maxs } = meta.means;
  const unlog = (v: number) => Math.sign(v) * (Math.exp(Math.abs(v)) - 1);

  const s = Splats.makeExtSplat();
  s.roughness = 0;
  const q = { x: 0, y: 0, z: 0, w: 1 };
  const lo = meansL.rgba, hi = meansU.rgba, qs = quats.rgba, ss = scales.rgba, cs = sh0.rgba;
  for (let i = 0; i < count; i += 1) {
    const i4 = i * 4;
    s.center.x = unlog(mins[0] + ((maxs[0] - mins[0]) * (lo[i4] | (hi[i4] << 8))) / 65535);
    s.center.y = unlog(mins[1] + ((maxs[1] - mins[1]) * (lo[i4 + 1] | (hi[i4 + 1] << 8))) / 65535);
    s.center.z = unlog(mins[2] + ((maxs[2] - mins[2]) * (lo[i4 + 2] | (hi[i4 + 2] << 8))) / 65535);

    const a = quat[qs[i4]], b = quat[qs[i4 + 1]], c = quat[qs[i4 + 2]];
    const r = Math.sqrt(Math.max(0, 1 - a * a - b * b - c * c));
    const mode = qs[i4 + 3] - 252;
    q.x = mode === 0 ? a : mode === 1 ? r : b;
    q.y = mode <= 1 ? b : mode === 2 ? r : c;
    q.z = mode <= 2 ? c : r;
    q.w = mode === 0 ? r : a;
    SplatMath.normalizeQuat(q, s.quaternion);

    s.scales.x = sx[ss[i4]];
    s.scales.y = sy[ss[i4 + 1]];
    s.scales.z = sz[ss[i4 + 2]];
    s.rgb.r = cr[cs[i4]];
    s.rgb.g = cg[cs[i4 + 1]];
    s.rgb.b = cb[cs[i4 + 2]];
    s.opacity = alpha[cs[i4 + 3]];
    encode(i, s);
    if ((i & 0xffff) === 0) {
      onProgress?.(i / count, "decoding");
    }
  }

  if (!centroids || !labels) {
    return { data, degree: 0, meta };
  }
  const label = data.addBundle("shLabel", LABEL_BUNDLE).bundles.shLabel.channels.label.data;
  const l = labels.rgba;
  for (let i = 0; i < count; i += 1) {
    label[i] = l[i * 4] | (l[i * 4 + 1] << 8);
  }
  const { palette, degree } = decodePalette(meta, centroids);
  return { data, palette, degree, meta };
}
