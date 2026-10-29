// src/core/formats.ts
var SCALARS = {
  uint8: { bytes: 1, array: Uint8Array },
  sint8: { bytes: 1, array: Int8Array },
  unorm8: { bytes: 1, array: Uint8Array },
  snorm8: { bytes: 1, array: Int8Array },
  uint16: { bytes: 2, array: Uint16Array },
  sint16: { bytes: 2, array: Int16Array },
  float16: { bytes: 2, array: Uint16Array },
  uint32: { bytes: 4, array: Uint32Array },
  sint32: { bytes: 4, array: Int32Array },
  float32: { bytes: 4, array: Float32Array }
};
var cache = /* @__PURE__ */ new Map();
var ArrayFormats = class {
  static info(format) {
    let info = cache.get(format);
    if (!info) {
      const [scalar, count] = format.split("x");
      const spec = SCALARS[scalar];
      const components = count === void 0 ? 1 : Number(count);
      if (!spec || !Number.isInteger(components) || components < 1) {
        throw new Error(`Invalid array format "${format}"`);
      }
      info = {
        format,
        scalar,
        components,
        scalarBytes: spec.bytes,
        bytes: spec.bytes * components,
        array: spec.array,
        gpu: components === 1 || components === 2 || components === 4
      };
      cache.set(format, info);
    }
    return info;
  }
  // Format of `scalar` with `components` components ("uint32", "uint32x4")
  static make(scalar, components) {
    return components === 1 ? scalar : `${scalar}x${components}`;
  }
};

// src/core/bundles.ts
function defineBundle(channels, { packing = 1, serialize = true } = {}) {
  for (const format of Object.values(channels)) {
    const texelComponents = ArrayFormats.info(format).components * packing;
    if (packing > 1 && ![1, 2, 4].includes(texelComponents)) {
      throw new Error(`Format ${format} cannot be packed ${packing} per texel`);
    }
  }
  return { channels, packing, serialize };
}

// src/core/layout.ts
var TextureLayout = class _TextureLayout {
  static WIDTH = 1024;
  static MAX_PACKING = 4;
  // One texture row for every packing (1, 2 or 4 elements per texel)
  static ROW_ELEMENTS = _TextureLayout.WIDTH * _TextureLayout.MAX_PACKING;
  // Array textures are limited by MAX_TEXTURE_SIZE (not MAX_3D_TEXTURE_SIZE),
  // >= 4096 on 100% of WebGL2 devices (web3dsurvey.com, Sep 2026)
  static MAX_HEIGHT = 4096;
  // WebGL2 MAX_ARRAY_TEXTURE_LAYERS: 100% of devices; WebGPU baseline 2048
  // (its default is 256, so createRenderer requests more)
  static MAX_LAYERS = 512;
  width;
  height;
  layers;
  xBits;
  yBits;
  // width * height * layers
  texels;
  constructor(height, layers) {
    this.width = _TextureLayout.WIDTH;
    this.height = height;
    this.layers = layers;
    this.xBits = Math.log2(this.width);
    this.yBits = Math.log2(height);
    this.texels = this.width * height * layers;
  }
  // Layout holding at least `texels` texels in 2 to 4 layers (at most 50%
  // padding) until the height reaches its cap, then one more 4096-row layer
  // at a time. At least 2 layers: the WebGL backend only renders to single
  // layers of targets with more than one layer.
  static for(texels) {
    const rows = Math.max(1, Math.ceil(texels / _TextureLayout.WIDTH));
    const height = Math.min(_TextureLayout.MAX_HEIGHT, 2 ** Math.max(0, Math.floor(Math.log2(rows / 2))));
    const layers = Math.max(2, Math.ceil(rows / height));
    if (layers > _TextureLayout.MAX_LAYERS) {
      throw new Error(`${texels} texels do not fit in an array texture`);
    }
    return new _TextureLayout(height, layers);
  }
  // Capacity for `count` elements: whole rows for every packing
  static alignCapacity(count) {
    return Math.max(1, Math.ceil(count / _TextureLayout.ROW_ELEMENTS)) * _TextureLayout.ROW_ELEMENTS;
  }
  // Texels [start, start + count) as few rectangles as possible: partial
  // rows at the ends, whole rows in between (one span per layer)
  spans(start, count) {
    const { width, height } = this;
    const layerSize = width * height;
    const spans = [];
    const end = start + count;
    let t = start;
    while (t < end) {
      const layer = Math.floor(t / layerSize);
      const inLayer = t - layer * layerSize;
      const y = Math.floor(inLayer / width);
      const x = inLayer - y * width;
      if (x > 0 || end - t < width) {
        const n = Math.min(width - x, end - t);
        spans.push({ x, y, layer, width: n, rows: 1, offset: t - start });
        t += n;
      } else {
        const rows = Math.min(Math.floor((end - t) / width), height - y);
        spans.push({ x: 0, y, layer, width, rows, offset: t - start });
        t += rows * width;
      }
    }
    return spans;
  }
  // Rectangles copying texels [srcStart, srcStart + count) of `src` to
  // dstStart of `dst`. Whole rows are copied together when both sides are
  // row-aligned; otherwise pieces stop at the row end of either side.
  static copySpans(src, srcStart, dst, dstStart, count) {
    const width = _TextureLayout.WIDTH;
    const position = (layout, t) => {
      const layerSize = width * layout.height;
      const layer = Math.floor(t / layerSize);
      const y = Math.floor((t - layer * layerSize) / width);
      return { x: t % width, y, layer };
    };
    const spans = [];
    let done = 0;
    while (done < count) {
      const s = position(src, srcStart + done);
      const d = position(dst, dstStart + done);
      const left = count - done;
      let span2;
      if (s.x === 0 && d.x === 0 && left >= width) {
        const rows = Math.min(Math.floor(left / width), src.height - s.y, dst.height - d.y);
        span2 = { src: s, dst: d, width, rows };
      } else {
        span2 = { src: s, dst: d, width: Math.min(left, width - s.x, width - d.x), rows: 1 };
      }
      spans.push(span2);
      done += span2.width * span2.rows;
    }
    return spans;
  }
};

// src/core/ArrayData.ts
var ArrayData = class _ArrayData {
  // A list of element indices, 4 per uint32x4 texel: a draw order, a subset
  static INDICES = defineBundle({ index: "uint32" }, { packing: 4 });
  count;
  capacity;
  bundles;
  meta;
  constructor({ bundles, count = 0, capacity, meta = {} } = {}) {
    this.count = count;
    this.capacity = capacity ?? TextureLayout.alignCapacity(count);
    if (this.capacity < count) {
      throw new Error(`Capacity ${this.capacity} is below count ${count}`);
    }
    this.bundles = {};
    this.meta = meta;
    for (const [name, def] of Object.entries(bundles ?? {})) {
      this.addBundle(name, def);
    }
  }
  // `data` arrays are used as given when they hold capacity elements, else
  // copied into a new array of that size
  addBundle(name, def, init = {}) {
    const channels = {};
    for (const [label, format] of Object.entries(def.channels)) {
      const info = ArrayFormats.info(format);
      const length = this.capacity * info.components;
      let data = init.data?.[label];
      if (data && data.constructor !== info.array) {
        throw new Error(`Channel ${name}.${label}: ${data.constructor.name} does not hold ${format}`);
      }
      if (!data || data.length < length) {
        const sized = new info.array(length);
        if (data) {
          sized.set(data);
        }
        data = sized;
      }
      channels[label] = { format, data };
    }
    this.anyBundles[name] = { def, channels, meta: { ...init.meta } };
    return this;
  }
  removeBundle(name) {
    if (!(name in this.bundles)) {
      return false;
    }
    delete this.anyBundles[name];
    return true;
  }
  // Resize every channel, keeping contents; count is clamped to the capacity
  setCapacity(capacity) {
    if (capacity === this.capacity) {
      return false;
    }
    for (const bundle of Object.values(this.anyBundles)) {
      for (const channel of Object.values(bundle.channels)) {
        const info = ArrayFormats.info(channel.format);
        const data = new info.array(capacity * info.components);
        data.set(channel.data.subarray(0, data.length));
        channel.data = data;
      }
    }
    this.capacity = capacity;
    this.count = Math.min(this.count, capacity);
    return true;
  }
  // Grow (at least doubling, whole rows) to hold `capacity` elements
  ensureCapacity(capacity) {
    if (capacity <= this.capacity) {
      return false;
    }
    return this.setCapacity(TextureLayout.alignCapacity(Math.max(capacity, this.capacity * 2)));
  }
  // Copy elements of matching bundles (default: all bundles both have)
  copyFrom(src, { bundles, srcStart = 0, dstStart = 0, count = src.count - srcStart } = {}) {
    if (srcStart < 0 || count < 0 || srcStart + count > src.capacity) {
      throw new Error(`Copy of ${count} elements from ${srcStart} exceeds the source capacity ${src.capacity}`);
    }
    this.ensureCapacity(dstStart + count);
    const names = bundles ?? Object.keys(this.bundles).filter((name) => name in src.bundles);
    for (const name of names) {
      const from = src.anyBundles[name];
      const to = this.anyBundles[name];
      if (!from || !to) {
        throw new Error(`Bundle ${name} missing`);
      }
      for (const [label, channel] of Object.entries(to.channels)) {
        const source = from.channels[label];
        if (source?.format !== channel.format) {
          throw new Error(`Channel ${name}.${label} missing or of another format`);
        }
        const components = ArrayFormats.info(channel.format).components;
        const values = source.data.subarray(srcStart * components, (srcStart + count) * components);
        channel.data.set(values, dstStart * components);
      }
    }
    this.count = Math.max(this.count, dstStart + count);
  }
  clone() {
    const copy = new _ArrayData({ count: this.count, capacity: this.capacity, meta: structuredClone(this.meta) });
    for (const [name, bundle] of Object.entries(this.anyBundles)) {
      const data = Object.fromEntries(Object.entries(bundle.channels).map(([label, channel]) => [label, channel.data.slice()]));
      copy.addBundle(name, bundle.def, { data, meta: structuredClone(bundle.meta) });
    }
    return copy;
  }
  // Swap contents with `other` (double buffering)
  swap(other) {
    [this.count, other.count] = [other.count, this.count];
    [this.capacity, other.capacity] = [other.capacity, this.capacity];
    [this.bundles, other.bundles] = [other.bundles, this.bundles];
    [this.meta, other.meta] = [other.meta, this.meta];
  }
  // The arrays are shared, not copied: pass transferables(t) to postMessage
  // and this ArrayData is unusable until setFromTransferable
  toTransferable() {
    const bundles = {};
    for (const [name, bundle] of Object.entries(this.anyBundles)) {
      const channels = Object.fromEntries(Object.entries(bundle.channels).map(([label, channel]) => [label, channel.data]));
      bundles[name] = { def: bundle.def, meta: bundle.meta, channels };
    }
    return { count: this.count, capacity: this.capacity, meta: this.meta, bundles };
  }
  // Take over `t` in place (e.g. data coming back from a worker). Bundles
  // and channels with the same names and formats keep their objects, so
  // references held elsewhere stay valid; others are replaced.
  setFromTransferable(t) {
    this.count = t.count;
    this.capacity = t.capacity;
    this.meta = t.meta;
    const bundles = {};
    for (const [name, value] of Object.entries(t.bundles)) {
      const existing = this.anyBundles[name];
      const labels = Object.keys(value.def.channels);
      const same = existing && existing.def.packing === value.def.packing && labels.length === Object.keys(existing.channels).length && labels.every((label) => existing.channels[label]?.format === value.def.channels[label]);
      if (same) {
        for (const label of labels) {
          existing.channels[label].data = value.channels[label];
        }
        existing.def = value.def;
        existing.meta = value.meta;
        bundles[name] = existing;
      } else {
        const channels = Object.fromEntries(labels.map((label) => [label, { format: value.def.channels[label], data: value.channels[label] }]));
        bundles[name] = { def: value.def, channels, meta: value.meta };
      }
    }
    this.bundles = bundles;
    return this;
  }
  static fromTransferable(t) {
    return new _ArrayData().setFromTransferable(t);
  }
  // The ArrayBuffers inside `value` (a TransferableArrayData or anything
  // else), for postMessage's transfer list
  static transferables(value) {
    const buffers = /* @__PURE__ */ new Set();
    const seen = /* @__PURE__ */ new Set();
    const visit = (item) => {
      if (!item || typeof item !== "object" || seen.has(item)) {
        return;
      }
      seen.add(item);
      if (item instanceof ArrayBuffer) {
        buffers.add(item);
      } else if (ArrayBuffer.isView(item)) {
        if (item.buffer instanceof ArrayBuffer) {
          buffers.add(item.buffer);
        }
      } else {
        Object.values(item).forEach(visit);
      }
    };
    visit(value);
    return [...buffers];
  }
  get anyBundles() {
    return this.bundles;
  }
};

// src/core/progress.ts
function span(progress, from, to) {
  return progress && ((fraction, stage) => progress(from + (to - from) * Math.min(1, Math.max(0, fraction)), stage));
}
function counter(progress, total, stage) {
  return progress ? (i) => (i & 65535) === 0 && progress(i / Math.max(1, total), stage) : () => {
  };
}
async function readResponse(response, progress) {
  const total = Number(response.headers.get("content-length") ?? 0);
  if (!progress || !response.body || !(total > 0)) {
    return new Uint8Array(await response.arrayBuffer());
  }
  const chunks = [];
  let read = 0;
  const reader = response.body.getReader();
  for (; ; ) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    chunks.push(value);
    read += value.byteLength;
    progress(Math.min(1, read / total), "downloading");
  }
  const bytes2 = new Uint8Array(read);
  let at = 0;
  for (const chunk of chunks) {
    bytes2.set(chunk, at);
    at += chunk.byteLength;
  }
  return bytes2;
}

// src/core/encoding.ts
var floatViews = /* @__PURE__ */ new WeakMap();
var f32 = new Float32Array(1);
var u32 = new Uint32Array(f32.buffer);
var Float16 = globalThis.Float16Array;
var f16 = Float16 ? new Float16(1) : void 0;
var u16 = f16 ? new Uint16Array(f16.buffer) : void 0;
function makeOctCodec(bits) {
  if (bits < 1 || bits > 16) {
    throw new Error(`Octahedral codes take 1 to 16 bits per axis, not ${bits}`);
  }
  const max = 2 ** bits - 1;
  const allOnes = (max | max << bits) >>> 0;
  return {
    encode(v) {
      const l1 = Math.abs(v.x) + Math.abs(v.y) + Math.abs(v.z);
      if (!(l1 > 0)) {
        return 0;
      }
      let px = v.x / l1;
      let py = v.y / l1;
      if (v.z < 0) {
        const ax = Math.abs(px);
        px = (1 - Math.abs(py)) * (px >= 0 ? 1 : -1);
        py = (1 - ax) * (py >= 0 ? 1 : -1);
      }
      const code = (Math.round((px * 0.5 + 0.5) * max) | Math.round((py * 0.5 + 0.5) * max) << bits) >>> 0;
      return code === 0 ? allOnes : code;
    },
    decode(code, out) {
      if (code === 0) {
        out.x = 0;
        out.y = 0;
        out.z = 0;
        return out;
      }
      let x = (code & max) / max * 2 - 1;
      let y = (code >>> bits & max) / max * 2 - 1;
      const z = 1 - Math.abs(x) - Math.abs(y);
      const t = Math.max(-z, 0);
      x += x >= 0 ? -t : t;
      y += y >= 0 ? -t : t;
      const length = Math.sqrt(x * x + y * y + z * z);
      out.x = x / length;
      out.y = y / length;
      out.z = z / length;
      return out;
    }
  };
}
function makeQuatCodec(axisBits, angleBits) {
  const axisCodeBits = 2 * axisBits;
  if (axisCodeBits + angleBits > 32) {
    throw new Error(`Quaternion codes hold at most 32 bits, not ${axisCodeBits + angleBits}`);
  }
  const oct = makeOctCodec(axisBits);
  const axisMask = 2 ** axisCodeBits - 1;
  const angleMax = 2 ** angleBits - 1;
  const axis = { x: 0, y: 0, z: 0 };
  return {
    encode(q) {
      const length = Math.sqrt(q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w);
      if (!(length > 0)) {
        return 0;
      }
      const s = (q.w < 0 ? -1 : 1) / length;
      axis.x = q.x * s;
      axis.y = q.y * s;
      axis.z = q.z * s;
      const angle = 2 * Math.acos(Math.min(1, q.w * s));
      const angleCode = Math.round(angle / Math.PI * angleMax);
      return (oct.encode(axis) | angleCode << axisCodeBits) >>> 0;
    },
    decode(code, out) {
      oct.decode(code & axisMask, out);
      const angle = (code >>> axisCodeBits & angleMax) / angleMax * Math.PI;
      const s = Math.sin(angle / 2);
      out.x *= s;
      out.y *= s;
      out.z *= s;
      out.w = Math.cos(angle / 2);
      return out;
    }
  };
}
var octCodecs = /* @__PURE__ */ new Map();
var quatCodecs = /* @__PURE__ */ new Map();
function octCodec(bits) {
  let codec = octCodecs.get(bits);
  if (!codec) {
    codec = makeOctCodec(bits);
    octCodecs.set(bits, codec);
  }
  return codec;
}
function quatCodec(axisBits, angleBits) {
  const key = `${axisBits}:${angleBits}`;
  let codec = quatCodecs.get(key);
  if (!codec) {
    codec = makeQuatCodec(axisBits, angleBits);
    quatCodecs.set(key, codec);
  }
  return codec;
}
var oct24 = octCodec(12);
var quatOct32 = quatCodec(10, 12);
var quatOct24 = quatCodec(8, 8);
var Encoding = class {
  // The same memory as floats, cached per array
  static floatView(u324) {
    let view = floatViews.get(u324);
    if (!view) {
      view = new Float32Array(u324.buffer, u324.byteOffset, u324.length);
      floatViews.set(u324, view);
    }
    return view;
  }
  // Half-float bits of f, rounded to nearest even (like the GPU's packHalf2x16)
  static encodeHalf(f) {
    if (f16 && u16) {
      f16[0] = f;
      return u16[0];
    }
    f32[0] = f;
    const bits = u32[0];
    const sign = bits >>> 16 & 32768;
    const exponent = bits >>> 23 & 255;
    const mantissa = bits & 8388607;
    if (exponent === 255) {
      return sign | 31744 | (mantissa ? 512 : 0);
    }
    const e = exponent - 127 + 15;
    if (e >= 31) {
      return sign | 31744;
    }
    if (e <= 0) {
      const m = Math.abs(f32[0]) * 2 ** 24;
      let rounded = Math.floor(m);
      const fraction = m - rounded;
      if (fraction > 0.5 || fraction === 0.5 && rounded & 1) {
        rounded += 1;
      }
      return sign | rounded;
    }
    const half = sign | e << 10 | mantissa >> 13;
    const rest = mantissa & 8191;
    return rest > 4096 || rest === 4096 && half & 1 ? half + 1 : half;
  }
  static decodeHalf(h) {
    const sign = h & 32768 ? -1 : 1;
    const exponent = h >> 10 & 31;
    const mantissa = h & 1023;
    if (exponent === 0) {
      return sign * mantissa * 2 ** -24;
    }
    if (exponent === 31) {
      return mantissa ? Number.NaN : sign * Number.POSITIVE_INFINITY;
    }
    return sign * (1 + mantissa / 1024) * 2 ** (exponent - 15);
  }
  static encodeUnorm8(v) {
    return Math.max(0, Math.min(255, Math.round(v * 255)));
  }
  // 128 = 1.0; merged LoD nodes can exceed 1, up to 255 / 128
  static encodeLodOpacity(opacity) {
    return Math.max(0, Math.min(255, Math.round(opacity * 128)));
  }
  static decodeLodOpacity(byte) {
    return byte / 128;
  }
  // 8-bit magnitudes, 3 sign bits and a 5-bit shared exponent, so colors may
  // exceed 1 or be negative
  static encodeExtRgb({ r, g, b }) {
    const maxAbs = Math.max(Math.abs(r), Math.abs(g), Math.abs(b));
    const base = Math.max(0, Math.min(31, (maxAbs > 0 ? Math.ceil(Math.log2(maxAbs)) : 0) + 15));
    const scale = 255 * 2 ** (15 - base);
    const mr = Math.min(255, Math.round(Math.abs(r) * scale));
    const mg = Math.min(255, Math.round(Math.abs(g) * scale));
    const mb = Math.min(255, Math.round(Math.abs(b) * scale));
    const signs = (r < 0 ? 1 : 0) | (g < 0 ? 2 : 0) | (b < 0 ? 4 : 0);
    return (mr | mg << 8 | mb << 16 | (base << 3 | signs) << 24) >>> 0;
  }
  static decodeExtRgb(encoded, out) {
    const unit = 2 ** ((encoded >>> 27 & 31) - 15) / 255;
    out.r = (encoded & 255) * unit * (encoded & 16777216 ? -1 : 1);
    out.g = (encoded >>> 8 & 255) * unit * (encoded & 33554432 ? -1 : 1);
    out.b = (encoded >>> 16 & 255) * unit * (encoded & 67108864 ? -1 : 1);
    return out;
  }
  // Octahedral direction with `bits` per axis (1 to 16)
  static encodeOct(v, bits) {
    return octCodec(bits).encode(v);
  }
  static decodeOct(code, bits, out) {
    return octCodec(bits).decode(code, out);
  }
  // Octahedral axis with `axisBits` per axis plus an `angleBits` angle (at
  // most 32 bits in all)
  static encodeQuatOct(q, axisBits, angleBits) {
    return quatCodec(axisBits, angleBits).encode(q);
  }
  static decodeQuatOct(code, axisBits, angleBits, out) {
    return quatCodec(axisBits, angleBits).decode(code, out);
  }
  static encodeOct24 = oct24.encode;
  static decodeOct24 = oct24.decode;
  static encodeQuatOct32 = quatOct32.encode;
  static decodeQuatOct32 = quatOct32.decode;
  static encodeQuatOct24 = quatOct24.encode;
  static decodeQuatOct24 = quatOct24.decode;
};

