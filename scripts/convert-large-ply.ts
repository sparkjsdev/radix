// Converts a PLY past Node's 2 GiB read limit into one RDX file, a chunk of records at a time
//
//   npm run convert:ply -- <in.ply> <out.rdx> [options]
//   --layout <name>   extSplats | packedSplats (default) | covSplats
//   --sh <codec>      ext (default) | packed | none
//   --chunk <n>       records per chunk (default 1000000)
import { closeSync, openSync, readSync, statSync, writeFileSync } from "node:fs";
import { ArrayData, PlyFile, RdxFile, Sh, Splats, type SplatLayout } from "../src/core";

const args = process.argv.slice(2);
const option = (name: string, fallback: string) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};
const [input, output] = args.filter((arg, i) => !arg.startsWith("--") && !args[i - 1]?.startsWith("--"));
if (!input || !output) {
  throw new Error("Usage: convert-large-ply.ts <in.ply> <out.rdx> [--layout packedSplats] [--sh ext | packed | none] [--chunk 1000000]");
}
const layout = option("--layout", "packedSplats") as SplatLayout;
const shOption = option("--sh", "ext");
const sh = shOption === "none" ? false : shOption;
const chunk = Number(option("--chunk", 1_000_000));

const fd = openSync(input, "r");
const headBytes = Buffer.alloc(64 * 1024);
readSync(fd, headBytes, 0, headBytes.length, 0);
const headText = headBytes.toString("latin1");
const end = headText.indexOf("end_header\n");
if (end < 0 || !headText.startsWith("ply\n") || !headText.includes("format binary_little_endian")) {
  throw new Error("Not a binary little-endian PLY");
}
const header = headText.slice(0, end + "end_header\n".length);
const elements = [...header.matchAll(/^element (\w+) (\d+)$/gm)];
if (elements.length !== 1 || elements[0][1] !== "vertex") {
  throw new Error("Only PLY files with a single vertex element are supported");
}
const count = Number(elements[0][2]);
const sizes: Record<string, number> = { char: 1, uchar: 1, short: 2, ushort: 2, int: 4, uint: 4, float: 4, double: 8 };
const recordSize = [...header.matchAll(/^property (\w+) \w+$/gm)].reduce((sum, [, type]) => sum + sizes[type], 0);
const dataStart = header.length;
const expected = dataStart + count * recordSize;
if (statSync(input).size < expected) {
  throw new Error(`PLY ends early: ${statSync(input).size} bytes, expected ${expected}`);
}
console.log(`${input}: ${count.toLocaleString()} splats of ${recordSize} bytes, into ${layout}`);

const data = Splats.make(count, { layout, meta: { source: input.split("/").pop() } }) as unknown as ArrayData;
data.count = count;
const start = performance.now();
for (let at = 0; at < count; at += chunk) {
  const n = Math.min(chunk, count - at);
  const head = Buffer.from(header.replace(/^element vertex \d+$/m, `element vertex ${n}`), "latin1");
  const bytes = new Uint8Array(head.length + n * recordSize);
  bytes.set(head);
  readSync(fd, bytes, head.length, n * recordSize, dataStart + at * recordSize);
  const part = (await PlyFile.read(bytes, { layout, sh })).splats as unknown as ArrayData;
  const found = Sh.find(part.bundles);
  if (found && !Sh.find(data.bundles)) {
    Sh.add(data, found.codec, found.degree);
  }
  data.meta.ignoredShDegree = part.meta.ignoredShDegree;
  data.copyFrom(part, { dstStart: at, count: n });
  process.stdout.write(`\r${Math.round(((at + n) / count) * 100)}% decoded`);
}
closeSync(fd);
console.log(` in ${((performance.now() - start) / 1000).toFixed(1)} s`);

const encodeStart = performance.now();
const file = await RdxFile.encode(data);
writeFileSync(output, file);
console.log(`${output}: ${(file.byteLength / 2 ** 20).toFixed(0)} MiB in ${((performance.now() - encodeStart) / 1000).toFixed(1)} s`);
