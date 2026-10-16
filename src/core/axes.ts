// Coordinate systems of splat data, as nianticlabs/spz numbers them (SPZ 4's
// coordinate-system record): three letters for where +x, +y and +z point,
// Right / Left, Up / Down, Back / Front, in any order. Converting from one
// to another is one signed permutation M, a rotation perhaps with a mirror:
// centers and normals p' = M p, rotations R' = M R M^T (the quaternion's
// vector part times det(M) M) with the scales permuted alike, covariances
// M S M^T, and the SH of band l
// by a (2l + 1)^2 matrix fitted once from the basis (least squares of
// c' . Y(d) = c . Y(M^T d) over spread directions d, exact as the band is
// closed under M). Flips, quarter turns and mirrors take the same path.
import type { ArrayData } from "./ArrayData";
import type { Cov, Quat, Vec3 } from "./math";
import { counter, type Progress } from "./progress";
import { Sh, type ShDegree, type ShPalette } from "./sh";
import { Splats, type ExtSplat, type Splat } from "./splats";

export type CoordinateSystem = "LDB" | "RDB" | "LUB" | "RUB" | "LDF" | "RDF" | "LUF" | "RUF"
  | "LFD" | "RFD" | "LFU" | "RFU" | "LBD" | "RBD" | "LBU" | "RBU";

// Index + 1 = SPZ's code
const SYSTEMS: readonly CoordinateSystem[] = [
  "LDB", "RDB", "LUB", "RUB", "LDF", "RDF", "LUF", "RUF",
  "LFD", "RFD", "LFU", "RFU", "LBD", "RBD", "LBU", "RBU",
];

const DIRECTIONS: Record<string, readonly number[]> = {
  R: [1, 0, 0], L: [-1, 0, 0], U: [0, 1, 0], D: [0, -1, 0], B: [0, 0, 1], F: [0, 0, -1],
};

// Where the system's x, y and z point, in RUB
function axesOf(system: CoordinateSystem): (readonly number[])[] {
  if (!SYSTEMS.includes(system)) {
    throw new Error(`Unknown coordinate system ${String(system)}`);
  }
  return [...system].map((letter) => DIRECTIONS[letter]);
}

export interface AxesConverter {
  // 3x3 row-major, from -> to
  readonly matrix: number[];
  readonly identity: boolean;
  // In place, returning the argument
  vec(v: Vec3): Vec3;
  // M R M^T: the splat's own axes turn with the scene, so its scales move
  // with them (`scales`)
  quat(q: Quat): Quat;
  // Scales along the splat's axes, permuted as M permutes them
  scales(s: Vec3): Vec3;
  cov(c: Cov): Cov;
  // Center, quaternion, scales, and normal when the splat has one
  splat<S extends Splat | ExtSplat>(s: S): S;
  // Bands 1 to `degree` of coefficient-major RGB values
  sh(coeffs: Float32Array, degree: ShDegree): Float32Array;
}

// Spread unit directions (a golden-angle spiral) for fitting band matrices
const FIT = Array.from({ length: 32 }, (_, k) => {
  const z = 1 - (2 * k + 1) / 32;
  const r = Math.sqrt(1 - z * z);
  const phi = k * 2.399963229728653 + 0.5;
  return { x: r * Math.cos(phi), y: r * Math.sin(phi), z };
});

