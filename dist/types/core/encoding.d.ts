import type { Quat, Rgb, Vec3 } from "./math";
export declare class Encoding {
    static floatView(u32: Uint32Array<ArrayBuffer>): Float32Array<ArrayBuffer>;
    static encodeHalf(f: number): number;
    static decodeHalf(h: number): number;
    static encodeUnorm8(v: number): number;
    static encodeLodOpacity(opacity: number): number;
    static decodeLodOpacity(byte: number): number;
    static encodeExtRgb({ r, g, b }: Rgb): number;
    static decodeExtRgb(encoded: number, out: Rgb): Rgb;
    static encodeOct(v: Vec3, bits: number): number;
    static decodeOct(code: number, bits: number, out: Vec3): Vec3;
    static encodeQuatOct(q: Quat, axisBits: number, angleBits: number): number;
    static decodeQuatOct(code: number, axisBits: number, angleBits: number, out: Quat): Quat;
    static readonly encodeOct24: (v: Vec3) => number;
    static readonly decodeOct24: (code: number, out: Vec3) => Vec3;
    static readonly encodeQuatOct32: (q: Quat) => number;
    static readonly decodeQuatOct32: (code: number, out: Quat) => Quat;
    static readonly encodeQuatOct24: (q: Quat) => number;
    static readonly decodeQuatOct24: (code: number, out: Quat) => Quat;
}