// src/core/sh.ts
var COEFFICIENTS = [0, 3, 8, 15, 24];
var MAX_DEGREE = 4;
var VALUES = COEFFICIENTS[MAX_DEGREE] * 3;
var PACKED_BAND_BYTES = [10, 16, 22, 28];
var PACKED_BYTES = [0, 10, 26, 48, 76];
var EXT_CHANNELS = { 1: ["A"], 2: ["A", "B"], 3: ["A", "B", "C", "D"], 4: ["A", "B", "C", "D", "E", "F"] };
var PACKED_CHANNELS = { 1: ["A"], 2: ["A", "B"], 3: ["A", "B", "C"], 4: ["A", "B", "C", "D", "E"] };
var SCALE_BIAS = 192;
var SCALE_STEPS = 16;
function encodeShScale(max) {
  if (!(max > 0)) {
    return 0;
  }
  let code = Math.max(1, Math.min(255, Math.ceil(Math.log2(max) * SCALE_STEPS) + SCALE_BIAS));
  while (code < 255 && decodeShScale(code) < max) {
    code += 1;
  }
  return code;
}
function decodeShScale(code) {
  return code === 0 ? 0 : 2 ** ((code - SCALE_BIAS) / SCALE_STEPS);
}
var getByte = (words, at, b) => words[at + (b >> 2)] >>> (b & 3) * 8 & 255;
var bytes = { out: new Uint32Array(0), at: 0, word: 0, shift: 0 };
var startBytes = (out, at) => {
  bytes.out = out;
  bytes.at = at;
  bytes.word = 0;
  bytes.shift = 0;
};
var putByte = (value) => {
  bytes.word |= (value & 255) << bytes.shift;
  bytes.shift += 8;
  if (bytes.shift === 32) {
    bytes.out[bytes.at++] = bytes.word >>> 0;
    bytes.word = 0;
    bytes.shift = 0;
  }
};
var endBytes = () => {
  if (bytes.shift > 0) {
    bytes.out[bytes.at++] = bytes.word >>> 0;
  }
};
var rgb = { r: 0, g: 0, b: 0 };
var ext = {
  name: "ext",
  words: (degree) => COEFFICIENTS[degree],
  channels: (degree) => EXT_CHANNELS[degree],
  encode(coeffs, degree, out, at) {
    for (let k = 0; k < COEFFICIENTS[degree]; k += 1) {
      rgb.r = coeffs[k * 3];
      rgb.g = coeffs[k * 3 + 1];
      rgb.b = coeffs[k * 3 + 2];
      out[at + k] = Encoding.encodeExtRgb(rgb);
    }
  },
  decode(words, at, degree, out) {
    for (let k = 0; k < COEFFICIENTS[degree]; k += 1) {
      Encoding.decodeExtRgb(words[at + k], rgb);
      out[k * 3] = rgb.r;
      out[k * 3 + 1] = rgb.g;
      out[k * 3 + 2] = rgb.b;
    }
    return out;
  }
};
var packed = {
  name: "packed",
  words: (degree) => Math.ceil(PACKED_BYTES[degree] / 4),
  channels: (degree) => PACKED_CHANNELS[degree],
  // Bands are contiguous (each its scale byte and values), so the bytes
  // go out in order
  encode(coeffs, degree, out, at) {
    startBytes(out, at);
    for (let band = 0; band < degree; band += 1) {
      const first = COEFFICIENTS[band] * 3;
      const end = COEFFICIENTS[band + 1] * 3;
      let max = 0;
      for (let v = first; v < end; v += 1) {
        max = Math.max(max, Math.abs(coeffs[v]));
      }
      const code = encodeShScale(max);
      const scale = decodeShScale(code);
      putByte(code);
      for (let v = first; v < end; v += 1) {
        putByte(scale > 0 ? Math.max(-127, Math.min(127, Math.round(coeffs[v] / scale * 127))) : 0);
      }
    }
    endBytes();
  },
  decode(words, at, degree, out) {
    let byte = 0;
    for (let band = 0; band < degree; band += 1) {
      const first = COEFFICIENTS[band] * 3;
      const end = COEFFICIENTS[band + 1] * 3;
      const scale = decodeShScale(getByte(words, at, byte)) / 127;
      for (let v = first; v < end; v += 1) {
        out[v] = (getByte(words, at, byte + 1 + v - first) << 24 >> 24) * scale;
      }
      byte += PACKED_BAND_BYTES[band];
    }
    return out;
  }
};
var CODECS = { ext, packed };
var channelLookup = /* @__PURE__ */ new Map();
var channelCounts = {};
for (const codec of Object.values(CODECS)) {
  channelCounts[codec.name] = [0, 0, 0, 0, 0];
  for (const degree of [1, 2, 3, 4]) {
    const suffixes = codec.channels(degree);
    channelCounts[codec.name][degree] = suffixes.length;
    for (const suffix of suffixes) {
      const label = `${codec.name}Sh${suffix}`;
      const entry = channelLookup.get(label);
      if (entry) {
        entry.degrees |= 1 << degree;
      } else {
        channelLookup.set(label, { codec: codec.name, degrees: 1 << degree });
      }
    }
  }
}
var shDegreeOf = (n) => n === 1 || n === 2 || n === 3 || n === 4 ? n : void 0;
var Sh = class _Sh {
  // RGB coefficients per degree, the DC band excluded
  static COEFFICIENTS = COEFFICIENTS;
  static MAX_DEGREE = MAX_DEGREE;
  // Values of the highest degree's entry: a coefficient array that fits
  // any degree
  static VALUES = VALUES;
  static LABEL = defineBundle({ label: "uint16" });
  // A codec by name (a string from meta is checked)
  static codec(name) {
    const codec = CODECS[name];
    if (!codec) {
      throw new Error(`Unknown SH codec ${name}`);
    }
    return codec;
  }
  static texels(codec, degree) {
    return Math.ceil(_Sh.codec(codec).words(degree) / 4);
  }
  // The degree of `coefficients` RGB coefficients past DC (3, 8, 15, 24), else
  // undefined
  static degreeOf(coefficients) {
    return shDegreeOf(COEFFICIENTS.indexOf(coefficients));
  }
  static bundleName(codec) {
    return `${_Sh.codec(codec).name}Sh`;
  }
  static bundle(codec, degree) {
    return defineBundle(Object.fromEntries(_Sh.codec(codec).channels(degree).map((suffix) => [`${codec}Sh${suffix}`, "uint32x4"])));
  }
  // Adds an empty per-splat SH bundle to `data`
  static add(data, codec, degree) {
    data.addBundle(_Sh.bundleName(codec), _Sh.bundle(codec, degree), { meta: { codec, degree } });
    return data.bundles[_Sh.bundleName(codec)];
  }
  // The per-splat SH bundle among `bundles` (of an ArrayData or GpuArrays):
  // a bundle whose channels are exactly a codec's for some degree.
  // Renderers call it per object per frame, so it allocates only the result.
  static find(bundles) {
    for (const name in bundles) {
      const bundle = bundles[name];
      let codec;
      let degrees = 30;
      let count = 0;
      for (const label in bundle.channels) {
        const entry = channelLookup.get(label);
        if (!entry || bundle.channels[label]?.format !== "uint32x4" || codec !== void 0 && entry.codec !== codec) {
          codec = void 0;
          break;
        }
        codec = entry.codec;
        degrees &= entry.degrees;
        count += 1;
      }
      if (codec === void 0) {
        continue;
      }
      const counts = channelCounts[codec];
      for (let degree = MAX_DEGREE; degree >= 1; degree -= 1) {
        if ((degrees & 1 << degree) !== 0 && counts[degree] === count) {
          return { name, codec, degree };
        }
      }
    }
    return void 0;
  }
  // For file readers: a bundle for a file's `degree` (0..4) of SH in
  // `target` (default ext) and its encoder, or undefined when there is none
  // or it is skipped (then meta.ignoredShDegree is the degree)
  static prepare(data, degree, target = "ext") {
    const d = shDegreeOf(degree);
    data.meta.ignoredShDegree = d && target === false ? d : 0;
    if (!d || target === false) {
      return void 0;
    }
    _Sh.add(data, target, d);
    return _Sh.encoder(data);
  }
  // The encoder of a per-splat bundle: (i, coeffs) writes splat i
  static encoder(data, found = _Sh.find(data.bundles)) {
    if (!found) {
      throw new Error("No SH bundle");
    }
    const { degree } = found;
    const codec = _Sh.codec(found.codec);
    const channels = channelArrays(data.bundles[found.name]);
    const words = new Uint32Array(channels.length * 4);
    return (i, coeffs) => {
      codec.encode(coeffs, degree, words, 0);
      const at = i * 4;
      for (let t = 0; t < channels.length; t += 1) {
        const channel = channels[t];
        const w = t * 4;
        channel[at] = words[w];
        channel[at + 1] = words[w + 1];
        channel[at + 2] = words[w + 2];
        channel[at + 3] = words[w + 3];
      }
    };
  }
  // The decoder of a per-splat bundle: (i, out) fills out with splat i's
  // coefficients (out holds at least COEFFICIENTS[degree] * 3 values)
  static decoder(data, found = _Sh.find(data.bundles)) {
    if (!found) {
      throw new Error("No SH bundle");
    }
    const { degree } = found;
    const codec = _Sh.codec(found.codec);
    const channels = channelArrays(data.bundles[found.name]);
    const words = new Uint32Array(channels.length * 4);
    return (i, out) => {
      const at = i * 4;
      for (let t = 0; t < channels.length; t += 1) {
        const channel = channels[t];
        const w = t * 4;
        words[w] = channel[at];
        words[w + 1] = channel[at + 1];
        words[w + 2] = channel[at + 2];
        words[w + 3] = channel[at + 3];
      }
      return codec.decode(words, 0, degree, out);
    };
  }
  // `data` with its SH in `codec` (at most `degree`): `data` itself when it
  // already is, else a new ArrayData sharing every other bundle's arrays
  static convert(data, codec, { degree } = {}) {
    const found = _Sh.find(data.bundles);
    if (!found) {
      return data;
    }
    const to = Math.min(degree ?? found.degree, found.degree);
    if (found.codec === codec && to === found.degree) {
      return data;
    }
    const out = shareBundles(data, found.name);
    _Sh.add(out, codec, to);
    const decode = _Sh.decoder(data, found);
    const encode = _Sh.encoder(out);
    const coeffs = new Float32Array(VALUES);
    for (let i = 0; i < data.count; i += 1) {
      encode(i, decode(i, coeffs));
    }
    return out;
  }
  // The SH color of `coeffs` along unit `dir` (object space, from the view
  // to the splat) through `degree`, added to the base color by the caller
  static evaluate(coeffs, dir, degree, out = [0, 0, 0]) {
    _Sh.basis(dir, basis);
    out[0] = 0;
    out[1] = 0;
    out[2] = 0;
    for (let k = 0; k < COEFFICIENTS[Math.max(0, Math.min(MAX_DEGREE, degree))]; k += 1) {
      out[0] += coeffs[k * 3] * basis[k];
      out[1] += coeffs[k * 3 + 1] * basis[k];
      out[2] += coeffs[k * 3 + 2] * basis[k];
    }
    return out;
  }
  // The 24 basis functions of bands 1-4 along unit `dir` (3DGS signs)
  static basis(dir, out = new Float64Array(COEFFICIENTS[MAX_DEGREE])) {
    const { x, y, z } = dir;
    const xx = x * x;
    const yy = y * y;
    const zz = z * z;
    out[0] = -0.4886025 * y;
    out[1] = 0.4886025 * z;
    out[2] = -0.4886025 * x;
    out[3] = 1.0925484 * x * y;
    out[4] = -1.0925484 * y * z;
    out[5] = 0.3153916 * (2 * zz - xx - yy);
    out[6] = -1.0925484 * x * z;
    out[7] = 0.5462742 * (xx - yy);
    out[8] = -0.5900436 * y * (3 * xx - yy);
    out[9] = 2.8906114 * x * y * z;
    out[10] = -0.4570458 * y * (4 * zz - xx - yy);
    out[11] = 0.3731763 * z * (2 * zz - 3 * xx - 3 * yy);
    out[12] = -0.4570458 * x * (4 * zz - xx - yy);
    out[13] = 1.4453057 * z * (xx - yy);
    out[14] = -0.5900436 * x * (xx - 3 * yy);
    out[15] = 2.5033429 * x * y * (xx - yy);
    out[16] = -1.7701308 * y * z * (3 * xx - yy);
    out[17] = 0.9461747 * x * y * (7 * zz - 1);
    out[18] = -0.6690465 * y * z * (7 * zz - 3);
    out[19] = 0.1057855 * (zz * (35 * zz - 30) + 3);
    out[20] = -0.6690465 * x * z * (7 * zz - 3);
    out[21] = 0.4730873 * (xx - yy) * (7 * zz - 1);
    out[22] = -1.7701308 * x * z * (xx - 3 * yy);
    out[23] = 0.6258357 * (xx * (xx - 3 * yy) - yy * (3 * xx - yy));
    return out;
  }
};
var basis = new Float64Array(COEFFICIENTS[MAX_DEGREE]);
var channelArrays = (bundle) => Object.values(bundle.channels).map((channel) => channel.data);
var channelRecord = (bundle) => Object.fromEntries(Object.entries(bundle.channels).map(([label, channel]) => [label, channel.data]));
function shareBundles(data, without) {
  const out = new ArrayData({ count: data.count, capacity: data.capacity, meta: { ...data.meta } });
  for (const [name, bundle] of Object.entries(data.bundles)) {
    if (name !== without) {
      out.addBundle(name, bundle.def, { data: channelRecord(bundle), meta: bundle.meta });
    }
  }
  return out;
}
var PALETTE = defineBundle({ shEntries: "uint32x4" });
var ShPalette = class _ShPalette {
  static BUNDLE = PALETTE;
  data;
  constructor(data) {
    if (data.bundles.shPalette?.channels.shEntries?.format !== "uint32x4") {
      throw new Error("Not an SH palette: no shPalette.shEntries channel");
    }
    this.data = data;
  }
  // The default stride of a codec's entries: its texels rounded up to a
  // power of two (1 / 2 / 4 / 8 for degree 1 / 2 / 3 / 4)
  static strideOf(codec, degree) {
    return 2 ** Math.ceil(Math.log2(Sh.texels(codec, degree)));
  }
  static create({ codec, degree, size, stride }) {
    const s = stride ?? _ShPalette.strideOf(codec, degree);
    if (s < Sh.texels(codec, degree)) {
      throw new Error(`Palette stride ${s} below the codec's ${Sh.texels(codec, degree)} texels`);
    }
    const data = new ArrayData({ count: size * s, meta: {} });
    data.addBundle("shPalette", PALETTE, { meta: { codec, degree, size, stride: s } });
    return new _ShPalette(data);
  }
  get meta() {
    return this.data.bundles.shPalette.meta;
  }
  get codec() {
    return Sh.codec(this.meta.codec).name;
  }
  get degree() {
    return this.meta.degree;
  }
  get size() {
    return this.meta.size;
  }
  get stride() {
    return this.meta.stride;
  }
  get words() {
    return this.data.bundles.shPalette.channels.shEntries.data;
  }
  set(n, coeffs) {
    Sh.codec(this.codec).encode(coeffs, this.degree, this.words, n * this.stride * 4);
  }
  get(n, out = new Float32Array(VALUES)) {
    return Sh.codec(this.codec).decode(this.words, n * this.stride * 4, this.degree, out);
  }
  // The same entries in another codec
  convert(codec, { stride } = {}) {
    const out = _ShPalette.create({ codec, degree: this.degree, size: this.size, stride });
    const coeffs = new Float32Array(VALUES);
    for (let n = 0; n < this.size; n += 1) {
      out.set(n, this.get(n, coeffs));
    }
    return out;
  }
  // Per-splat SH in `codec` for `labels` (one per splat), added to `data`
  expand(data, labels, codec = this.codec) {
    Sh.add(data, codec, this.degree);
    const encode = Sh.encoder(data);
    const coeffs = new Float32Array(VALUES);
    for (let i = 0; i < labels.length; i += 1) {
      encode(i, this.get(labels[i], coeffs));
    }
    return data;
  }
  // `data` with per-splat SH in place of its shLabel bundle: a new
  // ArrayData sharing every other bundle's arrays (`data` itself when it
  // has no labels)
  expanded(data, codec = this.codec) {
    const labels = data.bundles.shLabel?.channels.label?.data;
    if (!labels) {
      return data;
    }
    return this.expand(shareBundles(data, "shLabel"), labels.subarray(0, data.count), codec);
  }
};

// src/core/math.ts
var SplatMath = class _SplatMath {
  // Unit quaternion (identity for a zero one)
  static normalizeQuat(q, out) {
    const length = Math.sqrt(q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w);
    if (!(length > 0)) {
      out.x = 0;
      out.y = 0;
      out.z = 0;
      out.w = 1;
      return out;
    }
    out.x = q.x / length;
    out.y = q.y / length;
    out.z = q.z / length;
    out.w = q.w / length;
    return out;
  }
  // Sigma = M M^T with M = R(q) diag(scales)
  static covFromScaleQuat(scales, q, out) {
    const { x, y, z, w } = _SplatMath.normalizeQuat(q, { x: 0, y: 0, z: 0, w: 1 });
    const m = [
      scales.x * (1 - 2 * (y * y + z * z)),
      scales.x * 2 * (x * y + w * z),
      scales.x * 2 * (x * z - w * y),
      scales.y * 2 * (x * y - w * z),
      scales.y * (1 - 2 * (x * x + z * z)),
      scales.y * 2 * (y * z + w * x),
      scales.z * 2 * (x * z + w * y),
      scales.z * 2 * (y * z - w * x),
      scales.z * (1 - 2 * (x * x + y * y))
    ];
    const dot = (i, j) => m[i] * m[j] + m[i + 3] * m[j + 3] + m[i + 6] * m[j + 6];
    out.xx = dot(0, 0);
    out.yy = dot(1, 1);
    out.zz = dot(2, 2);
    out.xy = dot(0, 1);
    out.xz = dot(0, 2);
    out.yz = dot(1, 2);
    return out;
  }
  // Eigenvalues (descending) and eigenvectors (columns of `basis`,
  // right-handed) of a symmetric 3x3 matrix, by Jacobi rotations
  static symEigens(c) {
    const a = [c.xx, c.xy, c.xz, c.xy, c.yy, c.yz, c.xz, c.yz, c.zz];
    const v = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    const at = (col, row) => col * 3 + row;
    const eps = 1e-9 * (Math.abs(c.xx) + Math.abs(c.yy) + Math.abs(c.zz));
    for (let iter = 0; iter < 16; iter += 1) {
      let p = 0;
      let q = 1;
      let max = Math.abs(a[at(0, 1)]);
      if (Math.abs(a[at(0, 2)]) > max) {
        max = Math.abs(a[at(0, 2)]);
        q = 2;
      }
      if (Math.abs(a[at(1, 2)]) > max) {
        max = Math.abs(a[at(1, 2)]);
        p = 1;
        q = 2;
      }
      if (max <= eps) {
        break;
      }
      const phi = 0.5 * Math.atan2(2 * a[at(p, q)], a[at(q, q)] - a[at(p, p)]);
      const cos = Math.cos(phi);
      const sin = Math.sin(phi);
      for (let r = 0; r < 3; r += 1) {
        const arp = a[at(r, p)];
        const arq = a[at(r, q)];
        a[at(r, p)] = cos * arp - sin * arq;
        a[at(r, q)] = sin * arp + cos * arq;
      }
      for (let r = 0; r < 3; r += 1) {
        const apr = a[at(p, r)];
        const aqr = a[at(q, r)];
        a[at(p, r)] = cos * apr - sin * aqr;
        a[at(q, r)] = sin * apr + cos * aqr;
      }
      a[at(p, q)] = 0;
      a[at(q, p)] = 0;
      for (let r = 0; r < 3; r += 1) {
        const vrp = v[at(r, p)];
        const vrq = v[at(r, q)];
        v[at(r, p)] = cos * vrp - sin * vrq;
        v[at(r, q)] = sin * vrp + cos * vrq;
      }
    }
    const pairs = [0, 1, 2].map((j) => {
      const vector = [v[at(0, j)], v[at(1, j)], v[at(2, j)]];
      const length = Math.max(Math.hypot(vector[0], vector[1], vector[2]), 1e-30);
      return { value: a[at(j, j)], vector: vector.map((x) => x / length) };
    });
    pairs.sort((x, y) => y.value - x.value);
    const [v0, v1, v2] = pairs.map((pair) => pair.vector);
    const det = v0[0] * (v1[1] * v2[2] - v1[2] * v2[1]) - v1[0] * (v0[1] * v2[2] - v0[2] * v2[1]) + v2[0] * (v0[1] * v1[2] - v0[2] * v1[1]);
    if (det < 0) {
      v2[0] = -v2[0];
      v2[1] = -v2[1];
      v2[2] = -v2[2];
    }
    return { values: { x: pairs[0].value, y: pairs[1].value, z: pairs[2].value }, basis: [...v0, ...v1, ...v2] };
  }
  // Quaternion (w >= 0) of an orthonormal basis given as columns, after
  // glam's Quat::from_rotation_axes
  static basisToQuat(m, out) {
    const [m00, m01, m02, m10, m11, m12, m20, m21, m22] = m;
    let x;
    let y;
    let z;
    let w;
    if (m22 <= 0) {
      const dif10 = m11 - m00;
      const omm22 = 1 - m22;
      if (dif10 <= 0) {
        const four = omm22 - dif10;
        const inv = 0.5 / Math.sqrt(Math.max(four, 1e-30));
        [x, y, z, w] = [four * inv, (m01 + m10) * inv, (m02 + m20) * inv, (m12 - m21) * inv];
      } else {
        const four = omm22 + dif10;
        const inv = 0.5 / Math.sqrt(Math.max(four, 1e-30));
        [x, y, z, w] = [(m01 + m10) * inv, four * inv, (m12 + m21) * inv, (m20 - m02) * inv];
      }
    } else {
      const sum10 = m11 + m00;
      const opm22 = 1 + m22;
      if (sum10 <= 0) {
        const four = opm22 - sum10;
        const inv = 0.5 / Math.sqrt(Math.max(four, 1e-30));
        [x, y, z, w] = [(m02 + m20) * inv, (m12 + m21) * inv, four * inv, (m01 - m10) * inv];
      } else {
        const four = opm22 + sum10;
        const inv = 0.5 / Math.sqrt(Math.max(four, 1e-30));
        [x, y, z, w] = [(m12 - m21) * inv, (m20 - m02) * inv, (m01 - m10) * inv, four * inv];
      }
    }
    const s = w < 0 ? -1 : 1;
    return _SplatMath.normalizeQuat({ x: x * s, y: y * s, z: z * s, w: w * s }, out);
  }
};

