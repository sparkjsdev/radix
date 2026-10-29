// Tweakpane v4 panel of the SOG viewer. Bindings write straight into the
// viewer state, the LoD settings, the splat renderer and its params or the
// model's transform, which main.ts, the LoD stream and the renderer apply
// every frame; changes that need work (a reload, a new SH degree, a new
// LoD selection, a flip, framing) go through actions. Every folder but
// Monitors starts collapsed; the look lives in index.html.
import * as EssentialsPlugin from "@tweakpane/plugin-essentials";
import { Pane,                                    } from "tweakpane";
                                    
                                                   
import { Hdr,                                                                                                                     } from "@sparkjsdev/radix";
import { addControlsFolder } from "./controlsPane.js";
import { TIERS,               } from "./lodStream.js";
                                             
import { formatCount } from "./quickBar.js";

const fixed = (digits        ) => (v        ) => v.toFixed(digits);
// GPU "-": no timestamps (GPU timing off)
const ms = (gpu                    , cpu        ) => `${gpu === undefined ? "-" : gpu.toFixed(2)} · ${cpu.toFixed(2)}`;

// A row of toggle buttons for a small set of choices
let groups = 0;
function segmented                           (label        , values     , titles           )                {
  groups += 1;
  return {
    label,
    view: "radiogrid",
    groupName: `segmented-${groups}`,
    size: [values.length, 1],
    cells: (x        ) => ({ title: titles?.[x] ?? String(values[x]), value: values[x] }),
  };
}

