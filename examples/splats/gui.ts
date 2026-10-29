// Tweakpane v4 panel of the viewer. Bindings write straight into the viewer
// state, the splat renderer and its params or the model's transform, which
// main.ts and the renderer apply every frame; changes that need work (a
// reload, a flip, framing) go through actions. Every folder but Monitors
// starts collapsed; the look (theme variables, width) lives in index.html.
import * as EssentialsPlugin from "@tweakpane/plugin-essentials";
import { Pane, type BindingParams, type FolderApi } from "tweakpane";
import type * as THREE from "three";
import type { WebGPURenderer } from "three/webgpu";
import { Hdr, type CameraControls, type GpuProfile, type GpuProfiler, type ProjectionMethod, type SortKeyBits, type SplatRenderer } from "@sparkjsdev/radix";
import { addControlsFolder } from "./controlsPane.js";
import type { ViewerState } from "./main.js";

const fixed = (digits: number) => (v: number) => v.toFixed(digits);
// GPU "-": no timestamps (GPU timing off)
const ms = (gpu: number | undefined, cpu: number) => `${gpu === undefined ? "-" : gpu.toFixed(2)} · ${cpu.toFixed(2)}`;

// A row of toggle buttons for a small set of choices
let groups = 0;
function segmented<T extends string | number>(label: string, values: T[], titles?: string[]): BindingParams {
  groups += 1;
  return {
    label,
    view: "radiogrid",
    groupName: `segmented-${groups}`,
    size: [values.length, 1],
    cells: (x: number) => ({ title: titles?.[x] ?? String(values[x]), value: values[x] }),
  };
}

// Nested plain objects (a preset) into the state, key by key: only keys
// the target has
function assignDeep(target: object, source: object = {}) {
  const into = target as Record<string, unknown>;
  for (const [key, value] of Object.entries(source)) {
    if (!(key in into)) {
      continue;
    }
    if (typeof into[key] === "object" && into[key] !== null && typeof value === "object" && value !== null) {
      assignDeep(into[key], value);
    } else {
      into[key] = value;
    }
  }
}

