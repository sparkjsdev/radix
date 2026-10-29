import * as TSLStrict from "three/tsl";
export type TslNode = any;
export declare const TSL: Record<keyof typeof TSLStrict, TslNode>;
export declare function texelCoord(texel: TslNode, yBits: TslNode, yMask: TslNode): {
    x: any;
    y: any;
    layer: any;
};
