// GPU and CPU time per named phase. GPU times come from three's timestamp
// queries (WebGPURenderer with trackTimestamp: WebGPU `timestamp-query`, or
// EXT_disjoint_timer_query_webgl2 on the WebGL2 backend) through its
// Inspector hooks, which name the pass being recorded; CPU times wrap the
// phase's code. createRenderer({ profile: true }) installs one;
// `profiler.active` turns the GPU timestamps on and off.
//
//   profiler.beginFrame();
//   profiler.phase("update", () => update(camera));
//   profiler.label = "draw"; renderer.render(scene, camera);
//   const report = await profiler.collect(); // ms per phase, averaged
//
// Timestamps resolve a frame or two late; Chrome quantizes them to 100 us
// unless WebGPU developer features are on.
import { InspectorBase, TimestampQuery, type ComputeNode, type WebGPURenderer } from "three/webgpu";

export interface GpuProfile {
  // Average ms per frame of each phase over `frames` resolved frames
  gpu: Record<string, number>;
  cpu: Record<string, number>;
  frames: number;
}

interface PoolLike {
  timestamps: Map<string, number>;
}

export class GpuProfiler extends InspectorBase {
  // Phase of the passes recorded from now on
  label = "other";
  private frame = 0;
  private passes = new Map<string, { phase: string; frame: number }>();
  private cpu: Record<string, number> = {};
  private cpuFrames = new Set<number>();

  beginFrame() {
    this.frame += 1;
  }

  // Run fn with its passes labeled `name`; its CPU time is recorded too
  phase<T>(name: string, fn: () => T): T {
    const previous = this.label;
    this.label = name;
    const start = performance.now();
    try {
      return fn();
    } finally {
      this.mark(name, performance.now() - start);
      this.label = previous;
    }
  }

  // Record CPU milliseconds for a phase (e.g. an async worker round trip)
  mark(name: string, ms: number) {
    this.cpu[name] = (this.cpu[name] ?? 0) + ms;
    this.cpuFrames.add(this.frame);
  }

  beginCompute(uid: string, computeNode: ComputeNode) {
    if (!this.active) {
      return;
    }
    const nodes = Array.isArray(computeNode) ? computeNode : [computeNode];
    const name = nodes.map((node) => node.name).filter(Boolean).join(",");
    this.passes.set(uid, { phase: this.label !== "other" ? this.label : (name || "compute"), frame: this.frame });
  }

  beginRender(uid: string) {
    if (this.active) {
      this.passes.set(uid, { phase: this.label, frame: this.frame });
    }
  }

  // Whether the renderer tracks timestamps. Settable between frames (not
  // inside a render: WebGL2 timer queries must end as they began); stays
  // off without the feature. CPU phases are timed either way.
  get active() {
    return this.backend()?.trackTimestamp === true;
  }

  set active(on: boolean) {
    const backend = this.backend();
    if (backend) {
      backend.trackTimestamp = on && this.supported;
    }
  }

  // WebGPU `timestamp-query` (three requests every adapter feature) or
  // EXT_disjoint_timer_query_webgl2
  get supported() {
    const renderer = this.getRenderer() as WebGPURenderer | null;
    const gl = this.backend()?.gl;
    return renderer !== null && (gl ? gl.getExtension("EXT_disjoint_timer_query_webgl2") !== null : renderer.hasFeature("timestamp-query"));
  }

  private backend() {
    return (this.getRenderer() as WebGPURenderer | null)?.backend as { trackTimestamp?: boolean; gl?: WebGL2RenderingContext } | undefined;
  }

  // Resolve pending queries; undefined when nothing new resolved
  async collect(): Promise<GpuProfile | undefined> {
    const gpu: Record<string, number> = {};
    const frames = new Set<number>();
    const renderer = this.getRenderer() as WebGPURenderer | null;

    if (renderer && this.active) {
      await renderer.resolveTimestampsAsync(TimestampQuery.RENDER);
      await renderer.resolveTimestampsAsync(TimestampQuery.COMPUTE);
      const pools = (renderer.backend as unknown as { timestampQueryPool: Record<string, PoolLike | undefined> }).timestampQueryPool;
      for (const type of [TimestampQuery.RENDER, TimestampQuery.COMPUTE]) {
        for (const [uid, ms] of pools[type]?.timestamps ?? []) {
          const pass = this.passes.get(uid);
          if (pass) {
            this.passes.delete(uid);
            gpu[pass.phase] = (gpu[pass.phase] ?? 0) + ms;
            frames.add(pass.frame);
          }
        }
      }
      // Labels of passes whose queries never resolved (pool overflow)
      for (const [uid, pass] of this.passes) {
        if (pass.frame < this.frame - 8) {
          this.passes.delete(uid);
        }
      }
    }

    const cpuFrames = Math.max(1, this.cpuFrames.size);
    const cpu = Object.fromEntries(Object.entries(this.cpu).map(([name, ms]) => [name, ms / cpuFrames]));
    const resolved = Math.max(1, frames.size);
    this.cpu = {};
    this.cpuFrames.clear();

    if (frames.size === 0 && Object.keys(cpu).length === 0) {
      return undefined;
    }
    return { gpu: Object.fromEntries(Object.entries(gpu).map(([name, ms]) => [name, ms / resolved])), cpu, frames: frames.size };
  }

  static format(profile: GpuProfile) {
    const list = (times: Record<string, number>) => Object.entries(times).sort((a, b) => b[1] - a[1]).map(([name, ms]) => `${name} ${ms.toFixed(2)}`).join(", ");
    return `GPU ${list(profile.gpu) || "-"} | CPU ${list(profile.cpu) || "-"} ms`;
  }
}