// The band-l matrix T (row-major) with c' = T c for SH seen through M
function bandMatrix(m: number[], l: number): Float64Array {
  const size = 2 * l + 1;
  const start = Sh.COEFFICIENTS[l - 1];
  const normal = new Float64Array(size * size);
  const right = new Float64Array(size * size);
  const a = new Float64Array(Sh.COEFFICIENTS[Sh.MAX_DEGREE]);
  const b = new Float64Array(Sh.COEFFICIENTS[Sh.MAX_DEGREE]);
  for (const d of FIT) {
    Sh.basis(d, a);
    Sh.basis({
      x: m[0] * d.x + m[3] * d.y + m[6] * d.z,
      y: m[1] * d.x + m[4] * d.y + m[7] * d.z,
      z: m[2] * d.x + m[5] * d.y + m[8] * d.z,
    }, b);
    for (let i = 0; i < size; i += 1) {
      for (let j = 0; j < size; j += 1) {
        normal[i * size + j] += a[start + i] * a[start + j];
        right[i * size + j] += a[start + i] * b[start + j];
      }
    }
  }
  // Gauss-Jordan with partial pivoting: normal T = right
  for (let col = 0; col < size; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < size; row += 1) {
      if (Math.abs(normal[row * size + col]) > Math.abs(normal[pivot * size + col])) {
        pivot = row;
      }
    }
    for (let j = 0; j < size; j += 1) {
      [normal[col * size + j], normal[pivot * size + j]] = [normal[pivot * size + j], normal[col * size + j]];
      [right[col * size + j], right[pivot * size + j]] = [right[pivot * size + j], right[col * size + j]];
    }
    const inv = 1 / normal[col * size + col];
    for (let row = 0; row < size; row += 1) {
      if (row !== col) {
        const f = normal[row * size + col] * inv;
        for (let j = 0; j < size; j += 1) {
          normal[row * size + j] -= f * normal[col * size + j];
          right[row * size + j] -= f * right[col * size + j];
        }
      }
    }
  }
  for (let row = 0; row < size; row += 1) {
    const inv = 1 / normal[row * size + row];
    for (let j = 0; j < size; j += 1) {
      right[row * size + j] *= inv;
    }
  }
  // Near-integers made exact, so flips copy values bit for bit
  return right.map((v) => (Math.abs(v - Math.round(v)) < 1e-9 ? Math.round(v) : v));
}

class Converter implements AxesConverter {
  readonly matrix: number[];
  readonly identity: boolean;
  private readonly det: number;
  private readonly bands: Float64Array[] = [];
  private readonly scratch = new Float64Array(9);

  constructor(matrix: number[]) {
    this.matrix = matrix;
    this.identity = matrix.every((v, i) => v === (i % 4 === 0 ? 1 : 0));
    const [a, b, c, d, e, f, g, h, i] = matrix;
    this.det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  }

  vec(v: Vec3): Vec3 {
    const m = this.matrix;
    const { x, y, z } = v;
    v.x = m[0] * x + m[1] * y + m[2] * z;
    v.y = m[3] * x + m[4] * y + m[5] * z;
    v.z = m[6] * x + m[7] * y + m[8] * z;
    return v;
  }

  quat(q: Quat): Quat {
    const m = this.matrix;
    const d = this.det;
    const { x, y, z } = q;
    q.x = d * (m[0] * x + m[1] * y + m[2] * z);
    q.y = d * (m[3] * x + m[4] * y + m[5] * z);
    q.z = d * (m[6] * x + m[7] * y + m[8] * z);
    return q;
  }

  scales(s: Vec3): Vec3 {
    const m = this.matrix;
    const { x, y, z } = s;
    s.x = Math.abs(m[0]) * x + Math.abs(m[1]) * y + Math.abs(m[2]) * z;
    s.y = Math.abs(m[3]) * x + Math.abs(m[4]) * y + Math.abs(m[5]) * z;
    s.z = Math.abs(m[6]) * x + Math.abs(m[7]) * y + Math.abs(m[8]) * z;
    return s;
  }

  cov(c: Cov): Cov {
    const m = this.matrix;
    const s = [c.xx, c.xy, c.xz, c.xy, c.yy, c.yz, c.xz, c.yz, c.zz];
    // (M S) M^T
    const ms = this.scratch;
    for (let i = 0; i < 3; i += 1) {
      for (let j = 0; j < 3; j += 1) {
        ms[i * 3 + j] = m[i * 3] * s[j] + m[i * 3 + 1] * s[3 + j] + m[i * 3 + 2] * s[6 + j];
      }
    }
    const at = (i: number, j: number) => ms[i * 3] * m[j * 3] + ms[i * 3 + 1] * m[j * 3 + 1] + ms[i * 3 + 2] * m[j * 3 + 2];
    c.xx = at(0, 0);
    c.yy = at(1, 1);
    c.zz = at(2, 2);
    c.xy = at(0, 1);
    c.xz = at(0, 2);
    c.yz = at(1, 2);
    return c;
  }

