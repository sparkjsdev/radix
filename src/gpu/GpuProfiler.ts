import { InspectorBase, TimestampQuery, type ComputeNode, type WebGPURenderer } from "three/webgpu";

/** The times GpuProfiler.collect averages per frame. */
export interface GpuProfile {
  /** Milliseconds per frame of each phase. */
  gpu: Record<string, number>;
  /** Milliseconds per frame of each phase. */
  cpu: Record<string, number>;
  /** The resolved frames the GPU times average over. */
  frames: number;
}

interface PoolLike {
  timestamps: Map<string, number>;
}

/** Times named phases on the GPU and the CPU. */
export class GpuProfiler extends InspectorBase {
  /**
   * The phase of the passes recorded from now on.
   *
   * @default "other"
   */
  label = "other";
  private frame = 0;
  private passes = new Map<string, { phase: string; frame: number }>();
  private cpu: Record<string, number> = {};
  private cpuFrames = new Set<number>();

  /**
   * Starts a frame. Call it before each frame's render.
   */
  beginFrame() {
    this.frame += 1;
  }

  /** Runs fn with its passes labeled name, and times it on the CPU. */
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

  /** Adds CPU milliseconds to a phase. */
  mark(name: string, ms: number) {
    this.cpu[name] = (this.cpu[name] ?? 0) + ms;
    this.cpuFrames.add(this.frame);
  }

  /** Called by three as a compute dispatch starts. */
  beginCompute(uid: string, computeNode: ComputeNode) {
    if (!this.active) {
      return;
    }
    const nodes = Array.isArray(computeNode) ? computeNode : [computeNode];
    const name = nodes.map((node) => node.name).filter(Boolean).join(",");
    this.passes.set(uid, { phase: this.label !== "other" ? this.label : (name || "compute"), frame: this.frame });
  }

  /** Called by three as a render starts. */
  beginRender(uid: string) {
    if (this.active) {
      this.passes.set(uid, { phase: this.label, frame: this.frame });
    }
  }

  /**
   * Whether timestamps are tracked. Set it between frames, never inside a
   * render.
   */
  get active() {
    return this.backend()?.trackTimestamp === true;
  }

  set active(on: boolean) {
    const backend = this.backend();
    if (backend) {
      backend.trackTimestamp = on && this.supported;
    }
  }

  /** Whether the device has timestamp queries. */
  get supported() {
    const renderer = this.getRenderer() as WebGPURenderer | null;
    const gl = this.backend()?.gl;
    return renderer !== null && (gl ? gl.getExtension("EXT_disjoint_timer_query_webgl2") !== null : renderer.hasFeature("timestamp-query"));
  }

  private backend() {
    return (this.getRenderer() as WebGPURenderer | null)?.backend as { trackTimestamp?: boolean; gl?: WebGL2RenderingContext } | undefined;
  }

  /**
   * Resolves pending queries.
   *
   * @return The times, or undefined when nothing new resolved.
   */
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
      // Passes whose queries never resolved, after a pool overflow
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

  /** Formats times as one line, with phases sorted by time. */
  static format(profile: GpuProfile) {
    const list = (times: Record<string, number>) => Object.entries(times).sort((a, b) => b[1] - a[1]).map(([name, ms]) => `${name} ${ms.toFixed(2)}`).join(", ");
    return `GPU ${list(profile.gpu) || "-"} | CPU ${list(profile.cpu) || "-"} ms`;
  }
}