export function makeGui({ state, webgpu, hdr, renderer, profiler, splats, model, controls, actions }: {
  state: ViewerState;
  webgpu: boolean;
  hdr: boolean;
  renderer: WebGPURenderer;
  profiler?: GpuProfiler;
  splats: SplatRenderer;
  model: THREE.Object3D;
  controls: CameraControls;
  actions: {
    reload(): void;
    flip(): void;
    frame(): void;
    resetView(): void;
    exportFile(): void;
  };
}) {
  const pane = new Pane({ title: "Radix splats" });
  pane.registerPlugin(EssentialsPlugin);
  const folder = (title: string, parent: FolderApi | Pane = pane) => parent.addFolder({ title, expanded: false });
  const slider = <T extends object>(c: FolderApi, target: T, key: keyof T & string, label: string, min: number, max: number, digits = 2) =>
    c.addBinding(target, key, { label, min, max, step: 10 ** -digits, format: fixed(digits) });

  // --- Monitors ---
  const monitors = pane.addFolder({ title: `Monitors  ·  ${webgpu ? "WebGPU" : "WebGL2"}` });
  const fpsGraph = monitors.addBlade({ view: "fpsgraph", label: "fps", rows: 2, min: 0, max: 144 }) as unknown as { begin(): void; end(): void };
  const frame = { file: "none", ms: ms(undefined, 0), drawn: "0" };
  monitors.addBinding(frame, "file", { readonly: true });
  monitors.addBinding(frame, "ms", { readonly: true, label: "GPU · CPU ms" });
  // GPU timestamps cost frame time (their queries resolve every report), so
  // they start off (?profile=1 starts them on); CPU phases are timed either way
  if (profiler) {
    const timing = { get on() { return profiler.active; }, set on(value: boolean) { profiler.active = value; } };
    monitors.addBinding(timing, "on", { label: profiler.supported ? "GPU timing" : "GPU timing (n/a)", disabled: !profiler.supported });
  }
  monitors.addBinding(frame, "drawn", { readonly: true });
  const phaseFolder = monitors.addFolder({ title: "Phases  (GPU · CPU ms)", expanded: false });
  const phases: Record<string, string> = {};

  // --- Renderer (method, sort and key bits are in the quick bar) ---
  const p = splats.params;
  const o = splats.objectParams;
  const render = folder("Renderer");
  render.addBinding(state, "layout", segmented("layout", ["extSplats", "packedSplats"], ["ext (32 B)", "packed (16 B)"])).on("change", () => actions.reload());
  render.addBinding(state, "stereo", { label: "stereo (side by side)" });
  const cpuSort = folder("CPU sort (WebGL2 fallback)", render);
  slider(cpuSort, o, "sortGuard", "guard band", 0, 3);
  if (splats.autoSort) {
    slider(cpuSort, splats.autoSort, "distance", "re-sort after (m)", 0, 1, 3);
    const autoSort = splats.autoSort;
    const turn = { get degrees() { return autoSort.angle * 180 / Math.PI; }, set degrees(value) { autoSort.angle = value * Math.PI / 180; } };
    slider(cpuSort, turn, "degrees", "or after (deg)", 0, 45, 1);
  }

  // What all splats share (the draw reads it), then what each object projects with
  const quality = folder("Quality");
  slider(quality, p, "minAlpha", "min alpha", 0, 0.1, 3);
  slider(quality, p, "maxStdDev", "max std dev", 1, 4);
  slider(quality, p, "falloff", "falloff (0: discs)", 0, 1);
  slider(quality, o, "minPixelRadius", "min px radius", 0, 4);
  slider(quality, o, "maxPixelRadius", "max px radius", 16, 2048, 0);
  slider(quality, o, "blurAmount", "blur", 0, 2);
  slider(quality, o, "preBlurAmount", "pre-blur", 0, 2);
  slider(quality, o, "clipXY", "clip xy", 1, 2);
  quality.addBinding(o, "lodInflate", { label: "LoD inflate" });

  const lens = folder("Depth of field");
  slider(lens, o, "focalDistance", "focal dist", 0, 10);
  slider(lens, o, "apertureTan", "aperture tan", 0, 0.05, 3);

  // --- Transform of the splats, and the gizmo ---
  const transform = folder("Transform");
  transform.addBinding(state, "gizmo", segmented("gizmo (1 2 3)", ["off", "translate", "rotate", "scale"], ["off", "move", "rotate", "scale"]));
  transform.addBinding(model, "position", { format: fixed(3) });
  transform.addBinding(model, "rotation", { label: "rotation (rad)", format: fixed(3) });
  transform.addBinding(model, "scale", { format: fixed(3) });
  transform.addButton({ title: "Flip (half turn about x)" }).on("click", () => actions.flip());
  transform.addButton({ title: "Frame" }).on("click", () => actions.frame());
  transform.addButton({ title: "Start view" }).on("click", () => actions.resetView());

  // --- Display: HDR canvas, headroom tone mapping, background ---
  const display = folder("Display");
  const output = { extended: hdr };
  display.addBinding(output, "extended", { label: hdr ? "HDR canvas" : "HDR (?hdr=1)", disabled: !hdr }).on("change", (event) => Hdr.setOutput(renderer, event.value));
  const toneMapping = Hdr.useToneMapping(renderer, { enabled: false });
  display.addBinding(toneMapping, "enabled", { label: "tone mapping" });
  slider(display, toneMapping.headroom as { value: number }, "value", "headroom", 1, 16);
  display.addBinding(toneMapping, "exposure", { min: 0, max: 4, format: fixed(2) });
  slider(display, toneMapping.knee as { value: number }, "value", "knee", 0, 0.99);
  slider(display, toneMapping.whiten as { value: number }, "value", "whiten", 0, 4);
  display.addBinding(state, "sky", { label: "sky background" });
  display.addBinding(state, "background", { color: { type: "float" } });

  addControlsFolder(pane, controls);

  // --- Export: the loaded splats, as loaded (not transformed) ---
  const exporter = folder("Export");
  exporter.addBinding(state, "exportFormat", segmented("format", ["rdx", "ply", "compressed-ply", "spz"], ["rdx", "ply", "c.ply", "spz"]));
  exporter.addButton({ title: "Download" }).on("click", () => actions.exportFile());

  // --- Presets: the viewer state, method, sort, key bits and params as JSON ---
  const presets = folder("Presets");
  const preset = { json: "" };
  presets.addButton({ title: "Export to JSON (copies)" }).on("click", () => {
    preset.json = JSON.stringify({ state, method: splats.method, sortMode: splats.sortMode, sortBits: splats.sortBits, params: p, objectParams: o });
    void navigator.clipboard?.writeText(preset.json);
    pane.refresh();
  });
  presets.addBinding(preset, "json", { label: "json", multiline: true, rows: 3 });
  presets.addButton({ title: "Import JSON" }).on("click", () => {
    const parsed = JSON.parse(preset.json) as {
      state?: object; method?: ProjectionMethod; sortMode?: "gpu" | "cpu"; sortBits?: SortKeyBits; params?: object; objectParams?: object;
    };
    const layout = state.layout;
    assignDeep(state, parsed.state);
    assignDeep(p, parsed.params);
    assignDeep(o, parsed.objectParams);
    splats.method = parsed.method ?? splats.method;
    splats.sortBits = parsed.sortBits ?? splats.sortBits;
    // The GPU sort needs WebGPU
    if (parsed.sortMode === "cpu" || (parsed.sortMode === "gpu" && webgpu)) {
      splats.sortMode = parsed.sortMode;
    }
    if (state.layout !== layout) {
      actions.reload();
    }
    pane.refresh();
  });

  return {
    frameBegin: () => fpsGraph.begin(),
    frameEnd: () => fpsGraph.end(),
    refresh: () => pane.refresh(),
    monitor(values: { file: string; drawn: string }) {
      Object.assign(frame, values);
    },
    profile(profile: GpuProfile | undefined) {
      if (!profile) {
        return;
      }
      const sum = (values: Record<string, number>) => Object.values(values).reduce((a, b) => a + b, 0);
      const timed = Object.keys(profile.gpu).length > 0;
      frame.ms = ms(timed ? sum(profile.gpu) : undefined, sum(profile.cpu));
      for (const name of new Set([...Object.keys(profile.gpu), ...Object.keys(profile.cpu)])) {
        if (!(name in phases)) {
          phases[name] = "";
          phaseFolder.addBinding(phases, name, { readonly: true, label: name });
        }
        phases[name] = ms(timed ? profile.gpu[name] ?? 0 : undefined, profile.cpu[name] ?? 0);
      }
    },
  };
}
