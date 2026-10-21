/** A rectangle of texels in one layer. */
export interface TexelSpan {
  x: number;
  y: number;
  layer: number;
  /** The width, in texels. */
  width: number;
  /** The height, in rows. */
  rows: number;
  /** Texels from the start of the range. */
  offset: number;
}

/** A rectangle of texels copied between two layouts. */
export interface CopySpan {
  src: { x: number; y: number; layer: number };
  dst: { x: number; y: number; layer: number };
  /** The width, in texels. */
  width: number;
  /** The height, in rows. */
  rows: number;
}

/**
 * Maps elements to texels of a 2D array texture.
 *
 * Texel t is at x = t & 1023, y = (t >> 10) & (height - 1) and layer = t >> (10
 * + yBits).
 */
export class TextureLayout {
  /** Texels per row. */
  static readonly WIDTH = 1024;
  /** The most elements per texel. */
  static readonly MAX_PACKING = 4;
  /** Elements that fill whole rows at every packing. */
  static readonly ROW_ELEMENTS = TextureLayout.WIDTH * TextureLayout.MAX_PACKING;
  // Every WebGL2 device's MAX_TEXTURE_SIZE allows this
  /** The largest height, in rows. */
  static readonly MAX_HEIGHT = 4096;
  /**
   * Every WebGL2 device allows this many. createRenderer raises WebGPU's
   * default of 256.
   */
  static readonly MAX_LAYERS = 512;

  /** Texels per row. */
  readonly width: number;
  /** Rows per layer. */
  readonly height: number;
  readonly layers: number;
  /** The base-2 log of width. */
  readonly xBits: number;
  /** The base-2 log of height. */
  readonly yBits: number;
  readonly texels: number;

  private constructor(height: number, layers: number) {
    this.width = TextureLayout.WIDTH;
    this.height = height;
    this.layers = layers;
    this.xBits = Math.log2(this.width);
    this.yBits = Math.log2(height);
    this.texels = this.width * height * layers;
  }

  /** Returns the layout for a number of texels, throwing when they do not fit. */
  static for(texels: number): TextureLayout {
    const rows = Math.max(1, Math.ceil(texels / TextureLayout.WIDTH));
    const height = Math.min(TextureLayout.MAX_HEIGHT, 2 ** Math.max(0, Math.floor(Math.log2(rows / 2))));

    // At least 2, since WebGL renders to one layer only of multi-layer targets
    const layers = Math.max(2, Math.ceil(rows / height));
    if (layers > TextureLayout.MAX_LAYERS) {
      throw new Error(`${texels} texels do not fit in an array texture`);
    }
    return new TextureLayout(height, layers);
  }

  /** Rounds a capacity up to whole rows at every packing, a multiple of 4096. */
  static alignCapacity(count: number) {
    return Math.max(1, Math.ceil(count / TextureLayout.ROW_ELEMENTS)) * TextureLayout.ROW_ELEMENTS;
  }

  /** Covers a range of texels with the fewest rectangles. */
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

  /** Splits a copy between two layouts into rectangles. */
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
