import { ArrayData } from "./ArrayData";
import { defineBundle, type BundleDef } from "./bundles";
import { Compression } from "./compress";
import { ArrayFormats } from "./formats";
import { TextureLayout } from "./layout";
import type { Progress } from "./progress";

// RDX files: the serialized bundles of an ArrayData, split into chunks of
// rows. Every piece is a container:
//   u32 magic, u32 metaLength, u32 payloadCount, u32 0, JSON meta,
//   u32 payloadSize[payloadCount], payloads (each section 16-byte aligned)
// The header ("RDXH") holds an RdxHeader and no payloads; a chunk ("RDXC")
// holds { start, count } and one payload per serialized channel, in header
// order: that channel's elements [start, start + count), byte-transposed and
// gzipped. A whole file is the header followed by every chunk, so chunk i
// starts at the header's length plus the sizes of chunks 0..i-1. Chunked
// files are the same pieces apart: scene.rdx (header), scene-0.rdx, ...

const RDX_VERSION = 1;
const RDX_CHUNK_SIZE = 65536;
// "RDXH": every header and whole file starts with it
export const RDX_MAGIC = 0x48584452;
const CHUNK_MAGIC = 0x43584452; // "RDXC"
const HEAD_READ_BYTES = 64 * 1024;

export interface RdxHeader {
  version: number;
  count: number;
  // Elements per chunk, a multiple of 4096 (whole texture rows); the last
  // chunk holds the rest
  chunkSize: number;
  meta: Record<string, unknown>;
  // Serialized bundles only, in payload order
  bundles: Record<string, { def: BundleDef; meta: Record<string, unknown> }>;
  // Byte size of each chunk
  chunks: number[];
}

const align16 = (n: number) => Math.ceil(n / 16) * 16;

function encodeContainer(magic: number, meta: unknown, payloads: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const metaBytes = new TextEncoder().encode(JSON.stringify(meta));
  const sizesAt = 16 + align16(metaBytes.byteLength);
  const payloadsAt = sizesAt + align16(payloads.length * 4);
  const total = payloadsAt + payloads.reduce((sum, payload) => sum + align16(payload.byteLength), 0);

  const bytes = new Uint8Array(total);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, magic, true);
  view.setUint32(4, metaBytes.byteLength, true);
  view.setUint32(8, payloads.length, true);
  bytes.set(metaBytes, 16);

  let offset = payloadsAt;
  payloads.forEach((payload, i) => {
    view.setUint32(sizesAt + i * 4, payload.byteLength, true);
    bytes.set(payload, offset);
    offset += align16(payload.byteLength);
  });
  return bytes;
}

function decodeContainer(bytes: Uint8Array<ArrayBuffer>, magic: number) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 16 || view.getUint32(0, true) !== magic) {
    throw new Error("Not an RDX piece of the expected type");
  }

  const metaLength = view.getUint32(4, true);
  const payloadCount = view.getUint32(8, true);
  const meta = JSON.parse(new TextDecoder().decode(bytes.subarray(16, 16 + metaLength)));
  const sizesAt = 16 + align16(metaLength);

  let offset = sizesAt + align16(payloadCount * 4);
  const payloads = Array.from({ length: payloadCount }, (_, i) => {
    const size = view.getUint32(sizesAt + i * 4, true);
    const payload = bytes.subarray(offset, offset + size);
    offset += align16(size);
    return payload;
  });
  return { meta, payloads, byteLength: offset };
}

async function encodeRdxChunks(data: ArrayData, { chunkSize = RDX_CHUNK_SIZE, progress }: {
  chunkSize?: number;
  progress?: Progress;
} = {}): Promise<{ header: Uint8Array<ArrayBuffer>; chunks: Uint8Array<ArrayBuffer>[] }> {
  if (chunkSize <= 0 || chunkSize % TextureLayout.ROW_ELEMENTS !== 0) {
    throw new Error(`Chunk size ${chunkSize} is not a positive multiple of ${TextureLayout.ROW_ELEMENTS}`);
  }

  const bundles = Object.entries(data.bundles).filter(([, bundle]) => bundle.def.serialize);
  const chunkCount = Math.ceil(data.count / chunkSize);
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  for (let chunk = 0; chunk < chunkCount; chunk += 1) {
    progress?.(chunk / chunkCount, "encoding");
    const start = chunk * chunkSize;
    const count = Math.min(chunkSize, data.count - start);

    const payloads: Uint8Array[] = [];
    for (const [, bundle] of bundles) {
      for (const channel of Object.values(bundle.channels)) {
        const info = ArrayFormats.info(channel.format);
        payloads.push(await Compression.compressTransposed(channel.data.subarray(start * info.components, (start + count) * info.components), info.bytes));
      }
    }
    chunks.push(encodeContainer(CHUNK_MAGIC, { start, count }, payloads));
  }
  progress?.(1, "encoding");

  const header: RdxHeader = {
    version: RDX_VERSION,
    count: data.count,
    chunkSize,
    meta: data.meta,
    bundles: Object.fromEntries(bundles.map(([name, bundle]) => [name, { def: bundle.def, meta: bundle.meta }])),
    chunks: chunks.map((chunk) => chunk.byteLength),
  };
  return { header: encodeContainer(RDX_MAGIC, header, []), chunks };
}

