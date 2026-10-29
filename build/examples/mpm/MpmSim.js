// 3D MLS-MPM water in TSL compute kernels (WebGPU backend only), and the
// SplatGenerator that draws every particle as a splat straight from the
// particle buffers (waterSplats).
//
// The algorithm is Yuanming Hu's mpm88 (Taichi) taken to 3D, in the units
// of nialltl's MPM guide: positions in grid cells (dx = 1, cell (i, j, k)
// spans [i, i + 1)), time in seconds, so velocities are cells/s. Each
// substep is:
//   1. (the grid is clear: the previous grid update zeroed it);
//   2. P2G: every particle scatters weight * (mass * v + affine * dpos) and
//      weight * mass to its 3x3x3 quadratic B-spline neighbourhood, where
//      affine = stress * I + mass * C fuses the MLS-MPM force with the APIC
//      momentum (stress = -dt * 4 * E * vol * (J - 1) is the weakly
//      compressible fluid of mpm88). The scatter is atomicAdd on fixed-point
//      i32 cells, as in WebGPU-Ocean, since WGSL has no float atomics;
//   3. grid update: read and zero the atomic sums, momentum / mass, gravity, slip walls (mpm88's `bound`,
//      generalized to walls at any position with a velocity: a wall node's
//      normal velocity is clamped to the wall's, so a wall moving in pushes);
//   4. G2P: every particle gathers its new velocity and affine matrix C from
//      the grid, advects, and integrates J *= 1 + dt * trace(C); particles
//      left outside a wall (it moved past them) get a velocity floor toward
//      the inside.
// The walls (`walls`, a world-space box) can be moved at any time; step()
// glides the kernel walls there at up to MAX_WALL_SPEED. The grid extends BOUND cells beyond the initial walls, so
// walls can move inward from where they started, not outward. An optional
// SplatCollider (a baked splat mesh) adds level-set boundaries: grid nodes
// inside it lose their velocity into it relative to the collider's (Coulomb
// friction on the tangential part), and particles inside it are pushed out
// along its normal like the walls push them in. The particle
// state (position + J, velocity, the rows of C) never leaves the GPU: the
// splat shader reads it directly.
import * as THREE from "three";
                                                   
import { GpuSplats, TSL, WgpuBuffer, WgpuCompute, WgpuComputeBatch,                                   } from "@sparkjsdev/radix";
import { MpmParticleSort } from "./ParticleSort.js";
                                                        

const {
  If, Loop, atomicAdd, atomicLoad, atomicMax, atomicMin, atomicStore, clamp, dot, float, floor, hash, int, ivec3, length, max,
  min, mix, saturate, select, uint, uniform, vec3, vec4, workgroupArray, workgroupBarrier,
} = TSL;

// mpm88 constants in grid units: a particle is an eighth of a cell of unit
// density, so a cell filled with 8 particles has mass 1
const VOL = 0.125;
const RHO = 1.0;
const MASS = VOL * RHO;
// Grid padding in cells outside the initial walls: the wall band the grid
// velocities are clamped in, and where particles are kept so the stencil
// never leaves the grid
const BOUND = 3;
// Particles outside a wall are given at least penetration / PUSH_TIME of
// inward velocity (seconds): how fast a wall moved past them sweeps them in
const PUSH_TIME = 0.1;
// Top speed of the walls (m/s): a wall moved far (or while paused) glides to
// its new place at this speed instead of jumping and crushing the water
const MAX_WALL_SPEED = 4.0;
// Safety limits against blow-ups: node and particle speeds are capped at
// MAX_CFL cells per substep, and the pressure sees J (volume ratio) clamped
// to [J_MIN, J_MAX], so a hard compression cannot feed back into ever
// larger pressure. J itself only stays in [J_SAFE_MIN, J_SAFE_MAX] so it
// keeps tracking the volume (clamping it lost the compression for good).
const MAX_CFL = 0.3;
const J_MIN = 0.6;
const J_MAX = 1.2;
const J_SAFE_MIN = 0.1;
const J_SAFE_MAX = 10.0;
// Fixed-point scales of the atomic grid (i32 sums must stay below 2^31).
// Mass: one count is 1e-7 of a particle (as in WebGPU-Ocean); a cell holds
// at most a few dozen particles, so ~1e8 counts. Truncation makes a node's
// mass a little too small, and a coarse mass scale made the low-weight
// nodes at free surfaces up to twice too fast (momentum / mass), pumping
// energy into the fluid. Momentum: one count is 1e-5 mass * cells/s, so a
// cell of mass ~2 overflows at ~10,000 cells/s; truncation here only slows
// nodes down.
const MASS_SCALE = 1e7 / MASS;
const MOMENTUM_SCALE = 1e5;
// Tiled P2G: threads per workgroup, and grid nodes in its workgroup-memory
// tile (4 i32 each: 12 KB of the 16 KB WebGPU default). Morton-sorted
// chunks of 256 particles at ~8 per cell span about 7x7x5 to 11x7x7 nodes.
const TILE_WORKGROUP = 256;
const TILE_NODES = 768;

                                
                           
                                                                   
                     
                                                                             
               
                    
                                                
             
                   
                                                             
            
                  
                                                                            
                           
 

