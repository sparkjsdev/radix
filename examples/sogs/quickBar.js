// The bar at the top left: open files or a URL, a sample, then the settings
// changed most (method, sort, key bits, SH degree, camera mode, pixel
// ratio) as segmented buttons, and fps with the splat count (its "?" lists
// the camera controls). The frame loop calls refresh(), so it follows
// changes made elsewhere (the panel, the F key, a preset).
                                                                                                                          
import { SAMPLES,             } from "./catalog.js";
                                             

export function makeQuickBar(bar             , { state, webgpu, splats, controls, sample, actions }   
                     
                  
                        
                           
                                         
                               
                                                                                                                          
 ) {
  const refreshers                 = [];

  const group = (label = "") => {
    const element = Object.assign(document.createElement("div"), { className: "bar-group" });
    if (label) {
      element.append(Object.assign(document.createElement("span"), { className: "bar-label", textContent: label }));
    }
    bar.append(element);
    return element;
  };

  // Buttons for a few choices; the one matching get() is lit
  const segmented =    (label        , choices               , get         , set                    , { disabled = false, title = "" } = {}) => {
    const element = group(label);
    element.title = title;
    const buttons = choices.map(([value, textContent]) => {
      const button = Object.assign(document.createElement("button"), { textContent, disabled, onclick: () => set(value) });
      element.append(button);
      return { button, value };
    });
    refreshers.push(() => buttons.forEach(({ button, value }) => button.classList.toggle("active", value === get())));
  };

  const openButton = Object.assign(document.createElement("button"), {
    textContent: "Open...",
    title: "Open a .sog or .zip, or a SOG folder's meta.json with its .webp files (or drop them, or the folder, anywhere)",
    onclick: () => actions.pickFiles(),
  });
  const url = Object.assign(document.createElement("input"), { type: "url", placeholder: "URL + Enter" });
  url.title = "A .sog / .zip, a meta.json (its .webp files beside it) or a LoD lod-meta.json";
  url.onkeydown = (event) => {
    if (event.key === "Enter" && url.value.trim()) {
      actions.openUrl(url.value.trim());
      url.value = "";
      url.blur();
    }
  };
  group().append(openButton, url);

  // Blank while the file shown is not a sample
  const select = Object.assign(document.createElement("select"), { title: "Sample SOG files and LoD scenes" });
  select.append(...Object.entries(SAMPLES).map(([name, each]) => new Option(each.label, name)));
  select.onchange = () => {
    actions.openSample(select.value);
    select.blur();
  };
  group("sample").append(select);
  refreshers.push(() => {
    const shown = sample();
    const index = shown ? Object.values(SAMPLES).indexOf(shown) : -1;
    if (select.selectedIndex !== index) {
      select.selectedIndex = index;
    }
  });

  const methods                     = ["ewa", "3dgut", "htgs", "raygs"];
  segmented("method", methods.map((m) => [m, m]), () => splats.method, (v) => (splats.method = v));
  segmented               ("sort", [["gpu", "gpu"], ["cpu", "cpu"]], () => splats.sortMode, (v) => (splats.sortMode = v),
    { disabled: !webgpu, title: webgpu ? "gpu: WgpuSplatSorter; cpu: the WebGL2 fallback's worker sort" : "The GPU sort needs WebGPU" });
  segmented             ("bits", [[16, "16"], [24, "24"], [32, "32"]], () => splats.sortBits, (v) => (splats.sortBits = v));
  segmented("SH", [[0, "0"], [1, "1"], [2, "2"], [3, "3"]], () => state.sh, (v) => actions.setSh(v), { title: "Spherical harmonics degree drawn (up to the file's)" });
  segmented                    ("camera", [["orbit", "orbit"], ["fly", "fly"]], () => controls.mode, (v) => (controls.mode = v), { title: "F switches" });
  segmented("px", [[false, "1x"], [true, "device"]], () => state.devicePixels, (v) => (state.devicePixels = v), { title: `Pixel ratio: 1 or the device's (${devicePixelRatio})` });

  const stats = Object.assign(document.createElement("span"), { className: "bar-stats" });
  const help = Object.assign(document.createElement("span"), {
    className: "bar-label",
    textContent: "?",
    title: [
      "drag: look (fly) or orbit (orbit); F switches",
      "double press, then drag: slide",
      "right drag / two fingers: pan",
      "wheel / middle drag / pinch: forward and back (fly) or zoom (orbit)",
      "WASD / arrows: move, Q E: down / up, Shift fast, Ctrl slow, Caps Lock on: 10x",
      "1 2 3: gizmo move / rotate / scale, Esc: gizmo off",
    ].join("\n"),
  });
  group().append(stats, help);

  return {
    refresh: () => refreshers.forEach((refresh) => refresh()),
    monitor(fps        , count        ) {
      stats.textContent = `${Math.round(fps)} fps · ${formatCount(count)} splats`;
    },
  };
}

export function formatCount(v        ) {
  return v >= 1e6 ? `${(v / 1e6).toFixed(2)} M` : v >= 1e4 ? `${(v / 1e3).toFixed(1)} k` : v.toFixed(0);
}


//# sourceURL=examples/sogs/quickBar.ts