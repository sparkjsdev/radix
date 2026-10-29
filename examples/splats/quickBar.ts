// The bar at the top left: open a file or a URL, a sample, then the settings
// changed most (method, sort, key bits, SH degree, camera mode, pixel ratio) as
// segmented buttons, and fps with the splat count (its "?" lists the camera
// controls). The frame loop calls refresh(), so it follows changes made
// elsewhere (the panel, the F key, a preset).
import type { CameraControls, CameraControlsMode, ProjectionMethod, SortKeyBits, SplatRenderer } from "@sparkjsdev/radix";
import { SCANS, type Scan } from "./catalog.js";
import type { ViewerState } from "./main.js";

export function makeQuickBar(bar: HTMLElement, { state, webgpu, splats, controls, sample, shDegree, actions }: {
  state: ViewerState;
  webgpu: boolean;
  splats: SplatRenderer;
  controls: CameraControls;
  // The sample shown, if the file is one
  sample(): Scan | undefined;
  // The file's spherical-harmonics degree (0 without)
  shDegree(): number;
  actions: { pickFile(): void; openUrl(url: string): void; openSample(name: string): void };
}) {
  const refreshers: (() => void)[] = [];

  const group = (label = "") => {
    const element = Object.assign(document.createElement("div"), { className: "bar-group" });
    if (label) {
      element.append(Object.assign(document.createElement("span"), { className: "bar-label", textContent: label }));
    }
    bar.append(element);
    return element;
  };

  // Buttons for a few choices; the one matching get() is lit, those
  // enabled() refuses are greyed out
  const segmented = <T>(label: string, choices: [T, string][], get: () => T, set: (value: T) => void,
    { disabled = false, enabled = () => true, title = "" }: { disabled?: boolean; enabled?: (value: T) => boolean; title?: string } = {}) => {
    const element = group(label);
    element.title = title;
    const buttons = choices.map(([value, textContent]) => {
      const button = Object.assign(document.createElement("button"), { textContent, disabled, onclick: () => set(value) });
      element.append(button);
      return { button, value };
    });
    refreshers.push(() => buttons.forEach(({ button, value }) => {
      button.classList.toggle("active", value === get());
      button.disabled = disabled || !enabled(value);
    }));
  };

  const openButton = Object.assign(document.createElement("button"), {
    textContent: "Open...", title: "Open a .ply, .spz, .rad or .rdx file (or drop one anywhere)", onclick: () => actions.pickFile(),
  });
  const url = Object.assign(document.createElement("input"), { type: "url", placeholder: "URL + Enter" });
  url.onkeydown = (event) => {
    if (event.key === "Enter" && url.value.trim()) {
      actions.openUrl(url.value.trim());
      url.value = "";
      url.blur();
    }
  };
  group().append(openButton, url);

  // Blank while the file shown is not a sample
  const select = Object.assign(document.createElement("select"), { title: "Sample splats (hosted RDX files)" });
  select.append(...Object.entries(SCANS).map(([name, scan]) => new Option(scan.label, name)));
  select.onchange = () => {
    actions.openSample(select.value);
    select.blur();
  };
  group("sample").append(select);
  refreshers.push(() => {
    const scan = sample();
    const index = scan ? Object.values(SCANS).indexOf(scan) : -1;
    if (select.selectedIndex !== index) {
      select.selectedIndex = index;
    }
  });

  const methods: ProjectionMethod[] = ["ewa", "3dgut", "htgs", "raygs"];
  segmented("method", methods.map((m) => [m, m]), () => splats.method, (v) => (splats.method = v));
  segmented<"gpu" | "cpu">("sort", [["gpu", "gpu"], ["cpu", "cpu"]], () => splats.sortMode, (v) => (splats.sortMode = v),
    { disabled: !webgpu, title: webgpu ? "gpu: WgpuSplatSorter; cpu: the WebGL2 fallback's worker sort" : "The GPU sort needs WebGPU" });
  segmented<SortKeyBits>("bits", [[16, "16"], [24, "24"], [32, "32"]], () => splats.sortBits, (v) => (splats.sortBits = v));
  // Lit: the degree drawn (the highest allowed, up to the file's)
  segmented("SH", [[0, "0"], [1, "1"], [2, "2"], [3, "3"], [4, "4"]], () => Math.min(splats.objectParams.maxShDegree, shDegree()), (v) => (splats.objectParams.maxShDegree = v),
    { enabled: (v) => v <= shDegree(), title: "Highest spherical-harmonics degree drawn, up to the file's (?sh=0 skips them on load)" });
  segmented<CameraControlsMode>("camera", [["orbit", "orbit"], ["fly", "fly"]], () => controls.mode, (v) => (controls.mode = v), { title: "F switches" });
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
    monitor(fps: number, count: number) {
      stats.textContent = `${Math.round(fps)} fps · ${formatCount(count)} splats`;
    },
  };
}

export function formatCount(v: number) {
  return v >= 1e6 ? `${(v / 1e6).toFixed(2)} M` : v >= 1e4 ? `${(v / 1e3).toFixed(1)} k` : v.toFixed(0);
}