// src/core/splats.ts
var EXT = defineBundle({ extA: "uint32x4", extB: "uint32x4" });
var COV = defineBundle({ covA: "uint32x4", covB: "uint32x4" });
var PACKED = defineBundle({ packed: "uint32x4" });
var LOD_TREE = defineBundle({ node: "uint32x2" });
var LAYOUTS = { extSplats: EXT, covSplats: COV, packedSplats: PACKED };
var DEFAULT_PACKED_ENCODING = { rgbMin: 0, rgbMax: 1, lnScaleMin: -12, lnScaleMax: 9 };
function hasLayout(bundle, layout) {
  const channels = LAYOUTS[layout].channels;
  const labels = Object.keys(channels);
  return labels.length === Object.keys(bundle.channels).length && labels.every((label) => bundle.channels[label]?.format === channels[label]);
}
var isExtBundle = (bundle) => "extA" in bundle.channels;
var isCovBundle = (bundle) => "covA" in bundle.channels;
var lnHalf = (v) => Encoding.encodeHalf(Math.log(v));
var expHalf = (h) => Math.exp(Encoding.decodeHalf(h));
function storeA(a, f, i4, center, opacity) {
  f[i4] = center.x;
  f[i4 + 1] = center.y;
  f[i4 + 2] = center.z;
  a[i4 + 3] = (a[i4 + 3] & 16777215 | Encoding.encodeLodOpacity(opacity) << 24) >>> 0;
}
function storeNormal(a, i4, normal) {
  a[i4 + 3] = (a[i4 + 3] & 4278190080 | Encoding.encodeOct24(normal)) >>> 0;
}
function loadCenterA(f, i4, out) {
  out.x = f[i4];
  out.y = f[i4 + 1];
  out.z = f[i4 + 2];
  return out;
}
function storeExtFields(a, f, b, i4, s) {
  storeA(a, f, i4, s.center, s.opacity);
  b[i4] = Encoding.encodeExtRgb(s.rgb);
  b[i4 + 1] = (lnHalf(s.scales.x) | lnHalf(s.scales.y) << 16) >>> 0;
  b[i4 + 2] = (b[i4 + 2] & 4294901760 | lnHalf(s.scales.z)) >>> 0;
  b[i4 + 3] = Encoding.encodeQuatOct32(s.quaternion);
}
function storeExtPbr(a, b, i4, p) {
  storeNormal(a, i4, p.normal);
  b[i4 + 2] = (b[i4 + 2] & 65535 | Encoding.encodeUnorm8(p.roughness) << 16 | Encoding.encodeUnorm8(p.metallic) << 24) >>> 0;
}
function loadExtFields(a, f, b, i4, out) {
  loadCenterA(f, i4, out.center);
  out.opacity = Encoding.decodeLodOpacity(a[i4 + 3] >>> 24);
  Encoding.decodeExtRgb(b[i4], out.rgb);
  out.scales.x = expHalf(b[i4 + 1] & 65535);
  out.scales.y = expHalf(b[i4 + 1] >>> 16);
  out.scales.z = expHalf(b[i4 + 2] & 65535);
  Encoding.decodeQuatOct32(b[i4 + 3], out.quaternion);
  return out;
}
function loadExtPbr(a, b, i4, out) {
  Encoding.decodeOct24(a[i4 + 3] & 16777215, out.normal);
  out.roughness = (b[i4 + 2] >>> 16 & 255) / 255;
  out.metallic = (b[i4 + 2] >>> 24) / 255;
  return out;
}
function encodeExtWords(a, f, b, i4, s) {
  a[i4 + 3] = 0;
  b[i4 + 2] = 0;
  storeExtFields(a, f, b, i4, s);
  storeExtPbr(a, b, i4, s);
}
function decodeExtWords(a, f, b, i4, out) {
  loadExtFields(a, f, b, i4, out);
  loadExtPbr(a, b, i4, out);
  return out;
}
function encodeCorrelation(value, a, b) {
  const c = Math.max(-1, Math.min(1, value / Math.sqrt(a * b)));
  if (c === 0 || !Number.isFinite(c)) {
    return 0;
  }
  return Math.sign(c) * Math.max(-100, Math.min(-1e-7, Math.log(Math.abs(c))));
}
function decodeCorrelation(encoded) {
  return encoded === 0 ? 0 : -Math.sign(encoded) * Math.exp(-Math.abs(encoded));
}
function storeCovFields(a, f, b, i4, center, cov, rgb2, opacity) {
  const { xx, yy, zz, xy, xz, yz } = cov;
  storeA(a, f, i4, center, opacity);
  b[i4] = Encoding.encodeExtRgb(rgb2);
  b[i4 + 1] = (lnHalf(xx) | lnHalf(yy) << 16) >>> 0;
  b[i4 + 2] = (lnHalf(zz) | Encoding.encodeHalf(encodeCorrelation(xy, xx, yy)) << 16) >>> 0;
  b[i4 + 3] = (Encoding.encodeHalf(encodeCorrelation(xz, xx, zz)) | Encoding.encodeHalf(encodeCorrelation(yz, yy, zz)) << 16) >>> 0;
}
function encodeCovWords(a, f, b, i4, c) {
  a[i4 + 3] = 0;
  storeCovFields(a, f, b, i4, c.center, c.cov, c.rgb, c.opacity);
  storeNormal(a, i4, c.normal);
}
function decodeCovWords(a, f, b, i4, out) {
  loadCenterA(f, i4, out.center);
  Encoding.decodeOct24(a[i4 + 3] & 16777215, out.normal);
  out.opacity = Encoding.decodeLodOpacity(a[i4 + 3] >>> 24);
  Encoding.decodeExtRgb(b[i4], out.rgb);
  const xx = expHalf(b[i4 + 1] & 65535);
  const yy = expHalf(b[i4 + 1] >>> 16);
  const zz = expHalf(b[i4 + 2] & 65535);
  out.cov.xx = xx;
  out.cov.yy = yy;
  out.cov.zz = zz;
  out.cov.xy = decodeCorrelation(Encoding.decodeHalf(b[i4 + 2] >>> 16)) * Math.sqrt(xx * yy);
  out.cov.xz = decodeCorrelation(Encoding.decodeHalf(b[i4 + 3] & 65535)) * Math.sqrt(xx * zz);
  out.cov.yz = decodeCorrelation(Encoding.decodeHalf(b[i4 + 3] >>> 16)) * Math.sqrt(yy * zz);
  return out;
}
function packedCodec({ rgbMin, rgbMax, lnScaleMin, lnScaleMax }) {
  const rgbRange = rgbMax - rgbMin;
  const lnStep = (lnScaleMax - lnScaleMin) / 254;
  const color = (v) => Encoding.encodeUnorm8((v - rgbMin) / rgbRange);
  const scale = (v) => v <= 0 ? 0 : Math.max(1, Math.min(255, Math.round((Math.log(v) - lnScaleMin) / lnStep) + 1));
  const colorOf = (byte) => rgbMin + byte / 255 * rgbRange;
  const scaleOf = (code) => code === 0 ? 0 : Math.exp(lnScaleMin + (code - 1) * lnStep);
  return {
    encode(data, i4, s) {
      const quat = Encoding.encodeQuatOct24(s.quaternion);
      data[i4] = (color(s.rgb.r) | color(s.rgb.g) << 8 | color(s.rgb.b) << 16 | Encoding.encodeUnorm8(s.opacity) << 24) >>> 0;
      data[i4 + 1] = (Encoding.encodeHalf(s.center.x) | Encoding.encodeHalf(s.center.y) << 16) >>> 0;
      data[i4 + 2] = (Encoding.encodeHalf(s.center.z) | (quat & 65535) << 16) >>> 0;
      data[i4 + 3] = (scale(s.scales.x) | scale(s.scales.y) << 8 | scale(s.scales.z) << 16 | quat >>> 16 << 24) >>> 0;
    },
    decode(data, i4, out) {
      const x = data[i4];
      const y = data[i4 + 1];
      const z = data[i4 + 2];
      const w = data[i4 + 3];
      out.rgb.r = colorOf(x & 255);
      out.rgb.g = colorOf(x >>> 8 & 255);
      out.rgb.b = colorOf(x >>> 16 & 255);
      out.opacity = (x >>> 24) / 255;
      out.center.x = Encoding.decodeHalf(y & 65535);
      out.center.y = Encoding.decodeHalf(y >>> 16);
      out.center.z = Encoding.decodeHalf(z & 65535);
      out.scales.x = scaleOf(w & 255);
      out.scales.y = scaleOf(w >>> 8 & 255);
      out.scales.z = scaleOf(w >>> 16 & 255);
      Encoding.decodeQuatOct24(z >>> 16 | w >>> 24 << 16, out.quaternion);
      return out;
    }
  };
}
var extWords = (bundle) => {
  const a = bundle.channels.extA.data;
  return { a, f: Encoding.floatView(a), b: bundle.channels.extB.data };
};
var covWords = (bundle) => {
  const a = bundle.channels.covA.data;
  return { a, f: Encoding.floatView(a), b: bundle.channels.covB.data };
};
var arraysOf = (bundle) => Object.fromEntries(Object.entries(bundle.channels).map(([label, channel]) => [label, channel.data]));
var covScratch = {
  center: { x: 0, y: 0, z: 0 },
  cov: { xx: 1, yy: 1, zz: 1, xy: 0, xz: 0, yz: 0 },
  rgb: { r: 1, g: 1, b: 1 },
  opacity: 1,
  normal: { x: 0, y: 0, z: 0 }
};
var Splats = class _Splats {
  static EXT = EXT;
  static COV = COV;
  static PACKED = PACKED;
  static LOD_TREE = LOD_TREE;
  static LAYOUTS = LAYOUTS;
  static DEFAULT_PACKED_ENCODING = DEFAULT_PACKED_ENCODING;
  // --- Plain splat records ---
  static makeSplat() {
    return { center: { x: 0, y: 0, z: 0 }, scales: { x: 1, y: 1, z: 1 }, quaternion: { x: 0, y: 0, z: 0, w: 1 }, rgb: { r: 1, g: 1, b: 1 }, opacity: 1 };
  }
  static makePbr() {
    return { normal: { x: 0, y: 0, z: 0 }, roughness: 1, metallic: 0 };
  }
  static makeExtSplat() {
    return { ..._Splats.makeSplat(), ..._Splats.makePbr() };
  }
  static makeCovSplat() {
    return {
      center: { x: 0, y: 0, z: 0 },
      cov: { xx: 1, yy: 1, zz: 1, xy: 0, xz: 0, yz: 0 },
      rgb: { r: 1, g: 1, b: 1 },
      opacity: 1,
      normal: { x: 0, y: 0, z: 0 }
    };
  }
  // --- Bundles and tables ---
  static packedEncodingOf(bundle) {
    return { ...DEFAULT_PACKED_ENCODING, ...bundle.meta.encoding };
  }
  static isExt(bundle) {
    return hasLayout(bundle, "extSplats");
  }
  static isCov(bundle) {
    return hasLayout(bundle, "covSplats");
  }
  static isPacked(bundle) {
    return hasLayout(bundle, "packedSplats");
  }
  static layoutOf(bundle) {
    return Object.keys(LAYOUTS).find((layout) => hasLayout(bundle, layout));
  }
  // The splat bundle among `bundles` (of an ArrayData or GpuArrays):
  // `name` when given, else the standard names first, then any bundle of a
  // splat layout
  static findBundle(bundles, name) {
    const names = name !== void 0 ? [name] : [...Object.keys(LAYOUTS), ...Object.keys(bundles)];
    for (const candidate of names) {
      const bundle = bundles[candidate];
      const layout = bundle && _Splats.layoutOf(bundle);
      if (layout) {
        return { name: candidate, layout };
      }
    }
    return void 0;
  }
  // The splat bundle of `data` (as findBundle), or undefined
  static find(data, name) {
    const found = _Splats.findBundle(data.bundles, name);
    return found && { ...found, bundle: data.bundles[found.name] };
  }
  // The splat bundle of `data`; throws when there is none
  static get(data, name) {
    const found = _Splats.find(data, name);
    if (!found) {
      throw new Error(name !== void 0 ? `Bundle ${name} is not a splat bundle` : "No extSplats, covSplats or packedSplats bundle");
    }
    return found;
  }
  // The tree beside the splats, when the data has one
  static findLodTree(data) {
    const bundle = data.bundles.lodTree;
    return bundle?.channels.node?.format === "uint32x2" ? bundle : void 0;
  }
  // Adds an empty splat bundle of `layout` (default extSplats), named after it
  static add(data, { layout = "extSplats", encoding } = {}) {
    const meta = layout === "packedSplats" ? { encoding: { ...DEFAULT_PACKED_ENCODING, ...encoding } } : {};
    data.addBundle(layout, LAYOUTS[layout], { meta });
    return data.bundles[layout];
  }
  // Empty splats of `layout` in a new ArrayData of `count` elements
  static make(count, { meta, ...target } = {}) {
    const data = new ArrayData({ count, meta });
    _Splats.add(data, target);
    return data;
  }
  // `data` with its splats in `layout` (packed: in `encoding`, default the
  // source's): `data` itself when they already are, else a new ArrayData
  // sharing every other bundle's arrays
  static convert(data, { layout, encoding }) {
    const found = _Splats.get(data);
    const source = found.layout === "packedSplats" ? _Splats.packedEncodingOf(found.bundle) : void 0;
    const sameEncoding = !encoding || layout !== "packedSplats" || source !== void 0 && Object.entries(encoding).every(([key, value]) => source[key] === value);
    if (found.layout === layout && found.name === layout && sameEncoding) {
      return data;
    }
    const out = new ArrayData({ count: data.count, capacity: data.capacity, meta: { ...data.meta } });
    for (const [name, bundle] of Object.entries(data.bundles)) {
      if (name !== found.name) {
        out.addBundle(name, bundle.def, { data: arraysOf(bundle), meta: bundle.meta });
      }
    }
    if (found.layout === layout && sameEncoding) {
      out.addBundle(layout, found.bundle.def, { data: arraysOf(found.bundle), meta: found.bundle.meta });
      return out;
    }
    const decode = _Splats.decoder(found.bundle);
    const encode = _Splats.encoder(_Splats.add(out, { layout, encoding: { ...source, ...encoding } }));
    const s = _Splats.makeExtSplat();
    for (let i = 0; i < data.count; i += 1) {
      encode(i, decode(i, s));
    }
    return out;
  }
  // --- One layout's words ---
  static encodeExt(bundle, i, s) {
    const { a, f, b } = extWords(bundle);
    encodeExtWords(a, f, b, i * 4, s);
  }
  static decodeExt(bundle, i, out) {
    const { a, f, b } = extWords(bundle);
    return decodeExtWords(a, f, b, i * 4, out);
  }
  static encodeCov(bundle, i, c) {
    const { a, f, b } = covWords(bundle);
    encodeCovWords(a, f, b, i * 4, c);
  }
  static decodeCov(bundle, i, out) {
    const { a, f, b } = covWords(bundle);
    return decodeCovWords(a, f, b, i * 4, out);
  }
  static encodePacked(bundle, i, s, encoding = _Splats.packedEncodingOf(bundle)) {
    packedCodec(encoding).encode(bundle.channels.packed.data, i * 4, s);
  }
  static decodePacked(bundle, i, out, encoding = _Splats.packedEncodingOf(bundle)) {
    return packedCodec(encoding).decode(bundle.channels.packed.data, i * 4, out);
  }
  // --- Any layout, by the bundle's type ---
  // The standard 3DGS fields of splat i (cov splats are diagonalized)
  static load(bundle, i, out) {
    if (isExtBundle(bundle)) {
      const { a, f, b } = extWords(bundle);
      return loadExtFields(a, f, b, i * 4, out);
    }
    if (isCovBundle(bundle)) {
      return _Splats.fromCov(_Splats.decodeCov(bundle, i, covScratch), out);
    }
    return _Splats.decodePacked(bundle, i, out);
  }
  // Writes the standard 3DGS fields; ext keeps its PBR bits, cov its normal
  static store(bundle, i, s) {
    if (isExtBundle(bundle)) {
      const { a, f, b } = extWords(bundle);
      storeExtFields(a, f, b, i * 4, s);
    } else if (isCovBundle(bundle)) {
      const { a, f, b } = covWords(bundle);
      storeCovFields(a, f, b, i * 4, s.center, SplatMath.covFromScaleQuat(s.scales, s.quaternion, covScratch.cov), s.rgb, s.opacity);
    } else {
      _Splats.encodePacked(bundle, i, s);
    }
  }
  static loadPbr(bundle, i, out) {
    return loadExtPbr(bundle.channels.extA.data, bundle.channels.extB.data, i * 4, out);
  }
  // Writes the PBR fields; keeps the 3DGS bits
  static storePbr(bundle, i, p) {
    storeExtPbr(bundle.channels.extA.data, bundle.channels.extB.data, i * 4, p);
  }
  static loadCenter(bundle, i, out) {
    if (isExtBundle(bundle)) {
      return loadCenterA(Encoding.floatView(bundle.channels.extA.data), i * 4, out);
    }
    if (isCovBundle(bundle)) {
      return loadCenterA(Encoding.floatView(bundle.channels.covA.data), i * 4, out);
    }
    const data = bundle.channels.packed.data;
    out.x = Encoding.decodeHalf(data[i * 4 + 1] & 65535);
    out.y = Encoding.decodeHalf(data[i * 4 + 1] >>> 16);
    out.z = Encoding.decodeHalf(data[i * 4 + 2] & 65535);
    return out;
  }
  // The encoder of the bundle's layout, made once for a loop over splats:
  // (i, s) writes every field the layout stores (ext all of them, cov the
  // covariance and normal, packed the 3DGS fields in its encoding)
  static encoder(bundle) {
    if (isExtBundle(bundle)) {
      const { a, f, b } = extWords(bundle);
      return (i, s) => encodeExtWords(a, f, b, i * 4, s);
    }
    if (isCovBundle(bundle)) {
      const { a, f, b } = covWords(bundle);
      const cov = _Splats.makeCovSplat();
      return (i, s) => {
        _Splats.toCov(s, cov);
        cov.normal.x = s.normal.x;
        cov.normal.y = s.normal.y;
        cov.normal.z = s.normal.z;
        encodeCovWords(a, f, b, i * 4, cov);
      };
    }
    const data = bundle.channels.packed.data;
    const codec = packedCodec(_Splats.packedEncodingOf(bundle));
    return (i, s) => codec.encode(data, i * 4, s);
  }
  // The decoder of the bundle's layout: (i, out) fills every field, with the
  // defaults for those the layout lacks (no normal, roughness 1, metallic 0)
  static decoder(bundle) {
    if (isExtBundle(bundle)) {
      const { a, f, b } = extWords(bundle);
      return (i, out) => decodeExtWords(a, f, b, i * 4, out);
    }
    const noPbr = (out, normal) => {
      out.normal.x = normal?.x ?? 0;
      out.normal.y = normal?.y ?? 0;
      out.normal.z = normal?.z ?? 0;
      out.roughness = 1;
      out.metallic = 0;
      return out;
    };
    if (isCovBundle(bundle)) {
      const { a, f, b } = covWords(bundle);
      const cov = _Splats.makeCovSplat();
      return (i, out) => {
        _Splats.fromCov(decodeCovWords(a, f, b, i * 4, cov), out);
        return noPbr(out, cov.normal);
      };
    }
    const data = bundle.channels.packed.data;
    const codec = packedCodec(_Splats.packedEncodingOf(bundle));
    return (i, out) => noPbr(codec.decode(data, i * 4, out));
  }
  // --- Conversions ---
  // The covariance of s; out.normal is left as is
  static toCov(s, out) {
    out.center.x = s.center.x;
    out.center.y = s.center.y;
    out.center.z = s.center.z;
    out.rgb.r = s.rgb.r;
    out.rgb.g = s.rgb.g;
    out.rgb.b = s.rgb.b;
    out.opacity = s.opacity;
    SplatMath.covFromScaleQuat(s.scales, s.quaternion, out.cov);
    return out;
  }
  // Diagonalizes the covariance; the normal is dropped
  static fromCov(c, out) {
    const { values, basis: basis2 } = SplatMath.symEigens(c.cov);
    out.center.x = c.center.x;
    out.center.y = c.center.y;
    out.center.z = c.center.z;
    out.rgb.r = c.rgb.r;
    out.rgb.g = c.rgb.g;
    out.rgb.b = c.rgb.b;
    out.opacity = c.opacity;
    out.scales.x = Math.sqrt(Math.max(values.x, 0));
    out.scales.y = Math.sqrt(Math.max(values.y, 0));
    out.scales.z = Math.sqrt(Math.max(values.z, 0));
    SplatMath.basisToQuat(basis2, out.quaternion);
    return out;
  }
};