export class MpmSim {
  renderer                ;
  // The initial walls (world), and the current walls: move these freely
  // within `bounds`, step() applies them
  bounds            ;
  walls            ;
  // World position of grid cell (0, 0, 0), grid dimensions in cells, and
  // the world size of a cell
  gridMin               ;
  res               ;
  cellSize        ;
  numCells        ;
  count        ;
  substeps        ;
  collider                ;

  uniforms   
                                                              
                                                     
                                                                                 
                                                             
                      
                                                                          
                                    
                         
   ;
  // Walls (cells) the previous step() applied, for the wall velocity
          prevWallMin = new THREE.Vector3();
          prevWallMax = new THREE.Vector3();

  // Particle state: xyz position in cells + J, xyz velocity + the particle's
  // id (constant through the sort), rows of C
  pos                         ;
  vel                         ;
  c0                         ;
  c1                         ;
  c2                         ;
  // Grid: fixed-point (momentum xyz, mass) per cell for the P2G scatter, and
  // the float (velocity xyz, mass) the grid update writes for G2P
  gridAtomic                      ;
  gridVel                         ;

          p2g             ;
          p2gTiled             ;
  // P2G through a workgroup-memory tile (false: straight global atomics)
  tiledP2G = true;
          gridUpdate             ;
          g2p             ;
          batch                  ;
  // One compute pass per step() (false: one per dispatch, for GPU timings)
  batched = true;
  // Re-sort the particles by cell every this many steps, and on reset() (0:
  // never, the particles stay in reset()'s random order)
  sortEvery = 10;
          sorter                 ;
          steps = 0;

  constructor({ renderer, bounds, grid, particles, dt, substeps, E, gravity, collider }               ) {
    this.renderer = renderer;
    this.collider = collider;
    this.bounds = bounds.clone();
    this.walls = bounds.clone();
    const size = bounds.getSize(new THREE.Vector3());
    this.cellSize = Math.max(size.x, size.y, size.z) / grid;
    // Whole cells inside the walls, plus the padding on both sides
    const inner = new THREE.Vector3(
      Math.max(1, Math.round(size.x / this.cellSize)),
      Math.max(1, Math.round(size.y / this.cellSize)),
      Math.max(1, Math.round(size.z / this.cellSize)),
    );
    this.res = inner.clone().addScalar(2 * BOUND);
    this.gridMin = bounds.min.clone().subScalar(BOUND * this.cellSize);
    this.numCells = this.res.x * this.res.y * this.res.z;
    this.count = particles;
    this.substeps = substeps;
    this.uniforms = {
      dt: uniform(dt, "float"),
      E: uniform(E, "float"),
      // m/s^2 to cells/s^2
      gravity: uniform(gravity / this.cellSize, "float"),
      count: uniform(particles, "uint"),
      wallMin: uniform(this.toCells(this.walls.min, new THREE.Vector3())),
      wallMax: uniform(this.toCells(this.walls.max, new THREE.Vector3())),
      wallMinVel: uniform(new THREE.Vector3()),
      wallMaxVel: uniform(new THREE.Vector3()),
      friction: uniform(0.5, "float"),
      densityRate: uniform(0.1, "float"),
    };
    this.prevWallMin.copy(this.uniforms.wallMin.value);
    this.prevWallMax.copy(this.uniforms.wallMax.value);

    const vec4s = (count        ) => new WgpuBuffer({ renderer, format: "float32x4", count });
    this.pos = vec4s(particles);
    this.vel = vec4s(particles);
    this.c0 = vec4s(particles);
    this.c1 = vec4s(particles);
    this.c2 = vec4s(particles);
    this.gridAtomic = new WgpuBuffer({ renderer, format: "sint32", count: this.numCells * 4, atomic: true });
    this.gridVel = vec4s(this.numCells);

    this.p2g = this.makeP2G();
    this.p2gTiled = this.makeP2GTiled();
    this.gridUpdate = this.makeGridUpdate();
    this.g2p = this.makeG2P();
    this.batch = new WgpuComputeBatch(renderer);
    this.sorter = new MpmParticleSort(this);
    this.reset();
  }

