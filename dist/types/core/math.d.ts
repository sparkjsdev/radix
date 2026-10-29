export interface Vec3 {
    x: number;
    y: number;
    z: number;
}
export interface Quat {
    x: number;
    y: number;
    z: number;
    w: number;
}
export interface Rgb {
    r: number;
    g: number;
    b: number;
}
export interface Cov {
    xx: number;
    yy: number;
    zz: number;
    xy: number;
    xz: number;
    yz: number;
}
export declare class SplatMath {
    static normalizeQuat(q: Quat, out: Quat): Quat;
    static covFromScaleQuat(scales: Vec3, q: Quat, out: Cov): Cov;
    static symEigens(c: Cov): {
        values: Vec3;
        basis: number[];
    };
    static basisToQuat(m: number[], out: Quat): Quat;
}