  splat<S extends Splat | ExtSplat>(s: S): S {
    this.vec(s.center);
    this.quat(s.quaternion);
    this.scales(s.scales);
    if ("normal" in s) {
      this.vec(s.normal);
    }
    return s;
  }

  sh(coeffs: Float32Array, degree: ShDegree): Float32Array {
    if (this.identity) {
      return coeffs;
    }
    const tmp = this.scratch;
    for (let l = 1; l <= degree; l += 1) {
      const t = (this.bands[l] ??= bandMatrix(this.matrix, l));
      const size = 2 * l + 1;
      const start = Sh.COEFFICIENTS[l - 1];
      for (let c = 0; c < 3; c += 1) {
        for (let i = 0; i < size; i += 1) {
          let sum = 0;
          for (let j = 0; j < size; j += 1) {
            sum += t[i * size + j] * coeffs[(start + j) * 3 + c];
          }
          tmp[i] = sum;
        }
        for (let i = 0; i < size; i += 1) {
          coeffs[(start + i) * 3 + c] = tmp[i];
        }
      }
    }
    return coeffs;
  }
}

export class Axes {
  static readonly SYSTEMS = SYSTEMS;

  // 3x3 row-major: coordinates in `from` to coordinates in `to`
  static matrix(from: CoordinateSystem, to: CoordinateSystem): number[] {
    const a = axesOf(from);
    const b = axesOf(to);
    const m: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      for (let j = 0; j < 3; j += 1) {
        m.push(b[i][0] * a[j][0] + b[i][1] * a[j][1] + b[i][2] * a[j][2]);
      }
    }
    return m;
  }

  static converter(from: CoordinateSystem, to: CoordinateSystem): AxesConverter {
    return new Converter(Axes.matrix(from, to));
  }

  // A splat table in place: its splat bundle (any layout; cov through its
  // covariance), its per-splat SH, and `shPalette`'s entries when given;
  // sets meta.coordinateSystem to `to`. Other bundles are left as they are.
  static convert(data: ArrayData, to: CoordinateSystem, {
    from = data.meta.coordinateSystem as CoordinateSystem | undefined, shPalette, progress,
  }: { from?: CoordinateSystem; shPalette?: ShPalette; progress?: Progress } = {}): ArrayData {
    if (!from) {
      throw new Error("Axes.convert: the data's coordinate system is unknown (pass `from`)");
    }
    const c = Axes.converter(from, to);
    if (!c.identity) {
      const { bundle } = Splats.get(data);
      const found = Sh.find(data.bundles);
      const decodeSh = found && Sh.decoder(data, found);
      const encodeSh = found && Sh.encoder(data, found);
      const coeffs = new Float32Array(Sh.VALUES);
      const tick = counter(progress, data.count, "encoding");
      if (Splats.isCov(bundle)) {
        const s = Splats.makeCovSplat();
        for (let i = 0; i < data.count; i += 1) {
          tick(i);
          Splats.decodeCov(bundle, i, s);
          c.vec(s.center);
          c.cov(s.cov);
          c.vec(s.normal);
          Splats.encodeCov(bundle, i, s);
        }
      } else {
        const decode = Splats.decoder(bundle);
        const encode = Splats.encoder(bundle);
        const s = Splats.makeExtSplat();
        for (let i = 0; i < data.count; i += 1) {
          tick(i);
          encode(i, c.splat(decode(i, s)));
        }
      }
      if (found) {
        for (let i = 0; i < data.count; i += 1) {
          encodeSh!(i, c.sh(decodeSh!(i, coeffs), found.degree));
        }
      }
      if (shPalette) {
        for (let n = 0; n < shPalette.size; n += 1) {
          shPalette.set(n, c.sh(shPalette.get(n, coeffs), shPalette.degree));
        }
      }
    }
    data.meta.coordinateSystem = to;
    return data;
  }
}
