export interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  headerOffset: number;
}

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

export class ZipArchive {
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly entries = new Map<string, ZipEntry>();

  constructor(bytes: Uint8Array<ArrayBuffer>) {
    this.bytes = bytes;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    let end = -1;
    for (let at = bytes.byteLength - 22; at >= Math.max(0, bytes.byteLength - 22 - 65535); at -= 1) {
      if (view.getUint32(at, true) === EOCD) {
        end = at;
        break;
      }
    }
    if (end < 0) {
      throw new Error("ZIP: no end of central directory");
    }

    const total = view.getUint16(end + 10, true);
    let at = view.getUint32(end + 16, true);
    if (total === 0xffff || at === 0xffffffff) {
      throw new Error("ZIP: Zip64 archives are not supported");
    }

    const decoder = new TextDecoder();
    for (let i = 0; i < total; i += 1) {
      if (view.getUint32(at, true) !== CENTRAL) {
        throw new Error("ZIP: bad central directory");
      }
      const nameLength = view.getUint16(at + 28, true);
      const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
      this.entries.set(name, {
        name,
        method: view.getUint16(at + 10, true),
        compressedSize: view.getUint32(at + 20, true),
        size: view.getUint32(at + 24, true),
        headerOffset: view.getUint32(at + 42, true),
      });
      at += 46 + nameLength + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
    }
  }

  static isZip(bytes: Uint8Array) {
    return bytes.byteLength >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 3 && bytes[3] === 4;
  }

  async read(name: string): Promise<Uint8Array<ArrayBuffer>> {
    const entry = this.entries.get(name);
    if (!entry) {
      throw new Error(`ZIP: no entry ${name}`);
    }
    const view = new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength);
    const at = entry.headerOffset;
    if (view.getUint32(at, true) !== LOCAL) {
      throw new Error(`ZIP: bad local header for ${name}`);
    }
    const start = at + 30 + view.getUint16(at + 26, true) + view.getUint16(at + 28, true);
    const data = this.bytes.subarray(start, start + entry.compressedSize);
    if (entry.method === 0) {
      return data.slice();
    }
    if (entry.method !== 8) {
      throw new Error(`ZIP: ${name} uses compression method ${entry.method}`);
    }
    const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
}
