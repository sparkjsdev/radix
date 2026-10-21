// Ray picking against splats on the CPU, as Radix has no splat raycast
import { Splats, type ArrayData, type ExtSplat } from "@sparkjsdev/radix";

const SIGMAS = 3;

interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

interface Approach {
  t: number;
  alpha: number;
  index: number;
}

export class SplatPicker {
  decode: (i: number, out: ExtSplat) => ExtSplat;
  coverage: number;
  count: number;
  // Per splat: the center and a bounding radius (-1: skipped)
  centers: Float32Array;
  radii: Float32Array;
  splat: ExtSplat;

  constructor(data: ArrayData, { minOpacity = 0.02, coverage = 0.5 } = {}) {
    const { bundle } = Splats.get(data);
    this.decode = Splats.decoder(bundle);
    this.coverage = coverage;
    this.count = data.count;
    this.centers = new Float32Array(this.count * 3);
    this.radii = new Float32Array(this.count);
    const s = Splats.makeExtSplat();
    for (let i = 0; i < this.count; i += 1) {
      this.decode(i, s);
      this.centers[i * 3] = s.center.x;
      this.centers[i * 3 + 1] = s.center.y;
      this.centers[i * 3 + 2] = s.center.z;
      this.radii[i] = s.opacity < minOpacity ? -1 : SIGMAS * Math.max(s.scales.x, s.scales.y, s.scales.z);
    }
    this.splat = s;
  }

  // Where the opacity met along origin + t dir first reaches coverage, so
  // many faint splats stop the ray like one opaque one; dir need not be unit
  intersect(origin: Vec3Like, dir: Vec3Like, near = 0, far = Infinity): { t: number; index: number } | undefined {
    const { centers, radii, splat: s } = this;
    const dd = dir.x * dir.x + dir.y * dir.y + dir.z * dir.z;
    const length = Math.sqrt(dd);
    const hits: Approach[] = [];
    for (let i = 0; i < this.count; i += 1) {
      const r = radii[i];
      if (r < 0) {
        continue;
      }
      // Bounding sphere first
      const ox = centers[i * 3] - origin.x;
      const oy = centers[i * 3 + 1] - origin.y;
      const oz = centers[i * 3 + 2] - origin.z;
      const along = (ox * dir.x + oy * dir.y + oz * dir.z) / dd;
      const px = ox - along * dir.x;
      const py = oy - along * dir.y;
      const pz = oz - along * dir.z;
      if (px * px + py * py + pz * pz > r * r || along + r / length < near || along - r / length > far) {
        continue;
      }
      const hit = this.closest(i, s, origin, dir);
      if (hit && hit.t >= near && hit.t <= far) {
        hits.push(hit);
      }
    }
    if (hits.length === 0) {
      return undefined;
    }
    hits.sort((a, b) => a.t - b.t);
    let transmittance = 1;
    let best = hits[0];
    for (const hit of hits) {
      transmittance *= 1 - hit.alpha;
      if (hit.alpha > best.alpha) {
        best = hit;
      }
      if (1 - transmittance >= this.coverage) {
        return { t: hit.t, index: hit.index };
      }
    }
    // A thin cloud: its most opaque point
    return { t: best.t, index: best.index };
  }

  // The ray's closest approach to splat i in its Gaussian's metric, from the
  // picker's center, so edited centers move the splat
  closest(i: number, s: ExtSplat, origin: Vec3Like, dir: Vec3Like): Approach | undefined {
    this.decode(i, s);
    const { centers } = this;
    const { x: qx, y: qy, z: qz, w: qw } = s.quaternion;
    const sx = Math.max(s.scales.x, 1e-9);
    const sy = Math.max(s.scales.y, 1e-9);
    const sz = Math.max(s.scales.z, 1e-9);
    // Into the splat's frame: rotate by the conjugate, divide by the scales
    const p = rotateConjugate(origin.x - centers[i * 3], origin.y - centers[i * 3 + 1], origin.z - centers[i * 3 + 2], qx, qy, qz, qw);
    const v = rotateConjugate(dir.x, dir.y, dir.z, qx, qy, qz, qw);
    const [px, py, pz] = [p[0] / sx, p[1] / sy, p[2] / sz];
    const [vx, vy, vz] = [v[0] / sx, v[1] / sy, v[2] / sz];
    const vv = vx * vx + vy * vy + vz * vz;
    const t = -(px * vx + py * vy + pz * vz) / vv;
    const [cx, cy, cz] = [px + t * vx, py + t * vy, pz + t * vz];
    const m2 = cx * cx + cy * cy + cz * cz;
    if (m2 > SIGMAS * SIGMAS) {
      return undefined;
    }
    return { t, alpha: Math.min(0.99, s.opacity * Math.exp(-0.5 * m2)), index: i };
  }
}

// v rotated by the conjugate of the unit quaternion q
function rotateConjugate(vx: number, vy: number, vz: number, qx: number, qy: number, qz: number, qw: number) {
  const [x, y, z] = [-qx, -qy, -qz];
  // t = 2 cross(q.xyz, v); v + w t + cross(q.xyz, t)
  const tx = 2 * (y * vz - z * vy);
  const ty = 2 * (z * vx - x * vz);
  const tz = 2 * (x * vy - y * vx);
  return [vx + qw * tx + (y * tz - z * ty), vy + qw * ty + (z * tx - x * tz), vz + qw * tz + (x * ty - y * tx)];
}
