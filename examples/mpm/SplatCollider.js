// A static splat scan as an MPM collider: its splats are baked on the GPU
// into a dense narrow-band distance field in the scan's object space, and
// the simulation kernels sample it through the scan's current transform, so
// the scan can be moved, rotated and (uniformly) scaled without re-baking.
//
// The bake (WgpuCompute kernels, one dispatch each):
//   1. splats: every splat with opacity >= minOpacity adds its coverage,
//      opacity * 2 pi * s_mid * s_max / voxel^2 (its alpha integrated over
//      its plane: a fully covered surface through a voxel reads ~1), to the
//      voxels under its 3-sigma box, weighted by the Gaussian at the voxel
//      centres (fixed-point atomicAdd, as in the MPM P2G);
//   2. init: covered voxels (coverage >= threshold) get distance 0, the rest
//      `band`;
//   3. dilate: `band` chamfer passes (3x3x3 min of neighbour + 1, sqrt 2,
//      sqrt 3), ping-ponging between two buffers;
//   4. finalize: a 3x3x3 box blur (smooths the voxel staircase so the
//      gradient makes usable normals) minus the shell half-thickness, so
//      every surface becomes a slab about 2 * shell voxels thick.
// Distances are unsigned (scans have no reliable inside), in voxels.
//
// sample() evaluates, at a world point: phi (world units, < 0 inside a
// slab), the world normal (gradient of the trilinear field; zero on a
// slab's centre line) and the collider velocity from the pose change over
// the last step (capped like the MPM walls).
import * as THREE from "three";
                                                   
import {
  GpuExtSplatReader, GpuSplatMath, Splats, TSL, WgpuBuffer, WgpuCompute,                                              
} from "@sparkjsdev/radix";

const {
  If, Loop, atomicAdd, atomicLoad, clamp, dot, exp, float, floor, int, ivec3, length, max, min, mix, normalize, select,
  sqrt, uniform, vec3, vec4,
} = TSL;

const quatVec = GpuSplatMath.quatRotate;

// Fixed-point scale of the coverage sums (i32 atomics): one count is 1e-4 of
// a fully covered voxel
const COVERAGE_SCALE = 1e4;
// A splat deposits into at most (2 * FOOTPRINT + 1)^3 voxels around its centre
const FOOTPRINT = 2;
// Voxel budget of a bake; the voxel size is coarsened to fit
const MAX_VOXELS = 16 * 1024 * 1024;
// Splat centres sampled for the robust bounds, and the tails cut per axis
const BOUNDS_SAMPLES = 100_000;
const BOUNDS_TAIL = 0.005;
// phi outside the baked box (world units): no collision
const FAR = 1e6;
// Cap on the collider velocity the simulation sees (m/s), so a scan dragged
// far while paused does not fire the water across the box on the next step
const MAX_COLLIDER_SPEED = 4.0;

                                        
                                                           
                     
                                                
                    
                                                         
                
               
 

                                    
                      
                    
             
 

export class SplatCollider {
  renderer                ;
  // The object whose matrixWorld places the field, and the ext splats baked
  // (of a LoD tree, its leaves: interior nodes merge their children and
  // would count twice)
  target                ;
  splats           ;
  // Object-space box the field covers before the band margin: the splat
  // centres with outliers cut
  robustBounds            ;
  settings                        = { minOpacity: 0.05, threshold: 0.5, shell: 1.0, band: 4 };
  lastBake                    ;

  uniforms   
                                                                                        
                                                                            
                                                                           
                                                                        
                                                                        
                                                                                                                
                                                   
                     
   ;

  // Per-voxel coverage (fixed point), and the distance ping-pong pair; the
  // final field is `sdf` (distB)
  coverage                      ;
  distA                       ;
  distB                       ;

          reader = new GpuExtSplatReader();
          splatKernel             ;
          initKernel             ;
          dilateAB             ;
          dilateBA             ;
          finalizeKernel             ;
          prevMatrix = new THREE.Matrix4();
          hasPrev = false;

