import { type TslNode } from "./tsl";
export declare const roundHalfUp: (x: TslNode) => any;
declare function encodeQuatOct(q: TslNode, axisBits: number, angleBits: number): TslNode;
declare function decodeQuatOct(code: TslNode, axisBits: number, angleBits: number): TslNode;
export declare class GpuEncoding {
    static encodeHalf(f: TslNode): TslNode;
    static encodeHalf2(v: TslNode): TslNode;
    static decodeHalf2(word: TslNode): TslNode;
    static decodeHalf(h: TslNode): TslNode;
    static encodeUnorm8(v: TslNode): TslNode;
    static encodeLodOpacity(opacity: TslNode): TslNode;
    static decodeLodOpacity(byte: TslNode): TslNode;
    static readonly encodeExtRgb: (rgb: TslNode) => TslNode;
    static readonly decodeExtRgb: (encoded: TslNode) => TslNode;
    static encodeOct(v: TslNode, bits: number): TslNode;
    static decodeOct(code: TslNode, bits: number): TslNode;
    static readonly encodeQuatOct: typeof encodeQuatOct;
    static readonly decodeQuatOct: typeof decodeQuatOct;
    static encodeOct24(v: TslNode): TslNode;
    static decodeOct24(code: TslNode): TslNode;
    static encodeQuatOct32(q: TslNode): TslNode;
    static decodeQuatOct32(code: TslNode): TslNode;
    static encodeQuatOct24(q: TslNode): TslNode;
    static decodeQuatOct24(code: TslNode): TslNode;
}
export {};