// src/core/axes.ts
var SYSTEMS = [
  "LDB",
  "RDB",
  "LUB",
  "RUB",
  "LDF",
  "RDF",
  "LUF",
  "RUF",
  "LFD",
  "RFD",
  "LFU",
  "RFU",
  "LBD",
  "RBD",
  "LBU",
  "RBU"
];
var DIRECTIONS = {
  R: [1, 0, 0],
  L: [-1, 0, 0],
  U: [0, 1, 0],
  D: [0, -1, 0],
  B: [0, 0, 1],
  F: [0, 0, -1]
};
function axesOf(system) {
  if (!SYSTEMS.includes(system)) {
    throw new Error(`Unknown coordinate system ${String(system)}`);
  }
  return [...system].map((letter) => DIRECTIONS[letter]);
}
var FIT = Array.from({ length: 32 }, (_, k) => {
  const z = 1 - (2 * k + 1) / 32;
  const r = Math.sqrt(1 - z * z);
  const phi = k * 2.399963229728653 + 0.5;
  return { x: r * Math.cos(phi), y: r * Math.sin(phi), z };
});
function bandMatrix(m, l) {
  const size = 2 * l + 1;
  const start = Sh.COEFFICIENTS[l - 1];
  const normal = new Float64Array(size * size);
  const right = new Float64Array(size * size);
  const a = new Float64Array(Sh.COEFFICIENTS[Sh.MAX_DEGREE]);
  const b = new Float64Array(Sh.COEFFICIENTS[Sh.MAX_DEGREE]);
  for (const d of FIT) {
    Sh.basis(d, a);
    Sh.basis({
      x: m[0] * d.x + m[3] * d.y + m[6] * d.z,
      y: m[1] * d.x + m[4] * d.y + m[7] * d.z,
      z: m[2] * d.x + m[5] * d.y + m[8] * d.z
    }, b);
    for (let i = 0; i < size; i += 1) {
      for (let j = 0; j < size; j += 1) {
        normal[i * size + j] += a[start + i] * a[start + j];
        right[i * size + j] += a[start + i] * b[start + j];
      }
    }
  }
  for (let col = 0; col < size; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < size; row += 1) {
      if (Math.abs(normal[row * size + col]) > Math.abs(normal[pivot * size + col])) {
        pivot = row;
      }
    }
    for (let j = 0; j < size; j += 1) {
      [normal[col * size + j], normal[pivot * size + j]] = [normal[pivot * size + j], normal[col * size + j]];
      [right[col * size + j], right[pivot * size + j]] = [right[pivot * size + j], right[col * size + j]];
    }
    const inv = 1 / normal[col * size + col];
    for (let row = 0; row < size; row += 1) {
      if (row !== col) {
        const f = normal[row * size + col] * inv;
        for (let j = 0; j < size; j += 1) {
          normal[row * size + j] -= f * normal[col * size + j];
          right[row * size + j] -= f * right[col * size + j];
        }
      }
    }
  }
  for (let row = 0; row < size; row += 1) {
    const inv = 1 / normal[row * size + row];
    for (let j = 0; j < size; j += 1) {
      right[row * size + j] *= inv;
    }
  }
  return right.map((v) => Math.abs(v - Math.round(v)) < 1e-9 ? Math.round(v) : v);
}
var Converter = class {
  matrix;
  identity;
  det;
  bands = [];
  scratch = new Float64Array(9);
  constructor(matrix) {
    this.matrix = matrix;
    this.identity = matrix.every((v, i2) => v === (i2 % 4 === 0 ? 1 : 0));
    const [a, b, c, d, e, f, g, h, i] = matrix;
    this.det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  }
  vec(v) {
    const m = this.matrix;
    const { x, y, z } = v;
    v.x = m[0] * x + m[1] * y + m[2] * z;
    v.y = m[3] * x + m[4] * y + m[5] * z;
    v.z = m[6] * x + m[7] * y + m[8] * z;
    return v;
  }
  quat(q) {
    const m = this.matrix;
    const d = this.det;
    const { x, y, z } = q;
    q.x = d * (m[0] * x + m[1] * y + m[2] * z);
    q.y = d * (m[3] * x + m[4] * y + m[5] * z);
    q.z = d * (m[6] * x + m[7] * y + m[8] * z);
    return q;
  }
  scales(s) {
    const m = this.matrix;
    const { x, y, z } = s;
    s.x = Math.abs(m[0]) * x + Math.abs(m[1]) * y + Math.abs(m[2]) * z;
    s.y = Math.abs(m[3]) * x + Math.abs(m[4]) * y + Math.abs(m[5]) * z;
    s.z = Math.abs(m[6]) * x + Math.abs(m[7]) * y + Math.abs(m[8]) * z;
    return s;
  }
  cov(c) {
    const m = this.matrix;
    const s = [c.xx, c.xy, c.xz, c.xy, c.yy, c.yz, c.xz, c.yz, c.zz];
    const ms = this.scratch;
    for (let i = 0; i < 3; i += 1) {
      for (let j = 0; j < 3; j += 1) {
        ms[i * 3 + j] = m[i * 3] * s[j] + m[i * 3 + 1] * s[3 + j] + m[i * 3 + 2] * s[6 + j];
      }
    }
    const at = (i, j) => ms[i * 3] * m[j * 3] + ms[i * 3 + 1] * m[j * 3 + 1] + ms[i * 3 + 2] * m[j * 3 + 2];
    c.xx = at(0, 0);
    c.yy = at(1, 1);
    c.zz = at(2, 2);
    c.xy = at(0, 1);
    c.xz = at(0, 2);
    c.yz = at(1, 2);
    return c;
  }
  splat(s) {
    this.vec(s.center);
    this.quat(s.quaternion);
    this.scales(s.scales);
    if ("normal" in s) {
      this.vec(s.normal);
    }
    return s;
  }
  sh(coeffs, degree) {
    if (this.identity) {
      return coeffs;
    }
    const tmp = this.scratch;
    for (let l = 1; l <= degree; l += 1) {
      const t = this.bands[l] ??= bandMatrix(this.matrix, l);
      const size = 2 * l + 1;
      const start = Sh.COEFFICIENTS[l - 1];
      for (let c = 0; c < 3; c += 1) {
        for (let i = 0; i < size; i += 1) {
          let sum = 0;
          for (let j = 0; j < size; j += 1) {
            sum += t[i * size + j] * coeffs[(start + j) * 3 + c];
          }
          tmp[i] = sum;
        }
        for (let i = 0; i < size; i += 1) {
          coeffs[(start + i) * 3 + c] = tmp[i];
        }
      }
    }
    return coeffs;
  }
};
var Axes = class _Axes {
  static SYSTEMS = SYSTEMS;
  // 3x3 row-major: coordinates in `from` to coordinates in `to`
  static matrix(from, to) {
    const a = axesOf(from);
    const b = axesOf(to);
    const m = [];
    for (let i = 0; i < 3; i += 1) {
      for (let j = 0; j < 3; j += 1) {
        m.push(b[i][0] * a[j][0] + b[i][1] * a[j][1] + b[i][2] * a[j][2]);
      }
    }
    return m;
  }
  static converter(from, to) {
    return new Converter(_Axes.matrix(from, to));
  }
  // A splat table in place: its splat bundle (any layout; cov through its
  // covariance), its per-splat SH, and `shPalette`'s entries when given;
  // sets meta.coordinateSystem to `to`. Other bundles are left as they are.
  static convert(data, to, {
    from = data.meta.coordinateSystem,
    shPalette,
    progress
  } = {}) {
    if (!from) {
      throw new Error("Axes.convert: the data's coordinate system is unknown (pass `from`)");
    }
    const c = _Axes.converter(from, to);
    if (!c.identity) {
      const { bundle } = Splats.get(data);
      const found = Sh.find(data.bundles);
      const decodeSh = found && Sh.decoder(data, found);
      const encodeSh = found && Sh.encoder(data, found);
      const coeffs = new Float32Array(Sh.VALUES);
      const tick = counter(progress, data.count, "encoding");
      if (Splats.isCov(bundle)) {
        const s = Splats.makeCovSplat();
        for (let i = 0; i < data.count; i += 1) {
          tick(i);
          Splats.decodeCov(bundle, i, s);
          c.vec(s.center);
          c.cov(s.cov);
          c.vec(s.normal);
          Splats.encodeCov(bundle, i, s);
        }
      } else {
        const decode = Splats.decoder(bundle);
        const encode = Splats.encoder(bundle);
        const s = Splats.makeExtSplat();
        for (let i = 0; i < data.count; i += 1) {
          tick(i);
          encode(i, c.splat(decode(i, s)));
        }
      }
      if (found) {
        for (let i = 0; i < data.count; i += 1) {
          encodeSh(i, c.sh(decodeSh(i, coeffs), found.degree));
        }
      }
      if (shPalette) {
        for (let n = 0; n < shPalette.size; n += 1) {
          shPalette.set(n, c.sh(shPalette.get(n, coeffs), shPalette.degree));
        }
      }
    }
    data.meta.coordinateSystem = to;
    return data;
  }
};

