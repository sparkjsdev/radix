// The decode worker of LccDecoders.ts: it reads a block of an LCC scene
// (its range of data.bin and, with SH, twice that range of shcoef.bin), or
// the whole environment.bin, and decodes it into ext splats with Radix's
// CPU encoder (lccDecode.ts). A module worker has no import map, so Radix
// core comes from dist/radix-core.module.js, at the URL the page
// resolves.
// Messages (LccRequest / LccReply):
//   main -> worker
//     { type: "init", coreUrl }
//     { type: "decode", id, source, block, sh, ranges, normal? }
//     { type: "environment", id, source, sh, ranges, normal? }
//     { type: "chunk", id, source, paths, sh }   an LCC2 .spz / .ply chunk
//                                               (the first of `paths` there)
//     { type: "lciHeader", id, source }          collision.lci's header
//     { type: "lciMesh", id, source, mesh }      one of its meshes
//     { type: "lcc2Collision", id, source, node, ply, btree }
//                                               an LCC2 node's mesh + BVH
//     { type: "cancel", id }
//   worker -> main
//     { type: "decoded", id, data, ms, bytes }  data: TransferableArrayData,
//                                               its arrays transferred (a
//                                               chunk's meta.lccSh: whether
//                                               it has SH, in extSh)
//     { type: "missing", id }                   no environment.bin (or
//                                               collision.lci)
//     { type: "value", id, value }              a header, or a CollisionChunk
//                                               (its arrays transferred)
//     { type: "error", id, message }            ("AbortError" when cancelled)
import type * as Core from "@sparkjsdev/radix/core";
import { lciHeaderLength, readLcc2Collision, readLciHeader, readLciMesh, type CollisionChunk, type LciMesh } from "./collision.js";
import { decodeChunk } from "./lccChunk.js";
import { decodeBlock, splitEnvironment } from "./lccDecode.js";
import { readOptional, readRange, type LccBlock, type LccRanges, type LccSource } from "./LccScene.js";

type Normal = { min: number[]; max: number[] };

export type LccRequest =
  | { type: "init"; coreUrl: string }
  | { type: "decode"; id: number; source: LccSource; block: LccBlock; sh: boolean; ranges: LccRanges; normal?: Normal }
  | { type: "environment"; id: number; source: LccSource; sh: boolean; ranges: LccRanges; normal?: Normal }
  | { type: "chunk"; id: number; source: LccSource; paths: string[]; sh: boolean }
  | { type: "lciHeader"; id: number; source: LccSource }
  | { type: "lciMesh"; id: number; source: LccSource; mesh: LciMesh }
  | { type: "lcc2Collision"; id: number; source: LccSource; node: string; ply: string[]; btree: string[] }
  | { type: "cancel"; id: number };

export type LccReply =
  | { type: "decoded"; id: number; data: Core.TransferableArrayData; ms: number; bytes: number }
  | { type: "missing"; id: number }
  | { type: "value"; id: number; value: unknown }
  | { type: "error"; id: number; message: string };

type DecodeRequest = Extract<LccRequest, { type: "decode" | "environment" }>;
type CollisionRequest = Extract<LccRequest, { type: "lciHeader" | "lciMesh" | "lcc2Collision" }>;

const LCI = "collision.lci";

// A collision request's answer: undefined when the scene has no collision.lci
async function collision(request: CollisionRequest, signal: AbortSignal): Promise<{ value?: unknown; transfer: ArrayBuffer[] }> {
  const { source } = request;
  if (request.type === "lciHeader") {
    let head: Uint8Array;
    try {
      head = await readRange(source, LCI, 0, 4096, signal);
    } catch (error) {
      if (error instanceof Error && /HTTP 40[34]|No collision\.lci/i.test(error.message)) {
        return { transfer: [] };
      }
      throw error;
    }
    const length = lciHeaderLength(head);
    const bytes = head.byteLength >= length ? head : await readRange(source, LCI, 0, length, signal);
    return { value: readLciHeader(bytes), transfer: [] };
  }
  let chunk: CollisionChunk;
  if (request.type === "lciMesh") {
    const { mesh } = request;
    chunk = readLciMesh(await readRange(source, LCI, mesh.offset, mesh.offset + mesh.bytes, signal), mesh);
  } else {
    const [ply, btree] = await Promise.all([readFirst(source, request.ply, signal), readFirst(source, request.btree, signal)]);
    chunk = readLcc2Collision(request.node, ply.bytes, btree.bytes);
  }
  const buffers = new Set([chunk.vertices.buffer, chunk.faces.buffer, chunk.bvh.buffer, chunk.box.buffer] as ArrayBuffer[]);
  return { value: chunk, transfer: [...buffers] };
}

