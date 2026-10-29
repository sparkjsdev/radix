export type ScalarType = "uint8" | "sint8" | "unorm8" | "snorm8" | "uint16" | "sint16" | "float16" | "uint32" | "sint32" | "float32";
export type ArrayFormat = ScalarType | `${ScalarType}x${number}`;
export type TypedArray = Uint8Array<ArrayBuffer> | Int8Array<ArrayBuffer> | Uint16Array<ArrayBuffer> | Int16Array<ArrayBuffer> | Uint32Array<ArrayBuffer> | Int32Array<ArrayBuffer> | Float32Array<ArrayBuffer>;
export type TypedArrayConstructor = Uint8ArrayConstructor | Int8ArrayConstructor | Uint16ArrayConstructor | Int16ArrayConstructor | Uint32ArrayConstructor | Int32ArrayConstructor | Float32ArrayConstructor;
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
export type ArrayOf<F extends ArrayFormat> = ScalarArrays[ScalarOf<F> & ScalarType];
export interface FormatInfo {
    format: ArrayFormat;
    scalar: ScalarType;
    components: number;
    scalarBytes: number;
    bytes: number;
    array: TypedArrayConstructor;
    gpu: boolean;
}
export declare class ArrayFormats {
    static info(format: string): FormatInfo;
    static make(scalar: ScalarType, components: number): ArrayFormat;
}
export {};