// src/core/compress.ts
function transposeBytes(data, stride) {
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
async function pipe(data, transform) {
  const stream = new Blob([data]).stream().pipeThrough(transform);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
var ByteReader = class {
  // Bytes taken so far
  position = 0;
  // Unread chunks from `head` on, the first from `offset`
  chunks = [];
  head = 0;
  offset = 0;
  buffered = 0;
  reader;
  done = false;
  label;
  // `label` names the data in errors
  constructor(input, label = "Data") {
    this.label = label;
    if (input instanceof ReadableStream) {
      this.reader = input.getReader();
      return;
    }
    const bytes2 = input instanceof ArrayBuffer ? new Uint8Array(input) : input;
    if (bytes2.byteLength > 0) {
      this.chunks.push(bytes2);
    }
    this.buffered = bytes2.byteLength;
    this.done = true;
  }
  // Buffers at least n bytes, or all that remain; returns how many are
  async fill(n) {
    while (this.buffered < n && !this.done) {
      const { done, value } = await this.reader.read();
      if (done) {
        this.done = true;
      } else if (value.byteLength > 0) {
        this.chunks.push(value);
        this.buffered += value.byteLength;
      }
    }
    return this.buffered;
  }
  take(n, consume) {
    const first = this.chunks[this.head];
    let out;
    if (n === 0) {
      out = new Uint8Array(0);
    } else if (first.byteLength - this.offset >= n) {
      out = first.subarray(this.offset, this.offset + n);
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
  drop(n) {
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
  async read(n) {
    if (await this.fill(n) < n) {
      throw new Error(`${this.label} ended unexpectedly`);
    }
    return this.take(n, true);
  }
  // Up to n bytes, fewer at the end
  async peek(n) {
    return this.take(Math.min(n, await this.fill(n)), false);
  }
  async skip(n) {
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
  async rest() {
    return this.take(await this.fill(Infinity), true);
  }
  async atEnd() {
    return await this.fill(1) === 0;
  }
  // The bytes not taken yet, buffered ones first
  stream() {
    return new ReadableStream({
      pull: async (controller) => {
        if (await this.fill(1) === 0) {
          controller.close();
          return;
        }
        controller.enqueue(this.take(this.chunks[this.head].byteLength - this.offset, true));
      },
      cancel: () => this.cancel()
    });
  }
  cancel() {
    void this.reader?.cancel().catch(() => {
    });
    this.done = true;
    this.chunks = [];
    this.head = 0;
    this.buffered = 0;
    this.offset = 0;
  }
};
var Compression = class {
  static gzip(bytes2) {
    return pipe(bytes2, new CompressionStream("gzip"));
  }
  static gunzip(bytes2) {
    return pipe(bytes2, new DecompressionStream("gzip"));
  }
  static async readBytes(input) {
    if (input instanceof ArrayBuffer) {
      return new Uint8Array(input);
    }
    if (input instanceof Uint8Array) {
      return input;
    }
    return new Uint8Array(await new Response(input).arrayBuffer());
  }
  // `values` holds whole elements of `elementBytes` bytes
  static async compressTransposed(values, elementBytes) {
    const bytes2 = new Uint8Array(values.buffer, values.byteOffset, values.byteLength);
    return pipe(transposeBytes(bytes2, elementBytes), new CompressionStream("gzip"));
  }
  static async decompressTransposed(bytes2, elementBytes) {
    const transposed = await pipe(bytes2, new DecompressionStream("gzip"));
    if (transposed.byteLength % elementBytes !== 0) {
      throw new Error("Decompressed length must be divisible by the element size");
    }
    return transposed.byteLength === 0 ? transposed : transposeBytes(transposed, transposed.byteLength / elementBytes);
  }
};

// src/core/ply.ts
var SH_C0 = 0.28209479177387814;
var HEADER_MAX_BYTES = 64 * 1024;
var POINT_SCALE = 1e-3;
var COMPRESSED_CHUNK_SIZE = 256;
var COMPRESSED_CHUNK_PROPERTIES = [
  "min_x",
  "min_y",
  "min_z",
  "max_x",
  "max_y",
  "max_z",
  "min_scale_x",
  "min_scale_y",
  "min_scale_z",
  "max_scale_x",
  "max_scale_y",
  "max_scale_z",
  "min_r",
  "min_g",
  "min_b",
  "max_r",
  "max_g",
  "max_b"
];
var COMPRESSED_VERTEX_PROPERTIES = ["packed_position", "packed_rotation", "packed_scale", "packed_color"];
var COMPRESSED_REQUIRED = 12;
var COLOR_DEFAULTS = [0, 0, 0, 1, 1, 1];
var TYPES = {
  char: { bytes: 1, scale: 127 },
  uchar: { bytes: 1, scale: 255 },
  short: { bytes: 2, scale: 32767 },
  ushort: { bytes: 2, scale: 65535 },
  int: { bytes: 4, scale: 2147483647 },
  uint: { bytes: 4, scale: 4294967295 },
  float: { bytes: 4, scale: 1 },
  double: { bytes: 8, scale: 1 }
};
async function readPly(input, { progress, sh, ...target } = {}) {
  const bytes2 = await Compression.readBytes(input);
  const header = parseHeader(bytes2);
  const { headerLength, littleEndian, elements, comments } = header;
  const vertex = elements.find((element) => element.name === "vertex");
  if (!vertex) {
    throw new Error("PLY has no vertex element");
  }
  const prop = (name) => vertex.properties.find((p) => p.name === name && !p.countType);
  const has = (name) => prop(name) !== void 0;
  const chunk = elements.find((element) => element.name === "chunk");
  if (chunk && COMPRESSED_VERTEX_PROPERTIES.every(has)) {
    return { splats: readCompressed({ bytes: bytes2, header, vertex, chunk, target, sh, progress }) };
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
  const offset = elementOffset(bytes2, headerLength, elements, vertex);
  const view = new DataView(bytes2.buffer, bytes2.byteOffset, bytes2.byteLength);
  const reader = (property, normalized = false) => property && propertyReader(view, property, littleEndian, normalized);
  const r = (name, normalized = false) => reader(prop(name), normalized);
  const [x, y, z] = [r("x"), r("y"), r("z")];
  const normal = normals ? [r("nx"), r("ny"), r("nz")] : void 0;
  const metal = reader(metallic, true);
  const rough = reader(roughness, true);
  const scale = isStandard ? ["scale_0", "scale_1", "scale_2"].map((name) => r(name)) : [];
  const rot = isStandard ? ["rot_1", "rot_2", "rot_3", "rot_0"].map((name) => r(name)) : [];
  const opacity = isStandard ? r("opacity") : reader(prop("alpha"), true);
  const color = isStandard ? ["f_dc_0", "f_dc_1", "f_dc_2"].map((name) => r(name)) : ["red", "green", "blue"].map((name) => r(name, true));
  const perChannel = shRest / 3;
  const shValues = Sh.COEFFICIENTS[degree] * 3;
  const rest = Array.from({ length: shValues }, (_, v) => r(`f_rest_${v % 3 * perChannel + Math.floor(v / 3)}`));
  const coeffs = new Float32Array(Sh.VALUES);
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
      s.opacity = 1 / (1 + Math.exp(-opacity(base)));
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
  return { splats: data };
}
function readCompressed({ bytes: bytes2, header: { headerLength, littleEndian, elements, comments }, vertex, chunk, target, sh: shTarget, progress }) {
  for (const element of [chunk, vertex]) {
    if (element.properties.some((p) => p.countType)) {
      throw new Error(`PLY ${element.name} list properties are not supported`);
    }
  }
  const chunkProp = (name) => chunk.properties.find((p) => p.name === name);
  const missing = COMPRESSED_CHUNK_PROPERTIES.slice(0, COMPRESSED_REQUIRED).filter((name) => !chunkProp(name));
  if (missing.length > 0) {
    throw new Error(`PLY chunk lacks ${missing.join(", ")}`);
  }
  const chunks = Math.ceil(vertex.count / COMPRESSED_CHUNK_SIZE);
  if (chunk.count < chunks) {
    throw new Error(`PLY has ${chunk.count} chunks for ${vertex.count} splats`);
  }
  const view = new DataView(bytes2.buffer, bytes2.byteOffset, bytes2.byteLength);
  const stride = COMPRESSED_CHUNK_PROPERTIES.length;
  const ranges = new Float32Array(chunks * stride);
  const chunkOffset = elementOffset(bytes2, headerLength, elements, chunk);
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
  const shValues = Sh.COEFFICIENTS[degree] * 3;
  const shOffset = sh && encodeSh ? elementOffset(bytes2, headerLength, elements, sh) : 0;
  const shBytes = Uint8Array.from({ length: shValues }, (_, v) => sh.properties.find((p) => p.name === `f_rest_${v % 3 * (shRest / 3) + Math.floor(v / 3)}`)?.offset ?? 0);
  const coeffs = new Float32Array(Sh.VALUES);
  const offset = elementOffset(bytes2, headerLength, elements, vertex);
  const [position, rotation, scale, color] = COMPRESSED_VERTEX_PROPERTIES.map((name) => propertyReader(view, vertex.properties.find((p) => p.name === name), littleEndian));
  const s = Splats.makeExtSplat();
  const q = { x: 0, y: 0, z: 0, w: 1 };
  const tick = counter(progress, vertex.count, "decoding");
  for (let i = 0; i < vertex.count; i += 1) {
    tick(i);
    const base = offset + i * vertex.recordSize;
    const at = Math.floor(i / COMPRESSED_CHUNK_SIZE) * stride;
    const p = position(base);
    s.center.x = ranges[at] + (ranges[at + 3] - ranges[at]) * ((p >>> 21 & 2047) / 2047);
    s.center.y = ranges[at + 1] + (ranges[at + 4] - ranges[at + 1]) * ((p >>> 11 & 1023) / 1023);
    s.center.z = ranges[at + 2] + (ranges[at + 5] - ranges[at + 2]) * ((p & 2047) / 2047);
    const l = scale(base);
    s.scales.x = Math.exp(ranges[at + 6] + (ranges[at + 9] - ranges[at + 6]) * ((l >>> 21 & 2047) / 2047));
    s.scales.y = Math.exp(ranges[at + 7] + (ranges[at + 10] - ranges[at + 7]) * ((l >>> 11 & 1023) / 1023));
    s.scales.z = Math.exp(ranges[at + 8] + (ranges[at + 11] - ranges[at + 8]) * ((l & 2047) / 2047));
    const r = rotation(base);
    const a = ((r >>> 20 & 1023) / 1023 - 0.5) * Math.SQRT2;
    const b = ((r >>> 10 & 1023) / 1023 - 0.5) * Math.SQRT2;
    const c = ((r & 1023) / 1023 - 0.5) * Math.SQRT2;
    const m = Math.sqrt(Math.max(0, 1 - a * a - b * b - c * c));
    const largest = r >>> 30;
    q.w = largest === 0 ? m : a;
    q.x = largest === 0 ? a : largest === 1 ? m : b;
    q.y = largest <= 1 ? b : largest === 2 ? m : c;
    q.z = largest <= 2 ? c : m;
    SplatMath.normalizeQuat(q, s.quaternion);
    const k = color(base);
    s.rgb.r = ranges[at + 12] + (ranges[at + 15] - ranges[at + 12]) * ((k >>> 24 & 255) / 255);
    s.rgb.g = ranges[at + 13] + (ranges[at + 16] - ranges[at + 13]) * ((k >>> 16 & 255) / 255);
    s.rgb.b = ranges[at + 14] + (ranges[at + 17] - ranges[at + 14]) * ((k >>> 8 & 255) / 255);
    s.opacity = (k & 255) / 255;
    encode(i, s);
    if (encodeSh) {
      const record2 = shOffset + i * sh.recordSize;
      for (let v = 0; v < shValues; v += 1) {
        coeffs[v] = SH_BYTE_VALUES[bytes2[record2 + shBytes[v]]];
      }
      encodeSh(i, coeffs);
    }
  }
  return data;
}
function decodeCompressedSh(byte) {
  return ((byte === 0 ? 0 : byte === 255 ? 1 : (byte + 0.5) / 256) - 0.5) * 8;
}
var SH_BYTE_VALUES = Float64Array.from({ length: 256 }, (_, byte) => decodeCompressedSh(byte));
function encodeCompressedSh(value) {
  return Math.max(0, Math.min(255, Math.trunc((value / 8 + 0.5) * 256)));
}
function writePly(data, { pbr = false, compatibility = false, sh = true, progress } = {}) {
  const decode = Splats.decoder(Splats.get(data).bundle);
  const found = sh ? Sh.find(data.bundles) : void 0;
  const decodeSh = found && Sh.decoder(data, found);
  const perChannel = found ? Sh.COEFFICIENTS[found.degree] : 0;
  const coeffs = new Float32Array(Sh.VALUES);
  const normals = pbr || compatibility;
  const names = [
    "x",
    "y",
    "z",
    ...normals ? ["nx", "ny", "nz"] : [],
    "scale_0",
    "scale_1",
    "scale_2",
    "rot_0",
    "rot_1",
    "rot_2",
    "rot_3",
    "opacity",
    "f_dc_0",
    "f_dc_1",
    "f_dc_2",
    ...Array.from({ length: perChannel * 3 }, (_, k) => `f_rest_${k}`),
    ...pbr ? ["roughness", "metallic"] : []
  ];
  const header = new TextEncoder().encode([
    "ply",
    "format binary_little_endian 1.0",
    `element vertex ${data.count}`,
    ...names.map((name) => `property float ${name}`),
    "end_header",
    ""
  ].join("\n"));
  const bytes2 = new Uint8Array(header.byteLength + data.count * names.length * 4);
  bytes2.set(header);
  const floats = new DataView(bytes2.buffer, header.byteLength);
  const s = Splats.makeExtSplat();
  const q = { x: 0, y: 0, z: 0, w: 1 };
  let at = 0;
  const put = (value) => {
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
  return bytes2;
}
var PlyFile = class {
  // { splats }: the bundle of the asked layout (default extSplats), its
  // SH included
  static read = readPly;
  // The splat bundle of `data` (any layout)
  static write = writePly;
};
function parseHeader(bytes2) {
  const text = new TextDecoder().decode(bytes2.subarray(0, Math.min(bytes2.byteLength, HEADER_MAX_BYTES)));
  const end = text.search(/end_header\r?\n/);
  if (!text.startsWith("ply") || end < 0) {
    throw new Error("Invalid PLY header");
  }
  const headerLength = new TextEncoder().encode(text.slice(0, end)).byteLength + text.slice(end).match(/end_header\r?\n/)[0].length;
  let littleEndian;
  const elements = [];
  const comments = [];
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
  if (littleEndian === void 0) {
    throw new Error("PLY header has no format line");
  }
  return { headerLength, littleEndian, elements, comments };
}
function plyType(name) {
  const aliases = {
    int8: "char",
    uint8: "uchar",
    int16: "short",
    uint16: "ushort",
    int32: "int",
    uint32: "uint",
    float32: "float",
    float64: "double"
  };
  const type = aliases[name] ?? name;
  if (!TYPES[type]) {
    throw new Error(`Unsupported PLY property type ${name}`);
  }
  return type;
}
function shDegree(shRest) {
  return shRest >= 72 ? 4 : shRest >= 45 ? 3 : shRest >= 24 ? 2 : shRest > 0 ? 1 : 0;
}
function elementOffset(bytes2, headerLength, elements, element) {
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
  if (offset + element.count * element.recordSize > bytes2.byteLength) {
    throw new Error("PLY file ended unexpectedly");
  }
  return offset;
}
function propertyReader(view, { offset: at, type }, littleEndian, normalized = false) {
  if (type === "float") {
    return (base) => view.getFloat32(base + at, littleEndian);
  }
  if (type === "uint" && !normalized) {
    return (base) => view.getUint32(base + at, littleEndian);
  }
  const scale = normalized ? TYPES[type].scale : 1;
  return (base) => readScalar(view, base + at, type, littleEndian) / scale;
}
function readScalar(view, offset, type, littleEndian) {
  switch (type) {
    case "char":
      return view.getInt8(offset);
    case "uchar":
      return view.getUint8(offset);
    case "short":
      return view.getInt16(offset, littleEndian);
    case "ushort":
      return view.getUint16(offset, littleEndian);
    case "int":
      return view.getInt32(offset, littleEndian);
    case "uint":
      return view.getUint32(offset, littleEndian);
    case "float":
      return view.getFloat32(offset, littleEndian);
    case "double":
      return view.getFloat64(offset, littleEndian);
  }
}

// src/core/sort.ts
var FLOAT_BITS_INFINITY = 2139095040;
var f322 = new Float32Array(1);
var u322 = new Uint32Array(f322.buffer);
var histogramLo = new Uint32Array(65536);
var histogramHi = new Uint32Array(65536);
var scratchIndex = new Uint32Array(0);
var scratchDigit = new Uint16Array(0);
var SortKeys = class _SortKeys {
  // The float bits 16-bit keys cover (distances 2^-32..2^32)
  static KEY16_LO = 95 << 23;
  static KEY16_HI = (159 << 23) - 1;
  // Sort keys as projections write them: the 4 bytes of a key per RGBA8
  // texel, read back as a Uint32Array (little-endian)
  static KEYS = defineBundle({ key: "unorm8x4" }, { serialize: false });
  // The invalid key of a width: all ones
  static invalid(bits) {
    return 2 ** bits - 1;
  }
  static validMax(bits) {
    return 255 * 2 ** (bits - 8) - 1;
  }
  // Key of a distance >= 0; non-finite distances give the invalid key
  static compute(distance, bits) {
    const mask = _SortKeys.invalid(bits);
    f322[0] = distance;
    const f = u322[0];
    if (!(f < FLOAT_BITS_INFINITY)) {
      return mask;
    }
    const q = bits === 32 ? f : bits === 24 ? f >>> 7 : Math.min(Math.max(f, _SortKeys.KEY16_LO), _SortKeys.KEY16_HI) - _SortKeys.KEY16_LO >>> 13;
    return Math.min((mask ^ q) >>> 0, _SortKeys.validMax(bits));
  }
  // Stable ascending sort of `count` keys into `ordering` (indices; by
  // default a whole capacity, as an ArrayData.INDICES channel holds). Invalid keys sort
  // last; `visible` counts the others. 16-bit keys take one counting pass,
  // 24-bit keys two LSD passes of 11 and 13 bits, 32-bit keys two of 16.
  static sort({ keys, count, bits, ordering = new Uint32Array(TextureLayout.alignCapacity(count)) }) {
    if (ordering.length < count) {
      throw new Error(`SortKeys.sort: ordering holds ${ordering.length} of ${count} indices`);
    }
    if (scratchIndex.length < count) {
      scratchIndex = new Uint32Array(count);
      scratchDigit = new Uint16Array(count);
    }
    const visible = bits === 16 ? sort1x16(keys, count, ordering) : bits === 24 ? sort11x13(keys, count, ordering) : sort2x16(keys, count, ordering);
    return { ordering, visible };
  }
};
function prefixSum(histogram, last) {
  let sum = 0;
  for (let d = 0; d <= last; d += 1) {
    const n = histogram[d];
    histogram[d] = sum;
    sum += n;
  }
}
function sort1x16(keys, count, ordering) {
  const histogram = histogramLo;
  histogram.fill(0);
  for (let i = 0; i < count; i += 1) {
    histogram[keys[i] & 65535] += 1;
  }
  const visible = count - histogram[65535];
  prefixSum(histogram, 65535);
  for (let i = 0; i < count; i += 1) {
    ordering[histogram[keys[i] & 65535]++] = i;
  }
  return visible;
}
function sort11x13(keys, count, ordering) {
  const lo = histogramLo;
  const hi = histogramHi;
  lo.fill(0, 0, 2048);
  hi.fill(0, 0, 8192);
  for (let i = 0; i < count; i += 1) {
    const k = keys[i];
    lo[k & 2047] += 1;
    hi[k >>> 11] += 1;
  }
  const visible = count - hi[8191];
  prefixSum(lo, 2047);
  prefixSum(hi, 8191);
  for (let i = 0; i < count; i += 1) {
    const k = keys[i];
    const pos = lo[k & 2047]++;
    scratchIndex[pos] = i;
    scratchDigit[pos] = k >>> 11;
  }
  for (let j = 0; j < count; j += 1) {
    ordering[hi[scratchDigit[j]]++] = scratchIndex[j];
  }
  return visible;
}
function sort2x16(keys, count, ordering) {
  const lo = histogramLo;
  const hi = histogramHi;
  lo.fill(0);
  hi.fill(0);
  for (let i = 0; i < count; i += 1) {
    const k = keys[i];
    lo[k & 65535] += 1;
    hi[k >>> 16] += 1;
  }
  const visible = count - hi[65535];
  prefixSum(lo, 65535);
  prefixSum(hi, 65535);
  for (let i = 0; i < count; i += 1) {
    const k = keys[i];
    const pos = lo[k & 65535]++;
    scratchIndex[pos] = i;
    scratchDigit[pos] = k >>> 16;
  }
  for (let j = 0; j < count; j += 1) {
    ordering[hi[scratchDigit[j]]++] = scratchIndex[j];
  }
  return visible;
}

// src/core/compressedPly.ts
var VALUES2 = 14;
var LN_SCALE_LIMIT = 20;
function writeCompressedPly(data, { sort = true, sh = true, progress } = {}) {
  const { count } = data;
  const decode = Splats.decoder(Splats.get(data).bundle);
  const found = sh ? Sh.find(data.bundles) : void 0;
  const decodeSh = found && Sh.decoder(data, found);
  const perChannel = found ? Sh.COEFFICIENTS[Math.min(found.degree, 3)] : 0;
  const shValues = perChannel * 3;
  const tick = counter(progress, 2 * count, "encoding");
  const values = new Float32Array(count * VALUES2);
  const s = Splats.makeExtSplat();
  const q = { x: 0, y: 0, z: 0, w: 1 };
  for (let i = 0; i < count; i += 1) {
    tick(i);
    decode(i, s);
    SplatMath.normalizeQuat(s.quaternion, q);
    const v = i * VALUES2;
    values[v] = s.center.x;
    values[v + 1] = s.center.y;
    values[v + 2] = s.center.z;
    values[v + 3] = lnScale(s.scales.x);
    values[v + 4] = lnScale(s.scales.y);
    values[v + 5] = lnScale(s.scales.z);
    values[v + 6] = q.w;
    values[v + 7] = q.x;
    values[v + 8] = q.y;
    values[v + 9] = q.z;
    values[v + 10] = s.rgb.r;
    values[v + 11] = s.rgb.g;
    values[v + 12] = s.rgb.b;
    values[v + 13] = s.opacity;
  }
  const order = sort ? mortonOrder(values, count) : void 0;
  const chunks = Math.ceil(count / COMPRESSED_CHUNK_SIZE);
  const header = new TextEncoder().encode([
    "ply",
    "format binary_little_endian 1.0",
    "comment Generated by Radix",
    `element chunk ${chunks}`,
    ...COMPRESSED_CHUNK_PROPERTIES.map((name) => `property float ${name}`),
    `element vertex ${count}`,
    ...COMPRESSED_VERTEX_PROPERTIES.map((name) => `property uint ${name}`),
    ...shValues > 0 ? [`element sh ${count}`, ...Array.from({ length: shValues }, (_, k) => `property uchar f_rest_${k}`)] : [],
    "end_header",
    ""
  ].join("\n"));
  const stride = COMPRESSED_CHUNK_PROPERTIES.length;
  const vertexStart = header.byteLength + chunks * stride * 4;
  const shStart = vertexStart + count * COMPRESSED_VERTEX_PROPERTIES.length * 4;
  const bytes2 = new Uint8Array(shStart + count * shValues);
  bytes2.set(header);
  const view = new DataView(bytes2.buffer);
  const range = new Float32Array(stride);
  const extend = (at, value) => {
    range[at] = Math.min(range[at], value);
    range[at + 3] = Math.max(range[at + 3], value);
  };
  for (let c = 0; c < chunks; c += 1) {
    const start = c * COMPRESSED_CHUNK_SIZE;
    const end = Math.min(count, start + COMPRESSED_CHUNK_SIZE);
    for (let g = 0; g < stride; g += 6) {
      range.fill(Infinity, g, g + 3);
      range.fill(-Infinity, g + 3, g + 6);
    }
    for (let j = start; j < end; j += 1) {
      const v = (order ? order[j] : j) * VALUES2;
      for (let k = 0; k < 3; k += 1) {
        extend(k, values[v + k]);
        extend(6 + k, values[v + 3 + k]);
        extend(12 + k, values[v + 10 + k]);
      }
    }
    for (let k = 0; k < stride; k += 1) {
      view.setFloat32(header.byteLength + (c * stride + k) * 4, range[k], true);
    }
    for (let j = start; j < end; j += 1) {
      tick(count + j);
      const v = (order ? order[j] : j) * VALUES2;
      const at = vertexStart + j * 16;
      view.setUint32(at, pack111011(values, v, range, 0), true);
      view.setUint32(at + 4, packRotation(values, v + 6), true);
      view.setUint32(at + 8, pack111011(values, v + 3, range, 6), true);
      view.setUint32(at + 12, packColor(values, v + 10, range), true);
    }
  }
  if (decodeSh) {
    const coeffs = new Float32Array(Sh.VALUES);
    for (let j = 0; j < count; j += 1) {
      decodeSh(order ? order[j] : j, coeffs);
      const at = shStart + j * shValues;
      for (let c = 0; c < 3; c += 1) {
        for (let k = 0; k < perChannel; k += 1) {
          bytes2[at + c * perChannel + k] = encodeCompressedSh(coeffs[k * 3 + c]);
        }
      }
    }
  }
  return bytes2;
}
var CompressedPlyFile = class {
  // Either kind of PLY (the same as PlyFile.read)
  static read = PlyFile.read;
  // The splat bundle of `data` (any layout)
  static write = writeCompressedPly;
};
function lnScale(scale) {
  return Math.max(-LN_SCALE_LIMIT, Math.min(LN_SCALE_LIMIT, Math.log(scale)));
}
function unorm(value, min, max, bits) {
  const top = 2 ** bits - 1;
  const t = max > min ? (value - min) / (max - min) : 0;
  return Math.max(0, Math.min(top, Math.floor(t * top + 0.5)));
}
function pack111011(values, v, range, at) {
  return unorm(values[v], range[at], range[at + 3], 11) * 2 ** 21 + unorm(values[v + 1], range[at + 1], range[at + 4], 10) * 2 ** 11 + unorm(values[v + 2], range[at + 2], range[at + 5], 11);
}
function packColor(values, v, range) {
  return unorm(values[v], range[12], range[15], 8) * 2 ** 24 + unorm(values[v + 1], range[13], range[16], 8) * 2 ** 16 + unorm(values[v + 2], range[14], range[17], 8) * 2 ** 8 + unorm(values[v + 3], 0, 1, 8);
}
function packRotation(values, v) {
  let largest = 0;
  for (let k = 1; k < 4; k += 1) {
    if (Math.abs(values[v + k]) > Math.abs(values[v + largest])) {
      largest = k;
    }
  }
  const sign = values[v + largest] < 0 ? -1 : 1;
  let word = largest;
  for (let k = 0; k < 4; k += 1) {
    if (k !== largest) {
      word = word * 1024 + unorm(sign * values[v + k] * Math.SQRT1_2 + 0.5, 0, 1, 10);
    }
  }
  return word;
}
function mortonOrder(values, count) {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < count; i += 1) {
    for (let k = 0; k < 3; k += 1) {
      lo[k] = Math.min(lo[k], values[i * VALUES2 + k]);
      hi[k] = Math.max(hi[k], values[i * VALUES2 + k]);
    }
  }
  const cell = (value, k) => hi[k] > lo[k] ? Math.min(1023, Math.floor(1024 * (value - lo[k]) / (hi[k] - lo[k]))) : 0;
  const keys = new Uint32Array(count);
  for (let i = 0; i < count; i += 1) {
    const v = i * VALUES2;
    keys[i] = (spread3(cell(values[v + 2], 2)) << 2 | spread3(cell(values[v + 1], 1)) << 1 | spread3(cell(values[v], 0))) >>> 0;
  }
  return SortKeys.sort({ keys, count, bits: 32 }).ordering;
}
function spread3(x) {
  let s = (x ^ x << 16) & 4278190335;
  s = (s ^ s << 8) & 50393103;
  s = (s ^ s << 4) & 51130563;
  return (s ^ s << 2) & 153391689;
}

// src/core/rad.ts
var SH_BANDS = [["sh1", 9], ["sh2", 15], ["sh3", 21]];
var RAD_MAGIC = 809779538;
var RAD_CHUNK_MAGIC = 1128546642;
var RAD_CHUNK_SIZE = 65536;
var fromHalf = Encoding.decodeHalf;
var pad8 = (n) => n + 7 & ~7;
async function readRad(input, { progress, sh, ...target } = {}) {
  const bytes2 = await Compression.readBytes(input);
  const view = new DataView(bytes2.buffer, bytes2.byteOffset, bytes2.byteLength);
  const json = (at, length) => JSON.parse(new TextDecoder().decode(bytes2.subarray(at, at + length)));
  const magic = view.getUint32(0, true);
  const meta = json(8, view.getUint32(4, true));
  let chunks;
  if (magic === RAD_MAGIC) {
    if (meta.version !== 1 || meta.type !== "gsplat") {
      throw new Error(`Unsupported RAD version ${String(meta.version)} or type ${String(meta.type)}`);
    }
    const start = 8 + pad8(view.getUint32(4, true));
    chunks = meta.chunks.map((range) => {
      if (range.filename) {
        throw new Error("RAD external chunk files are not supported");
      }
      return { at: start + range.offset, standalone: false };
    });
  } else if (magic === RAD_CHUNK_MAGIC) {
    chunks = [{ at: 0, standalone: true }];
  } else {
    throw new Error(`Invalid RAD magic 0x${magic.toString(16)}`);
  }
  const count = meta.count;
  const lod = (meta.lodTree ?? meta.lod_tree) === true;
  const maxSh = Number(meta.maxSh ?? meta.max_sh ?? 0);
  const codeCount = Number(meta.shCodeCount ?? meta.sh_code_count ?? 0);
  const data = new ArrayData({ count, meta: { format: "rad" } });
  const encode = Splats.encoder(Splats.add(data, target));
  let clusters;
  let encodeSh;
  if (codeCount > 0 && sh !== false && maxSh >= 1 && maxSh <= 3) {
    data.meta.ignoredShDegree = 0;
    clusters = { palette: ShPalette.create({ codec: sh ?? "ext", degree: maxSh, size: codeCount }), labels: new Uint32Array(count), read: false };
  } else {
    encodeSh = Sh.prepare(data, maxSh, sh);
  }
  const nodes = lod ? data.addBundle("lodTree", Splats.LOD_TREE).bundles.lodTree.channels.node.data : void 0;
  for (const [index, { at, standalone }] of chunks.entries()) {
    progress?.(index / chunks.length, "decoding");
    if (view.getUint32(at, true) !== RAD_CHUNK_MAGIC) {
      throw new Error("Invalid RAD chunk");
    }
    const length = view.getUint32(at + 4, true);
    const raw = json(at + 8, length);
    const chunk = {
      base: standalone ? 0 : raw.base,
      count: raw.count,
      payloadBytes: raw.payloadBytes ?? raw.payload_bytes,
      lodTree: (raw.lodTree ?? raw.lod_tree) === true,
      properties: raw.properties
    };
    const payloadAt = at + 8 + pad8(length) + 8;
    await decodeChunk(chunk, bytes2.subarray(payloadAt, payloadAt + chunk.payloadBytes), encode, nodes, encodeSh && { encode: encodeSh, degree: maxSh }, clusters);
  }
  progress?.(1, "decoding");
  if (!clusters) {
    return { splats: data };
  }
  const { palette, labels } = clusters;
  if (!clusters.read) {
    throw new Error("RAD file with shCodeCount misses sh1_code");
  }
  for (let i = 0; i < count; i += 1) {
    if (labels[i] >= palette.size) {
      throw new Error(`RAD sh_label ${labels[i]} past shCodeCount ${palette.size}`);
    }
  }
  if (palette.size > 65536) {
    palette.expand(data, labels);
    return { splats: data };
  }
  data.addBundle("shLabel", Sh.LABEL).bundles.shLabel.channels.label.data.set(labels);
  return { splats: data, shPalette: palette };
}
async function decodeChunk(chunk, payload, encode, nodes, sh, clusters) {
  const n = chunk.count;
  const columns = {};
  const codes = {};
  for (const property of chunk.properties) {
    let bytes2 = payload.subarray(property.offset, property.offset + property.bytes);
    if (property.compression) {
      bytes2 = await decompress(bytes2);
    }
    switch (property.property) {
      case "center":
      case "alpha":
      case "rgb":
      case "scales":
        columns[property.property] = decodeNumbers(property, bytes2, property.property === "alpha" ? 1 : 3, n);
        break;
      case "orientation":
        columns.orientation = decodeOrientation(property, bytes2, n);
        break;
      case "child_count":
      case "child_start":
        columns[property.property] = decodeUints(property, bytes2, n);
        break;
      case "sh1":
      case "sh2":
      case "sh3":
        if (sh) {
          columns[property.property] = decodeNumbers(property, bytes2, SH_BANDS.find(([name]) => name === property.property)[1], n);
        }
        break;
      case "sh1_code":
      case "sh2_code":
      case "sh3_code":
        if (clusters) {
          const band = property.property.slice(0, 3);
          codes[band] = decodeNumbers(property, bytes2, SH_BANDS.find(([name]) => name === band)[1], clusters.palette.size);
        }
        break;
      case "sh_label":
        if (clusters) {
          clusters.labels.set(decodeUints(property, bytes2, n), chunk.base);
        }
        break;
    }
  }
  for (const required of ["center", "alpha", "rgb", "scales", "orientation"]) {
    if (n > 0 && !columns[required]) {
      throw new Error(`RAD chunk misses ${required}`);
    }
  }
  const { center, alpha, rgb: rgb2, scales, orientation, child_count: childCounts, child_start: childStarts } = columns;
  const s = Splats.makeExtSplat();
  for (let i = 0; i < n; i += 1) {
    s.center.x = center[i * 3];
    s.center.y = center[i * 3 + 1];
    s.center.z = center[i * 3 + 2];
    s.opacity = alpha[i];
    s.rgb.r = rgb2[i * 3];
    s.rgb.g = rgb2[i * 3 + 1];
    s.rgb.b = rgb2[i * 3 + 2];
    s.scales.x = scales[i * 3];
    s.scales.y = scales[i * 3 + 1];
    s.scales.z = scales[i * 3 + 2];
    s.quaternion.x = orientation[i * 4];
    s.quaternion.y = orientation[i * 4 + 1];
    s.quaternion.z = orientation[i * 4 + 2];
    s.quaternion.w = orientation[i * 4 + 3];
    encode(chunk.base + i, s);
  }
  if (sh) {
    gatherSh(n, sh.degree, columns, (i, coeffs) => sh.encode(chunk.base + i, coeffs));
  }
  if (clusters && codes.sh1) {
    const { palette } = clusters;
    gatherSh(palette.size, palette.degree, codes, (e, coeffs) => palette.set(e, coeffs));
    clusters.read = true;
  }
  if (nodes && chunk.lodTree) {
    if (!childCounts || !childStarts) {
      throw new Error("RAD chunk misses child_count or child_start");
    }
    for (let i = 0; i < n; i += 1) {
      nodes[(chunk.base + i) * 2] = childCounts[i];
      nodes[(chunk.base + i) * 2 + 1] = childStarts[i];
    }
  }
}
function gatherSh(n, degree, columns, put) {
  const coeffs = new Float32Array(Sh.VALUES);
  const bands = SH_BANDS.slice(0, degree).map(([name, values]) => ({ values, column: columns[name] }));
  for (let i = 0; i < n; i += 1) {
    let at = 0;
    for (let b = 0; b < bands.length; b += 1) {
      const { values, column } = bands[b];
      for (let v = 0; v < values; v += 1) {
        coeffs[at + v] = column ? column[i * values + v] : 0;
      }
      at += values;
    }
    put(i, coeffs);
  }
}
var f323 = new Float32Array(1);
var u323 = new Uint32Array(f323.buffer);
var floatOfBits = (bits) => {
  u323[0] = bits;
  return f323[0];
};
function decodeNumbers(property, bytes2, dims, n) {
  const out = new Float32Array(dims * n);
  const view = new DataView(bytes2.buffer, bytes2.byteOffset, bytes2.byteLength);
  const stride = dims * n;
  const min = property.min ?? 0;
  const max = property.max ?? 1;
  const signed = (byte) => (byte << 24 >> 24) / 127 * max;
  for (let d = 0; d < dims; d += 1) {
    let last = 0;
    for (let i = 0; i < n; i += 1) {
      const k = d * n + i;
      let value;
      switch (property.encoding) {
        case "f32":
          value = view.getFloat32(k * 4, true);
          break;
        case "f16":
          value = fromHalf(view.getUint16(k * 2, true));
          break;
        case "f32_lebytes":
          value = floatOfBits((bytes2[k] | bytes2[k + stride] << 8 | bytes2[k + stride * 2] << 16 | bytes2[k + stride * 3] << 24) >>> 0);
          break;
        case "f16_lebytes":
          value = fromHalf(bytes2[k] | bytes2[k + stride] << 8);
          break;
        case "r8":
          value = bytes2[k] / 255 * (max - min) + min;
          break;
        case "r8_delta":
          last = last + bytes2[k] & 255;
          value = last / 255 * (max - min) + min;
          break;
        case "s8":
          value = signed(bytes2[k]);
          break;
        case "s8_delta":
          last = last + bytes2[k] & 255;
          value = signed(last);
          break;
        case "ln_0r8":
          value = bytes2[k] === 0 ? 0 : Math.exp(min + (bytes2[k] - 1) * ((max - min) / 254));
          break;
        case "ln_f16":
          value = Math.exp(fromHalf(view.getUint16(k * 2, true)));
          break;
        default:
          throw new Error(`Unsupported RAD ${property.property} encoding ${property.encoding}`);
      }
      out[i * dims + d] = value;
    }
  }
  return out;
}
function decodeOrientation(property, bytes2, n) {
  const out = new Float32Array(n * 4);
  if (property.encoding === "oct88r8") {
    const axis = { x: 0, y: 0, z: 0 };
    for (let i = 0; i < n; i += 1) {
      const code = bytes2[i * 3] | bytes2[i * 3 + 1] << 8;
      if (code === 0) {
        Object.assign(axis, { x: 0, y: 0, z: -1 });
      } else {
        Encoding.decodeOct(code, 8, axis);
      }
      const angle = bytes2[i * 3 + 2] / 255 * Math.PI;
      const s = Math.sin(angle / 2);
      out[i * 4] = axis.x * s;
      out[i * 4 + 1] = axis.y * s;
      out[i * 4 + 2] = axis.z * s;
      out[i * 4 + 3] = Math.cos(angle / 2);
    }
    return out;
  }
  const xyz = decodeNumbers(property, bytes2, 3, n);
  for (let i = 0; i < n; i += 1) {
    const x = xyz[i * 3];
    const y = xyz[i * 3 + 1];
    const z = xyz[i * 3 + 2];
    out[i * 4] = x;
    out[i * 4 + 1] = y;
    out[i * 4 + 2] = z;
    out[i * 4 + 3] = Math.sqrt(Math.max(0, 1 - x * x - y * y - z * z));
  }
  return out;
}
function decodeUints(property, bytes2, n) {
  if (property.encoding !== "u16" && property.encoding !== "u32") {
    throw new Error(`Unsupported RAD ${property.property} encoding ${property.encoding}`);
  }
  const view = new DataView(bytes2.buffer, bytes2.byteOffset, bytes2.byteLength);
  const out = new Uint32Array(n);
  for (let i = 0; i < n; i += 1) {
    out[i] = property.encoding === "u16" ? view.getUint16(i * 2, true) : view.getUint32(i * 4, true);
  }
  return out;
}
async function decompress(bytes2) {
  for (const format of ["deflate", "deflate-raw", "gzip"]) {
    try {
      const stream = new Blob([bytes2.slice()]).stream().pipeThrough(new DecompressionStream(format));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch {
    }
  }
  return bytes2;
}
var RadFile = class {
  // { splats, shPalette? }: the bundle of the asked layout (default
  // extSplats), plus lodTree, and the palette of clustered SH
  static read = readRad;
  // One RAD0 file of the splat bundle of `data` (any layout) and its
  // lodTree when it has one, in chunks of `chunkSize` splats
  static write = writeRad;
};
var bytesOf = (values) => new Uint8Array(values.buffer, values.byteOffset, values.byteLength);
async function writeRad(data, { chunkSize = RAD_CHUNK_SIZE, sh = true, radSh = "s8", shPalette, progress } = {}) {
  const decode = Splats.decoder(Splats.get(data).bundle);
  const tree = Splats.findLodTree(data);
  const labels = sh && shPalette ? data.bundles.shLabel?.channels.label?.data : void 0;
  const found = sh && !labels ? Sh.find(data.bundles) : void 0;
  const decodeSh = found && Sh.decoder(data, found);
  const maxSh = Math.min(labels ? shPalette.degree : found?.degree ?? 0, 3);
  const bandMax = [0, 0, 0];
  const encoder = new TextEncoder();
  const s = Splats.makeExtSplat();
  const shColumns = (n, suffix, get) => {
    const coeffs = new Float32Array(Sh.VALUES);
    const bands = SH_BANDS.slice(0, maxSh).map(([, values]) => new Float32Array(values * n));
    for (let i = 0; i < n; i += 1) {
      get(i, coeffs);
      let at2 = 0;
      for (let b = 0; b < bands.length; b += 1) {
        const band = bands[b];
        const values = SH_BANDS[b][1];
        for (let v = 0; v < values; v += 1) {
          band[v * n + i] = coeffs[at2 + v];
        }
        at2 += values;
      }
    }
    return bands.map((band, b) => {
      const name = SH_BANDS[b][0] + suffix;
      if (radSh === "f32") {
        return [name, "f32", bytesOf(band)];
      }
      if (radSh === "f16") {
        const halves = new Uint16Array(band.length);
        for (let k = 0; k < band.length; k += 1) {
          halves[k] = Encoding.encodeHalf(band[k]);
        }
        return [name, "f16", bytesOf(halves)];
      }
      let max = 0;
      for (let k = 0; k < band.length; k += 1) {
        max = Math.max(max, Math.abs(band[k]));
      }
      max ||= 1;
      bandMax[b] = Math.max(bandMax[b], max);
      const codes = new Uint8Array(band.length);
      for (let k = 0; k < band.length; k += 1) {
        codes[k] = Math.max(-127, Math.min(127, Math.round(band[k] / max * 127))) & 255;
      }
      return [name, "s8", codes, { min: -max, max }];
    });
  };
  const chunks = [];
  const ranges = [];
  let offset = 0;
  const tick = counter(progress, data.count, "encoding");
  for (let base = 0; base < data.count; base += chunkSize) {
    const n = Math.min(chunkSize, data.count - base);
    const center = new Float32Array(n * 3);
    const alpha = new Float32Array(n);
    const rgb2 = new Float32Array(n * 3);
    const scales = new Float32Array(n * 3);
    const orientation = new Float32Array(n * 3);
    for (let i = 0; i < n; i += 1) {
      tick(base + i);
      decode(base + i, s);
      const q = s.quaternion;
      const sign = q.w < 0 ? -1 : 1;
      center[i] = s.center.x;
      center[n + i] = s.center.y;
      center[2 * n + i] = s.center.z;
      rgb2[i] = s.rgb.r;
      rgb2[n + i] = s.rgb.g;
      rgb2[2 * n + i] = s.rgb.b;
      scales[i] = s.scales.x;
      scales[n + i] = s.scales.y;
      scales[2 * n + i] = s.scales.z;
      orientation[i] = q.x * sign;
      orientation[n + i] = q.y * sign;
      orientation[2 * n + i] = q.z * sign;
      alpha[i] = s.opacity;
    }
    const columns = [
      ["center", "f32", bytesOf(center)],
      ["alpha", "f32", bytesOf(alpha)],
      ["rgb", "f32", bytesOf(rgb2)],
      ["scales", "f32", bytesOf(scales)],
      ["orientation", "f32", bytesOf(orientation)]
    ];
    if (decodeSh) {
      columns.push(...shColumns(n, "", (i, coeffs) => decodeSh(base + i, coeffs)));
    }
    if (labels) {
      if (base === 0) {
        columns.push(...shColumns(shPalette.size, "_code", (e, coeffs) => shPalette.get(e, coeffs)));
      }
      columns.push(["sh_label", "u16", bytesOf(Uint16Array.from(labels.subarray(base, base + n)))]);
    }
    if (tree) {
      const nodes = tree.channels.node.data;
      const counts = new Uint32Array(n);
      const starts = new Uint32Array(n);
      for (let i = 0; i < n; i += 1) {
        counts[i] = nodes[(base + i) * 2];
        starts[i] = nodes[(base + i) * 2 + 1];
      }
      columns.push(["child_count", "u32", bytesOf(counts)], ["child_start", "u32", bytesOf(starts)]);
    }
    const payloads = await Promise.all(columns.map(([, , bytes2]) => Compression.gzip(bytes2)));
    const properties = [];
    let payloadBytes = 0;
    columns.forEach(([property, encoding, , range], c) => {
      properties.push({ offset: payloadBytes, bytes: payloads[c].byteLength, property, encoding, compression: "gz", ...range });
      payloadBytes += pad8(payloads[c].byteLength);
    });
    const meta = encoder.encode(JSON.stringify({ version: 1, base, count: n, payloadBytes, maxSh, lodTree: tree !== void 0, properties }));
    const chunk = new Uint8Array(8 + pad8(meta.byteLength) + 8 + payloadBytes);
    const view2 = new DataView(chunk.buffer);
    view2.setUint32(0, RAD_CHUNK_MAGIC, true);
    view2.setUint32(4, meta.byteLength, true);
    chunk.set(meta, 8);
    const payloadAt = 8 + pad8(meta.byteLength);
    view2.setUint32(payloadAt, payloadBytes, true);
    properties.forEach((property, c) => chunk.set(payloads[c], payloadAt + 8 + property.offset));
    chunks.push(chunk);
    ranges.push({ offset, bytes: chunk.byteLength });
    offset += chunk.byteLength;
  }
  const splatEncoding = maxSh > 0 && radSh === "s8" ? { sh1Max: bandMax[0] || 1, sh2Max: bandMax[1] || 1, sh3Max: bandMax[2] || 1 } : void 0;
  const header = encoder.encode(JSON.stringify({
    version: 1,
    type: "gsplat",
    count: data.count,
    maxSh,
    lodTree: tree !== void 0,
    chunkSize,
    chunks: ranges,
    splatEncoding,
    shCodeCount: labels ? shPalette.size : void 0
  }));
  const file = new Uint8Array(8 + pad8(header.byteLength) + offset);
  const view = new DataView(file.buffer);
  view.setUint32(0, RAD_MAGIC, true);
  view.setUint32(4, header.byteLength, true);
  file.set(header, 8);
  let at = 8 + pad8(header.byteLength);
  for (const chunk of chunks) {
    file.set(chunk, at);
    at += chunk.byteLength;
  }
  progress?.(1, "encoding");
  return file;
}

// src/core/rdx.ts
var RDX_VERSION = 1;
var RDX_CHUNK_SIZE = 65536;
var RDX_MAGIC = 1213744210;
var CHUNK_MAGIC = 1129858130;
var HEAD_READ_BYTES = 64 * 1024;
var align16 = (n) => Math.ceil(n / 16) * 16;
function encodeContainer(magic, meta, payloads) {
  const metaBytes = new TextEncoder().encode(JSON.stringify(meta));
  const sizesAt = 16 + align16(metaBytes.byteLength);
  const payloadsAt = sizesAt + align16(payloads.length * 4);
  const total = payloadsAt + payloads.reduce((sum, payload) => sum + align16(payload.byteLength), 0);
  const bytes2 = new Uint8Array(total);
  const view = new DataView(bytes2.buffer);
  view.setUint32(0, magic, true);
  view.setUint32(4, metaBytes.byteLength, true);
  view.setUint32(8, payloads.length, true);
  bytes2.set(metaBytes, 16);
  let offset = payloadsAt;
  payloads.forEach((payload, i) => {
    view.setUint32(sizesAt + i * 4, payload.byteLength, true);
    bytes2.set(payload, offset);
    offset += align16(payload.byteLength);
  });
  return bytes2;
}
function decodeContainer(bytes2, magic) {
  const view = new DataView(bytes2.buffer, bytes2.byteOffset, bytes2.byteLength);
  if (bytes2.byteLength < 16 || view.getUint32(0, true) !== magic) {
    throw new Error("Not an RDX piece of the expected type");
  }
  const metaLength = view.getUint32(4, true);
  const payloadCount = view.getUint32(8, true);
  const meta = JSON.parse(new TextDecoder().decode(bytes2.subarray(16, 16 + metaLength)));
  const sizesAt = 16 + align16(metaLength);
  let offset = sizesAt + align16(payloadCount * 4);
  const payloads = Array.from({ length: payloadCount }, (_, i) => {
    const size = view.getUint32(sizesAt + i * 4, true);
    const payload = bytes2.subarray(offset, offset + size);
    offset += align16(size);
    return payload;
  });
  return { meta, payloads, byteLength: offset };
}
async function encodeRdxChunks(data, { chunkSize = RDX_CHUNK_SIZE, progress } = {}) {
  if (chunkSize <= 0 || chunkSize % TextureLayout.ROW_ELEMENTS !== 0) {
    throw new Error(`Chunk size ${chunkSize} is not a positive multiple of ${TextureLayout.ROW_ELEMENTS}`);
  }
  const bundles = Object.entries(data.bundles).filter(([, bundle]) => bundle.def.serialize);
  const chunkCount = Math.ceil(data.count / chunkSize);
  const chunks = [];
  for (let chunk = 0; chunk < chunkCount; chunk += 1) {
    progress?.(chunk / chunkCount, "encoding");
    const start = chunk * chunkSize;
    const count = Math.min(chunkSize, data.count - start);
    const payloads = [];
    for (const [, bundle] of bundles) {
      for (const channel of Object.values(bundle.channels)) {
        const info = ArrayFormats.info(channel.format);
        payloads.push(await Compression.compressTransposed(channel.data.subarray(start * info.components, (start + count) * info.components), info.bytes));
      }
    }
    chunks.push(encodeContainer(CHUNK_MAGIC, { start, count }, payloads));
  }
  progress?.(1, "encoding");
  const header = {
    version: RDX_VERSION,
    count: data.count,
    chunkSize,
    meta: data.meta,
    bundles: Object.fromEntries(bundles.map(([name, bundle]) => [name, { def: bundle.def, meta: bundle.meta }])),
    chunks: chunks.map((chunk) => chunk.byteLength)
  };
  return { header: encodeContainer(RDX_MAGIC, header, []), chunks };
}
function rdxChunkName(headerName, chunk) {
  const at = headerName.search(/\.rdx($|[?#])/);
  if (at < 0) {
    throw new Error(`${headerName} does not end in .rdx`);
  }
  return `${headerName.slice(0, at)}-${chunk}${headerName.slice(at)}`;
}
async function encodeRdxFiles(data, headerName, options = {}) {
  const { header, chunks } = await encodeRdxChunks(data, options);
  const files = { [headerName]: header };
  chunks.forEach((chunk, i) => files[rdxChunkName(headerName, i)] = chunk);
  return files;
}
async function encodeRdx(data, options = {}) {
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
function decodeRdxHeader(bytes2) {
  const { meta, byteLength } = decodeContainer(bytes2, RDX_MAGIC);
  const header = meta;
  if (header.version !== RDX_VERSION) {
    throw new Error(`RDX version ${header.version} is not ${RDX_VERSION}`);
  }
  return { header, byteLength };
}
function rdxData(header) {
  const data = new ArrayData({ count: header.count, meta: header.meta });
  for (const [name, { def, meta }] of Object.entries(header.bundles)) {
    data.addBundle(name, defineBundle(def.channels, { packing: def.packing, serialize: def.serialize }), { meta });
  }
  return data;
}
async function decodeRdxChunk(header, bytes2, into) {
  const { meta, payloads } = decodeContainer(bytes2, CHUNK_MAGIC);
  const { start, count } = meta;
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
      channel.data.set(new info.array(decoded.buffer, decoded.byteOffset, count * info.components), start * info.components);
    }
  }
  into.count = Math.max(into.count, start + count);
}
async function decodeRdx(bytes2, { progress } = {}) {
  const { header, byteLength } = decodeRdxHeader(bytes2);
  const data = rdxData(header);
  let offset = byteLength;
  for (const [chunk, size] of header.chunks.entries()) {
    progress?.(chunk / header.chunks.length, "decoding");
    await decodeRdxChunk(header, bytes2.subarray(offset, offset + size), data);
    offset += size;
  }
  progress?.(1, "decoding");
  return data;
}
async function openRdx(readRange) {
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
  const offsets = [];
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
    }
  };
}
async function fetchBytes(url, init) {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`Failed to load ${url}: ${response.status}`);
  }
  return { status: response.status, bytes: new Uint8Array(await response.arrayBuffer()) };
}
async function loadRdx(url, { chunked = false, init = {} } = {}) {
  if (chunked) {
    const { header } = decodeRdxHeader((await fetchBytes(url, init)).bytes);
    return {
      header,
      async readChunk(chunk, into) {
        await decodeRdxChunk(header, (await fetchBytes(rdxChunkName(url, chunk), init)).bytes, into);
      }
    };
  }
  let whole;
  return openRdx(async (start, end) => {
    if (!whole) {
      const headers = new Headers(init.headers);
      headers.set("Range", `bytes=${start}-${end - 1}`);
      const { status, bytes: bytes2 } = await fetchBytes(url, { ...init, headers });
      if (status === 206) {
        return bytes2;
      }
      whole = bytes2;
    }
    return whole.subarray(start, end);
  });
}
var RdxFile = class {
  // Elements per chunk by default (a multiple of 4096)
  static CHUNK_SIZE = RDX_CHUNK_SIZE;
  // Whole file: the header, then every chunk
  static encode = encodeRdx;
  static decode = decodeRdx;
  // The header and the chunks as separate pieces
  static encodeChunks = encodeRdxChunks;
  // Chunked files by name: { "scene.rdx": header, "scene-0.rdx": chunk 0, ... }
  static encodeFiles = encodeRdxFiles;
  // scene.rdx -> scene-0.rdx (a query or hash after .rdx is kept)
  static chunkName = rdxChunkName;
  // The header at the start of `bytes`; byteLength is where chunk 0 starts
  // in a whole file
  static decodeHeader = decodeRdxHeader;
  // An empty ArrayData of a header's bundles, count and meta, for chunks
  static makeData = rdxData;
  // Writes a chunk's elements into `into`
  static decodeChunk = decodeRdxChunk;
  // A whole file through a range reader: one read for the header, one per chunk
  static open = openRdx;
  // A whole file over HTTP Range requests, or a chunked set with `chunked`
  static load = loadRdx;
};

// node_modules/fzstd/esm/index.mjs
var ab = ArrayBuffer;
var u8 = Uint8Array;
var u162 = Uint16Array;
var i16 = Int16Array;
var i32 = Int32Array;
var slc = function(v, s, e) {
  if (u8.prototype.slice)
    return u8.prototype.slice.call(v, s, e);
  if (s == null || s < 0)
    s = 0;
  if (e == null || e > v.length)
    e = v.length;
  var n = new u8(e - s);
  n.set(v.subarray(s, e));
  return n;
};
var fill = function(v, n, s, e) {
  if (u8.prototype.fill)
    return u8.prototype.fill.call(v, n, s, e);
  if (s == null || s < 0)
    s = 0;
  if (e == null || e > v.length)
    e = v.length;
  for (; s < e; ++s)
    v[s] = n;
  return v;
};
var cpw = function(v, t, s, e) {
  if (u8.prototype.copyWithin)
    return u8.prototype.copyWithin.call(v, t, s, e);
  if (s == null || s < 0)
    s = 0;
  if (e == null || e > v.length)
    e = v.length;
  while (s < e) {
    v[t++] = v[s++];
  }
};
var ec = [
  "invalid zstd data",
  "window size too large (>2046MB)",
  "invalid block type",
  "FSE accuracy too high",
  "match distance too far back",
  "unexpected EOF"
];
var err = function(ind, msg, nt) {
  var e = new Error(msg || ec[ind]);
  e.code = ind;
  if (Error.captureStackTrace)
    Error.captureStackTrace(e, err);
  if (!nt)
    throw e;
  return e;
};
var rb = function(d, b, n) {
  var i = 0, o = 0;
  for (; i < n; ++i)
    o |= d[b++] << (i << 3);
  return o;
};
var b4 = function(d, b) {
  return (d[b] | d[b + 1] << 8 | d[b + 2] << 16 | d[b + 3] << 24) >>> 0;
};
var rzfh = function(dat, w) {
  var n3 = dat[0] | dat[1] << 8 | dat[2] << 16;
  if (n3 == 3126568 && dat[3] == 253) {
    var flg = dat[4];
    var ss = flg >> 5 & 1, cc = flg >> 2 & 1, df = flg & 3, fcf = flg >> 6;
    if (flg & 8)
      err(0);
    var bt = 6 - ss;
    var db = df == 3 ? 4 : df;
    var di = rb(dat, bt, db);
    bt += db;
    var fsb = fcf ? 1 << fcf : ss;
    var fss = rb(dat, bt, fsb) + (fcf == 1 && 256);
    var ws = fss;
    if (!ss) {
      var wb = 1 << 10 + (dat[5] >> 3);
      ws = wb + (wb >> 3) * (dat[5] & 7);
    }
    if (ws > 2145386496)
      err(1);
    var buf = new u8((w == 1 ? fss || ws : w ? 0 : ws) + 12);
    buf[0] = 1, buf[4] = 4, buf[8] = 8;
    return {
      b: bt + fsb,
      y: 0,
      l: 0,
      d: di,
      w: w && w != 1 ? w : buf.subarray(12),
      e: ws,
      o: new i32(buf.buffer, 0, 3),
      u: fss,
      c: cc,
      m: Math.min(131072, ws)
    };
  } else if ((n3 >> 4 | dat[3] << 20) == 25481893) {
    return b4(dat, 4) + 8;
  }
  err(0);
};
var msb = function(val) {
  var bits = 0;
  for (; 1 << bits <= val; ++bits)
    ;
  return bits - 1;
};
var rfse = function(dat, bt, mal) {
  var tpos = (bt << 3) + 4;
  var al = (dat[bt] & 15) + 5;
  if (al > mal)
    err(3);
  var sz = 1 << al;
  var probs = sz, sym = -1, re = -1, i = -1, ht = sz;
  var buf = new ab(512 + (sz << 2));
  var freq = new i16(buf, 0, 256);
  var dstate = new u162(buf, 0, 256);
  var nstate = new u162(buf, 512, sz);
  var bb1 = 512 + (sz << 1);
  var syms = new u8(buf, bb1, sz);
  var nbits = new u8(buf, bb1 + sz);
  while (sym < 255 && probs > 0) {
    var bits = msb(probs + 1);
    var cbt = tpos >> 3;
    var msk = (1 << bits + 1) - 1;
    var val = (dat[cbt] | dat[cbt + 1] << 8 | dat[cbt + 2] << 16) >> (tpos & 7) & msk;
    var msk1fb = (1 << bits) - 1;
    var msv = msk - probs - 1;
    var sval = val & msk1fb;
    if (sval < msv)
      tpos += bits, val = sval;
    else {
      tpos += bits + 1;
      if (val > msk1fb)
        val -= msv;
    }
    freq[++sym] = --val;
    if (val == -1) {
      probs += val;
      syms[--ht] = sym;
    } else
      probs -= val;
    if (!val) {
      do {
        var rbt = tpos >> 3;
        re = (dat[rbt] | dat[rbt + 1] << 8) >> (tpos & 7) & 3;
        tpos += 2;
        sym += re;
      } while (re == 3);
    }
  }
  if (sym > 255 || probs)
    err(0);
  var sympos = 0;
  var sstep = (sz >> 1) + (sz >> 3) + 3;
  var smask = sz - 1;
  for (var s = 0; s <= sym; ++s) {
    var sf = freq[s];
    if (sf < 1) {
      dstate[s] = -sf;
      continue;
    }
    for (i = 0; i < sf; ++i) {
      syms[sympos] = s;
      do {
        sympos = sympos + sstep & smask;
      } while (sympos >= ht);
    }
  }
  if (sympos)
    err(0);
  for (i = 0; i < sz; ++i) {
    var ns = dstate[syms[i]]++;
    var nb = nbits[i] = al - msb(ns);
    nstate[i] = (ns << nb) - sz;
  }
  return [tpos + 7 >> 3, {
    b: al,
    s: syms,
    n: nbits,
    t: nstate
  }];
};
var rhu = function(dat, bt) {
  var i = 0, wc = -1;
  var buf = new u8(292), hb = dat[bt];
  var hw = buf.subarray(0, 256);
  var rc = buf.subarray(256, 268);
  var ri = new u162(buf.buffer, 268);
  if (hb < 128) {
    var _a = rfse(dat, bt + 1, 6), ebt = _a[0], fdt = _a[1];
    bt += hb;
    var epos = ebt << 3;
    var lb = dat[bt];
    if (!lb)
      err(0);
    var st1 = 0, st2 = 0, btr1 = fdt.b, btr2 = btr1;
    var fpos = (++bt << 3) - 8 + msb(lb);
    for (; ; ) {
      fpos -= btr1;
      if (fpos < epos)
        break;
      var cbt = fpos >> 3;
      st1 += (dat[cbt] | dat[cbt + 1] << 8) >> (fpos & 7) & (1 << btr1) - 1;
      hw[++wc] = fdt.s[st1];
      fpos -= btr2;
      if (fpos < epos)
        break;
      cbt = fpos >> 3;
      st2 += (dat[cbt] | dat[cbt + 1] << 8) >> (fpos & 7) & (1 << btr2) - 1;
      hw[++wc] = fdt.s[st2];
      btr1 = fdt.n[st1];
      st1 = fdt.t[st1];
      btr2 = fdt.n[st2];
      st2 = fdt.t[st2];
    }
    if (++wc > 255)
      err(0);
  } else {
    wc = hb - 127;
    for (; i < wc; i += 2) {
      var byte = dat[++bt];
      hw[i] = byte >> 4;
      hw[i + 1] = byte & 15;
    }
    ++bt;
  }
  var wes = 0;
  for (i = 0; i < wc; ++i) {
    var wt = hw[i];
    if (wt > 11)
      err(0);
    wes += wt && 1 << wt - 1;
  }
  var mb = msb(wes) + 1;
  var ts = 1 << mb;
  var rem = ts - wes;
  if (rem & rem - 1)
    err(0);
  hw[wc++] = msb(rem) + 1;
  for (i = 0; i < wc; ++i) {
    var wt = hw[i];
    ++rc[hw[i] = wt && mb + 1 - wt];
  }
  var hbuf = new u8(ts << 1);
  var syms = hbuf.subarray(0, ts), nb = hbuf.subarray(ts);
  ri[mb] = 0;
  for (i = mb; i > 0; --i) {
    var pv = ri[i];
    fill(nb, i, pv, ri[i - 1] = pv + rc[i] * (1 << mb - i));
  }
  if (ri[0] != ts)
    err(0);
  for (i = 0; i < wc; ++i) {
    var bits = hw[i];
    if (bits) {
      var code = ri[bits];
      fill(syms, i, code, ri[bits] = code + (1 << mb - bits));
    }
  }
  return [bt, {
    n: nb,
    b: mb,
    s: syms
  }];
};
var dllt = rfse(/* @__PURE__ */ new u8([
  81,
  16,
  99,
  140,
  49,
  198,
  24,
  99,
  12,
  33,
  196,
  24,
  99,
  102,
  102,
  134,
  70,
  146,
  4
]), 0, 6)[1];
var dmlt = rfse(/* @__PURE__ */ new u8([
  33,
  20,
  196,
  24,
  99,
  140,
  33,
  132,
  16,
  66,
  8,
  33,
  132,
  16,
  66,
  8,
  33,
  68,
  68,
  68,
  68,
  68,
  68,
  68,
  68,
  36,
  9
]), 0, 6)[1];
var doct = rfse(/* @__PURE__ */ new u8([
  32,
  132,
  16,
  66,
  102,
  70,
  68,
  68,
  68,
  68,
  36,
  73,
  2
]), 0, 5)[1];
var b2bl = function(b, s) {
  var len = b.length, bl = new i32(len);
  for (var i = 0; i < len; ++i) {
    bl[i] = s;
    s += 1 << b[i];
  }
  return bl;
};
var llb = /* @__PURE__ */ new u8((/* @__PURE__ */ new i32([
  0,
  0,
  0,
  0,
  16843009,
  50528770,
  134678020,
  202050057,
  269422093
])).buffer, 0, 36);
var llbl = /* @__PURE__ */ b2bl(llb, 0);
var mlb = /* @__PURE__ */ new u8((/* @__PURE__ */ new i32([
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  16843009,
  50528770,
  117769220,
  185207048,
  252579084,
  16
])).buffer, 0, 53);
var mlbl = /* @__PURE__ */ b2bl(mlb, 3);
var dhu = function(dat, out, hu) {
  var len = dat.length, ss = out.length, lb = dat[len - 1], msk = (1 << hu.b) - 1, eb = -hu.b;
  if (!lb)
    err(0);
  var st = 0, btr = hu.b, pos = (len << 3) - 8 + msb(lb) - btr, i = -1;
  for (; pos > eb && i < ss; ) {
    var cbt = pos >> 3;
    var val = (dat[cbt] | dat[cbt + 1] << 8 | dat[cbt + 2] << 16) >> (pos & 7);
    st = (st << btr | val) & msk;
    out[++i] = hu.s[st];
    pos -= btr = hu.n[st];
  }
  if (pos != eb || i + 1 != ss)
    err(0);
};
var dhu4 = function(dat, out, hu) {
  var bt = 6;
  var ss = out.length, sz1 = ss + 3 >> 2, sz2 = sz1 << 1, sz3 = sz1 + sz2;
  dhu(dat.subarray(bt, bt += dat[0] | dat[1] << 8), out.subarray(0, sz1), hu);
  dhu(dat.subarray(bt, bt += dat[2] | dat[3] << 8), out.subarray(sz1, sz2), hu);
  dhu(dat.subarray(bt, bt += dat[4] | dat[5] << 8), out.subarray(sz2, sz3), hu);
  dhu(dat.subarray(bt), out.subarray(sz3), hu);
};
var rzb = function(dat, st, out) {
  var _a;
  var bt = st.b;
  var b0 = dat[bt], btype = b0 >> 1 & 3;
  st.l = b0 & 1;
  var sz = b0 >> 3 | dat[bt + 1] << 5 | dat[bt + 2] << 13;
  var ebt = (bt += 3) + sz;
  if (btype == 1) {
    if (bt >= dat.length)
      return;
    st.b = bt + 1;
    if (out) {
      fill(out, dat[bt], st.y, st.y += sz);
      return out;
    }
    return fill(new u8(sz), dat[bt]);
  }
  if (ebt > dat.length)
    return;
  if (btype == 0) {
    st.b = ebt;
    if (out) {
      out.set(dat.subarray(bt, ebt), st.y);
      st.y += sz;
      return out;
    }
    return slc(dat, bt, ebt);
  }
  if (btype == 2) {
    var b3 = dat[bt], lbt = b3 & 3, sf = b3 >> 2 & 3;
    var lss = b3 >> 4, lcs = 0, s4 = 0;
    if (lbt < 2) {
      if (sf & 1)
        lss |= dat[++bt] << 4 | (sf & 2 && dat[++bt] << 12);
      else
        lss = b3 >> 3;
    } else {
      s4 = sf;
      if (sf < 2)
        lss |= (dat[++bt] & 63) << 4, lcs = dat[bt] >> 6 | dat[++bt] << 2;
      else if (sf == 2)
        lss |= dat[++bt] << 4 | (dat[++bt] & 3) << 12, lcs = dat[bt] >> 2 | dat[++bt] << 6;
      else
        lss |= dat[++bt] << 4 | (dat[++bt] & 63) << 12, lcs = dat[bt] >> 6 | dat[++bt] << 2 | dat[++bt] << 10;
    }
    ++bt;
    var buf = out ? out.subarray(st.y, st.y + st.m) : new u8(st.m);
    var spl = buf.length - lss;
    if (lbt == 0)
      buf.set(dat.subarray(bt, bt += lss), spl);
    else if (lbt == 1)
      fill(buf, dat[bt++], spl);
    else {
      var hu = st.h;
      if (lbt == 2) {
        var hud = rhu(dat, bt);
        lcs += bt - (bt = hud[0]);
        st.h = hu = hud[1];
      } else if (!hu)
        err(0);
      (s4 ? dhu4 : dhu)(dat.subarray(bt, bt += lcs), buf.subarray(spl), hu);
    }
    var ns = dat[bt++];
    if (ns) {
      if (ns == 255)
        ns = (dat[bt++] | dat[bt++] << 8) + 32512;
      else if (ns > 127)
        ns = ns - 128 << 8 | dat[bt++];
      var scm = dat[bt++];
      if (scm & 3)
        err(0);
      var dts = [dmlt, doct, dllt];
      for (var i = 2; i > -1; --i) {
        var md = scm >> (i << 1) + 2 & 3;
        if (md == 1) {
          var rbuf = new u8([0, 0, dat[bt++]]);
          dts[i] = {
            s: rbuf.subarray(2, 3),
            n: rbuf.subarray(0, 1),
            t: new u162(rbuf.buffer, 0, 1),
            b: 0
          };
        } else if (md == 2) {
          _a = rfse(dat, bt, 9 - (i & 1)), bt = _a[0], dts[i] = _a[1];
        } else if (md == 3) {
          if (!st.t)
            err(0);
          dts[i] = st.t[i];
        }
      }
      var _b = st.t = dts, mlt = _b[0], oct = _b[1], llt = _b[2];
      var lb = dat[ebt - 1];
      if (!lb)
        err(0);
      var spos = (ebt << 3) - 8 + msb(lb) - llt.b, cbt = spos >> 3, oubt = 0;
      var lst = (dat[cbt] | dat[cbt + 1] << 8) >> (spos & 7) & (1 << llt.b) - 1;
      cbt = (spos -= oct.b) >> 3;
      var ost = (dat[cbt] | dat[cbt + 1] << 8) >> (spos & 7) & (1 << oct.b) - 1;
      cbt = (spos -= mlt.b) >> 3;
      var mst = (dat[cbt] | dat[cbt + 1] << 8) >> (spos & 7) & (1 << mlt.b) - 1;
      for (++ns; --ns; ) {
        var llc = llt.s[lst];
        var lbtr = llt.n[lst];
        var mlc = mlt.s[mst];
        var mbtr = mlt.n[mst];
        var ofc = oct.s[ost];
        var obtr = oct.n[ost];
        cbt = (spos -= ofc) >> 3;
        var ofp = 1 << ofc;
        var off = ofp + ((dat[cbt] | dat[cbt + 1] << 8 | dat[cbt + 2] << 16 | dat[cbt + 3] << 24) >>> (spos & 7) & ofp - 1);
        cbt = (spos -= mlb[mlc]) >> 3;
        var ml = mlbl[mlc] + ((dat[cbt] | dat[cbt + 1] << 8 | dat[cbt + 2] << 16) >> (spos & 7) & (1 << mlb[mlc]) - 1);
        cbt = (spos -= llb[llc]) >> 3;
        var ll = llbl[llc] + ((dat[cbt] | dat[cbt + 1] << 8 | dat[cbt + 2] << 16) >> (spos & 7) & (1 << llb[llc]) - 1);
        cbt = (spos -= lbtr) >> 3;
        lst = llt.t[lst] + ((dat[cbt] | dat[cbt + 1] << 8) >> (spos & 7) & (1 << lbtr) - 1);
        cbt = (spos -= mbtr) >> 3;
        mst = mlt.t[mst] + ((dat[cbt] | dat[cbt + 1] << 8) >> (spos & 7) & (1 << mbtr) - 1);
        cbt = (spos -= obtr) >> 3;
        ost = oct.t[ost] + ((dat[cbt] | dat[cbt + 1] << 8) >> (spos & 7) & (1 << obtr) - 1);
        if (off > 3) {
          st.o[2] = st.o[1];
          st.o[1] = st.o[0];
          st.o[0] = off -= 3;
        } else {
          var idx = off - (ll != 0);
          if (idx) {
            off = idx == 3 ? st.o[0] - 1 : st.o[idx];
            if (idx > 1)
              st.o[2] = st.o[1];
            st.o[1] = st.o[0];
            st.o[0] = off;
          } else
            off = st.o[0];
        }
        for (var i = 0; i < ll; ++i) {
          buf[oubt + i] = buf[spl + i];
        }
        oubt += ll, spl += ll;
        var stin = oubt - off;
        if (stin < 0) {
          var len = -stin;
          var bs = st.e + stin;
          if (len > ml)
            len = ml;
          for (var i = 0; i < len; ++i) {
            buf[oubt + i] = st.w[bs + i];
          }
          oubt += len, ml -= len, stin = 0;
        }
        for (var i = 0; i < ml; ++i) {
          buf[oubt + i] = buf[stin + i];
        }
        oubt += ml;
      }
      if (oubt != spl) {
        while (spl < buf.length) {
          buf[oubt++] = buf[spl++];
        }
      } else
        oubt = buf.length;
      if (out)
        st.y += oubt;
      else
        buf = slc(buf, 0, oubt);
    } else if (out) {
      st.y += lss;
      if (spl) {
        for (var i = 0; i < lss; ++i) {
          buf[i] = buf[spl + i];
        }
      }
    } else if (spl)
      buf = slc(buf, spl);
    st.b = ebt;
    return buf;
  }
  err(2);
};
var cct = function(bufs, ol) {
  if (bufs.length == 1)
    return bufs[0];
  var buf = new u8(ol);
  for (var i = 0, b = 0; i < bufs.length; ++i) {
    var chk = bufs[i];
    buf.set(chk, b);
    b += chk.length;
  }
  return buf;
};
function decompress2(dat, buf) {
  var bufs = [], nb = +!buf;
  var bt = 0, ol = 0;
  for (; dat.length; ) {
    var st = rzfh(dat, nb || buf);
    if (typeof st == "object") {
      if (nb) {
        buf = null;
        if (st.w.length == st.u) {
          bufs.push(buf = st.w);
          ol += st.u;
        }
      } else {
        bufs.push(buf);
        st.e = 0;
      }
      for (; !st.l; ) {
        var blk = rzb(dat, st, buf);
        if (!blk)
          err(5);
        if (buf)
          st.e = st.y;
        else {
          bufs.push(blk);
          ol += blk.length;
          cpw(st.w, 0, blk.length);
          st.w.set(blk, st.w.length - blk.length);
        }
      }
      bt = st.b + st.c * 4;
    } else
      bt = st;
    dat = dat.subarray(bt);
  }
  return cct(bufs, ol);
}

// src/core/zstd.ts
var LEVEL = 12;
var zlib;
function nodeZstd() {
  if (zlib === void 0) {
    const process = globalThis.process;
    const found = process?.getBuiltinModule?.("node:zlib");
    zlib = found?.zstdCompressSync && found.zstdDecompressSync ? found : null;
  }
  return zlib;
}
var streamSupport = {};
function streams(kind) {
  if (streamSupport[kind] === void 0) {
    try {
      void (kind === "compress" ? new CompressionStream("zstd") : new DecompressionStream("zstd"));
      streamSupport[kind] = true;
    } catch {
      streamSupport[kind] = false;
    }
  }
  return streamSupport[kind];
}
function own(bytes2) {
  return bytes2.byteOffset === 0 && bytes2.byteLength === bytes2.buffer.byteLength && bytes2.buffer instanceof ArrayBuffer ? new Uint8Array(bytes2.buffer) : new Uint8Array(bytes2);
}
var Zstd = class {
  // One or more frames of exactly `size` bytes in all; `native: false`
  // decodes with fzstd
  static async decompress(bytes2, size, { native = true } = {}) {
    const zstd = native ? nodeZstd() : null;
    let out;
    try {
      out = zstd ? zstd.zstdDecompressSync(bytes2) : native && streams("decompress") ? await pipe(new Uint8Array(bytes2), new DecompressionStream("zstd")) : decompress2(bytes2);
    } catch (error) {
      throw new Error(`Invalid zstd stream: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (out.byteLength !== size) {
      throw new Error(`zstd stream decoded to ${out.byteLength} bytes, not ${size}`);
    }
    return own(out);
  }
  // One frame; `level` (1 to 22) is Node's zstd level; `native: false` uses
  // the encoder below
  static async compress(bytes2, { native = true, level = LEVEL } = {}) {
    const zstd = native ? nodeZstd() : null;
    if (zstd) {
      return own(zstd.zstdCompressSync(bytes2, { params: { [zstd.constants.ZSTD_c_compressionLevel]: level } }));
    }
    if (native && streams("compress")) {
      return pipe(new Uint8Array(bytes2), new CompressionStream("zstd"));
    }
    return encodeFrame(bytes2);
  }
};
var BLOCK = 1 << 17;
var MAX_BITS = 11;
var WEIGHT_LOG = 6;
var MIN_HUFFMAN = 64;
var BitWriter = class {
  bytes;
  pos;
  acc = 0;
  n = 0;
  constructor(bytes2, pos = 0) {
    this.bytes = bytes2;
    this.pos = pos;
  }
  // nbits <= 24
  add(value, nbits) {
    this.acc |= value << this.n;
    this.n += nbits;
    while (this.n >= 8) {
      this.bytes[this.pos++] = this.acc & 255;
      this.acc >>>= 8;
      this.n -= 8;
    }
  }
  // The last partial byte; returns the end
  flush() {
    if (this.n > 0) {
      this.bytes[this.pos++] = this.acc & 255;
    }
    this.acc = 0;
    this.n = 0;
    return this.pos;
  }
  close() {
    this.add(1, 1);
    return this.flush();
  }
};
function huffmanLengths(counts, lengths) {
  lengths.fill(0);
  const syms = [];
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
  const pick = (next) => leaf < n && (inner >= next || weight[leaf] <= weight[inner]) ? leaf++ : inner++;
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
function huffmanCodes(lengths, maxBits, codes) {
  let slot = 0;
  for (let len = maxBits; len >= 1; len -= 1) {
    const span2 = 1 << maxBits - len;
    for (let s = 0; s < 256; s += 1) {
      if (lengths[s] === len) {
        codes[s] = slot >> maxBits - len;
        slot += span2;
      }
    }
  }
}
var highBit = (v) => 31 - Math.clz32(v);
function fseWeights(weights, count, out, at) {
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
    return void 0;
  }
  const norm = new Int32Array(maxSym + 1);
  let sum = 0;
  for (let s = 0; s <= maxSym; s += 1) {
    if (freq[s] > 0) {
      norm[s] = Math.max(1, Math.floor(freq[s] * size / count));
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
  for (let s = 0; s <= maxSym && remaining > 1; ) {
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
      pos = pos + (size >> 1) + (size >> 3) + 3 & size - 1;
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
  const stream = new BitWriter(scratch, end);
  const states = [0, 0];
  const started = [false, false];
  for (let k = count - 1; k >= 0; k -= 1) {
    const s = weights[k];
    const which = k & 1;
    if (!started[which]) {
      const nbOut = deltaNbBits[s] + (1 << 15) >> 16;
      const value = (nbOut << 16) - deltaNbBits[s];
      states[which] = stateTable[(value >> nbOut) + deltaFind[s]];
      started[which] = true;
    } else {
      const value = states[which];
      const nbOut = value + deltaNbBits[s] >> 16;
      stream.add(value & (1 << nbOut) - 1, nbOut);
      states[which] = stateTable[(value >> nbOut) + deltaFind[s]];
    }
  }
  stream.add(states[1] & size - 1, WEIGHT_LOG);
  stream.add(states[0] & size - 1, WEIGHT_LOG);
  end = stream.close();
  if (end > 127) {
    return void 0;
  }
  out.set(scratch.subarray(0, end), at);
  return end;
}
function treeDescription(lengths, maxBits, out, at) {
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
  const directSize = last <= 128 ? 1 + (last + 1 >> 1) : Infinity;
  if (fseSize !== void 0 && fseSize + 1 < directSize) {
    out[at] = fseSize;
    out.set(fse.subarray(0, fseSize), at + 1);
    return fseSize + 1;
  }
  if (directSize === Infinity) {
    return void 0;
  }
  out[at] = 127 + last;
  for (let s = 0; s < last; s += 2) {
    out[at + 1 + (s >> 1)] = weights[s] << 4 | (s + 1 < last ? weights[s + 1] : 0);
  }
  return directSize;
}
function writeLE(out, at, value, bytes2) {
  for (let i = 0; i < bytes2; i += 1) {
    out[at + i] = value % 256;
    value = Math.floor(value / 256);
  }
}
function encodeFrame(src) {
  const blocks = Math.max(1, Math.ceil(src.byteLength / BLOCK));
  const out = new Uint8Array(14 + src.byteLength + blocks * 3);
  writeLE(out, 0, 4247762216, 4);
  const wide = src.byteLength >= 2 ** 32;
  out[4] = (wide ? 3 : 2) << 6;
  out[5] = 17 - 10 << 3;
  writeLE(out, 6, src.byteLength, wide ? 8 : 4);
  let at = wide ? 14 : 10;
  const counts = new Uint32Array(256);
  const lengths = new Uint8Array(256);
  const codes = new Uint16Array(256);
  const prevLengths = new Uint8Array(256);
  const prevCodes = new Uint16Array(256);
  let hasPrev = false;
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
      writeLE(out, at, last | 1 << 1 | n << 3, 3);
      out[at + 3] = lit[0];
      at += 4;
      continue;
    }
    const [size, fresh] = n >= MIN_HUFFMAN ? compressBlock(lit, counts, lengths, codes, prevLengths, prevCodes, hasPrev, block) : [0, false];
    if (size > 0 && size < n) {
      writeLE(out, at, last | 2 << 1 | size << 3, 3);
      out.set(block.subarray(0, size), at + 3);
      at += 3 + size;
      if (fresh) {
        prevLengths.set(lengths);
        prevCodes.set(codes);
      }
      hasPrev = true;
    } else {
      writeLE(out, at, last | n << 3, 3);
      out.set(lit, at + 3);
      at += 3 + n;
    }
  }
  return out.slice(0, at);
}
function compressBlock(lit, counts, lengths, codes, prevLengths, prevCodes, hasPrev, block) {
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
  const newCost = treeSize === void 0 ? Infinity : newBits + treeSize * 8;
  if (newCost === Infinity && prevBits === Infinity) {
    return [0, false];
  }
  const treeless = prevBits <= newCost;
  if (!treeless) {
    huffmanCodes(lengths, maxBits, codes);
  }
  const useLengths = treeless ? prevLengths : lengths;
  const useCodes = treeless ? prevCodes : codes;
  const headerMax = 5;
  let at = headerMax;
  if (!treeless) {
    block.set(tree.subarray(0, treeSize), at);
    at += treeSize;
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
  block[at] = 0;
  at += 1;
  block.copyWithin(0, begin, at);
  return [at - begin, !treeless];
}

// src/core/spz.ts
var SPZ_MAGIC = 1347635022;
var GZIP_LATEST = 4;
var NGSP_VERSION = 4;
var FLAG_ANTIALIASED = 1;
var FLAG_EXTENSIONS = 2;
var FLAG_PBR = 64;
var FLAG_LOD = 128;
var RECORD_SAFE_ORBIT = 2914910210;
var RECORD_COORDINATE_SYSTEM = 2914910211;
var RECORD_LOD = 1381498881;
var RECORD_PBR = 1381498882;
var LOD_BYTES = 6;
var PBR_BYTES = 5;
var COLOR_SCALE = SH_C0 / 0.15;
var SH_VECTORS = { 0: 0, 1: 3, 2: 8, 3: 15, 4: 24 };
var le32 = (bytes2, at) => (bytes2[at] | bytes2[at + 1] << 8 | bytes2[at + 2] << 16 | bytes2[at + 3] << 24) >>> 0;
function parseRecords(bytes2) {
  const records = [];
  let at = 0;
  while (at + 8 <= bytes2.byteLength) {
    const type = le32(bytes2, at);
    const length = le32(bytes2, at + 4);
    if (at + 8 + length > bytes2.byteLength) {
      throw new Error(`SPZ extension record 0x${type.toString(16)} runs past its end`);
    }
    records.push({ type, data: bytes2.subarray(at + 8, at + 8 + length) });
    at += 8 + length;
  }
  return records;
}
async function splitRecords(records, count, out) {
  for (const record2 of records) {
    if (record2.type === RECORD_LOD) {
      out.lodTree = await Zstd.decompress(record2.data, count * LOD_BYTES);
    } else if (record2.type === RECORD_PBR) {
      out.pbr = await Zstd.decompress(record2.data, count * PBR_BYTES);
    } else {
      out.extensions.push(record2);
    }
  }
}
function checkHeader(version, shDegree2, latest) {
  if (version < 1 || version > latest || !(shDegree2 in SH_VECTORS)) {
    throw new Error(`Unsupported SPZ version ${version} or SH degree ${shDegree2}`);
  }
}
async function unpackGzip(r, sh) {
  const head = await r.read(16);
  if (le32(head, 0) !== SPZ_MAGIC) {
    throw new Error("Invalid SPZ file");
  }
  const version = le32(head, 4);
  const count = le32(head, 8);
  const [shDegree2, fractionalBits, flags] = [head[12], head[13], head[14]];
  checkHeader(version, shDegree2, GZIP_LATEST);
  const shBytes = count * SH_VECTORS[shDegree2] * 3;
  const out = {
    container: "gzip",
    version,
    count,
    shDegree: shDegree2,
    fractionalBits,
    flags,
    centers: await r.read(count * (version === 1 ? 6 : 9)),
    alphas: await r.read(count),
    colors: await r.read(count * 3),
    scales: await r.read(count * 3),
    rotations: await r.read(count * (version >= 3 ? 4 : 3)),
    extensions: []
  };
  if (sh && shBytes > 0) {
    out.sh = await r.read(shBytes);
  } else {
    await r.skip(shBytes);
  }
  if (flags & FLAG_LOD) {
    out.lodTree = await r.read(count * LOD_BYTES);
  }
  if (flags & FLAG_PBR) {
    out.pbr = await r.read(count * PBR_BYTES);
  }
  if (flags & FLAG_EXTENSIONS) {
    await splitRecords(parseRecords(await r.rest()), count, out);
  } else {
    r.cancel();
  }
  return out;
}
async function unpackNgsp(r, sh) {
  const head = await r.read(32);
  const version = le32(head, 4);
  const count = le32(head, 8);
  const [shDegree2, fractionalBits, flags, numStreams] = [head[12], head[13], head[14], head[15]];
  const tocByteOffset = le32(head, 16);
  if (version !== NGSP_VERSION) {
    throw new Error(`Unsupported SPZ version ${version} in the NGSP container`);
  }
  checkHeader(version, shDegree2, NGSP_VERSION);
  if (count > 2147483647) {
    throw new Error(`Invalid SPZ point count ${count}`);
  }
  if (tocByteOffset < 32) {
    throw new Error("SPZ 4 table of contents inside the header");
  }
  const records = await r.read(tocByteOffset - 32);
  const sizes = [9, 1, 3, 3, 4, SH_VECTORS[shDegree2] * 3].map((bytes2) => count * bytes2);
  const present = sizes.flatMap((size, i) => size > 0 ? [i] : []);
  if (numStreams !== present.length) {
    throw new Error(`SPZ 4 file with ${numStreams} streams, ${present.length} expected`);
  }
  const toc = await r.read(numStreams * 16);
  const compressed = [];
  let total = tocByteOffset + toc.byteLength;
  for (let k = 0; k < numStreams; k += 1) {
    const [low, high, sizeLow, sizeHigh] = [0, 4, 8, 12].map((at) => le32(toc, k * 16 + at));
    if (high >= 1 << 21 || sizeHigh !== 0 || sizeLow !== sizes[present[k]]) {
      throw new Error(`SPZ 4 stream ${k} sizes don't match its header`);
    }
    compressed.push(high * 2 ** 32 + low);
    total += compressed[k];
  }
  if (count * 9 > total * 1024) {
    throw new Error(`Invalid SPZ point count ${count} for ${total} bytes`);
  }
  const columns = sizes.map(() => new Uint8Array(0));
  let complete = true;
  for (let k = 0; k < numStreams; k += 1) {
    if (present[k] === 5 && !sh) {
      r.cancel();
      complete = false;
      break;
    }
    columns[present[k]] = await Zstd.decompress(await r.read(compressed[k]), sizes[present[k]]);
  }
  if (complete && !await r.atEnd()) {
    throw new Error("SPZ 4 file has bytes after its last stream");
  }
  const out = {
    container: "ngsp",
    version,
    count,
    shDegree: shDegree2,
    fractionalBits,
    flags,
    centers: columns[0],
    alphas: columns[1],
    colors: columns[2],
    scales: columns[3],
    rotations: columns[4],
    sh: sh && columns[5].byteLength > 0 ? columns[5] : void 0,
    extensions: []
  };
  if (flags & FLAG_EXTENSIONS) {
    await splitRecords(parseRecords(records), count, out);
  }
  return out;
}
async function unpackSpz(input, { sh = true } = {}) {
  const raw = new ByteReader(input, "SPZ file");
  const head = await raw.peek(4);
  if (head.byteLength === 4 && le32(head, 0) === SPZ_MAGIC) {
    return unpackNgsp(raw, sh);
  }
  if (head[0] !== 31 || head[1] !== 139) {
    raw.cancel();
    throw new Error("Invalid SPZ file");
  }
  return unpackGzip(new ByteReader(raw.stream().pipeThrough(new DecompressionStream("gzip")), "SPZ file"), sh);
}
async function readSpz(input, {
  progress,
  sh: shTarget,
  coordinateSystem,
  ...target
} = {}) {
  const u = await unpackSpz(input, { sh: shTarget !== false });
  const { version, count, shDegree: shDegree2 } = u;
  const meta = { format: "spz", version, container: u.container, antialiased: (u.flags & FLAG_ANTIALIASED) !== 0 };
  let stored = "RUB";
  const skipped = [];
  for (const { type, data: bytes2 } of u.extensions) {
    const view = new DataView(bytes2.buffer, bytes2.byteOffset, bytes2.byteLength);
    if (type === RECORD_SAFE_ORBIT && bytes2.byteLength >= 12) {
      meta.safeOrbitCamera = { elevationMin: view.getFloat32(0, true), elevationMax: view.getFloat32(4, true), radiusMin: view.getFloat32(8, true) };
    } else if (type === RECORD_COORDINATE_SYSTEM && bytes2.byteLength >= 4) {
      const code = view.getUint32(0, true);
      if (code > Axes.SYSTEMS.length) {
        throw new Error(`Unknown SPZ coordinate system ${code}`);
      }
      stored = code === 0 ? "RUB" : Axes.SYSTEMS[code - 1];
    } else {
      skipped.push(type);
    }
  }
  if (skipped.length > 0) {
    meta.skippedExtensions = skipped;
  }
  meta.coordinateSystem = coordinateSystem ?? stored;
  const convert = coordinateSystem && coordinateSystem !== stored ? Axes.converter(stored, coordinateSystem) : void 0;
  const data = new ArrayData({ count, meta });
  const encode = Splats.encoder(Splats.add(data, target));
  const encodeSh = Sh.prepare(data, shDegree2, shTarget);
  const shValues = SH_VECTORS[shDegree2] * 3;
  const coeffs = new Float32Array(Sh.VALUES);
  const { centers, alphas, colors, scales, rotations, sh, pbr } = u;
  const centerView = new DataView(centers.buffer, centers.byteOffset, centers.byteLength);
  const rotationView = new DataView(rotations.buffer, rotations.byteOffset, rotations.byteLength);
  const fixed = 1 / (1 << u.fractionalBits);
  const int24 = (at) => (centers[at] | centers[at + 1] << 8 | centers[at + 2] << 16) << 8 >> 8;
  const s = Splats.makeExtSplat();
  const color = (byte) => (byte / 255 - 0.5) * COLOR_SCALE + 0.5;
  const scale = (byte) => Math.exp(byte / 16 - 10);
  const tick = counter(progress, count, "decoding");
  for (let i = 0; i < count; i += 1) {
    tick(i);
    if (version === 1) {
      s.center.x = Encoding.decodeHalf(centerView.getUint16(i * 6, true));
      s.center.y = Encoding.decodeHalf(centerView.getUint16(i * 6 + 2, true));
      s.center.z = Encoding.decodeHalf(centerView.getUint16(i * 6 + 4, true));
    } else {
      s.center.x = int24(i * 9) * fixed;
      s.center.y = int24(i * 9 + 3) * fixed;
      s.center.z = int24(i * 9 + 6) * fixed;
    }
    s.opacity = alphas[i] / 255;
    s.rgb.r = color(colors[i * 3]);
    s.rgb.g = color(colors[i * 3 + 1]);
    s.rgb.b = color(colors[i * 3 + 2]);
    s.scales.x = scale(scales[i * 3]);
    s.scales.y = scale(scales[i * 3 + 1]);
    s.scales.z = scale(scales[i * 3 + 2]);
    if (version >= 3) {
      decodeSmallestThree(rotationView.getUint32(i * 4, true), s.quaternion);
    } else {
      const x = rotations[i * 3] / 127.5 - 1;
      const y = rotations[i * 3 + 1] / 127.5 - 1;
      const z = rotations[i * 3 + 2] / 127.5 - 1;
      s.quaternion.x = x;
      s.quaternion.y = y;
      s.quaternion.z = z;
      s.quaternion.w = Math.sqrt(Math.max(0, 1 - x * x - y * y - z * z));
    }
    if (pbr) {
      Encoding.decodeOct24(pbr[i * 3] | pbr[i * 3 + 1] << 8 | pbr[i * 3 + 2] << 16, s.normal);
      s.roughness = pbr[count * 3 + i] / 255;
      s.metallic = pbr[count * 4 + i] / 255;
    }
    encode(i, convert ? convert.splat(s) : s);
    if (encodeSh && sh) {
      for (let v = 0; v < shValues; v += 1) {
        coeffs[v] = (sh[i * shValues + v] - 128) / 128;
      }
      encodeSh(i, convert ? convert.sh(coeffs, shDegree2) : coeffs);
    }
  }
  if (u.lodTree) {
    const tree = new DataView(u.lodTree.buffer, u.lodTree.byteOffset, u.lodTree.byteLength);
    const nodes = data.addBundle("lodTree", Splats.LOD_TREE).bundles.lodTree.channels.node.data;
    for (let i = 0; i < count; i += 1) {
      nodes[i * 2] = tree.getUint16(i * 2, true);
      nodes[i * 2 + 1] = tree.getUint32(count * 2 + i * 4, true);
    }
  }
  return { splats: data };
}
function record(type, payload) {
  const out = new Uint8Array(8 + payload.byteLength);
  const view = new DataView(out.buffer);
  view.setUint32(0, type, true);
  view.setUint32(4, payload.byteLength, true);
  out.set(payload, 8);
  return out;
}
var concat = (parts) => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
};
async function writeSpz(data, {
  version = 3,
  fractionalBits = 12,
  antialiased = true,
  pbr = false,
  lod,
  sh = true,
  coordinateSystem,
  zstdLevel,
  progress
} = {}) {
  if (version !== 2 && version !== 3 && version !== 4) {
    throw new Error(`SPZ version ${String(version)} cannot be written (2, 3 or 4)`);
  }
  const decode = Splats.decoder(Splats.get(data).bundle);
  const tree = Splats.findLodTree(data);
  const withLod = lod ?? tree !== void 0;
  if (withLod && !tree) {
    throw new Error("SpzFile.write with lod needs a lodTree bundle");
  }
  const found = sh ? Sh.find(data.bundles) : void 0;
  const decodeSh = found && Sh.decoder(data, found);
  const shValues = found ? SH_VECTORS[found.degree] * 3 : 0;
  const coeffs = new Float32Array(Sh.VALUES);
  const count = data.count;
  const rotationBytes = version === 2 ? 3 : 4;
  const alphas = 16 + count * 9;
  const colors = alphas + count;
  const scales = colors + count * 3;
  const rotations = scales + count * 3;
  const shStart = rotations + count * rotationBytes;
  const lodStart = shStart + count * shValues;
  const pbrStart = lodStart + (withLod ? count * LOD_BYTES : 0);
  const size = pbrStart + (pbr ? count * PBR_BYTES : 0);
  const bytes2 = new Uint8Array(size);
  const view = new DataView(bytes2.buffer);
  const flags = antialiased ? FLAG_ANTIALIASED : 0;
  view.setUint32(0, SPZ_MAGIC, true);
  view.setUint32(4, version, true);
  view.setUint32(8, count, true);
  view.setUint8(12, found?.degree ?? 0);
  view.setUint8(13, fractionalBits);
  view.setUint8(14, flags | (version < 4 ? (pbr ? FLAG_PBR : 0) | (withLod ? FLAG_LOD : 0) : 0));
  const fixed = 1 << fractionalBits;
  const byte = (value) => Math.round(Math.max(0, Math.min(255, value)));
  const colorByte = (value) => byte(((value - 0.5) / COLOR_SCALE + 0.5) * 255);
  const scaleByte = (value) => byte((Math.log(Math.max(value, Number.MIN_VALUE)) + 10) * 16);
  const putCenter = (at, value) => {
    const code = Math.max(-8388607, Math.min(8388607, Math.round(value * fixed)));
    bytes2[at] = code & 255;
    bytes2[at + 1] = code >> 8 & 255;
    bytes2[at + 2] = code >> 16 & 255;
  };
  const s = Splats.makeExtSplat();
  const q = { x: 0, y: 0, z: 0, w: 1 };
  const tick = counter(span(progress, 0, 0.8), count, "encoding");
  for (let i = 0; i < count; i += 1) {
    tick(i);
    decode(i, s);
    putCenter(16 + i * 9, s.center.x);
    putCenter(16 + i * 9 + 3, s.center.y);
    putCenter(16 + i * 9 + 6, s.center.z);
    bytes2[colors + i * 3] = colorByte(s.rgb.r);
    bytes2[colors + i * 3 + 1] = colorByte(s.rgb.g);
    bytes2[colors + i * 3 + 2] = colorByte(s.rgb.b);
    bytes2[scales + i * 3] = scaleByte(s.scales.x);
    bytes2[scales + i * 3 + 1] = scaleByte(s.scales.y);
    bytes2[scales + i * 3 + 2] = scaleByte(s.scales.z);
    bytes2[alphas + i] = byte(s.opacity * 255);
    if (version === 2) {
      SplatMath.normalizeQuat(s.quaternion, q);
      const sign = q.w < 0 ? -1 : 1;
      bytes2[rotations + i * 3] = byte((q.x * sign + 1) * 127.5);
      bytes2[rotations + i * 3 + 1] = byte((q.y * sign + 1) * 127.5);
      bytes2[rotations + i * 3 + 2] = byte((q.z * sign + 1) * 127.5);
    } else {
      view.setUint32(rotations + i * 4, encodeSmallestThree(s.quaternion), true);
    }
    if (decodeSh) {
      decodeSh(i, coeffs);
      for (let v = 0; v < shValues; v += 1) {
        bytes2[shStart + i * shValues + v] = byte(coeffs[v] * 128 + 128);
      }
    }
    if (withLod) {
      const nodes = tree.channels.node.data;
      view.setUint16(lodStart + i * 2, nodes[i * 2] & 65535, true);
      view.setUint32(lodStart + count * 2 + i * 4, nodes[i * 2 + 1], true);
    }
    if (pbr) {
      const normal = Encoding.encodeOct24(s.normal);
      bytes2[pbrStart + i * 3] = normal & 255;
      bytes2[pbrStart + i * 3 + 1] = normal >> 8 & 255;
      bytes2[pbrStart + i * 3 + 2] = normal >> 16 & 255;
      bytes2[pbrStart + count * 3 + i] = Encoding.encodeUnorm8(s.roughness);
      bytes2[pbrStart + count * 4 + i] = Encoding.encodeUnorm8(s.metallic);
    }
  }
  progress?.(0.8, "compressing");
  if (version < 4) {
    const compressed = await Compression.gzip(bytes2);
    progress?.(1, "compressing");
    return compressed;
  }
  const records = [];
  const orbit = data.meta.safeOrbitCamera;
  if (orbit) {
    records.push(record(RECORD_SAFE_ORBIT, new Uint8Array(Float32Array.of(orbit.elevationMin, orbit.elevationMax, orbit.radiusMin).buffer)));
  }
  const system = coordinateSystem ?? data.meta.coordinateSystem;
  if (system && system !== "RUB") {
    const code = Axes.SYSTEMS.indexOf(system) + 1;
    if (code === 0) {
      throw new Error(`Unknown coordinate system ${system}`);
    }
    records.push(record(RECORD_COORDINATE_SYSTEM, new Uint8Array(Uint32Array.of(code).buffer)));
  }
  if (withLod) {
    records.push(record(RECORD_LOD, await Zstd.compress(bytes2.subarray(lodStart, pbrStart), { level: zstdLevel })));
  }
  if (pbr) {
    records.push(record(RECORD_PBR, await Zstd.compress(bytes2.subarray(pbrStart, size), { level: zstdLevel })));
  }
  const streams2 = [];
  const sizes = [];
  const bounds = [16, alphas, colors, scales, rotations, shStart, lodStart];
  for (let k = 0; k < 6; k += 1) {
    if (bounds[k + 1] > bounds[k]) {
      streams2.push(await Zstd.compress(bytes2.subarray(bounds[k], bounds[k + 1]), { level: zstdLevel }));
      sizes.push(bounds[k + 1] - bounds[k]);
    }
  }
  const extensions = concat(records);
  const head = new Uint8Array(32 + extensions.byteLength + streams2.length * 16);
  const headView = new DataView(head.buffer);
  headView.setUint32(0, SPZ_MAGIC, true);
  headView.setUint32(4, NGSP_VERSION, true);
  headView.setUint32(8, count, true);
  head[12] = found?.degree ?? 0;
  head[13] = fractionalBits;
  head[14] = flags | (records.length > 0 ? FLAG_EXTENSIONS : 0);
  head[15] = streams2.length;
  headView.setUint32(16, 32 + extensions.byteLength, true);
  head.set(extensions, 32);
  for (let k = 0; k < streams2.length; k += 1) {
    const at = 32 + extensions.byteLength + k * 16;
    headView.setUint32(at, streams2[k].byteLength % 2 ** 32, true);
    headView.setUint32(at + 4, Math.floor(streams2[k].byteLength / 2 ** 32), true);
    headView.setUint32(at + 8, sizes[k], true);
  }
  progress?.(1, "compressing");
  return concat([head, ...streams2]);
}
var SpzFile = class {
  // Versions 1 to 4 in gzip and SPZ 4 (NGSP), from bytes or a stream, as
  // { splats }: the bundle of the asked layout (default extSplats), plus
  // lodTree, its SH included
  static read = readSpz;
  // The splat bundle of `data` (any layout): version 2, 3 or 4
  static write = writeSpz;
  // A file's header and byte columns (sh: false leaves the SH out)
  static unpack = unpackSpz;
};
function encodeSmallestThree(quaternion) {
  const n = SplatMath.normalizeQuat(quaternion, { x: 0, y: 0, z: 0, w: 1 });
  const q = [n.x, n.y, n.z, n.w];
  let largest = 0;
  for (let i = 1; i < 4; i += 1) {
    if (Math.abs(q[i]) > Math.abs(q[largest])) {
      largest = i;
    }
  }
  const negate = q[largest] < 0 ? 1 : 0;
  let packed2 = largest;
  for (let i = 0; i < 4; i += 1) {
    if (i !== largest) {
      const sign = (q[i] < 0 ? 1 : 0) ^ negate;
      const magnitude = Math.max(0, Math.min(511, Math.round(511 * Math.abs(q[i]) / Math.SQRT1_2)));
      packed2 = packed2 << 10 | sign << 9 | magnitude;
    }
  }
  return packed2 >>> 0;
}
function decodeSmallestThree(packed2, out) {
  const largest = packed2 >>> 30;
  const q = [0, 0, 0, 0];
  let rest = packed2;
  let sum = 0;
  for (let i = 3; i >= 0; i -= 1) {
    if (i !== largest) {
      const value = Math.SQRT1_2 * ((rest & 511) / 511) * (rest >>> 9 & 1 ? -1 : 1);
      rest >>>= 10;
      q[i] = value;
      sum += value * value;
    }
  }
  q[largest] = Math.sqrt(Math.max(1 - sum, 0));
  [out.x, out.y, out.z, out.w] = q;
}

// src/core/files.ts
var SplatFiles = class _SplatFiles {
  // The format of a file from its first bytes, else its name's extension;
  // compressed PLY files are "ply" (PlyFile.read reads both)
  static detectFormat(bytes2, name = "") {
    const magic = bytes2.byteLength >= 4 ? new DataView(bytes2.buffer, bytes2.byteOffset, bytes2.byteLength).getUint32(0, true) : 0;
    if (magic === RDX_MAGIC) {
      return "rdx";
    }
    if (magic === RAD_MAGIC || magic === RAD_CHUNK_MAGIC) {
      return "rad";
    }
    if (bytes2[0] === 112 && bytes2[1] === 108 && bytes2[2] === 121) {
      return "ply";
    }
    const extension = name.toLowerCase().replace(/[?#].*$/, "").split(".").pop();
    if (bytes2[0] === 31 && bytes2[1] === 139 || magic === SPZ_MAGIC || extension === "spz") {
      return "spz";
    }
    throw new Error(`Unknown splat file format${name ? `: ${name}` : ""}`);
  }
  static async decode(bytes2, {
    name = "",
    progress,
    layout = "extSplats",
    encoding,
    sh,
    coordinateSystem
  } = {}) {
    const options = { progress, layout, encoding, sh, coordinateSystem };
    switch (_SplatFiles.detectFormat(bytes2, name)) {
      case "rdx":
        return { splats: _SplatFiles.withSh(Splats.convert(await RdxFile.decode(bytes2, { progress }), { layout, encoding }), sh) };
      case "rad":
        return RadFile.read(bytes2, options);
      case "ply":
      case "compressed-ply":
        return PlyFile.read(bytes2, options);
      case "spz":
        return SpzFile.read(bytes2, options);
    }
  }
  // A table's SH as asked: kept when `sh` is undefined, dropped with false
  // (meta.ignoredShDegree records the degree), else converted to the codec
  static withSh(data, sh) {
    const table = data;
    const found = Sh.find(table.bundles);
    if (sh === void 0 || !found) {
      return data;
    }
    if (sh === false) {
      table.removeBundle(found.name);
      table.meta.ignoredShDegree = found.degree;
      return data;
    }
    return Sh.convert(table, sh);
  }
  // A file of `data` in `format`: PLY, SPZ and RAD take its splat bundle
  // (and lodTree, and SH), RDX every serialized bundle
  static async encode(data, format, options = {}) {
    if (options.shPalette && format !== "rad" && options.sh !== false) {
      data = options.shPalette.expanded(data);
    }
    switch (format) {
      case "ply":
        return PlyFile.write(data, options);
      case "compressed-ply":
        return CompressedPlyFile.write(data, options);
      case "spz":
        return SpzFile.write(data, options);
      case "rad":
        return RadFile.write(data, options);
      case "rdx":
        return RdxFile.encode(data, options);
    }
  }
  // Download (0-40% of the progress) and decode
  static async fetch(url, { init, progress, ...target } = {}) {
    const response = await fetch(url, init);
    if (!response.ok) {
      throw new Error(`Failed to load ${url}: ${response.status}`);
    }
    const bytes2 = await readResponse(response, span(progress, 0, 0.4));
    return _SplatFiles.decode(bytes2, { ...target, name: url, progress: span(progress, 0.4, 1) });
  }
};
export {
  ArrayData,
  ArrayFormats,
  Axes,
  ByteReader,
  CompressedPlyFile,
  Compression,
  Encoding,
  PlyFile,
  RadFile,
  RdxFile,
  Sh,
  ShPalette,
  SortKeys,
  SplatFiles,
  SplatMath,
  Splats,
  SpzFile,
  TextureLayout,
  Zstd,
  decodeShScale,
  defineBundle,
  encodeShScale
};
//# sourceMappingURL=radix-core.module.js.map
