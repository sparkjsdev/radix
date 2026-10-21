import { decompress as fzstdDecompress } from "fzstd";
import { pipe } from "./compress";

interface ZlibZstd {
  zstdCompressSync(bytes: Uint8Array, options?: { params: Record<number, number> }): Uint8Array;
  zstdDecompressSync(bytes: Uint8Array): Uint8Array;
  constants: { ZSTD_c_compressionLevel: number };
}

// A little smaller than gzip on SPZ columns
const LEVEL = 12;

let zlib: ZlibZstd | null | undefined;
function nodeZstd(): ZlibZstd | null {
  if (zlib === undefined) {
    const process = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process;
    const found = process?.getBuiltinModule?.("node:zlib") as Partial<ZlibZstd> | undefined;
    zlib = found?.zstdCompressSync && found.zstdDecompressSync ? (found as ZlibZstd) : null;
  }
  return zlib;
}

const streamSupport: { compress?: boolean; decompress?: boolean } = {};
function streams(kind: "compress" | "decompress"): boolean {
  if (streamSupport[kind] === undefined) {
    try {
      // Throws on an unknown format
      void (kind === "compress" ? new CompressionStream("zstd" as CompressionFormat) : new DecompressionStream("zstd" as CompressionFormat));
      streamSupport[kind] = true;
    } catch {
      streamSupport[kind] = false;
    }
  }
  return streamSupport[kind]!;
}

// A Node Buffer may view a shared pool
function own(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength && bytes.buffer instanceof ArrayBuffer
    ? new Uint8Array(bytes.buffer)
    : new Uint8Array(bytes);
}

