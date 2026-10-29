export interface TexelSpan {
    x: number;
    y: number;
    layer: number;
    width: number;
    rows: number;
    offset: number;
}
export interface CopySpan {
    src: {
        x: number;
        y: number;
        layer: number;
    };
    dst: {
        x: number;
        y: number;
        layer: number;
    };
    width: number;
    rows: number;
}
export declare class TextureLayout {
    static readonly WIDTH = 1024;
    static readonly MAX_PACKING = 4;
    static readonly ROW_ELEMENTS: number;
    static readonly MAX_HEIGHT = 4096;
    static readonly MAX_LAYERS = 512;
    readonly width: number;
    readonly height: number;
    readonly layers: number;
    readonly xBits: number;
    readonly yBits: number;
    readonly texels: number;
    private constructor();
    static for(texels: number): TextureLayout;
    static alignCapacity(count: number): number;
    spans(start: number, count: number): TexelSpan[];
    static copySpans(src: TextureLayout, srcStart: number, dst: TextureLayout, dstStart: number, count: number): CopySpan[];
}