// The first of `paths` the source has
async function readFirst(source: LccSource, paths: string[], signal: AbortSignal) {
  for (const path of paths) {
    const bytes = await readOptional(source, path, signal);
    if (bytes) {
      return { bytes, path };
    }
  }
  throw new Error(`${paths[0]}: not found`);
}

const scope = globalThis as unknown as { postMessage(message: unknown, transfer: ArrayBuffer[]): void; onmessage: ((event: MessageEvent) => void) | null };

let core: Promise<typeof Core> | undefined;
const pending = new Map<number, AbortController>();

// The splats and SH bytes a request reads, or undefined for a missing environment
async function read(request: DecodeRequest, signal: AbortSignal) {
  const { source, sh } = request;
  if (request.type === "environment") {
    const bytes = await readOptional(source, "environment.bin", signal);
    return bytes && { ...splitEnvironment(bytes, sh), bytes: bytes.byteLength };
  }
  const { block } = request;
  const [data, shBytes] = await Promise.all([
    readRange(source, "data.bin", block.offset, block.offset + block.size, signal),
    sh ? readRange(source, "shcoef.bin", block.offset * 2, (block.offset + block.size) * 2, signal) : undefined,
  ]);
  return { count: block.count, data, sh: shBytes, bytes: data.byteLength + (shBytes?.byteLength ?? 0) };
}

async function decode(request: Exclude<LccRequest, { type: "init" | "cancel" }>) {
  const { id } = request;
  const controller = new AbortController();
  pending.set(id, controller);
  const aborted = () => {
    if (controller.signal.aborted) {
      throw new DOMException("Cancelled", "AbortError");
    }
  };
  try {
    const start = performance.now();
    let data: Core.ArrayData;
    let bytes: number;
    if (request.type === "lciHeader" || request.type === "lciMesh" || request.type === "lcc2Collision") {
      const { value, transfer } = await collision(request, controller.signal);
      aborted();
      scope.postMessage(value === undefined ? { type: "missing", id } satisfies LccReply : { type: "value", id, value } satisfies LccReply, transfer);
      return;
    }
    const module = await core!;
    if (request.type === "chunk") {
      const file = await readFirst(request.source, request.paths, controller.signal);
      aborted();
      const chunk = await decodeChunk(module, file.bytes, file.path, request.sh);
      data = chunk.data;
      data.meta.lccSh = chunk.sh;
      bytes = file.bytes.byteLength;
    } else {
      const input = await read(request, controller.signal);
      aborted();
      if (!input) {
        scope.postMessage({ type: "missing", id } satisfies LccReply, []);
        return;
      }
      data = decodeBlock(module, input.data, input.sh, input.count, request.ranges, request.normal);
      bytes = input.bytes;
    }
    const decoded = data.toTransferable();
    const reply: LccReply = { type: "decoded", id, data: decoded, ms: performance.now() - start, bytes };
    scope.postMessage(reply, module.ArrayData.transferables(decoded));
  } catch (error) {
    const message = error instanceof DOMException && error.name === "AbortError" ? "AbortError" : error instanceof Error ? error.message : String(error);
    scope.postMessage({ type: "error", id, message } satisfies LccReply, []);
  } finally {
    pending.delete(id);
  }
}

scope.onmessage = (event: MessageEvent<LccRequest>) => {
  const request = event.data;
  if (request.type === "init") {
    core = import(request.coreUrl) as Promise<typeof Core>;
  } else if (request.type === "cancel") {
    pending.get(request.id)?.abort();
  } else {
    void decode(request);
  }
};
