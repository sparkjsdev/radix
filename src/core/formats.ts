// Format names follow WebGPU vertex formats: a scalar type, optionally
// followed by "x" and a component count ("uint32", "uint32x2", "unorm8x4").
// Only 1, 2 or 4 components can live on the GPU; other counts are CPU-only.

export type ScalarType =
  | "uint8" | "sint8" | "unorm8" | "snorm8"
  | "uint16" | "sint16" | "float16"
  | "uint32" | "sint32" | "float32";

export type ArrayFormat = ScalarType | `${ScalarType}x${number}`;

export type TypedArray =
  | Uint8Array<ArrayBuffer> | Int8Array<ArrayBuffer>
  | Uint16Array<ArrayBuffer> | Int16Array<ArrayBuffer>
  | Uint32Array<ArrayBuffer> | Int32Array<ArrayBuffer>
  | Float32Array<ArrayBuffer>;

export type TypedArrayConstructor =
  | Uint8ArrayConstructor | Int8ArrayConstructor
  | Uint16ArrayConstructor | Int16ArrayConstructor
  | Uint32ArrayConstructor | Int32ArrayConstructor
  | Float32ArrayConstructor;

interface ScalarArrays {
  uint8: Uint8Array<ArrayBuffer>;
  sint8: Int8Array<ArrayBuffer>;
  unorm8: Uint8Array<ArrayBuffer>;
  snorm8: Int8Array<ArrayBuffer>;
  uint16: Uint16Array<ArrayBuffer>;
  sint16: Int16Array<ArrayBuffer>;
  float16: Uint16Array<ArrayBuffer>;
  uint32: Uint32Array<ArrayBuffer>;
  sint32: Int32Array<ArrayBuffer>;
  float32: Float32Array<ArrayBuffer>;
}

type ScalarOf<F extends string> = F extends `${infer S}x${number}` ? S : F;

// The CPU array type of a format, e.g. ArrayOf<"uint32x4"> = Uint32Array
export type ArrayOf<F extends ArrayFormat> = ScalarArrays[ScalarOf<F> & ScalarType];

// float16 is stored as raw half-float bits
const SCALARS: Record<ScalarType, { bytes: number; array: TypedArrayConstructor }> = {
  uint8: { bytes: 1, array: Uint8Array },
  sint8: { bytes: 1, array: Int8Array },
  unorm8: { bytes: 1, array: Uint8Array },
  snorm8: { bytes: 1, array: Int8Array },
  uint16: { bytes: 2, array: Uint16Array },
  sint16: { bytes: 2, array: Int16Array },
  float16: { bytes: 2, array: Uint16Array },
  uint32: { bytes: 4, array: Uint32Array },
  sint32: { bytes: 4, array: Int32Array },
  float32: { bytes: 4, array: Float32Array },
};

export interface FormatInfo {
  format: ArrayFormat;
  scalar: ScalarType;
  components: number;
  scalarBytes: number;
  // Bytes per element
  bytes: number;
  array: TypedArrayConstructor;
  gpu: boolean;
}

const cache = new Map<string, FormatInfo>();

export class ArrayFormats {
  static info(format: string): FormatInfo {
    let info = cache.get(format);
    if (!info) {
      const [scalar, count] = format.split("x") as [ScalarType, string | undefined];
      const spec = SCALARS[scalar];
      const components = count === undefined ? 1 : Number(count);
      if (!spec || !Number.isInteger(components) || components < 1) {
        throw new Error(`Invalid array format "${format}"`);
      }

      info = {
        format: format as ArrayFormat,
        scalar,
        components,
        scalarBytes: spec.bytes,
        bytes: spec.bytes * components,
        array: spec.array,
        gpu: components === 1 || components === 2 || components === 4,
      };
      cache.set(format, info);
    }
    return info;
  }

  // Format of `scalar` with `components` components ("uint32", "uint32x4")
  static make(scalar: ScalarType, components: number): ArrayFormat {
    return components === 1 ? scalar : `${scalar}x${components}`;
  }
}