// Name of chunk i of a chunked set: scene.rdx -> scene-0.rdx (a query or
// hash after .rdx is kept)
function rdxChunkName(headerName: string, chunk: number) {
  const at = headerName.search(/\.rdx($|[?#])/);
  if (at < 0) {
    throw new Error(`${headerName} does not end in .rdx`);
  }
  return `${headerName.slice(0, at)}-${chunk}${headerName.slice(at)}`;
}

// Chunked files by name, ready to write or upload: { "scene.rdx": header,
// "scene-0.rdx": chunk 0, ... }
async function encodeRdxFiles(data: ArrayData, headerName: string, options: { chunkSize?: number; progress?: Progress } = {}) {
  const { header, chunks } = await encodeRdxChunks(data, options);
  const files: Record<string, Uint8Array<ArrayBuffer>> = { [headerName]: header };
  chunks.forEach((chunk, i) => (files[rdxChunkName(headerName, i)] = chunk));
  return files;
}

// Whole file: the header, then every chunk
async function encodeRdx(data: ArrayData, options: { chunkSize?: number; progress?: Progress } = {}): Promise<Uint8Array<ArrayBuffer>> {
  const { header, chunks } = await encodeRdxChunks(data, options);
  const file = new Uint8Array(header.byteLength + chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  file.set(header);

  let offset = header.byteLength;
  for (const chunk of chunks) {
    file.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return file;
}

// The header at the start of `bytes`; byteLength is where chunk 0 starts in
// a whole file
function decodeRdxHeader(bytes: Uint8Array<ArrayBuffer>): { header: RdxHeader; byteLength: number } {
  const { meta, byteLength } = decodeContainer(bytes, RDX_MAGIC);
  const header = meta as RdxHeader;
  if (header.version !== RDX_VERSION) {
    throw new Error(`RDX version ${header.version} is not ${RDX_VERSION}`);
  }
  return { header, byteLength };
}

// An empty ArrayData of the header's bundles, count and meta, for chunks to
// be decoded into
function rdxData(header: RdxHeader): ArrayData {
  const data = new ArrayData({ count: header.count, meta: header.meta });
  for (const [name, { def, meta }] of Object.entries(header.bundles)) {
    data.addBundle(name, defineBundle(def.channels, { packing: def.packing, serialize: def.serialize }), { meta });
  }
  return data;
}

// Writes the chunk's elements [start, start + count) into `into`
async function decodeRdxChunk(header: RdxHeader, bytes: Uint8Array<ArrayBuffer>, into: ArrayData): Promise<void> {
  const { meta, payloads } = decodeContainer(bytes, CHUNK_MAGIC);
  const { start, count } = meta as { start: number; count: number };
  into.ensureCapacity(start + count);

  let index = 0;
  for (const [name, { def }] of Object.entries(header.bundles)) {
    for (const [label, format] of Object.entries(def.channels)) {
      const info = ArrayFormats.info(format);
      const decoded = await Compression.decompressTransposed(payloads[index++], info.bytes);
      if (decoded.byteLength !== count * info.bytes) {
        throw new Error(`Chunk at ${start}: ${name}.${label} holds ${decoded.byteLength} bytes, expected ${count * info.bytes}`);
      }

      const channel = into.bundles[name]?.channels[label];
      if (channel?.format !== format) {
        throw new Error(`Channel ${name}.${label} missing from the target or of another format`);
      }
      channel.data.set(new info.array(decoded.buffer, decoded.byteOffset, count * info.components) as never, start * info.components);
    }
  }

  into.count = Math.max(into.count, start + count);
}

async function decodeRdx(bytes: Uint8Array<ArrayBuffer>, { progress }: { progress?: Progress } = {}): Promise<ArrayData> {
  const { header, byteLength } = decodeRdxHeader(bytes);
  const data = rdxData(header);

  let offset = byteLength;
  for (const [chunk, size] of header.chunks.entries()) {
    progress?.(chunk / header.chunks.length, "decoding");
    await decodeRdxChunk(header, bytes.subarray(offset, offset + size), data);
    offset += size;
  }
  progress?.(1, "decoding");
  return data;
}

export interface RdxReader {
  header: RdxHeader;
  // One readRange of chunk i, decoded into `into`
  readChunk(chunk: number, into: ArrayData): Promise<void>;
}

// A whole file through `readRange` (bytes [start, end); fewer past the end
// of the file): the header with one read (two when it is over 64 KB), then
// one read per chunk
async function openRdx(readRange: (start: number, end: number) => Promise<Uint8Array<ArrayBuffer>>): Promise<RdxReader> {
  let head = await readRange(0, HEAD_READ_BYTES);
  if (head.byteLength < 16) {
    throw new Error("Not an RDX file");
  }
  const metaLength = new DataView(head.buffer, head.byteOffset, head.byteLength).getUint32(4, true);
  const headerLength = 16 + align16(metaLength);
  if (head.byteLength < headerLength) {
    head = await readRange(0, headerLength);
  }

  const { header, byteLength } = decodeRdxHeader(head.subarray(0, headerLength));
  const offsets: number[] = [];
  let offset = byteLength;
  for (const size of header.chunks) {
    offsets.push(offset);
    offset += size;
  }

  return {
    header,
    async readChunk(chunk, into) {
      if (!(chunk >= 0 && chunk < offsets.length)) {
        throw new Error(`No chunk ${chunk} (the file has ${offsets.length})`);
      }
      await decodeRdxChunk(header, await readRange(offsets[chunk], offsets[chunk] + header.chunks[chunk]), into);
    },
  };
}

async function fetchBytes(url: string, init: RequestInit) {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`Failed to load ${url}: ${response.status}`);
  }
  return { status: response.status, bytes: new Uint8Array(await response.arrayBuffer()) };
}

// A whole file over HTTP Range requests (a server that ignores Range sends
// the file once, 200 not 206, and later reads slice it), or with `chunked`
// the header at `url` and chunk i at rdxChunkName(url, i)
async function loadRdx(url: string, { chunked = false, init = {} }: { chunked?: boolean; init?: RequestInit } = {}): Promise<RdxReader> {
  if (chunked) {
    const { header } = decodeRdxHeader((await fetchBytes(url, init)).bytes);
    return {
      header,
      async readChunk(chunk, into) {
        await decodeRdxChunk(header, (await fetchBytes(rdxChunkName(url, chunk), init)).bytes, into);
      },
    };
  }

  let whole: Uint8Array<ArrayBuffer> | undefined;
  return openRdx(async (start, end) => {
    if (!whole) {
      const headers = new Headers(init.headers);
      headers.set("Range", `bytes=${start}-${end - 1}`);
      const { status, bytes } = await fetchBytes(url, { ...init, headers });
      if (status === 206) {
        return bytes;
      }
      whole = bytes;
    }
    return whole.subarray(start, end);
  });
}

// RDX files of any ArrayData: whole, or chunked (a header and chunk files),
// read whole or a chunk at a time (range reads over HTTP)
export class RdxFile {
  // Elements per chunk by default (a multiple of 4096)
  static readonly CHUNK_SIZE = RDX_CHUNK_SIZE;
  // Whole file: the header, then every chunk
  static readonly encode = encodeRdx;
  static readonly decode = decodeRdx;
  // The header and the chunks as separate pieces
  static readonly encodeChunks = encodeRdxChunks;
  // Chunked files by name: { "scene.rdx": header, "scene-0.rdx": chunk 0, ... }
  static readonly encodeFiles = encodeRdxFiles;
  // scene.rdx -> scene-0.rdx (a query or hash after .rdx is kept)
  static readonly chunkName = rdxChunkName;
  // The header at the start of `bytes`; byteLength is where chunk 0 starts
  // in a whole file
  static readonly decodeHeader = decodeRdxHeader;
  // An empty ArrayData of a header's bundles, count and meta, for chunks
  static readonly makeData = rdxData;
  // Writes a chunk's elements into `into`
  static readonly decodeChunk = decodeRdxChunk;
  // A whole file through a range reader: one read for the header, one per chunk
  static readonly open = openRdx;
  // A whole file over HTTP Range requests, or a chunked set with `chunked`
  static readonly load = loadRdx;
}