  // `data`: the splats on the CPU (for the bounds), `splats` the same on the
  // GPU, with an extSplats bundle
  constructor({ renderer, target, data, splats }                                                                                          ) {
    this.renderer = renderer;
    this.target = target;
    this.splats = splats;
    this.robustBounds = robustSplatBounds(data);
    this.uniforms = {
      bakeMin: uniform(new THREE.Vector3()),
      voxelSize: uniform(1, "float"),
      dims: uniform(new THREE.Vector3()),
      numVoxels: uniform(0, "uint"),
      minOpacity: uniform(this.settings.minOpacity, "float"),
      threshold: uniform(this.settings.threshold, "float"),
      shell: uniform(this.settings.shell, "float"),
      band: uniform(this.settings.band, "float"),
      invMatrix: uniform(new THREE.Matrix4()),
      normalMatrix: uniform(new THREE.Matrix3()),
      worldScale: uniform(1, "float"),
      prevFromCurrent: uniform(new THREE.Matrix4()),
      stepTime: uniform(1, "float"),
      enabled: uniform(1, "float"),
    };
    this.coverage = new WgpuBuffer({ renderer, format: "sint32", count: 1, atomic: true });
    this.distA = new WgpuBuffer({ renderer, format: "float32", count: 1 });
    this.distB = new WgpuBuffer({ renderer, format: "float32", count: 1 });
    this.splatKernel = this.makeSplatKernel();
    this.initKernel = this.makeInitKernel();
    this.dilateAB = this.makeDilate(this.distA, this.distB);
    this.dilateBA = this.makeDilate(this.distB, this.distA);
    this.finalizeKernel = this.makeFinalize();
  }

  get sdf() {
    return this.distB;
  }

  // Flat index of voxel (i, j, k)
          voxelIndex(voxel         )          {
    const dims = ivec3(this.uniforms.dims);
    return voxel.x.mul(dims.y).add(voxel.y).mul(dims.z).add(voxel.z);
  }

  // Voxel (i, j, k) of a flat index
          voxelOf(index         )          {
    const dims = ivec3(this.uniforms.dims);
    const flat = int(index);
    return ivec3(flat.div(dims.y.mul(dims.z)), flat.div(dims.z).mod(dims.y), flat.mod(dims.z));
  }

          makeSplatKernel() {
    const { reader, coverage } = this;
    const u = this.uniforms;
    return new WgpuCompute({
      label: "colliderSplats",
      body: ({ index }) => {
        const splat = reader.loadSplat(index).toVar();
        If(index.lessThan(reader.count).and(splat.get("opacity").greaterThanEqual(u.minOpacity)), () => {
          const s = max(splat.get("scales"), vec3(1e-9)).toVar();
          const q = splat.get("quaternion").toVar();
          const sMin = min(s.x, min(s.y, s.z));
          const area = s.x.mul(s.y).mul(s.z).div(sMin).mul(2 * Math.PI);
          const amount = splat.get("opacity").mul(area).div(u.voxelSize.mul(u.voxelSize)).mul(COVERAGE_SCALE).toVar();
          // 3-sigma half-extent of the rotated ellipsoid per axis, in voxels
          const ax = quatVec(q, vec3(s.x, 0.0, 0.0));
          const ay = quatVec(q, vec3(0.0, s.y, 0.0));
          const az = quatVec(q, vec3(0.0, 0.0, s.z));
          const extent = sqrt(ax.mul(ax).add(ay.mul(ay)).add(az.mul(az))).mul(3.0).div(u.voxelSize).toVar();
          // Voxel coordinates: voxel v spans [v, v + 1)
          const g = splat.get("center").sub(u.bakeMin).div(u.voxelSize).toVar();
          const dims = ivec3(u.dims).toVar();
          const cell = ivec3(floor(g)).toVar();
          const inside = cell.x.greaterThanEqual(int(0)).and(cell.y.greaterThanEqual(int(0))).and(cell.z.greaterThanEqual(int(0)))
            .and(cell.x.lessThan(dims.x)).and(cell.y.lessThan(dims.y)).and(cell.z.lessThan(dims.z));
          If(inside, () => {
            const lo = max(ivec3(floor(g.sub(extent))), max(cell.sub(ivec3(FOOTPRINT)), ivec3(0))).toVar();
            const hi = min(ivec3(floor(g.add(extent))), min(cell.add(ivec3(FOOTPRINT)), dims.sub(ivec3(1)))).toVar();
            const single = lo.x.equal(hi.x).and(lo.y.equal(hi.y)).and(lo.z.equal(hi.z));
            If(single, () => {
              atomicAdd(coverage.element(this.voxelIndex(cell)), int(amount.add(0.5)));
            }).Else(() => {
              // Gaussian weight at a voxel centre: the offset in the splat's
              // frame, in standard deviations
              const qInv = vec4(q.xyz.negate(), q.w).toVar();
              const weight = (voxel         ) => {
                const d = quatVec(qInv, vec3(voxel).add(0.5).sub(g).mul(u.voxelSize)).div(s);
                return exp(dot(d, d).mul(-0.5));
              };
              const total = float(0.0).toVar();
              loop3(lo, hi, (voxel) => { total.addAssign(weight(voxel)); });
              If(total.greaterThan(1e-6), () => {
                const scale = amount.div(total).toVar();
                loop3(lo, hi, (voxel) => {
                  atomicAdd(coverage.element(this.voxelIndex(voxel)), int(weight(voxel).mul(scale).add(0.5)));
                });
              }).Else(() => {
                atomicAdd(coverage.element(this.voxelIndex(cell)), int(amount.add(0.5)));
              });
            });
          });
        });
      },
    });
  }

