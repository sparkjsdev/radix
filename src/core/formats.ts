/**
 * A scalar type of an array format. float16 holds raw half-float bits.
 */
export type ScalarType =
  | "uint8" | "sint8" | "unorm8" | "snorm8"
  | "uint16" | "sint16" | "float16"
  | "uint32" | "sint32" | "float32";

// Names follow WebGPU's vertex formats
/**
 * An array format, a scalar type with an optional component count such as x4.
 * Only formats of 1, 2 or 4 components can be stored on the GPU.
 */
export type ArrayFormat = ScalarType | `${ScalarType}x${number}`;

/** A typed array that holds an array format. */
export type TypedArray =
  | Uint8Array<ArrayBuffer> | Int8Array<ArrayBuffer>
  | Uint16Array<ArrayBuffer> | Int16Array<ArrayBuffer>
  | Uint32Array<ArrayBuffer> | Int32Array<ArrayBuffer>
  | Float32Array<ArrayBuffer>;

/** The class of a TypedArray. */
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

/** The CPU array type of a format. */
export type ArrayOf<F extends ArrayFormat> = ScalarArrays[ScalarOf<F> & ScalarType];

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

/** The parts and sizes of an array format. */
export interface FormatInfo {
  format: ArrayFormat;
  scalar: ScalarType;
  components: number;
  /** The size of a scalar, in bytes. */
  scalarBytes: number;
  /** The size of an element, in bytes. */
  bytes: number;
  array: TypedArrayConstructor;
  /** Whether the GPU can store the format. */
  gpu: boolean;
}

const cache = new Map<string, FormatInfo>();

/** Parses and builds array format names. */
export class ArrayFormats {
  /** Returns the parts and sizes of a format, throwing for an invalid one. */
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

  /** Builds a format from a scalar type and a component count. */
  static make(scalar: ScalarType, components: number): ArrayFormat {
    return components === 1 ? scalar : `${scalar}x${components}`;
  }
}
