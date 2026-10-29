// Ray picking against splats on the CPU, from the loaded ArrayData (Radix
// has no splat raycast; Spark's SplatMesh.raycast does this). Each splat
// near the ray adds its Gaussian's opacity where the ray passes closest to
// it; the hit is where the accumulated opacity first reaches `coverage`, so
// many faint splats (grass, hair) stop the ray like one opaque one.
import { Splats,                               } from "@sparkjsdev/radix";

const SIGMAS = 3;

                    
            
            
            
 

                    
            
                
                
 

export class SplatPicker {
  decode                                        ;
  coverage        ;
  count        ;
  // Per splat: the center and a bounding radius (-1: skipped)
  centers              ;
  radii              ;
  splat          ;

  constructor(data           , { minOpacity = 0.02, coverage = 0.5 } = {}) {
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

  // The hit of the ray origin + t dir (object space; dir need not be unit)
  // as { t, index }, or undefined
  intersect(origin          , dir          , near = 0, far = Infinity)                                           {
    const { centers, radii, splat: s } = this;
    const dd = dir.x * dir.x + dir.y * dir.y + dir.z * dir.z;
    const length = Math.sqrt(dd);
    const hits             = [];
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

  // Where the ray passes closest to splat i, in its Gaussian's metric, and
  // the opacity it meets there: { t, alpha, index }, or undefined. The
  // center is the picker's (edited centers move the splat)
  closest(i        , s          , origin          , dir          )                       {
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
function rotateConjugate(vx        , vy        , vz        , qx        , qy        , qz        , qw        ) {
  const [x, y, z] = [-qx, -qy, -qz];
  // t = 2 cross(q.xyz, v); v + w t + cross(q.xyz, t)
  const tx = 2 * (y * vz - z * vy);
  const ty = 2 * (z * vx - x * vz);
  const tz = 2 * (x * vy - y * vx);
  return [vx + qw * tx + (y * tz - z * ty), vy + qw * ty + (z * tx - x * tz), vz + qw * tz + (x * ty - y * tx)];
}


//# sourceURL=examples/spark/js/raycast.ts