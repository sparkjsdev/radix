// Splat files to and from ArrayData on this thread: PLY (standard or
// compressed), SPZ, RAD and RDX,
// told apart by content, then by the name's extension. Every format loads
// into the bundle named after the asked layout (default extSplats, plus
// lodTree when the file has a tree): PLY, SPZ and RAD decode straight into
// it; RDX keeps its other bundles and converts its splats when they are in
// another layout. Spherical harmonics load into an SH bundle (core/sh.ts,
// `sh`: default ext; RDX keeps its stored codec unless `sh` is given), or,
// for RAD's clustered SH, into bundle shLabel and an ShPalette returned
// beside the splats. worker/splatFiles.ts runs these on a worker or here.
import type { ArrayData } from "./ArrayData";
import type { CoordinateSystem } from "./axes";
import { CompressedPlyFile } from "./compressedPly";
import { PlyFile } from "./ply";
import { readResponse, span, type Progress } from "./progress";
import { RAD_CHUNK_MAGIC, RAD_MAGIC, RadFile } from "./rad";
import { RDX_MAGIC, RdxFile } from "./rdx";
import { Sh, type ShPalette, type ShTarget } from "./sh";
import { Splats, type LoadedSplats, type SplatLayout, type SplatReadOptions } from "./splats";
import { SPZ_MAGIC, SpzFile } from "./spz";

export type SplatFormat = "ply" | "compressed-ply" | "spz" | "rad" | "rdx";

// fetch options for a splat file's URL (headers, credentials, mode, cache,
// referrer...); the load's own signal aborts it
export type SplatRequestInit = Omit<RequestInit, "signal" | "body" | "window" | "method">;

// `name` tells formats apart by extension when their first bytes do not
export type SplatLoadOptions<L extends SplatLayout = "extSplats"> = SplatReadOptions<L> & { name?: string };

// Options of every writer; each format takes the ones it knows (ply: pbr,
// compatibility; compressed-ply: sort; spz: version (4: SPZ 4's NGSP
// container), pbr, lod, fractionalBits, antialiased, coordinateSystem (the
// system version 4 records, default meta.coordinateSystem), zstdLevel
// (version 4, Node's zstd); rad:
// chunkSize, radSh; rdx: chunkSize; ply,
// compressed-ply, spz, rad: sh, default true, writes the SH bundle; all:
// shPalette, the palette of the data's shLabel bundle, written as RAD's
// clustered SH and expanded to per-splat SH by the others)
export interface SplatWriteOptions {
  pbr?: boolean;
  compatibility?: boolean;
  sort?: boolean;
  version?: 2 | 3 | 4;
  coordinateSystem?: CoordinateSystem;
  zstdLevel?: number;
  lod?: boolean;
  fractionalBits?: number;
  antialiased?: boolean;
  chunkSize?: number;
  sh?: boolean;
  radSh?: "s8" | "f16" | "f32";
  shPalette?: ShPalette;
}

export class SplatFiles {
  // The format of a file from its first bytes, else its name's extension;
  // compressed PLY files are "ply" (PlyFile.read reads both)
  static detectFormat(bytes: Uint8Array, name = ""): SplatFormat {
    const magic = bytes.byteLength >= 4 ? new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true) : 0;
    if (magic === RDX_MAGIC) {
      return "rdx";
    }
    if (magic === RAD_MAGIC || magic === RAD_CHUNK_MAGIC) {
      return "rad";
    }
    if (bytes[0] === 0x70 && bytes[1] === 0x6c && bytes[2] === 0x79) {
      return "ply";
    }
    const extension = name.toLowerCase().replace(/[?#].*$/, "").split(".").pop();
    // NGSP: SPZ 4's plaintext header
    if ((bytes[0] === 0x1f && bytes[1] === 0x8b) || magic === SPZ_MAGIC || extension === "spz") {
      return "spz";
    }
    throw new Error(`Unknown splat file format${name ? `: ${name}` : ""}`);
  }

  static async decode<L extends SplatLayout = "extSplats">(bytes: Uint8Array<ArrayBuffer>, {
    name = "", progress, layout = "extSplats" as L, encoding, sh, coordinateSystem,
  }: SplatLoadOptions<L> = {}): Promise<LoadedSplats<L>> {
    const options = { progress, layout, encoding, sh, coordinateSystem };
    switch (SplatFiles.detectFormat(bytes, name)) {
      case "rdx": return { splats: SplatFiles.withSh(Splats.convert(await RdxFile.decode(bytes, { progress }), { layout, encoding }), sh) };
      case "rad": return RadFile.read(bytes, options);
      case "ply":
      case "compressed-ply": return PlyFile.read(bytes, options);
      case "spz": return SpzFile.read(bytes, options);
    }
  }

  // A table's SH as asked: kept when `sh` is undefined, dropped with false
  // (meta.ignoredShDegree records the degree), else converted to the codec
  static withSh<D>(data: D, sh: ShTarget | undefined): D {
    const table = data as unknown as ArrayData;
    const found = Sh.find(table.bundles);
    if (sh === undefined || !found) {
      return data;
    }
    if (sh === false) {
      table.removeBundle(found.name);
      table.meta.ignoredShDegree = found.degree;
      return data;
    }
    return Sh.convert(table, sh) as unknown as D;
  }

  // A file of `data` in `format`: PLY, SPZ and RAD take its splat bundle
  // (and lodTree, and SH), RDX every serialized bundle
  static async encode(data: ArrayData, format: SplatFormat, options: SplatWriteOptions & { progress?: Progress } = {}): Promise<Uint8Array<ArrayBuffer>> {
    if (options.shPalette && format !== "rad" && options.sh !== false) {
      data = options.shPalette.expanded(data);
    }
    switch (format) {
      case "ply": return PlyFile.write(data, options);
      case "compressed-ply": return CompressedPlyFile.write(data, options);
      case "spz": return SpzFile.write(data, options);
      case "rad": return RadFile.write(data, options);
      case "rdx": return RdxFile.encode(data, options);
    }
  }

  // Download (0-40% of the progress) and decode
  static async fetch<L extends SplatLayout = "extSplats">(url: string, { init, progress, ...target }: SplatReadOptions<L> & {
    init?: RequestInit;
  } = {}): Promise<LoadedSplats<L>> {
    const response = await fetch(url, init);
    if (!response.ok) {
      throw new Error(`Failed to load ${url}: ${response.status}`);
    }
    const bytes = await readResponse(response, span(progress, 0, 0.4));
    return SplatFiles.decode(bytes, { ...target, name: url, progress: span(progress, 0.4, 1) });
  }
}
