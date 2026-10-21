import type { TypedArray } from "./formats";

/** A file's bytes, whole or as a stream. */
export type BytesInput = Uint8Array<ArrayBuffer> | ArrayBuffer | ReadableStream<Uint8Array>;

function transposeBytes(data: Uint8Array, stride: number) {
  if (data.byteLength % stride !== 0) {
    throw new Error("Data length must be divisible by the byte stride");
  }

  const output = new Uint8Array(data.byteLength);
  let out = 0;
  for (let offset = 0; offset < stride; offset += 1) {
    for (let i = offset; i < data.byteLength; i += stride) {
      output[out++] = data[i];
    }
  }
  return output;
}

export async function pipe(data: Uint8Array<ArrayBuffer>, transform: CompressionStream | DecompressionStream) {
  const stream = new Blob([data]).stream().pipeThrough(transform);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Reads bytes in order from a buffer or a stream.
 *
 * A read within one chunk returns a view of it, and other reads a copy.
 */
export class ByteReader {
  /** The bytes taken so far. */
  position = 0;
  // Unread chunks start at head, the first at offset
  private chunks: Uint8Array[] = [];
  private head = 0;
  private offset = 0;
  private buffered = 0;
  private reader?: ReadableStreamDefaultReader<Uint8Array>;
  private done = false;
  private label: string;

  /**
   * Starts reading.
   *
   * @param [label="Data"] The name errors give the data.
   */
  constructor(input: BytesInput, label = "Data") {
    this.label = label;
    if (input instanceof ReadableStream) {
      this.reader = input.getReader();
      return;
    }
    const bytes = input instanceof ArrayBuffer ? new Uint8Array(input) : input;
    if (bytes.byteLength > 0) {
      this.chunks.push(bytes);
    }
    this.buffered = bytes.byteLength;
    this.done = true;
  }

  // Returns the bytes buffered, at least n unless the input ends
  private async fill(n: number): Promise<number> {
    while (this.buffered < n && !this.done) {
      const { done, value } = await this.reader!.read();
      if (done) {
        this.done = true;
      } else if (value.byteLength > 0) {
        this.chunks.push(value);
        this.buffered += value.byteLength;
      }
    }
    return this.buffered;
  }

  private take(n: number, consume: boolean): Uint8Array<ArrayBuffer> {
    const first = this.chunks[this.head];
    let out: Uint8Array<ArrayBuffer>;
    if (n === 0) {
      out = new Uint8Array(0);
    } else if (first.byteLength - this.offset >= n) {
      out = first.subarray(this.offset, this.offset + n) as Uint8Array<ArrayBuffer>;
    } else {
      out = new Uint8Array(n);
      let at = 0;
      for (let k = this.head, from = this.offset; at < n; k += 1, from = 0) {
        const part = this.chunks[k].subarray(from, from + n - at);
        out.set(part, at);
        at += part.byteLength;
      }
    }
    if (consume) {
      this.drop(n);
    }
    return out;
  }

  private drop(n: number) {
    this.position += n;
    this.buffered -= n;
    while (n > 0) {
      const left = this.chunks[this.head].byteLength - this.offset;
      if (n < left) {
        this.offset += n;
        break;
      }
      n -= left;
      this.head += 1;
      this.offset = 0;
    }
    if (this.head > 64 && this.head * 2 > this.chunks.length) {
      this.chunks = this.chunks.slice(this.head);
      this.head = 0;
    }
  }

  /** Takes exactly n bytes, throwing when the input ends first. */
  async read(n: number): Promise<Uint8Array<ArrayBuffer>> {
    if ((await this.fill(n)) < n) {
      throw new Error(`${this.label} ended unexpectedly`);
    }
    return this.take(n, true);
  }

  /** Returns up to n bytes without taking them, fewer at the end. */
  async peek(n: number): Promise<Uint8Array<ArrayBuffer>> {
    return this.take(Math.min(n, await this.fill(n)), false);
  }

  /** Skips n bytes without copying them. */
  async skip(n: number) {
    while (n > 0) {
      const have = await this.fill(1);
      if (have === 0) {
        throw new Error(`${this.label} ended unexpectedly`);
      }
      const step = Math.min(n, have);
      this.drop(step);
      n -= step;
    }
  }

  /** Takes the remaining bytes. */
  async rest(): Promise<Uint8Array<ArrayBuffer>> {
    return this.take(await this.fill(Infinity), true);
  }

  /** Checks whether every byte is taken. */
  async atEnd(): Promise<boolean> {
    return (await this.fill(1)) === 0;
  }

  /** Returns the bytes not taken yet as a stream. */
  stream(): ReadableStream<Uint8Array<ArrayBuffer>> {
    return new ReadableStream({
      pull: async (controller) => {
        if ((await this.fill(1)) === 0) {
          controller.close();
          return;
        }
        controller.enqueue(this.take(this.chunks[this.head].byteLength - this.offset, true));
      },
      cancel: () => this.cancel(),
    });
  }

  /** Stops reading and cancels the source stream. */
  cancel() {
    void this.reader?.cancel().catch(() => {});
    this.done = true;
    this.chunks = [];
    this.head = 0;
    this.buffered = 0;
    this.offset = 0;
  }
}

/** Gzip, and byte-transposed gzip for element data. */
export class Compression {
  /** Compresses bytes with gzip. */
  static gzip(bytes: Uint8Array<ArrayBuffer>) {
    return pipe(bytes, new CompressionStream("gzip"));
  }

  /** Decompresses gzip bytes. */
  static gunzip(bytes: Uint8Array<ArrayBuffer>) {
    return pipe(bytes, new DecompressionStream("gzip"));
  }

  /** Reads a whole input into one array. */
  static async readBytes(input: BytesInput): Promise<Uint8Array<ArrayBuffer>> {
    if (input instanceof ArrayBuffer) {
      return new Uint8Array(input);
    }
    if (input instanceof Uint8Array) {
      return input;
    }
    return new Uint8Array(await new Response(input as ReadableStream<Uint8Array<ArrayBuffer>>).arrayBuffer());
  }

  /**
   * Gzips element data with byte k of every element stored together, which
   * compresses better.
   *
   * @param values Whole elements.
   * @param elementBytes The size of an element, in bytes.
   */
  static async compressTransposed(values: TypedArray, elementBytes: number): Promise<Uint8Array<ArrayBuffer>> {
    const bytes = new Uint8Array(values.buffer, values.byteOffset, values.byteLength);
    return pipe(transposeBytes(bytes, elementBytes), new CompressionStream("gzip"));
  }

  /**
   * Reverses compressTransposed.
   *
   * @param elementBytes The size of an element, in bytes.
   */
  static async decompressTransposed(bytes: Uint8Array<ArrayBuffer>, elementBytes: number): Promise<Uint8Array<ArrayBuffer>> {
    const transposed = await pipe(bytes, new DecompressionStream("gzip"));
    if (transposed.byteLength % elementBytes !== 0) {
      throw new Error("Decompressed length must be divisible by the element size");
    }
    // The inverse is a transpose with the element count as stride
    return transposed.byteLength === 0 ? transposed : transposeBytes(transposed, transposed.byteLength / elementBytes);
  }
}