          makeInitKernel() {
    const { coverage, distA } = this;
    const u = this.uniforms;
    return new WgpuCompute({
      label: "colliderInit",
      body: ({ index }) => {
        If(index.lessThan(u.numVoxels), () => {
          const covered = float(atomicLoad(coverage.element(index))).greaterThanEqual(u.threshold.mul(COVERAGE_SCALE));
          distA.element(index).assign(select(covered, float(0.0), u.band));
        });
      },
    });
  }

  // One chamfer pass: min over the 26 neighbours of their distance plus the
  // step length. Neighbours are clamped to the grid; a clamped neighbour is
  // the voxel itself or nearer than the step, so it never lowers a distance.
          makeDilate(src                       , dst                       ) {
    const u = this.uniforms;
    return new WgpuCompute({
      label: "colliderDilate",
      body: ({ index }) => {
        If(index.lessThan(u.numVoxels), () => {
          const voxel = this.voxelOf(index).toVar();
          const top = ivec3(u.dims).sub(ivec3(1)).toVar();
          const d = src.element(index).toVar();
          forNeighbours((offset, length) => {
            if (length > 0) {
              const n = clamp(voxel.add(ivec3(...offset)), ivec3(0), top);
              d.assign(min(d, src.element(this.voxelIndex(n)).add(length)));
            }
          });
          dst.element(index).assign(d);
        });
      },
    });
  }

  // distA -> sdf: 3x3x3 box blur minus the shell half-thickness
          makeFinalize() {
    const { distA, distB } = this;
    const u = this.uniforms;
    return new WgpuCompute({
      label: "colliderFinalize",
      body: ({ index }) => {
        If(index.lessThan(u.numVoxels), () => {
          const voxel = this.voxelOf(index).toVar();
          const top = ivec3(u.dims).sub(ivec3(1)).toVar();
          const sum = float(0.0).toVar();
          forNeighbours((offset) => {
            sum.addAssign(distA.element(this.voxelIndex(clamp(voxel.add(ivec3(...offset)), ivec3(0), top))));
          });
          distB.element(index).assign(sum.div(27.0).sub(u.shell));
        });
      },
    });
  }