  // Gravity in m/s^2 (stored in cells/s^2)
  set gravity(value        ) {
    this.uniforms.gravity.value = value / this.cellSize;
  }

  get gravity() {
    return this.uniforms.gravity.value * this.cellSize;
  }

  // World point to grid cells
  toCells(world               , out               ) {
    return out.copy(world).sub(this.gridMin).divideScalar(this.cellSize);
  }

  // Move the kernel walls toward `walls` (clamped to the padded grid and at
  // least a cell apart) by at most MAX_WALL_SPEED over this step's `time`
  // (seconds); the velocities are exactly that motion, so the grid pushes
  // the water as far as the walls really moved
          applyWalls(time        ) {
    const u = this.uniforms;
    const limit = this.res.clone().subScalar(BOUND);
    const targetMin = this.toCells(this.walls.min, new THREE.Vector3())
      .clamp(new THREE.Vector3(BOUND, BOUND, BOUND), limit.clone().subScalar(1));
    const targetMax = this.toCells(this.walls.max, new THREE.Vector3()).clamp(targetMin.clone().addScalar(1), limit);
    const maxStep = (MAX_WALL_SPEED / this.cellSize) * time;
    const glide = (target               , previous               , out               ) => {
      out.copy(target).sub(previous).clampLength(0, maxStep).add(previous);
    };
    const min = u.wallMin.value                 ;
    const max = u.wallMax.value                 ;
    glide(targetMin, this.prevWallMin, min);
    glide(targetMax, this.prevWallMax, max);
    max.max(min.clone().addScalar(1));
    (u.wallMinVel.value                 ).copy(min).sub(this.prevWallMin).divideScalar(time);
    (u.wallMaxVel.value                 ).copy(max).sub(this.prevWallMax).divideScalar(time);
    this.prevWallMin.copy(min);
    this.prevWallMax.copy(max);
  }

  // Resize the particle buffers (the kernels read the count from a uniform,
  // so they are not rebuilt); the particles are garbage until reset()
  setCount(count        ) {
    if (count === this.count) {
      return;
    }
    this.count = count;
    this.uniforms.count.value = count;
    for (const buffer of [this.pos, this.vel, this.c0, this.c1, this.c2]) {
      buffer.setCapacity(count);
    }
  }

  // Flat index of cell (i, j, k)
          cellIndex(cell         )          {
    const { res } = this;
    return cell.x.mul(int(res.y)).add(cell.y).mul(int(res.z)).add(cell.z);
  }

