// Tweakpane v4 panel of the LCC viewer, after examples/splats/gui.ts.
// Bindings write straight into the viewer state, the streamer's settings and
// the splat renderer and its params, which main.ts, the streamer and the
// renderer apply every frame; changes that need work (framing, export) go
// through actions. Every folder but Monitors starts collapsed.
import * as EssentialsPlugin from "@tweakpane/plugin-essentials";
import { Pane,                                    } from "tweakpane";
                                                   
import { Hdr,                                                                            } from "@sparkjsdev/radix";
import { addControlsFolder } from "./controlsPane.js";
                                                            
                                             

const fixed = (digits        ) => (v        ) => v.toFixed(digits);
// GPU "-": no timestamps (GPU timing off)
const ms = (gpu                    , cpu        ) => `${gpu === undefined ? "-" : gpu.toFixed(2)} · ${cpu.toFixed(2)}`;

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

// Nested plain objects (a preset) into the target, key by key: only keys
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

                          
                
                
                 
                 
                
                 
             
                      
                    
               
 

export function makeGui({ state, settings, hdr, renderer, profiler, splats, controls, actions }   
                     
                                
               
                           
                         
                        
                           
            
                  
                      
                       
                       
    
 ) {
  const pane = new Pane({ title: "Radix LCC" });
  pane.registerPlugin(EssentialsPlugin);
  const folder = (title        , parent                   = pane) => parent.addFolder({ title, expanded: false });
  const slider =                   (c           , target   , key                  , label        , min        , max        , digits = 2) =>
    c.addBinding(target, key, { label, min, max, step: 10 ** -digits, format: fixed(digits) });

  // --- Monitors ---
  const monitors = pane.addFolder({ title: "Monitors" });
  const fpsGraph = monitors.addBlade({ view: "fpsgraph", label: "fps", rows: 2, min: 0, max: 144 })                                             ;
  const frame = { ms: ms(undefined, 0) };
  const values          = { scene: "none", drawn: "0", levels: "", blocks: "", cache: "", decode: "", sh: "", environment: "", collision: "", walk: "" };
  monitors.addBinding(values, "scene", { readonly: true });
  monitors.addBinding(frame, "ms", { readonly: true, label: "GPU · CPU ms" });
  // GPU timestamps cost frame time (their queries resolve every report), so
  // they start off (?profile=1 starts them on); CPU phases are timed either way
  if (profiler) {
    const timing = { get on() { return profiler.active; }, set on(value         ) { profiler.active = value; } };
    monitors.addBinding(timing, "on", { label: profiler.supported ? "GPU timing" : "GPU timing (n/a)", disabled: !profiler.supported });
  }
  monitors.addBinding(values, "drawn", { readonly: true, label: "drawn (in view)" });
  monitors.addBinding(values, "levels", { readonly: true, label: "per level" });
  monitors.addBinding(values, "blocks", { readonly: true, label: "blocks" });
  monitors.addBinding(values, "cache", { readonly: true, label: "GPU cache" });
  monitors.addBinding(values, "decode", { readonly: true, label: "decoded" });
  monitors.addBinding(values, "sh", { readonly: true, label: "SH" });
  monitors.addBinding(values, "environment", { readonly: true, label: "environment" });
  monitors.addBinding(values, "collision", { readonly: true, label: "collision" });
  monitors.addBinding(values, "walk", { readonly: true, label: "walk" });
  const phaseFolder = monitors.addFolder({ title: "Phases  (GPU · CPU ms)", expanded: false });
  const phases                         = {};

  // --- Level of detail ---
  const lod = folder("Level of detail");
  const level = { auto: settings.level === "auto", fixed: settings.level === "auto" ? 0 : settings.level };
  const fixedLevel = lod.addBinding(level, "fixed", { label: "fixed level", min: 0, max: 7, step: 1 });
  lod.addBinding(level, "auto", { label: "auto (by distance)" }).on("change", () => {
    settings.level = level.auto ? "auto" : level.fixed;
  });
  fixedLevel.on("change", () => {
    if (!level.auto) {
      settings.level = level.fixed;
    }
  });
  slider(lod, settings, "lodDistance", "level 0 within", 0.05, 50);
  slider(lod, settings, "hysteresis", "hysteresis (v1)", 0, 1);
  slider(lod, settings, "behindPenalty", "behind penalty (LCC2)", 1, 4);
  lod.addBinding(settings, "budget", { label: "splat budget", min: 100_000, max: 20_000_000, step: 100_000, format: (v        ) => `${(v / 1e6).toFixed(1)} M` });
  lod.addBinding(settings, "budgetMode", segmented("budget (LCC2)", ["limit", "target"]));
  const cache = { mb: settings.cacheBytes / 1e6 };
  lod.addBinding(cache, "mb", { label: "GPU cache (MB)", min: 128, max: 8192, step: 64 }).on("change", () => (settings.cacheBytes = cache.mb * 1e6));
  lod.addBinding(settings, "freeze", { label: "freeze selection" });
  lod.addBinding(settings, "colorByLevel", { label: "color by level" });
  lod.addBinding(settings, "environment", { label: "environment" });
  lod.addBinding(state, "showCells", { label: "cell boxes" });

  // --- Collision: the debug overlay and walk mode (G) ---
  const collision = folder("Collision");
  const c = state.collision;
  collision.addBinding(c, "mesh", { label: "wireframe" });
  collision.addBinding(c, "boxes", { label: "chunk boxes" });
  collision.addBinding(c, "leaves", { label: "BVH boxes" });
  collision.addBinding(c, "leafDepth", { label: "BVH depth", min: 0, max: 24, step: 1 });
  collision.addBinding(c, "depthTest", { label: "depth test" });
  slider(collision, c, "opacity", "opacity", 0.05, 1);
  collision.addBinding(c, "radius", { label: "load radius", min: 5, max: 1000, step: 5 });
  collision.addButton({ title: "Walk / stop (G)" }).on("click", () => actions.toggleWalk());
  const walk = state.walk;
  slider(collision, walk, "eyeHeight", "eye height", 0.05, 3);
  slider(collision, walk, "radius", "radius", 0.01, 1);
  slider(collision, walk, "stepHeight", "step height", 0, 1);
  slider(collision, walk, "speed", "walk speed", 0.1, 5);
  slider(collision, walk, "gravity", "gravity", 0, 30, 1);
  slider(collision, walk, "jumpSpeed", "jump speed", 0, 10, 1);

  // --- Spherical harmonics ---
  const sh = folder("Spherical harmonics");
  sh.addBinding(state.sh, "enabled", { label: "on" });
  sh.addBinding(state.sh, "degree", segmented("degree", [0, 1, 2, 3]));

  // --- Renderer (method, sort and key bits are in the quick bar) ---
  const p = splats.params;
  const o = splats.objectParams;
  const render = folder("Renderer");
  const cpuSort = folder("CPU sort (WebGL2 fallback)", render);
  slider(cpuSort, o, "sortGuard", "guard band", 0, 3);
  if (splats.autoSort) {
    slider(cpuSort, splats.autoSort, "distance", "re-sort after (m)", 0, 1, 3);
    const autoSort = splats.autoSort;
    const turn = { get degrees() { return autoSort.angle * 180 / Math.PI; }, set degrees(value) { autoSort.angle = value * Math.PI / 180; } };
    slider(cpuSort, turn, "degrees", "or after (deg)", 0, 45, 1);
  }

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
  slider(lens, o, "focalDistance", "focal dist", 0, 20);
  slider(lens, o, "apertureTan", "aperture tan", 0, 0.05, 3);

  // --- Display: HDR canvas, headroom tone mapping, background ---
  const display = folder("Display");
  const output = { extended: hdr };
  display.addBinding(output, "extended", { label: hdr ? "HDR canvas" : "HDR (?hdr=1)", disabled: !hdr }).on("change", (event) => Hdr.setOutput(renderer, event.value));
  const toneMapping = Hdr.useToneMapping(renderer, { enabled: false });
  display.addBinding(toneMapping, "enabled", { label: "tone mapping" });
  slider(display, toneMapping.headroom                     , "value", "headroom", 1, 16);
  display.addBinding(toneMapping, "exposure", { min: 0, max: 4, format: fixed(2) });
  display.addBinding(state, "background", { color: { type: "float" } });

  addControlsFolder(pane, controls);

  const camera = folder("Camera");
  camera.addButton({ title: "Start view" }).on("click", () => actions.resetView());
  camera.addButton({ title: "Frame" }).on("click", () => actions.frame());

  // --- Export: the drawn blocks as ext splats, in the file's frame ---
  const exporter = folder("Export");
  exporter.addBinding(state, "exportFormat", segmented("format", ["rdx", "ply", "compressed-ply", "spz"], ["rdx", "ply", "c.ply", "spz"]));
  // Read as each block decodes; without copies, export reads the GPU back
  exporter.addBinding(settings, "keepCpu", { label: "keep CPU copies" });
  exporter.addButton({ title: "Download drawn blocks" }).on("click", () => actions.exportFile());

  // --- Presets: LoD, SH and render settings as JSON ---
  const presets = folder("Presets");
  const preset = { json: "" };
  presets.addButton({ title: "Export to JSON (copies)" }).on("click", () => {
    preset.json = JSON.stringify({ settings, sh: state.sh, method: splats.method, sortBits: splats.sortBits, params: p, objectParams: o });
    void navigator.clipboard?.writeText(preset.json);
    pane.refresh();
  });
  presets.addBinding(preset, "json", { label: "json", multiline: true, rows: 3 });
  presets.addButton({ title: "Import JSON" }).on("click", () => {
    const parsed = JSON.parse(preset.json)                                                                                                                                                      ;
    assignDeep(settings, parsed.settings);
    assignDeep(state.sh, parsed.sh);
    assignDeep(p, parsed.params);
    assignDeep(o, parsed.objectParams);
    splats.method = parsed.method ?? splats.method;
    splats.sortBits = parsed.sortBits ?? splats.sortBits;
    level.auto = settings.level === "auto";
    level.fixed = settings.level === "auto" ? level.fixed : settings.level;
    cache.mb = settings.cacheBytes / 1e6;
    pane.refresh();
  });

  return {
    frameBegin: () => fpsGraph.begin(),
    frameEnd: () => fpsGraph.end(),
    refresh() {
      level.auto = settings.level === "auto";
      if (settings.level !== "auto") {
        level.fixed = settings.level;
      }
      pane.refresh();
    },
    monitor(next                  ) {
      Object.assign(values, next);
    },
    profile(profile                        ) {
      if (!profile) {
        return;
      }
      const sum = (entries                        ) => Object.values(entries).reduce((a, b) => a + b, 0);
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


//# sourceURL=examples/lcc/gui.ts