  // Bake the splats with voxels of `voxelSize` (object units), coarsened if
  // the robust bounds would need more than MAX_VOXELS
  async bake(voxelSize        )                             {
    const { renderer, settings } = this;
    const u = this.uniforms;
    const start = performance.now();
    const band = Math.max(1, Math.round(settings.band));
    const size = this.robustBounds.getSize(new THREE.Vector3());
    const margin = band + Math.ceil(settings.shell) + 1;
    const dimsFor = (voxel        ) => size.clone().divideScalar(voxel).ceil().addScalar(2 * margin).max(new THREE.Vector3(2, 2, 2));
    let voxel = voxelSize;
    let dims = dimsFor(voxel);
    while (dims.x * dims.y * dims.z > MAX_VOXELS) {
      voxel *= Math.cbrt((dims.x * dims.y * dims.z) / MAX_VOXELS) * 1.01;
      dims = dimsFor(voxel);
    }
    if (voxel !== voxelSize) {
      console.warn(`SplatCollider: voxel size ${voxelSize.toFixed(4)} needs too many voxels, using ${voxel.toFixed(4)}`);
    }
    const numVoxels = dims.x * dims.y * dims.z;
    for (const buffer of [this.coverage, this.distA, this.distB]) {
      buffer.setCapacity(numVoxels);
    }
    (u.bakeMin.value                 ).copy(this.robustBounds.min).subScalar(margin * voxel);
    u.voxelSize.value = voxel;
    (u.dims.value                 ).copy(dims);
    u.numVoxels.value = numVoxels;
    u.minOpacity.value = settings.minOpacity;
    u.threshold.value = settings.threshold;
    u.shell.value = settings.shell;
    u.band.value = band;
    this.reader.bind(this.splats);

    // clearBuffer submits on the same queue, so it is ordered before the dispatches
    this.coverage.clear();
    this.splatKernel.dispatch(renderer, this.splats.count);
    this.initKernel.dispatch(renderer, numVoxels);
    // Whole A -> B -> A pairs, so the band ends up in distA for the finalize
    for (let pass = 0; pass < band; pass += 2) {
      this.dilateAB.dispatch(renderer, numVoxels);
      this.dilateBA.dispatch(renderer, numVoxels);
    }
    this.finalizeKernel.dispatch(renderer, numVoxels);
    await this.sdf.read(0, 1);
    this.lastBake = { dims, voxelSize: voxel, ms: performance.now() - start };
    return this.lastBake;
  }

  // Pick up the target's pose for the next step of `stepTime` seconds: the
  // world-to-object transform, and the previous pose for the velocity
  update(stepTime        ) {
    const u = this.uniforms;
    this.target.updateWorldMatrix(true, false);
    const matrix = this.target.matrixWorld;
    if (!this.hasPrev) {
      this.prevMatrix.copy(matrix);
      this.hasPrev = true;
    }
    const inverse = (u.invMatrix.value                 ).copy(matrix).invert();
    (u.prevFromCurrent.value                 ).multiplyMatrices(this.prevMatrix, inverse);
    (u.normalMatrix.value                 ).getNormalMatrix(matrix);
    u.worldScale.value = matrix.getMaxScaleOnAxis();
    u.stepTime.value = stepTime;
    this.prevMatrix.copy(matrix);
  }