  // Quadratic B-spline stencil of a position in cells (mpm88): base is the
  // corner cell, fx in [0.5, 1.5) the offset to it, and the weights of the
  // 3 cells per axis are w[0..2]. The 27 cells are unrolled at build time
  // like mpm88's ti.static loop; body gets each cell's index (ivec3), weight
  // and dpos = cell - position.
          stencil(Xp         , body                                                         ) {
    const base = ivec3(floor(Xp.sub(0.5))).toVar();
    const fx = Xp.sub(vec3(base)).toVar();
    const a = float(1.5).sub(fx);
    const b = fx.sub(1.0);
    const c = fx.sub(0.5);
    const w = [a.mul(a).mul(0.5).toVar(), float(0.75).sub(b.mul(b)).toVar(), c.mul(c).mul(0.5).toVar()];
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        for (let k = 0; k < 3; k++) {
          const weight = w[i].x.mul(w[j].y).mul(w[k].z).toVar();
          const dpos = vec3(i, j, k).sub(fx).toVar();
          const cell = base.add(ivec3(i, j, k)).toVar();
          body(cell, weight, dpos);
        }
      }
    }
  }

  // One particle's P2G contributions: for each of its 27 stencil cells, the
  // fixed-point (momentum xyz, mass) sums, handed to `deposit`
          scatterParticle(index         , deposit                                          ) {
    const { pos, vel, c0, c1, c2 } = this;
    const u = this.uniforms;
    const p = pos.element(index).toVar();
    const v = vel.element(index).xyz.toVar();
    const C0 = c0.element(index).xyz.toVar();
    const C1 = c1.element(index).xyz.toVar();
    const C2 = c2.element(index).xyz.toVar();
    // Weakly compressible fluid, fused with dt and the MLS-MPM
    // M_p^-1 = 4 / dx^2 factor (mpm88's `stress`)
    const stress = u.dt.mul(-4 * VOL).mul(u.E).mul(clamp(p.w, J_MIN, J_MAX).sub(1.0)).toVar();
    this.stencil(p.xyz, (cell, weight, dpos) => {
      // affine * dpos with affine = stress * I + mass * C
      const Cd = vec3(dot(C0, dpos), dot(C1, dpos), dot(C2, dpos));
      const momentum = weight.mul(v.add(Cd).mul(MASS).add(dpos.mul(stress))).toVar();
      deposit(cell, [
        int(momentum.x.mul(MOMENTUM_SCALE)),
        int(momentum.y.mul(MOMENTUM_SCALE)),
        int(momentum.z.mul(MOMENTUM_SCALE)),
        int(weight.mul(MASS * MASS_SCALE)),
      ]);
    });
  }

  // Global atomicAdd of a cell's fixed-point sums
          depositGlobal(cell         , sums           ) {
    const slot = this.cellIndex(cell).mul(4).toVar();
    sums.forEach((value, c) => {
      atomicAdd(this.gridAtomic.element(slot.add(c)), value);
    });
  }

          makeP2G() {
    const u = this.uniforms;
    return new WgpuCompute({
      label: "mpmP2G",
      body: ({ index }) => {
        If(index.lessThan(u.count), () => {
          this.scatterParticle(index, (cell, sums) => this.depositGlobal(cell, sums));
        });
      },
    });
  }

  // P2G through workgroup memory: a workgroup's particles (neighbours after
  // the sort) first accumulate into a tile covering their stencils' bounding
  // box with workgroup atomics, then the tile is added to the global grid
  // with one atomic per non-zero node component. Integer sums are
  // order-independent, so the grid is bit-identical to the direct kernel's.
  // When the box does not fit TILE_NODES (unsorted or scattered particles),
  // the workgroup scatters straight to the global grid instead. Barriers are
  // outside any branch (all threads reach them, including those past the
  // particle count): WGSL requires uniform control flow for barriers and TSL
  // has no workgroupUniformLoad to make the tile decision uniform.
          makeP2GTiled() {
    const { pos } = this;
    const u = this.uniforms;
    const tile = workgroupArray("int", TILE_NODES * 4).toAtomic();
    // min xyz, max xyz of the particles' stencil base cells
    const boundsArray = workgroupArray("int", 6).toAtomic();
    // (workgroup arrays want node indices)
    const bounds = { element: (i        ) => boundsArray.element(uint(i)) };
    const BIG = 1 << 30;
    return new WgpuCompute({
      label: "mpmP2GTiled",
      workgroupSize: [TILE_WORKGROUP],
      body: ({ index, localId }) => {
        const lid = localId.x;
        Loop({ start: lid, end: uint(TILE_NODES * 4), type: "uint", condition: "<", update: TILE_WORKGROUP }, ({ i }                ) => {
          atomicStore(tile.element(i), int(0));
        });
        If(lid.equal(uint(0)), () => {
          for (let a = 0; a < 3; a++) {
            atomicStore(bounds.element(a), int(BIG));
            atomicStore(bounds.element(a + 3), int(-BIG));
          }
        });
        workgroupBarrier();

        const valid = index.lessThan(u.count).toVar();
        If(valid, () => {
          const base = ivec3(floor(pos.element(index).xyz.sub(0.5))).toVar();
          (["x", "y", "z"]         ).forEach((axis, a) => {
            atomicMin(bounds.element(a), base[axis]);
            atomicMax(bounds.element(a + 3), base[axis]);
          });
        });
        workgroupBarrier();

        const lo = ivec3(atomicLoad(bounds.element(0)), atomicLoad(bounds.element(1)), atomicLoad(bounds.element(2))).toVar();
        const hi = ivec3(atomicLoad(bounds.element(3)), atomicLoad(bounds.element(4)), atomicLoad(bounds.element(5))).toVar();
        // Stencil nodes span base .. base + 2 on each axis
        const dims = hi.sub(lo).add(ivec3(3)).toVar();
        const nodes = dims.x.mul(dims.y).mul(dims.z).toVar();
        const fits = hi.x.greaterThanEqual(lo.x).and(nodes.lessThanEqual(int(TILE_NODES))).toVar();
        If(valid, () => {
          If(fits, () => {
            this.scatterParticle(index, (cell, sums) => {
              const local = cell.sub(lo);
              const slot = local.x.mul(dims.y).add(local.y).mul(dims.z).add(local.z).mul(4).toVar();
              sums.forEach((value, c) => {
                atomicAdd(tile.element(slot.add(c)), value);
              });
            });
          }).Else(() => {
            this.scatterParticle(index, (cell, sums) => this.depositGlobal(cell, sums));
          });
        });
        workgroupBarrier();

        If(fits, () => {
          Loop({ start: lid, end: uint(nodes), type: "uint", condition: "<", update: TILE_WORKGROUP }, ({ i }                ) => {
            const k = int(i);
            const cell = lo.add(ivec3(k.div(dims.y.mul(dims.z)), k.div(dims.z).mod(dims.y), k.mod(dims.z))).toVar();
            const slot = this.cellIndex(cell).mul(4).toVar();
            for (let c = 0; c < 4; c++) {
              const value = atomicLoad(tile.element(i.mul(uint(4)).add(uint(c)))).toVar();
              If(value.notEqual(int(0)), () => {
                atomicAdd(this.gridAtomic.element(slot.add(c)), value);
              });
            }
          });
        });
      },
    });
  }

  // A velocity (cells/s) scaled down to at most MAX_CFL cells per substep
          capSpeed(v         )          {
    const limit = float(MAX_CFL).div(this.uniforms.dt);
    return v.mul(min(1.0, limit.div(max(length(v), 1e-6))));
  }

  // Grid position (cells, TSL vec3) to world
          toWorld(cells         )          {
    const { gridMin, cellSize } = this;
    return vec3(gridMin.x, gridMin.y, gridMin.z).add(cells.mul(cellSize));
  }

          makeGridUpdate() {
    const { gridAtomic, gridVel, numCells, res, collider, cellSize } = this;
    const u = this.uniforms;
    return new WgpuCompute({
      label: "mpmGrid",
      body: ({ index }) => {
        If(index.lessThan(uint(numCells)), () => {
          const slot = index.mul(uint(4)).toVar();
          // Read the node and zero it for the next substep's P2G (this is
          // the only reader, so no separate clear pass is needed)
          const sums = [0, 1, 2, 3].map((offset) => float(atomicLoad(gridAtomic.element(slot.add(uint(offset))))).toVar());
          for (let offset = 0; offset < 4; offset++) {
            atomicStore(gridAtomic.element(slot.add(uint(offset))), int(0));
          }
          const mass = sums[3].div(MASS_SCALE).toVar();
          const out = vec4(0.0).toVar();
          If(mass.greaterThan(0.0), () => {
            const v = vec3(sums[0], sums[1], sums[2]).div(MOMENTUM_SCALE).div(mass).toVar();
            v.y.subAssign(u.dt.mul(u.gravity));
            v.assign(this.capSpeed(v));
            // Slip walls: a node beyond a wall moves into the wall no faster
            // than the wall itself (a still wall: no velocity into it)
            const i = int(index).div(int(res.y * res.z));
            const j = int(index).div(int(res.z)).mod(int(res.y));
            const k = int(index).mod(int(res.z));
            const node = vec3(float(i), float(j), float(k)).toVar();
            for (const axis of ["x", "y", "z"]         ) {
              If(node[axis].lessThan(u.wallMin[axis]), () => { v[axis].assign(max(v[axis], u.wallMinVel[axis])); });
              If(node[axis].greaterThan(u.wallMax[axis]), () => { v[axis].assign(min(v[axis], u.wallMaxVel[axis])); });
            }
            if (collider) {
              // Level-set boundary: a node inside the collider keeps no
              // velocity into it (relative to the collider's) and its
              // tangential velocity loses friction * |normal velocity|; on a
              // slab's centre line (no normal) it moves with the collider
              const hit = collider.sample(this.toWorld(node));
              If(hit.phi.lessThan(0.0), () => {
                const vco = hit.velocity.div(cellSize).toVar();
                const vrel = v.sub(vco).toVar();
                const vn = dot(vrel, hit.normal).toVar();
                If(dot(hit.normal, hit.normal).lessThan(0.5), () => {
                  v.assign(vco);
                }).ElseIf(vn.lessThan(0.0), () => {
                  const vt = vrel.sub(hit.normal.mul(vn)).toVar();
                  const keep = max(0.0, float(1.0).add(u.friction.mul(vn).div(max(length(vt), 1e-6))));
                  v.assign(vco.add(vt.mul(keep)));
                });
              });
            }
            out.assign(vec4(v, mass));
          });
          gridVel.element(index).assign(out);
        });
      },
    });
  }

          makeG2P() {
    const { pos, vel, c0, c1, c2, gridVel, res, collider, cellSize } = this;
    const u = this.uniforms;
    return new WgpuCompute({
      label: "mpmG2P",
      body: ({ index }) => {
        If(index.lessThan(u.count), () => {
          const p = pos.element(index).toVar();
          const id = vel.element(index).w.toVar();
          const newV = vec3(0.0).toVar();
          const C0 = vec3(0.0).toVar();
          const C1 = vec3(0.0).toVar();
          const C2 = vec3(0.0).toVar();
          // Grid mass at the particle (B-spline weighted): its actual density
          const density = float(0.0).toVar();
          this.stencil(p.xyz, (cell, weight, dpos) => {
            const node = gridVel.element(this.cellIndex(cell)).toVar();
            const gv = node.xyz.mul(weight).toVar();
            density.addAssign(node.w.mul(weight));
            newV.addAssign(gv);
            // C += 4 * weight * outer(gv, dpos) / dx^2, row by row
            C0.addAssign(dpos.mul(gv.x.mul(4.0)));
            C1.addAssign(dpos.mul(gv.y.mul(4.0)));
            C2.addAssign(dpos.mul(gv.z.mul(4.0)));
          });
          // A particle outside a wall (the wall moved past it) is swept back
          // in: at least penetration / PUSH_TIME of velocity toward the inside
          for (const axis of ["x", "y", "z"]         ) {
            const under = u.wallMin[axis].sub(p[axis]);
            const over = p[axis].sub(u.wallMax[axis]);
            If(under.greaterThan(0.0), () => { newV[axis].assign(max(newV[axis], under.div(PUSH_TIME))); });
            If(over.greaterThan(0.0), () => { newV[axis].assign(min(newV[axis], over.div(-PUSH_TIME))); });
          }
          if (collider) {
            // Likewise out of the collider: at least penetration / PUSH_TIME
            // along its normal, relative to its velocity
            const hit = collider.sample(this.toWorld(p.xyz));
            If(hit.phi.lessThan(0.0), () => {
              const vco = hit.velocity.div(cellSize);
              const push = hit.phi.div(-cellSize * PUSH_TIME).sub(dot(newV.sub(vco), hit.normal));
              newV.addAssign(hit.normal.mul(max(push, 0.0)));
            });
          }
          newV.assign(this.capSpeed(newV));
          const x = p.xyz.add(newV.mul(u.dt));
          // Keep the stencil inside the grid whatever the walls let through
          // (nialltl's clamp). The walls are soft: a particle only stops
          // fully once all its stencil nodes are wall nodes (within 1.5
          // cells of the edge), so the clamp must sit inside that band, not
          // at the wall, or particles pile up on it and J collapses.
          const clamped = clamp(x, vec3(1.0), vec3(res.x - 2.0, res.y - 2.0, res.z - 2.0));
          const Jint = p.w.mul(float(1.0).add(u.dt.mul(C0.x.add(C1.y).add(C2.z)))).toVar();
          // Density correction: J integrated from the velocity divergence
          // misses particles packing below the grid resolution (after hard
          // compressions they pile up at 10-60x density with J ~ 1), so pull
          // J toward rest density / grid density when the particles are
          // denser than J says (never the other way: free-surface nodes are
          // partly empty, which would read as tension)
          const Jdensity = float(RHO).div(max(density, 1e-3));
          const Jfixed = min(Jint, mix(Jint, Jdensity, u.densityRate));
          const J = clamp(Jfixed, J_SAFE_MIN, J_SAFE_MAX);
          pos.element(index).assign(vec4(clamped, J));
          vel.element(index).assign(vec4(newV, id));
          c0.element(index).assign(vec4(C0, 0.0));
          c1.element(index).assign(vec4(C1, 0.0));
          c2.element(index).assign(vec4(C2, 0.0));
        });
      },
    });
  }

  // Advance by substeps * dt seconds, with the walls where `walls` says.
  // All substeps go into one compute pass (`batched`), or one pass per
  // kernel dispatch when not (for per-kernel GPU timings)
  step() {
    this.steps += 1;
    if (this.sortEvery > 0 && this.steps % this.sortEvery === 0) {
      this.sorter.sort();
    }
    const time = this.substeps * this.uniforms.dt.value;
    this.applyWalls(time);
    this.collider?.update(time);
    for (let s = 0; s < this.substeps; s++) {
      this.batch.add(this.tiledP2G ? this.p2gTiled : this.p2g, this.count)
        .add(this.gridUpdate, this.numCells)
        .add(this.g2p, this.count);
    }
    this.batch.submit({ split: !this.batched });
  }

  // Refill the particles at 8 per cell, randomly placed: by default a ball
  // of water at the centre of the current walls (its radius follows from
  // the particle count, capped to fit the walls), or with `drop` a slab
  // spanning the walls in x/z with its base `drop` cells above the floor
  // (0: on the floor; its thickness follows from the particle count)
  reset(drop         ) {
    const { count } = this;
    const min = this.toCells(this.walls.min, new THREE.Vector3());
    const inner = this.toCells(this.walls.max, new THREE.Vector3()).sub(min);
    const data = new Float32Array(count * 4);
    if (drop === undefined) {
      const center = inner.clone().multiplyScalar(0.5).add(min);
      const fit = Math.max(1, 0.5 * Math.min(inner.x, inner.y, inner.z) - 1);
      const radius = Math.min(Math.cbrt((3 * count) / (8 * 4 * Math.PI)), fit);
      const p = new THREE.Vector3();
      for (let i = 0; i < count; i++) {
        do {
          p.set(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1);
        } while (p.lengthSq() > 1);
        p.multiplyScalar(radius).add(center);
        data.set([p.x, p.y, p.z, 1.0], i * 4);
      }
    } else {
      const height = Math.min(inner.y, count / (8 * inner.x * inner.z));
      const by = Math.max(0, Math.min(inner.y - drop, height));
      for (let i = 0; i < count; i++) {
        data[i * 4 + 0] = min.x + Math.random() * inner.x;
        data[i * 4 + 1] = min.y + drop + Math.random() * by;
        data[i * 4 + 2] = min.z + Math.random() * inner.z;
        data[i * 4 + 3] = 1.0; // J
      }
    }
    this.pos.upload(data);
    // At rest, with the particle's id in vel.w (it survives the sort)
    const velocities = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      velocities[i * 4 + 3] = i;
    }
    this.vel.upload(velocities);
    for (const buffer of [this.c0, this.c1, this.c2]) {
      buffer.clear();
    }
    // The positions are random: bring them into cell order at once
    if (this.sortEvery > 0) {
      this.sorter?.sort();
    }
  }

  dispose() {
    this.sorter.dispose();
    for (const buffer of [this.pos, this.vel, this.c0, this.c1, this.c2, this.gridAtomic, this.gridVel]) {
      buffer.dispose();
    }
  }
}

