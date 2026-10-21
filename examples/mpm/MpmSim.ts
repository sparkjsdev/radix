/*!
 * This file is a translation of mpm88.py from Taichi
 * (https://github.com/taichi-dev/taichi), which carries this notice:
 *
 *   MPM-MLS in 88 lines of Taichi code, originally created by @yuanming-hu
 *
 * mpm88.py is licensed under the Apache License, Version 2.0. A copy of the
 * License is in LICENSE-Apache-2.0.txt beside this file and at
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * This file changes it: it is taken from 2D to 3D, written as TSL compute
 * kernels in the units of nialltl's MPM guide, with moving walls and a
 * collider added.
 */
/*!
 * The position clamp follows incremental_mpm (https://github.com/nialltl/incremental_mpm):
 *
 * MIT License
 *
 * Copyright (c) 2019 niall tl
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
/*!
 * The fixed-point grid sums follow WebGPU-Ocean (https://github.com/matsuoka-601/WebGPU-Ocean):
 *
 * MIT License
 *
 * Copyright (c) 2025 matsuoka-601
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import * as THREE from "three";
import type { WebGPURenderer } from "three/webgpu";
import { GpuSplats, TSL, WgpuBuffer, WgpuCompute, WgpuComputeBatch, type SplatGenerator, type TslNode } from "@sparkjsdev/radix";
import { MpmParticleSort } from "./ParticleSort.js";
import type { SplatCollider } from "./SplatCollider.js";

const {
  If, Loop, atomicAdd, atomicLoad, atomicMax, atomicMin, atomicStore, clamp, dot, float, floor, hash, int, ivec3, length, max,
  min, mix, saturate, select, uint, uniform, vec3, vec4, workgroupArray, workgroupBarrier,
} = TSL;

// A particle is an eighth of a cell at unit density, as in mpm88
const VOL = 0.125;
const RHO = 1.0;
const MASS = VOL * RHO;
// Padding cells outside the initial walls, for the wall nodes and the stencils past them
const BOUND = 3;
// Seconds: a particle past a wall or inside the collider gets at least
// penetration / PUSH_TIME of outward velocity
const PUSH_TIME = 0.1;
// m/s, so a wall moved far glides instead of jumping and crushing the water
const MAX_WALL_SPEED = 4.0;
// Caps against blow-ups: speed in cells per substep, and the J (volume ratio)
// the pressure sees. J itself has a wider range so it keeps tracking the volume.
const MAX_CFL = 0.3;
const J_MIN = 0.6;
const J_MAX = 1.2;
const J_SAFE_MIN = 0.1;
const J_SAFE_MAX = 10.0;
// Fixed point, as in WebGPU-Ocean, since WGSL has no float atomics. Mass is
// fine-grained, as truncating it speeds up the light nodes at free surfaces.
// Truncating momentum only slows nodes, and a cell of mass 2 overflows i32
// near 10,000 cells/s.
const MASS_SCALE = 1e7 / MASS;
const MOMENTUM_SCALE = 1e5;
// Tiled P2G: 4 i32 per node take 12 KB of WebGPU's default 16 KB of workgroup
// memory, which usually holds the nodes of 256 Morton-sorted particles
const TILE_WORKGROUP = 256;
const TILE_NODES = 768;

export interface MpmSimOptions {
  renderer: WebGPURenderer;
  // World-space box the walls start at
  bounds: THREE.Box3;
  // Cells along the box's longest axis, without the padding
  grid: number;
  particles: number;
  // Seconds per substep and substeps per step()
  dt: number;
  substeps: number;
  // Stiffness (bulk modulus, grid units) and gravity (m/s^2)
  E: number;
  gravity: number;
  collider?: SplatCollider;
}

export class MpmSim {
  renderer: WebGPURenderer;
  // World space; walls can move freely within bounds, and step() applies them
  bounds: THREE.Box3;
  walls: THREE.Box3;
  // World corner of cell (0, 0, 0), grid size in cells, and a cell's world size
  gridMin: THREE.Vector3;
  res: THREE.Vector3;
  cellSize: number;
  numCells: number;
  count: number;
  substeps: number;
  collider?: SplatCollider;

  uniforms: {
    dt: TslNode; E: TslNode; gravity: TslNode; count: TslNode;
    // Walls in cells and their velocities in cells/s
    wallMin: TslNode; wallMax: TslNode; wallMinVel: TslNode; wallMaxVel: TslNode;
    // Coulomb friction coefficient of the collider (0: slip)
    friction: TslNode;
    // Fraction per substep by which G2P pulls J toward the grid density's (0: off)
    densityRate: TslNode;
  };
  // Walls (cells) the previous step() applied, for the wall velocity
  private prevWallMin = new THREE.Vector3();
  private prevWallMax = new THREE.Vector3();

  // Position in cells and J, velocity in cells/s and the particle's id, rows of C
  pos: WgpuBuffer<"float32x4">;
  vel: WgpuBuffer<"float32x4">;
  c0: WgpuBuffer<"float32x4">;
  c1: WgpuBuffer<"float32x4">;
  c2: WgpuBuffer<"float32x4">;
  // Per cell: fixed-point (momentum xyz, mass) from P2G, (velocity xyz, mass) for G2P
  gridAtomic: WgpuBuffer<"sint32">;
  gridVel: WgpuBuffer<"float32x4">;

  private p2g: WgpuCompute;
  private p2gTiled: WgpuCompute;
  tiledP2G = true;
  private gridUpdate: WgpuCompute;
  private g2p: WgpuCompute;
  private batch: WgpuComputeBatch;
  // One compute pass per step() (false: one per dispatch, for GPU timings)
  batched = true;
  // Steps between re-sorts of the particles by cell, also run on reset() (0: never)
  sortEvery = 10;
  private sorter: MpmParticleSort;
  private steps = 0;

  constructor({ renderer, bounds, grid, particles, dt, substeps, E, gravity, collider }: MpmSimOptions) {
    this.renderer = renderer;
    this.collider = collider;
    this.bounds = bounds.clone();
    this.walls = bounds.clone();
    const size = bounds.getSize(new THREE.Vector3());
    this.cellSize = Math.max(size.x, size.y, size.z) / grid;
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

    const vec4s = (count: number) => new WgpuBuffer({ renderer, format: "float32x4", count });
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
  set gravity(value: number) {
    this.uniforms.gravity.value = value / this.cellSize;
  }

  get gravity() {
    return this.uniforms.gravity.value * this.cellSize;
  }

  toCells(world: THREE.Vector3, out: THREE.Vector3) {
    return out.copy(world).sub(this.gridMin).divideScalar(this.cellSize);
  }

  // Over the given seconds; the velocities are the motion applied, so the grid
  // pushes the water as far as the walls moved
  private applyWalls(time: number) {
    const u = this.uniforms;
    const limit = this.res.clone().subScalar(BOUND);
    const targetMin = this.toCells(this.walls.min, new THREE.Vector3())
      .clamp(new THREE.Vector3(BOUND, BOUND, BOUND), limit.clone().subScalar(1));
    const targetMax = this.toCells(this.walls.max, new THREE.Vector3()).clamp(targetMin.clone().addScalar(1), limit);
    const maxStep = (MAX_WALL_SPEED / this.cellSize) * time;
    const glide = (target: THREE.Vector3, previous: THREE.Vector3, out: THREE.Vector3) => {
      out.copy(target).sub(previous).clampLength(0, maxStep).add(previous);
    };
    const min = u.wallMin.value as THREE.Vector3;
    const max = u.wallMax.value as THREE.Vector3;
    glide(targetMin, this.prevWallMin, min);
    glide(targetMax, this.prevWallMax, max);
    max.max(min.clone().addScalar(1));
    (u.wallMinVel.value as THREE.Vector3).copy(min).sub(this.prevWallMin).divideScalar(time);
    (u.wallMaxVel.value as THREE.Vector3).copy(max).sub(this.prevWallMax).divideScalar(time);
    this.prevWallMin.copy(min);
    this.prevWallMax.copy(max);
  }

  // The particles are undefined until reset()
  setCount(count: number) {
    if (count === this.count) {
      return;
    }
    this.count = count;
    this.uniforms.count.value = count;
    for (const buffer of [this.pos, this.vel, this.c0, this.c1, this.c2]) {
      buffer.setCapacity(count);
    }
  }

  private cellIndex(cell: TslNode): TslNode {
    const { res } = this;
    return cell.x.mul(int(res.y)).add(cell.y).mul(int(res.z)).add(cell.z);
  }

  // mpm88's quadratic B-spline over 3x3x3 cells, unrolled at build time, with
  // dpos = cell - position
  private stencil(Xp: TslNode, body: (cell: TslNode, weight: TslNode, dpos: TslNode) => void) {
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

  private scatterParticle(index: TslNode, deposit: (cell: TslNode, sums: TslNode[]) => void) {
    const { pos, vel, c0, c1, c2 } = this;
    const u = this.uniforms;
    const p = pos.element(index).toVar();
    const v = vel.element(index).xyz.toVar();
    const C0 = c0.element(index).xyz.toVar();
    const C1 = c1.element(index).xyz.toVar();
    const C2 = c2.element(index).xyz.toVar();
    // mpm88's stress: weakly compressible, fused with dt and MLS-MPM's M_p^-1 = 4 / dx^2
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

  private depositGlobal(cell: TslNode, sums: TslNode[]) {
    const slot = this.cellIndex(cell).mul(4).toVar();
    sums.forEach((value, c) => {
      atomicAdd(this.gridAtomic.element(slot.add(c)), value);
    });
  }

  private makeP2G() {
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

  // Integer sums are order-independent, so the grid is bit-identical to the
  // direct kernel's. Barriers sit outside every branch, as WGSL needs uniform
  // control flow for them and TSL has no workgroupUniformLoad.
  private makeP2GTiled() {
    const { pos } = this;
    const u = this.uniforms;
    const tile = workgroupArray("int", TILE_NODES * 4).toAtomic();
    // min xyz, max xyz of the particles' stencil base cells
    const boundsArray = workgroupArray("int", 6).toAtomic();
    // Workgroup arrays want node indices
    const bounds = { element: (i: number) => boundsArray.element(uint(i)) };
    const BIG = 1 << 30;
    return new WgpuCompute({
      label: "mpmP2GTiled",
      workgroupSize: [TILE_WORKGROUP],
      body: ({ index, localId }) => {
        const lid = localId.x;
        Loop({ start: lid, end: uint(TILE_NODES * 4), type: "uint", condition: "<", update: TILE_WORKGROUP }, ({ i }: { i: TslNode }) => {
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
          (["x", "y", "z"] as const).forEach((axis, a) => {
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
          Loop({ start: lid, end: uint(nodes), type: "uint", condition: "<", update: TILE_WORKGROUP }, ({ i }: { i: TslNode }) => {
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
  private capSpeed(v: TslNode): TslNode {
    const limit = float(MAX_CFL).div(this.uniforms.dt);
    return v.mul(min(1.0, limit.div(max(length(v), 1e-6))));
  }

  private toWorld(cells: TslNode): TslNode {
    const { gridMin, cellSize } = this;
    return vec3(gridMin.x, gridMin.y, gridMin.z).add(cells.mul(cellSize));
  }

  private makeGridUpdate() {
    const { gridAtomic, gridVel, numCells, res, collider, cellSize } = this;
    const u = this.uniforms;
    return new WgpuCompute({
      label: "mpmGrid",
      body: ({ index }) => {
        If(index.lessThan(uint(numCells)), () => {
          const slot = index.mul(uint(4)).toVar();
          // Zeroed for the next P2G here, the only reader, so no clear pass is needed
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
            // Slip walls: a node past a wall moves into it no faster than the wall
            const i = int(index).div(int(res.y * res.z));
            const j = int(index).div(int(res.z)).mod(int(res.y));
            const k = int(index).mod(int(res.z));
            const node = vec3(float(i), float(j), float(k)).toVar();
            for (const axis of ["x", "y", "z"] as const) {
              If(node[axis].lessThan(u.wallMin[axis]), () => { v[axis].assign(max(v[axis], u.wallMinVel[axis])); });
              If(node[axis].greaterThan(u.wallMax[axis]), () => { v[axis].assign(min(v[axis], u.wallMaxVel[axis])); });
            }
            if (collider) {
              // Level-set boundary with Coulomb friction, relative to the
              // collider; a node on a slab's centre line has no normal and moves with it
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

  private makeG2P() {
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
          for (const axis of ["x", "y", "z"] as const) {
            const under = u.wallMin[axis].sub(p[axis]);
            const over = p[axis].sub(u.wallMax[axis]);
            If(under.greaterThan(0.0), () => { newV[axis].assign(max(newV[axis], under.div(PUSH_TIME))); });
            If(over.greaterThan(0.0), () => { newV[axis].assign(min(newV[axis], over.div(-PUSH_TIME))); });
          }
          if (collider) {
            const hit = collider.sample(this.toWorld(p.xyz));
            If(hit.phi.lessThan(0.0), () => {
              const vco = hit.velocity.div(cellSize);
              const push = hit.phi.div(-cellSize * PUSH_TIME).sub(dot(newV.sub(vco), hit.normal));
              newV.addAssign(hit.normal.mul(max(push, 0.0)));
            });
          }
          newV.assign(this.capSpeed(newV));
          const x = p.xyz.add(newV.mul(u.dt));
          // nialltl's clamp keeps the stencil on the grid. The walls are soft, so
          // it sits where all stencil nodes are wall nodes: at the wall,
          // particles would pile up and collapse J.
          const clamped = clamp(x, vec3(1.0), vec3(res.x - 2.0, res.y - 2.0, res.z - 2.0));
          const Jint = p.w.mul(float(1.0).add(u.dt.mul(C0.x.add(C1.y).add(C2.z)))).toVar();
          // Integrated J misses particles packing below the grid resolution, so
          // it is pulled toward the grid density's, only when denser: partly
          // empty free-surface nodes would read as tension
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

  // 8 particles per cell, as a ball, or with drop a slab that many cells above the floor
  reset(drop?: number) {
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

export const COLOR_MODES = ["speed", "pressure", "both"] as const;

// Follows setCount, since the buffers keep their TSL nodes when they grow.
// radius is a standard deviation in metres, variation tells the particles
// apart when the water moves as a block, and pressure shows as metres of
// water head so its range holds for any E.
export function waterSplats(sim: MpmSim) {
  const uniforms = {
    radius: uniform(sim.cellSize * 0.4, "float"),
    opacity: uniform(1.0, "float"),
    variation: uniform(0.2, "float"),
    colorMode: uniform(COLOR_MODES.indexOf("both"), "float"),
    speedRange: uniform(3.0, "float"),
    pressureRange: uniform(0.5, "float"),
  };

  const generator: SplatGenerator = {
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
