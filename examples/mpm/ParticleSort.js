// Reorders the MPM particle buffers by the Morton code of each particle's
// grid cell, so that neighbouring threads work on neighbouring particles:
// P2G's atomics and G2P's gathers then hit the same cache lines, and a
// workgroup's particles span a small box of cells (what the tiled P2G needs).
// The particles drift apart as the water moves; MpmSim re-sorts every
// `sortEvery` steps.
//
// One sort: a kernel writes (Morton key, index) per particle, WgpuRadixSort
// sorts the pairs, two gather kernels write the particles in sorted order to
// scratch buffers (two, to stay within 8 storage buffers per stage), and the
// scratch buffers are copied back.
                                                   
import { TSL, WgpuBuffer, WgpuCompute, WgpuRadixSort,                                } from "@sparkjsdev/radix";
                                          

const { If, clamp, floor, ivec3, uint } = TSL;

// The low 10 bits of v with two zero bits between each (3D Morton spreading)
function spreadBits(v         )          {
  const x = v.bitAnd(uint(0x3ff)).toVar();
  x.assign(x.bitOr(x.shiftLeft(uint(16))).bitAnd(uint(0x030000ff)));
  x.assign(x.bitOr(x.shiftLeft(uint(8))).bitAnd(uint(0x0300f00f)));
  x.assign(x.bitOr(x.shiftLeft(uint(4))).bitAnd(uint(0x030c30c3)));
  x.assign(x.bitOr(x.shiftLeft(uint(2))).bitAnd(uint(0x09249249)));
  return x;
}

export class MpmParticleSort {
  sim        ;
  renderer                ;
  // Key bits the radix sort looks at (3 x the bits of the largest grid dimension)
           bits             ;
          keys                      ;
          values                      ;
          radix               ;
  // Sorted copies of pos, vel, c0, c1, c2
          scratch                           ;
          keyKernel             ;
          gatherKernels               ;

  constructor(sim        ) {
    this.sim = sim;
    const { renderer, res } = sim;
    this.renderer = renderer;
    const keyBits = 3 * Math.ceil(Math.log2(Math.max(res.x, res.y, res.z)));
    if (keyBits > 30) {
      throw new Error(`MpmParticleSort: grid ${res.x}x${res.y}x${res.z} is too large for 10-bit Morton axes`);
    }
    this.bits = keyBits <= 16 ? 16 : keyBits <= 24 ? 24 : 32;
    this.keys = new WgpuBuffer({ renderer, format: "uint32", count: sim.count });
    this.values = new WgpuBuffer({ renderer, format: "uint32", count: sim.count });
    this.radix = new WgpuRadixSort({ renderer, keys: this.keys, values: this.values });
    this.scratch = this.sources().map(() => new WgpuBuffer({ renderer, format: "float32x4", count: sim.count }));
    this.keyKernel = this.makeKeys();
    const [pos, vel, c0, c1, c2] = this.sources();
    const [sPos, sVel, sC0, sC1, sC2] = this.scratch;
    this.gatherKernels = [this.makeGather([pos, vel, c0], [sPos, sVel, sC0]), this.makeGather([c1, c2], [sC1, sC2])];
  }

          sources() {
    const { pos, vel, c0, c1, c2 } = this.sim;
    return [pos, vel, c0, c1, c2];
  }

          makeKeys() {
    const { sim, keys, values } = this;
    const { res } = sim;
    return new WgpuCompute({
      label: "mpmSortKeys",
      body: ({ index }) => {
        If(index.lessThan(sim.uniforms.count), () => {
          const cell = clamp(ivec3(floor(sim.pos.element(index).xyz)), ivec3(0), ivec3(res.x - 1, res.y - 1, res.z - 1)).toVar();
          const key = spreadBits(uint(cell.x)).shiftLeft(uint(2))
            .bitOr(spreadBits(uint(cell.y)).shiftLeft(uint(1)))
            .bitOr(spreadBits(uint(cell.z)));
          keys.element(index).assign(key);
          values.element(index).assign(index);
        });
      },
    });
  }

  // dst[k][i] = src[k][values[i]]
          makeGather(src                           , dst                           ) {
    const { sim, values } = this;
    return new WgpuCompute({
      label: "mpmSortGather",
      body: ({ index }) => {
        If(index.lessThan(sim.uniforms.count), () => {
          const from = values.element(index).toVar();
          src.forEach((buffer, k) => {
            dst[k].element(index).assign(buffer.element(from));
          });
        });
      },
    });
  }

  sort() {
    const { renderer, sim } = this;
    const count = sim.count;
    if (count <= 0) {
      return;
    }
    this.keys.ensureCapacity(count);
    this.values.ensureCapacity(count);
    for (const buffer of this.scratch) {
      buffer.ensureCapacity(count);
    }
    this.keyKernel.dispatch(renderer, count);
    this.radix.sort(count, { bits: this.bits });
    for (const kernel of this.gatherKernels) {
      kernel.dispatch(renderer, count);
    }
    // Same queue as the dispatches above, so ordered after them
    this.sources().forEach((buffer, k) => buffer.copyFrom(this.scratch[k], { count }));
  }

  dispose() {
    this.radix.dispose();
    for (const buffer of [this.keys, this.values, ...this.scratch]) {
      buffer.dispose();
    }
  }
}


//# sourceURL=examples/mpm/ParticleSort.ts