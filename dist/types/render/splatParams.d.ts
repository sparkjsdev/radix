export interface SplatViewParams {
    maxStdDev: number;
    minAlpha: number;
    falloff: number;
}
export interface SplatObjectParams {
    lodInflate: boolean;
    blurAmount: number;
    preBlurAmount: number;
    clipXY: number;
    minPixelRadius: number;
    maxPixelRadius: number;
    minContribution: number;
    focalDistance: number;
    apertureTan: number;
    sortGuard: number;
    maxShDegree: number;
}
declare const nodes: {
    minAlpha: any;
    maxStdDev: any;
    falloff: any;
    lodInflate: any;
    blurAmount: any;
    preBlurAmount: any;
    clipXY: any;
    minPixelRadius: any;
    maxPixelRadius: any;
    minContribution: any;
    focalDistance: any;
    apertureTan: any;
    sortGuard: any;
    maxShDegree: any;
};
export type SplatParamNodes = typeof nodes;
export declare class SplatParams {
    static readonly VIEW: Readonly<SplatViewParams>;
    static readonly OBJECT: Readonly<SplatObjectParams>;
    static readonly nodes: {
        minAlpha: any;
        maxStdDev: any;
        falloff: any;
        lodInflate: any;
        blurAmount: any;
        preBlurAmount: any;
        clipXY: any;
        minPixelRadius: any;
        maxPixelRadius: any;
        minContribution: any;
        focalDistance: any;
        apertureTan: any;
        sortGuard: any;
        maxShDegree: any;
    };
    static setView(params: SplatViewParams): void;
    static setObject(params: SplatObjectParams, overrides?: Partial<SplatObjectParams>): void;
}
export {};