export const COLOR_MODES = ["speed", "pressure", "both"]         ;

// Draws the particles of a MpmSim as isotropic splats in world space: the
// generator reads the simulation's position / velocity buffers directly, so
// nothing is copied, and it follows setCount (the buffers keep their TSL
// nodes when they grow; the page makes a new collection with the new
// count). `radius` is the splat standard deviation in metres; every
// particle's brightness is scaled by a fixed factor in [1 - variation, 1]
// hashed from its id, so the particles stay distinguishable when the water
// moves as a block.
//
// Colour (`colorMode`, an index into COLOR_MODES):
//   speed: blue at rest to white at `speedRange` m/s;
//   pressure: light blue at zero to deep blue at `pressureRange`, with
//     pressure E (1 - J) shown as metres of water head (the depth of still
//     water with that pressure at 9.8 m/s^2), so the scale does not change
//     with E; tension (J > 1) stays light blue;
//   both: the pressure blue, whitened by speed.
export function waterSplats(sim        ) {
  const uniforms = {
    radius: uniform(sim.cellSize * 0.4, "float"),
    opacity: uniform(1.0, "float"),
    variation: uniform(0.2, "float"),
    colorMode: uniform(COLOR_MODES.indexOf("both"), "float"),
    speedRange: uniform(3.0, "float"),
    pressureRange: uniform(0.5, "float"),
  };

  const generator                 = {
    generateSplat: (index) => {
      const { gridMin, cellSize } = sim;
      const state = sim.pos.element(index).toVar();
      const velocity = sim.vel.element(index).toVar();
      const speed = length(velocity.xyz).mul(cellSize);
      const center = vec3(gridMin.x, gridMin.y, gridMin.z).add(state.xyz.mul(cellSize));
      // E (cells^2/s^2) * (1 - J) over g in cells/s^2, times the cell size: metres of head
      const head = sim.uniforms.E.mul(float(1.0).sub(state.w)).mul((cellSize * cellSize) / 9.8);
      const pressureRgb = mix(vec3(0.15, 0.5, 1.0), vec3(0.02, 0.1, 0.45), saturate(head.div(uniforms.pressureRange)));
      const whiten = saturate(speed.div(uniforms.speedRange));
      const white = vec3(0.8, 0.9, 1.0);
      const rgb = select(
        uniforms.colorMode.lessThan(0.5),
        mix(vec3(0.05, 0.3, 0.8), white, whiten),
        select(uniforms.colorMode.lessThan(1.5), pressureRgb, mix(pressureRgb, white, whiten)),
      );
      // Hashed from the particle's id (vel.w), not its slot: the sort moves particles
      const brightness = float(1.0).sub(uniforms.variation.mul(hash(uint(velocity.w))));
      return GpuSplats.Splat(center, vec3(uniforms.radius), vec4(0, 0, 0, 1), saturate(rgb.mul(brightness)), uniforms.opacity, uint(index));
    },
  };

  return { generator, uniforms };
}


//# sourceURL=examples/mpm/MpmSim.ts