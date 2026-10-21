// Splat files on this thread. worker/splatFiles.ts runs them on a worker.
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
import { fileName } from "./url";

/** The splat file formats that Radix reads and writes. */
export type SplatFormat = "ply" | "compressed-ply" | "spz" | "rad" | "rdx";

/**
 * fetch options for a splat file's URL. The load's own signal aborts it.
 */
export type SplatRequestInit = Omit<RequestInit, "signal" | "body" | "window" | "method">;

/** Read options, plus a name whose extension tells formats apart when the first bytes do not. */
export type SplatLoadOptions<L extends SplatLayout = "extSplats"> = SplatReadOptions<L> & { name?: string };

/** The options of every writer, each format reading its own. */
export interface SplatWriteOptions {
  /**
   * Whether PLY and SPZ write ext splats' normals, roughness and metallic.
   *
   * @default false
   */
  pbr?: boolean;
  /**
   * Whether PLY writes zero normals for tools that expect them.
   *
   * @default false
   */
  compatibility?: boolean;
  /**
   * Whether compressed PLY writes the splats in Morton order of their centers.
   *
   * @default true
   */
  sort?: boolean;
  /**
   * The SPZ version, where 2 and 3 use the gzip container and 4 SPZ 4's.
   *
   * @default 3
   */
  version?: 2 | 3 | 4;
  /**
   * The system SPZ 4 records. The data is not converted.
   *
   * @default meta.coordinateSystem
   */
  coordinateSystem?: CoordinateSystem;
  /**
   * Node's zstd level for SPZ 4, from 1 to 22.
   *
   * @default 12
   */
  zstdLevel?: number;
  /**
   * Whether SPZ writes the lodTree bundle, whose child counts must be below
   * 2^16.
   *
   * @default true when the data has a lodTree
   */
  lod?: boolean;
  /**
   * Fraction bits of SPZ's 24-bit fixed-point centers.
   *
   * @default 12
   */
  fractionalBits?: number;
  /**
   * SPZ's antialiasing flag.
   *
   * @default true
   */
  antialiased?: boolean;
  /**
   * Splats per chunk in RAD and RDX, a multiple of 4096 for RDX.
   *
   * @default 65536
   */
  chunkSize?: number;
  /**
   * Whether PLY, compressed PLY, SPZ and RAD write the SH bundle.
   *
   * @default true
   */
  sh?: boolean;
  /**
   * RAD's SH encoding, where s8 is over each band's largest value per chunk.
   *
   * @default "s8"
   */
  radSh?: "s8" | "f16" | "f32";
  /** The palette shLabel indexes, which RAD writes as clustered SH and the others per splat. */
  shPalette?: ShPalette;
}

/** Reads and writes every splat format on the current thread. */
export class SplatFiles {
  /**
   * Detects a file's format from its first bytes, else its name's extension.
   *
   * @param [name=""] The file's name or URL.
   * @return The format, where compressed PLY is "ply".
   */
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
    if ((bytes[0] === 0x1f && bytes[1] === 0x8b) || magic === SPZ_MAGIC || extension === "spz") {
      return "spz";
    }
    throw new Error(`Unknown splat file format${name ? `: ${name}` : ""}`);
  }

  /**
   * Reads a file in any format.
   *
   * @return The splats, and a palette for RAD's clustered SH.
   */
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

  /**
   * Keeps, drops or converts a table's SH, recording a dropped degree in
   * meta.ignoredShDegree.
   *
   * @param sh The codec to convert to, false to drop the SH, or undefined to
   *   keep it.
   * @return The table, or a converted one.
   */
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

  /**
   * Writes a table in any format: its splats, LoD tree and SH, or every
   * serialized bundle for RDX.
   */
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

  /**
   * Downloads and decodes a file.
   *
   * @param [options.progress] Reports progress, the download being the first
   *   40%.
   * @return The splats, and a palette for RAD's clustered SH.
   */
  static async fetch<L extends SplatLayout = "extSplats">(url: string, { init, progress, ...target }: SplatReadOptions<L> & {
    init?: RequestInit;
  } = {}): Promise<LoadedSplats<L>> {
    const response = await fetch(url, init);
    if (!response.ok) {
      throw new Error(`Failed to load ${fileName(url)}: ${response.status}`);
    }
    const bytes = await readResponse(response, span(progress, 0, 0.4));
    return SplatFiles.decode(bytes, { ...target, name: fileName(url), progress: span(progress, 0.4, 1) });
  }
}
