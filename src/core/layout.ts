// How elements map to texels of a 2D array texture, shared by the CPU side
// (capacity alignment) and the GPU side (uploads, reads, copies, shaders).
// Width and height are powers of two, so texel t sits at x = t & 1023,
// y = (t >> 10) & (height - 1), layer = t >> (10 + yBits): shifts and masks
// only. The layer count is not a power of two.

// A rectangle of texels within one layer; `offset` counts texels from the
// start of the range
export interface TexelSpan {
  x: number;
  y: number;
  layer: number;
  width: number;
  rows: number;
  offset: number;
}

export interface CopySpan {
  src: { x: number; y: number; layer: number };
  dst: { x: number; y: number; layer: number };
  width: number;
  rows: number;
}

export class TextureLayout {
  static readonly WIDTH = 1024;
  static readonly MAX_PACKING = 4;
  // One texture row for every packing (1, 2 or 4 elements per texel)
  static readonly ROW_ELEMENTS = TextureLayout.WIDTH * TextureLayout.MAX_PACKING;
  // Array textures are limited by MAX_TEXTURE_SIZE (not MAX_3D_TEXTURE_SIZE),
  // >= 4096 on 100% of WebGL2 devices (web3dsurvey.com, Sep 2026)
  static readonly MAX_HEIGHT = 4096;
  // WebGL2 MAX_ARRAY_TEXTURE_LAYERS: 100% of devices; WebGPU baseline 2048
  // (its default is 256, so createRenderer requests more)
  static readonly MAX_LAYERS = 512;

  readonly width: number;
  readonly height: number;
  readonly layers: number;
  readonly xBits: number;
  readonly yBits: number;
  // width * height * layers
  readonly texels: number;

  private constructor(height: number, layers: number) {
    this.width = TextureLayout.WIDTH;
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
  static for(texels: number): TextureLayout {
    const rows = Math.max(1, Math.ceil(texels / TextureLayout.WIDTH));
    const height = Math.min(TextureLayout.MAX_HEIGHT, 2 ** Math.max(0, Math.floor(Math.log2(rows / 2))));

    const layers = Math.max(2, Math.ceil(rows / height));
    if (layers > TextureLayout.MAX_LAYERS) {
      throw new Error(`${texels} texels do not fit in an array texture`);
    }
    return new TextureLayout(height, layers);
  }

  // Capacity for `count` elements: whole rows for every packing
  static alignCapacity(count: number) {
    return Math.max(1, Math.ceil(count / TextureLayout.ROW_ELEMENTS)) * TextureLayout.ROW_ELEMENTS;
  }

  // Texels [start, start + count) as few rectangles as possible: partial
  // rows at the ends, whole rows in between (one span per layer)
  spans(start: number, count: number): TexelSpan[] {
    const { width, height } = this;
    const layerSize = width * height;
    const spans: TexelSpan[] = [];
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
  static copySpans(src: TextureLayout, srcStart: number, dst: TextureLayout, dstStart: number, count: number): CopySpan[] {
    const width = TextureLayout.WIDTH;
    const position = (layout: TextureLayout, t: number) => {
      const layerSize = width * layout.height;
      const layer = Math.floor(t / layerSize);
      const y = Math.floor((t - layer * layerSize) / width);
      return { x: t % width, y, layer };
    };

    const spans: CopySpan[] = [];
    let done = 0;
    while (done < count) {
      const s = position(src, srcStart + done);
      const d = position(dst, dstStart + done);
      const left = count - done;

      let span: CopySpan;
      if (s.x === 0 && d.x === 0 && left >= width) {
        const rows = Math.min(Math.floor(left / width), src.height - s.y, dst.height - d.y);
        span = { src: s, dst: d, width, rows };
      } else {
        span = { src: s, dst: d, width: Math.min(left, width - s.x, width - d.x), rows: 1 };
      }
      spans.push(span);
      done += span.width * span.rows;
    }
    return spans;
  }
}
