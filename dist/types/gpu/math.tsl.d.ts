import { type TslNode } from "./tsl";
export declare class GpuSplatMath {
    static readonly quatRotate: (q: TslNode, v: TslNode) => TslNode;
    static readonly quatMul: (q1: TslNode, q2: TslNode) => TslNode;
    static quatConj(q: TslNode): TslNode;
    static mat3FromMat4(m: TslNode): TslNode;
    static readonly scaleQuatMatrix: (scales: TslNode, quat: TslNode) => TslNode;
    static covFromScaleQuat(scales: TslNode, quat: TslNode): TslNode;
    static covMatrix(xxyyzz: TslNode, xyxzyz: TslNode): TslNode;
    static readonly symEigens: (xxyyzz: TslNode, xyxzyz: TslNode) => TslNode;
    static readonly basisToQuat: (basis: TslNode) => TslNode;
}