/** Zstandard compression, with the platform's zstd where it has one. */
export class Zstd {
  /**
   * Decodes one or more frames.
   *
   * @param size The decoded size in bytes, which must match.
   * @param [options.native=true] Whether to try the platform's zstd before
   *   fzstd.
   */
  static async decompress(bytes: Uint8Array, size: number, { native = true }: { native?: boolean } = {}): Promise<Uint8Array<ArrayBuffer>> {
    const zstd = native ? nodeZstd() : null;
    let out: Uint8Array;
    try {
      out = zstd
        ? zstd.zstdDecompressSync(bytes)
        : native && streams("decompress")
          ? await pipe(new Uint8Array(bytes), new DecompressionStream("zstd" as CompressionFormat))
          : fzstdDecompress(bytes);
    } catch (error) {
      throw new Error(`Invalid zstd stream: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (out.byteLength !== size) {
      throw new Error(`zstd stream decoded to ${out.byteLength} bytes, not ${size}`);
    }
    return own(out);
  }

  /**
   * Encodes bytes as one frame.
   *
   * @param [options.native=true] Whether to try the platform's zstd before
   *   Radix's encoder.
   * @param [options.level=12] Node's zstd level, from 1 to 22.
   */
  static async compress(bytes: Uint8Array, { native = true, level = LEVEL }: { native?: boolean; level?: number } = {}): Promise<Uint8Array<ArrayBuffer>> {
    const zstd = native ? nodeZstd() : null;
    if (zstd) {
      return own(zstd.zstdCompressSync(bytes, { params: { [zstd.constants.ZSTD_c_compressionLevel]: level } }));
    }
    if (native && streams("compress")) {
      return pipe(new Uint8Array(bytes), new CompressionStream("zstd" as CompressionFormat));
    }
    return encodeFrame(bytes);
  }
}

const BLOCK = 1 << 17;
const MAX_BITS = 11;
// The format's limit for FSE-coded weights
const WEIGHT_LOG = 6;
// Smaller blocks are stored raw, as four streams cost a few bytes each
const MIN_HUFFMAN = 64;

// Bits from the lowest up. close() adds a backward stream's 1 marker bit.
class BitWriter {
  bytes: Uint8Array;
  pos: number;
  private acc = 0;
  private n = 0;

  constructor(bytes: Uint8Array, pos = 0) {
    this.bytes = bytes;
    this.pos = pos;
  }

  // nbits <= 24
  add(value: number, nbits: number) {
    this.acc |= value << this.n;
    this.n += nbits;
    while (this.n >= 8) {
      this.bytes[this.pos++] = this.acc & 0xff;
      this.acc >>>= 8;
      this.n -= 8;
    }
  }

  flush() {
    if (this.n > 0) {
      this.bytes[this.pos++] = this.acc & 0xff;
    }
    this.acc = 0;
    this.n = 0;
    return this.pos;
  }

  close() {
    this.add(1, 1);
    return this.flush();
  }
}

// Huffman code lengths, limited to MAX_BITS by JPEG's Annex K rebalancing
function huffmanLengths(counts: Uint32Array, lengths: Uint8Array): number {
  lengths.fill(0);
  const syms: number[] = [];
  for (let s = 0; s < 256; s += 1) {
    if (counts[s] > 0) {
      syms.push(s);
    }
  }
  syms.sort((a, b) => counts[a] - counts[b] || a - b);
  const n = syms.length;
  const weight = new Float64Array(2 * n - 1);
  const parent = new Int32Array(2 * n - 1);
  const depth = new Uint8Array(2 * n - 1);
  for (let i = 0; i < n; i += 1) {
    weight[i] = counts[syms[i]];
  }
  let leaf = 0;
  let inner = n;
  const pick = (next: number) => (leaf < n && (inner >= next || weight[leaf] <= weight[inner]) ? leaf++ : inner++);
  for (let next = n; next < 2 * n - 1; next += 1) {
    const a = pick(next);
    const b = pick(next);
    weight[next] = weight[a] + weight[b];
    parent[a] = next;
    parent[b] = next;
  }
  const lengthCount = new Uint32Array(257);
  let longest = 0;
  for (let i = 2 * n - 3; i >= 0; i -= 1) {
    depth[i] = depth[parent[i]] + 1;
    if (i < n) {
      lengthCount[depth[i]] += 1;
      longest = Math.max(longest, depth[i]);
    }
  }
  for (let i = longest; i > MAX_BITS; i -= 1) {
    while (lengthCount[i] > 0) {
      let j = i - 2;
      while (lengthCount[j] === 0) {
        j -= 1;
      }
      lengthCount[i] -= 2;
      lengthCount[i - 1] += 1;
      lengthCount[j + 1] += 2;
      lengthCount[j] -= 1;
    }
  }
  // The most frequent symbols get the shortest codes
  let at = n - 1;
  let max = 0;
  for (let len = 1; len <= Math.min(longest, MAX_BITS); len += 1) {
    for (let k = 0; k < lengthCount[len]; k += 1) {
      lengths[syms[at--]] = len;
      max = len;
    }
  }
  return max;
}

// Canonical codes in the decoder's order: by increasing weight, then value
function huffmanCodes(lengths: Uint8Array, maxBits: number, codes: Uint16Array) {
  let slot = 0;
  for (let len = maxBits; len >= 1; len -= 1) {
    const span = 1 << (maxBits - len);
    for (let s = 0; s < 256; s += 1) {
      if (lengths[s] === len) {
        codes[s] = slot >> (maxBits - len);
        slot += span;
      }
    }
  }
}

const highBit = (v: number) => 31 - Math.clz32(v);

/*!
 * The FSE encoder below translates Zstandard's fse_compress.c and fse.h
 * (https://github.com/facebook/zstd), used under its BSD license:
 *
 * BSD License
 *
 * For Zstandard software
 *
 * Copyright (c) Meta Platforms, Inc. and affiliates. All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without modification,
 * are permitted provided that the following conditions are met:
 *
 *  * Redistributions of source code must retain the above copyright notice, this
 *    list of conditions and the following disclaimer.
 *
 *  * Redistributions in binary form must reproduce the above copyright notice,
 *    this list of conditions and the following disclaimer in the documentation
 *    and/or other materials provided with the distribution.
 *
 *  * Neither the name Facebook, nor Meta, nor the names of its contributors may
 *    be used to endorse or promote products derived from this software without
 *    specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
 * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR
 * ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
 * (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
 * LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON
 * ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
 * (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
 * SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */
// FSE-coded weights. Undefined for a single distinct weight or over 127 bytes.
function fseWeights(weights: Uint8Array, count: number, out: Uint8Array, at: number): number | undefined {
  const size = 1 << WEIGHT_LOG;
  const freq = new Uint32Array(MAX_BITS + 1);
  for (let i = 0; i < count; i += 1) {
    freq[weights[i]] += 1;
  }
  let maxSym = 0;
  let distinct = 0;
  for (let s = 0; s <= MAX_BITS; s += 1) {
    if (freq[s] > 0) {
      maxSym = s;
      distinct += 1;
    }
  }
  if (distinct < 2 || count <= 2) {
    return undefined;
  }
  const norm = new Int32Array(maxSym + 1);
  let sum = 0;
  for (let s = 0; s <= maxSym; s += 1) {
    if (freq[s] > 0) {
      norm[s] = Math.max(1, Math.floor((freq[s] * size) / count));
      sum += norm[s];
    }
  }
  while (sum !== size) {
    let pickS = -1;
    for (let s = 0; s <= maxSym; s += 1) {
      if (sum > size ? norm[s] > 1 && (pickS < 0 || norm[s] > norm[pickS]) : freq[s] > 0 && (pickS < 0 || freq[s] > freq[pickS])) {
        pickS = s;
      }
    }
    norm[pickS] += sum > size ? -1 : 1;
    sum += sum > size ? -1 : 1;
  }

  const scratch = new Uint8Array(256);
  const header = new BitWriter(scratch);
  header.add(WEIGHT_LOG - 5, 4);
  let remaining = size + 1;
  let threshold = size;
  let nbBits = WEIGHT_LOG + 1;
  let previousIs0 = false;
  for (let s = 0; s <= maxSym && remaining > 1;) {
    if (previousIs0) {
      let start = s;
      while (norm[s] === 0) {
        s += 1;
      }
      while (s >= start + 3) {
        start += 3;
        header.add(3, 2);
      }
      header.add(s - start, 2);
    }
    let value = norm[s++];
    const max = 2 * threshold - 1 - remaining;
    remaining -= value;
    value += 1;
    if (value >= threshold) {
      value += max;
    }
    header.add(value, value < max ? nbBits - 1 : nbBits);
    previousIs0 = value === 1;
    while (remaining < threshold) {
      nbBits -= 1;
      threshold >>= 1;
    }
  }
  let end = header.flush();

  const spread = new Uint8Array(size);
  let pos = 0;
  for (let s = 0; s <= maxSym; s += 1) {
    for (let i = 0; i < norm[s]; i += 1) {
      spread[pos] = s;
      pos = (pos + (size >> 1) + (size >> 3) + 3) & (size - 1);
    }
  }
  const cumul = new Int32Array(maxSym + 2);
  for (let s = 0; s <= maxSym; s += 1) {
    cumul[s + 1] = cumul[s] + norm[s];
  }
  const stateTable = new Uint16Array(size);
  for (let u = 0; u < size; u += 1) {
    stateTable[cumul[spread[u]]++] = size + u;
  }
  const deltaNbBits = new Int32Array(maxSym + 1);
  const deltaFind = new Int32Array(maxSym + 1);
  let total = 0;
  for (let s = 0; s <= maxSym; s += 1) {
    if (norm[s] === 1) {
      deltaNbBits[s] = (WEIGHT_LOG << 16) - size;
      deltaFind[s] = total - 1;
      total += 1;
    } else if (norm[s] > 1) {
      const maxBitsOut = WEIGHT_LOG - highBit(norm[s] - 1);
      deltaNbBits[s] = (maxBitsOut << 16) - (norm[s] << maxBitsOut);
      deltaFind[s] = total - norm[s];
      total += norm[s];
    }
  }

  // Symbols last to first, weight k on state 1 when k is even, else 2
  const stream = new BitWriter(scratch, end);
  const states = [0, 0];
  const started = [false, false];
  for (let k = count - 1; k >= 0; k -= 1) {
    const s = weights[k];
    const which = k & 1;
    if (!started[which]) {
      const nbOut = (deltaNbBits[s] + (1 << 15)) >> 16;
      const value = (nbOut << 16) - deltaNbBits[s];
      states[which] = stateTable[(value >> nbOut) + deltaFind[s]];
      started[which] = true;
    } else {
      const value = states[which];
      const nbOut = (value + deltaNbBits[s]) >> 16;
      stream.add(value & ((1 << nbOut) - 1), nbOut);
      states[which] = stateTable[(value >> nbOut) + deltaFind[s]];
    }
  }
  stream.add(states[1] & (size - 1), WEIGHT_LOG);
  stream.add(states[0] & (size - 1), WEIGHT_LOG);
  end = stream.close();
  if (end > 127) {
    return undefined;
  }
  out.set(scratch.subarray(0, end), at);
  return end;
}

// Weights of all symbols but the last, whose weight is implied, FSE-coded or
// 4 bits each, whichever is smaller
function treeDescription(lengths: Uint8Array, maxBits: number, out: Uint8Array, at: number): number | undefined {
  let last = 255;
  while (lengths[last] === 0) {
    last -= 1;
  }
  const weights = new Uint8Array(256);
  for (let s = 0; s < last; s += 1) {
    weights[s] = lengths[s] ? maxBits + 1 - lengths[s] : 0;
  }
  const fse = new Uint8Array(128);
  const fseSize = fseWeights(weights, last, fse, 0);
  const directSize = last <= 128 ? 1 + ((last + 1) >> 1) : Infinity;
  if (fseSize !== undefined && fseSize + 1 < directSize) {
    out[at] = fseSize;
    out.set(fse.subarray(0, fseSize), at + 1);
    return fseSize + 1;
  }
  if (directSize === Infinity) {
    return undefined;
  }
  out[at] = 127 + last;
  for (let s = 0; s < last; s += 2) {
    out[at + 1 + (s >> 1)] = (weights[s] << 4) | (s + 1 < last ? weights[s + 1] : 0);
  }
  return directSize;
}

function writeLE(out: Uint8Array, at: number, value: number, bytes: number) {
  for (let i = 0; i < bytes; i += 1) {
    out[at + i] = value % 256;
    value = Math.floor(value / 256);
  }
}

// An RFC 8878 frame: magic, a 128 KB window, the content size, then RLE, raw or
// Huffman blocks. It codes literals only, since SPZ's columns have few repeats.
function encodeFrame(src: Uint8Array): Uint8Array<ArrayBuffer> {
  const blocks = Math.max(1, Math.ceil(src.byteLength / BLOCK));
  const out = new Uint8Array(14 + src.byteLength + blocks * 3);
  writeLE(out, 0, 0xfd2fb528, 4);
  const wide = src.byteLength >= 2 ** 32;
  out[4] = (wide ? 3 : 2) << 6;
  out[5] = (17 - 10) << 3;
  writeLE(out, 6, src.byteLength, wide ? 8 : 4);
  let at = wide ? 14 : 10;

  const counts = new Uint32Array(256);
  const lengths = new Uint8Array(256);
  const codes = new Uint16Array(256);
  const prevLengths = new Uint8Array(256);
  const prevCodes = new Uint16Array(256);
  let hasPrev = false;
  // Room for one stream past BLOCK before compressBlock gives up
  const block = new Uint8Array(2 * BLOCK);
  for (let b = 0; b < blocks; b += 1) {
    const start = b * BLOCK;
    const n = Math.min(BLOCK, src.byteLength - start);
    const last = b === blocks - 1 ? 1 : 0;
    const lit = src.subarray(start, start + n);
    counts.fill(0);
    for (let i = 0; i < n; i += 1) {
      counts[lit[i]] += 1;
    }
    if (n > 0 && counts[lit[0]] === n) {
      writeLE(out, at, last | (1 << 1) | (n << 3), 3);
      out[at + 3] = lit[0];
      at += 4;
      continue;
    }
    const [size, fresh] = n >= MIN_HUFFMAN ? compressBlock(lit, counts, lengths, codes, prevLengths, prevCodes, hasPrev, block) : [0, false];
    if (size > 0 && size < n) {
      writeLE(out, at, last | (2 << 1) | (size << 3), 3);
      out.set(block.subarray(0, size), at + 3);
      at += 3 + size;
      // The decoder's table changes only with a block it reads
      if (fresh) {
        prevLengths.set(lengths);
        prevCodes.set(codes);
      }
      hasPrev = true;
    } else {
      writeLE(out, at, last | (n << 3), 3);
      out.set(lit, at + 3);
      at += 3 + n;
    }
  }
  return out.slice(0, at);
}

// Returns its size, 0 if Huffman can't code it, and whether lengths and codes hold a new table
function compressBlock(
  lit: Uint8Array, counts: Uint32Array, lengths: Uint8Array, codes: Uint16Array,
  prevLengths: Uint8Array, prevCodes: Uint16Array, hasPrev: boolean, block: Uint8Array,
): [number, boolean] {
  const n = lit.byteLength;
  const maxBits = huffmanLengths(counts, lengths);
  const tree = new Uint8Array(256);
  const treeSize = treeDescription(lengths, maxBits, tree, 0);
  let newBits = 0;
  let prevBits = hasPrev ? 0 : Infinity;
  for (let s = 0; s < 256; s += 1) {
    if (counts[s] > 0) {
      newBits += counts[s] * lengths[s];
      prevBits += prevLengths[s] > 0 ? counts[s] * prevLengths[s] : Infinity;
    }
  }
  const newCost = treeSize === undefined ? Infinity : newBits + treeSize * 8;
  if (newCost === Infinity && prevBits === Infinity) {
    return [0, false];
  }
  const treeless = prevBits <= newCost;
  if (!treeless) {
    huffmanCodes(lengths, maxBits, codes);
  }
  const useLengths = treeless ? prevLengths : lengths;
  const useCodes = treeless ? prevCodes : codes;

  // The header, at most 5 bytes, goes in last
  const headerMax = 5;
  let at = headerMax;
  if (!treeless) {
    block.set(tree.subarray(0, treeSize), at);
    at += treeSize!;
  }
  const jump = at;
  at += 6;
  const segment = Math.ceil(n / 4);
  const sizes = [0, 0, 0];
  for (let k = 0; k < 4; k += 1) {
    const from = Math.min(n, k * segment);
    const to = Math.min(n, from + segment);
    const writer = new BitWriter(block, at);
    for (let i = to - 1; i >= from; i -= 1) {
      const s = lit[i];
      writer.add(useCodes[s], useLengths[s]);
    }
    const end = writer.close();
    if (k < 3) {
      sizes[k] = end - at;
    }
    at = end;
    if (at > BLOCK) {
      return [0, false];
    }
  }
  writeLE(block, jump, sizes[0], 2);
  writeLE(block, jump + 2, sizes[1], 2);
  writeLE(block, jump + 4, sizes[2], 2);
  const compressed = at - headerMax;
  const format = Math.max(n, compressed) <= 1023 ? 1 : Math.max(n, compressed) <= 16383 ? 2 : 3;
  const headerSize = format + 2;
  const type = treeless ? 3 : 2;
  const header = type + (format << 2) + n * 16 + compressed * 2 ** (format === 1 ? 14 : format === 2 ? 18 : 22);
  const begin = headerMax - headerSize;
  writeLE(block, begin, header, headerSize);
  // No sequences
  block[at] = 0;
  at += 1;
  block.copyWithin(0, begin, at);
  return [at - begin, !treeless];
}