// Nested plain objects (a preset) into the state, key by key: only keys
// the target has
function assignDeep(target        , source         = {}) {
  const into = target                           ;
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

export function makeGui({ state, webgpu, hdr, renderer, profiler, splats, model, controls, actions }   
                     
                  
               
                           
                         
                        
                        
                           
            
                   
                                
                       
                 
                  
                      
    
 ) {
  const pane = new Pane({ title: "Radix SOG viewer" });
  pane.registerPlugin(EssentialsPlugin);
  const folder = (title        , parent                   = pane) => parent.addFolder({ title, expanded: false });
  const slider =                   (c           , target   , key                  , label        , min        , max        , digits = 2) =>
    c.addBinding(target, key, { label, min, max, step: 10 ** -digits, format: fixed(digits) });

  // --- Monitors ---
  const monitors = pane.addFolder({ title: `Monitors  ·  ${webgpu ? "WebGPU" : "WebGL2"}` });
  const fpsGraph = monitors.addBlade({ view: "fpsgraph", label: "fps", rows: 2, min: 0, max: 144 })                                             ;
  const frame = { file: "none", format: "", load: "", ms: ms(undefined, 0), drawn: "0" };
  monitors.addBinding(frame, "file", { readonly: true });
  monitors.addBinding(frame, "format", { readonly: true });
  monitors.addBinding(frame, "load", { readonly: true, label: "load" });
  monitors.addBinding(frame, "ms", { readonly: true, label: "GPU · CPU ms" });
  // GPU timestamps cost frame time (their queries resolve every report), so
  // they start off (?profile=1 starts them on); CPU phases are timed either way
  if (profiler) {
    const timing = { get on() { return profiler.active; }, set on(value         ) { profiler.active = value; } };
    monitors.addBinding(timing, "on", { label: profiler.supported ? "GPU timing" : "GPU timing (n/a)", disabled: !profiler.supported });
  }
  monitors.addBinding(frame, "drawn", { readonly: true });
  const lodMonitor = { levels: "", shown: "", resident: "", loading: "", waiting: "", decode: "" };
  const lodMonitors = monitors.addFolder({ title: "LoD", expanded: true, hidden: true });
  lodMonitors.addBinding(lodMonitor, "levels", { readonly: true, label: "leaves / level" });
  lodMonitors.addBinding(lodMonitor, "shown", { readonly: true, label: "shown · selected · budget" });
  lodMonitors.addBinding(lodMonitor, "resident", { readonly: true, label: "resident" });
  lodMonitors.addBinding(lodMonitor, "loading", { readonly: true, label: "loads" });
  lodMonitors.addBinding(lodMonitor, "waiting", { readonly: true, label: "waiting (tiers)" });
  lodMonitors.addBinding(lodMonitor, "decode", { readonly: true, label: "GPU decode ms" });
  const phaseFolder = monitors.addFolder({ title: "Phases  (GPU · CPU ms)", expanded: false });
  const phases                         = {};

  // --- Renderer (method, sort and key bits are in the quick bar) ---
  const p = splats.params;
  const o = splats.objectParams;
  const render = folder("Renderer");
  render.addBinding(state, "decode", segmented("decode", ["cpu", "gpu"], ["CPU (ArrayData)", "GPU (writer pass)"])).on("change", () => actions.reload());
  render.addBinding(state, "layout", segmented("layout (CPU)", ["extSplats", "packedSplats"], ["ext (32 B)", "packed (16 B)"])).on("change", () => actions.reload());
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

  const lens = folder("Depth of field");
  slider(lens, o, "focalDistance", "focal dist", 0, 10);
  slider(lens, o, "apertureTan", "aperture tan", 0, 0.05, 3);

  // --- Spherical harmonics (the palette's degree, up to the file's) ---
  const sh = folder("Spherical harmonics");
  sh.addBinding(state, "sh", segmented("degree", [0, 1, 2, 3])).on("change", (event) => actions.setSh(event.value          ));

  // --- LoD (SOG LoD scenes): the selection, the streaming budget, debug ---
  const lod = folder("LoD");
  const l = state.lod;
  const reselect = () => actions.lodChanged();
  slider(lod, l, "baseDistance", "base distance", 0.5, 50, 1).on("change", reselect);
  slider(lod, l, "multiplier", "multiplier", 1.2, 6).on("change", reselect);
  lod.addBinding(l, "rangeMin", { label: "finest level", min: 0, max: 7, step: 1 }).on("change", reselect);
  lod.addBinding(l, "rangeMax", { label: "coarsest level", min: 0, max: 7, step: 1 }).on("change", reselect);
  slider(lod, l, "behindPenalty", "behind penalty", 1, 5, 1).on("change", reselect);
  lod.addBinding(l, "splatBudget", { label: "splat budget (0: none)", min: 0, max: 16_000_000, step: 250_000, format: (v        ) => formatCount(v) }).on("change", reselect);
  lod.addBinding(l, "budgetMode", segmented("budget", ["target", "limit"], ["fill (target)", "cap (limit)"])).on("change", reselect);
  lod.addBinding(l, "underfillLimit", { label: "underfill levels", min: 0, max: 7, step: 1 }).on("change", reselect);
  lod.addBinding(l, "residentBudget", { label: "resident budget", min: 2_000_000, max: 64_000_000, step: 1_000_000, format: (v        ) => formatCount(v) }).on("change", reselect);
  slider(lod, l, "updateDistance", "re-select after (m)", 0, 5).on("change", reselect);
  slider(lod, l, "updateAngle", "or after (deg)", 1, 180, 0).on("change", reselect);
  lod.addBinding(l, "freeze", { label: "freeze selection" }).on("change", reselect);
  lod.addBinding(l, "colorLevels", { label: "color by level" }).on("change", reselect);

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
  slider(display, toneMapping.headroom                     , "value", "headroom", 1, 16);
  display.addBinding(toneMapping, "exposure", { min: 0, max: 4, format: fixed(2) });
  slider(display, toneMapping.knee                     , "value", "knee", 0, 0.99);
  slider(display, toneMapping.whiten                     , "value", "whiten", 0, 4);
  display.addBinding(state, "sky", { label: "sky background" });
  display.addBinding(state, "background", { color: { type: "float" } });

  addControlsFolder(pane, controls);

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
    const parsed = JSON.parse(preset.json)     
                                                                                                                                          
     ;
    const { layout, decode, sh: degree } = state;
    assignDeep(state, parsed.state);
    assignDeep(p, parsed.params);
    assignDeep(o, parsed.objectParams);
    splats.method = parsed.method ?? splats.method;
    splats.sortBits = parsed.sortBits ?? splats.sortBits;
    // The GPU sort needs WebGPU
    if (parsed.sortMode === "cpu" || (parsed.sortMode === "gpu" && webgpu)) {
      splats.sortMode = parsed.sortMode;
    }
    if (state.layout !== layout || state.decode !== decode) {
      actions.reload();
    } else if (state.sh !== degree) {
      actions.setSh(state.sh);
    }
    actions.lodChanged();
    pane.refresh();
  });

  return {
    frameBegin: () => fpsGraph.begin(),
    frameEnd: () => fpsGraph.end(),
    refresh: () => pane.refresh(),
    monitor(values                                                               ) {
      Object.assign(frame, values);
    },
    lod(stats                      ) {
      lodMonitors.hidden = !stats;
      if (!stats) {
        return;
      }
      lodMonitor.levels = stats.shownLevels.join(" ");
      const budget = state.lod.splatBudget > 0 ? `${formatCount(state.lod.splatBudget)} ${state.lod.budgetMode}` : "none";
      lodMonitor.shown = `${formatCount(stats.shown)} · ${formatCount(stats.selected)} · ${budget}`;
      lodMonitor.resident = `${stats.residentFiles} files, ${formatCount(stats.residentSplats)}`;
      lodMonitor.loading = `${stats.loading} now, ${stats.loaded} done, ${stats.evicted} evicted${stats.failed ? `, ${stats.failed} failed` : ""}`;
      lodMonitor.waiting = TIERS.map((tier, i) => `${tier} ${stats.waiting[i]}`).reverse().join(", ");
      lodMonitor.decode = stats.decodeMs.toFixed(1);
    },
    profile(profile                        ) {
      if (!profile) {
        return;
      }
      const sum = (values                        ) => Object.values(values).reduce((a, b) => a + b, 0);
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


//# sourceURL=examples/sogs/gui.ts