  // The field at world point `world` (TSL vec3): phi in world units (FAR
  // outside the baked box or when disabled), the world normal (zero where
  // the gradient vanishes) and the collider velocity in world units/s
  sample(world         )                                                       {
    const { sdf } = this;
    const u = this.uniforms;
    const phi = float(FAR).toVar();
    const normal = vec3(0.0).toVar();
    const velocity = vec3(0.0).toVar();
    // Voxel coordinates with voxel centres at integers
    const g = u.invMatrix.mul(vec4(world, 1.0)).xyz.sub(u.bakeMin).div(u.voxelSize).sub(0.5).toVar();
    const top = u.dims.sub(1.0);
    const inside = g.x.greaterThanEqual(0.0).and(g.y.greaterThanEqual(0.0)).and(g.z.greaterThanEqual(0.0))
      .and(g.x.lessThanEqual(top.x)).and(g.y.lessThanEqual(top.y)).and(g.z.lessThanEqual(top.z));
    If(u.enabled.greaterThan(0.5).and(inside), () => {
      const base = min(ivec3(floor(g)), ivec3(u.dims).sub(ivec3(2))).toVar();
      const f = g.sub(vec3(base)).toVar();
      const load = (dx        , dy        , dz        ) => sdf.element(this.voxelIndex(base.add(ivec3(dx, dy, dz)))).toVar();
      const c000 = load(0, 0, 0);
      const c100 = load(1, 0, 0);
      const c010 = load(0, 1, 0);
      const c110 = load(1, 1, 0);
      const c001 = load(0, 0, 1);
      const c101 = load(1, 0, 1);
      const c011 = load(0, 1, 1);
      const c111 = load(1, 1, 1);
      const x00 = mix(c000, c100, f.x).toVar();
      const x10 = mix(c010, c110, f.x).toVar();
      const x01 = mix(c001, c101, f.x).toVar();
      const x11 = mix(c011, c111, f.x).toVar();
      const y0 = mix(x00, x10, f.y).toVar();
      const y1 = mix(x01, x11, f.y).toVar();
      // Analytic gradient of the trilinear interpolant (per voxel)
      const grad = vec3(
        mix(mix(c100.sub(c000), c110.sub(c010), f.y), mix(c101.sub(c001), c111.sub(c011), f.y), f.z),
        mix(x10.sub(x00), x11.sub(x01), f.z),
        y1.sub(y0),
      ).toVar();
      phi.assign(mix(y0, y1, f.z).mul(u.voxelSize).mul(u.worldScale));
      If(length(grad).greaterThan(1e-3), () => {
        normal.assign(normalize(u.normalMatrix.mul(grad)));
      });
      const v = world.sub(u.prevFromCurrent.mul(vec4(world, 1.0)).xyz).div(u.stepTime).toVar();
      velocity.assign(v.mul(min(1.0, float(MAX_COLLIDER_SPEED).div(max(length(v), 1e-6)))));
    });
    return { phi, normal, velocity };
  }

  // The splat arrays are the page's (it draws them too)
  dispose() {
    for (const buffer of [this.coverage, this.distA, this.distB]) {
      buffer.dispose();
    }
  }
}

// Inclusive 3D loop over voxels lo..hi (ivec3 nodes)
function loop3(lo         , hi         , body                          ) {
  Loop(
    { start: lo.x, end: hi.x, type: "int", condition: "<=", name: "vx" },
    { start: lo.y, end: hi.y, type: "int", condition: "<=", name: "vy" },
    { start: lo.z, end: hi.z, type: "int", condition: "<=", name: "vz" },
    ({ vx, vy, vz }                                           ) => { body(ivec3(vx, vy, vz)); },
  );
}

// The 27 offsets of a 3x3x3 neighbourhood with their lengths, unrolled at build time
function forNeighbours(body                                                            ) {
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dz = -1; dz <= 1; dz++) {
        body([dx, dy, dz], Math.hypot(dx, dy, dz));
      }
    }
  }
}

// Object-space bounds of the splat centres with `tail` cut from both ends
// of each axis (scans have far floaters), from a strided sample
export function robustSplatBounds(data           , tail = BOUNDS_TAIL) {
  const { bundle } = Splats.get(data);
  const center = { x: 0, y: 0, z: 0 };
  const stride = Math.max(1, Math.floor(data.count / BOUNDS_SAMPLES));
  const samples = Math.ceil(data.count / stride);
  const axes = [new Float32Array(samples), new Float32Array(samples), new Float32Array(samples)];
  for (let n = 0; n < samples; n++) {
    Splats.loadCenter(bundle, n * stride, center);
    axes[0][n] = center.x;
    axes[1][n] = center.y;
    axes[2][n] = center.z;
  }
  const lo = new THREE.Vector3();
  const hi = new THREE.Vector3();
  axes.forEach((values, axis) => {
    values.sort();
    const cut = Math.floor(tail * (samples - 1));
    lo.setComponent(axis, values[cut]);
    hi.setComponent(axis, values[samples - 1 - cut]);
  });
  return new THREE.Box3(lo, hi);
}


//# sourceURL=examples/mpm/SplatCollider.ts