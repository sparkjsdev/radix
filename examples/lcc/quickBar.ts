// The bar at the top left, after examples/splats/quickBar.ts: a sample
// scene, Open a scene folder or a meta.lcc URL, the LoD level (auto or one
// level everywhere), spherical harmonics, the environment (background
// splats), then method, sort, key bits,
// camera mode (orbit, fly or walk) and pixel ratio as segmented buttons, and fps with the splats
// drawn (its "?" lists the camera controls). The frame loop calls
// refresh(), so it follows changes made elsewhere (the panel, the F key).
import type { CameraControls, CameraControlsMode, ProjectionMethod, SortKeyBits, SplatRenderer } from "@sparkjsdev/radix";
import { SAMPLES, type LccSample } from "./catalog.js";
import type { LccStreamerSettings } from "./LccStreamer.js";
import type { ViewerState } from "./main.js";

export function makeQuickBar(bar: HTMLElement, { state, settings, webgpu, splats, controls, sample, levels, hasSh, hasEnvironment, walk, actions }: {
  state: ViewerState;
  settings: LccStreamerSettings;
  webgpu: boolean;
  splats: SplatRenderer;
  controls: CameraControls;
  // The sample shown, if the scene is one
  sample(): LccSample | undefined;
  // The scene's level count and whether it has SH and an environment
  levels(): number;
  hasSh(): boolean;
  hasEnvironment(): boolean;
  // Walk mode: on, possible (the scene has collision), switched
  walk: { active(): boolean; available(): boolean; set(on: boolean): void };
  actions: { pickFolder(): void; openUrl(url: string): void; openSample(name: string): void };
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

  // Buttons for a few choices; the one matching get() is lit
  const segmented = <T>(element: HTMLElement, choices: [T, string][], get: () => T, set: (value: T) => void, disabled = () => false) => {
    const buttons = choices.map(([value, textContent]) => {
      const button = Object.assign(document.createElement("button"), { textContent, onclick: () => set(value) });
      element.append(button);
      return { button, value };
    });
    refreshers.push(() => buttons.forEach(({ button, value }) => {
      button.classList.toggle("active", value === get());
      button.disabled = disabled();
    }));
  };

  const openButton = Object.assign(document.createElement("button"), {
    textContent: "Open folder...", title: "Open an LCC or LCC2 scene folder (or drop one anywhere)", onclick: () => actions.pickFolder(),
  });
  const url = Object.assign(document.createElement("input"), { type: "url", placeholder: ".lcc / .lcc2 URL + Enter" });
  url.onkeydown = (event) => {
    if (event.key === "Enter" && url.value.trim()) {
      actions.openUrl(url.value.trim());
      url.value = "";
      url.blur();
    }
  };
  group().append(openButton, url);

  // Blank while the scene shown is not a sample
  const select = Object.assign(document.createElement("select"), { title: "Sample scenes" });
  select.append(...Object.entries(SAMPLES).map(([name, sample]) => new Option(sample.label, name)));
  select.onchange = () => {
    actions.openSample(select.value);
    select.blur();
  };
  group("scene").append(select);
  refreshers.push(() => {
    const shown = sample();
    const index = shown ? Object.values(SAMPLES).indexOf(shown) : -1;
    if (select.selectedIndex !== index) {
      select.selectedIndex = index;
    }
  });

  // One button per level of the scene shown, rebuilt when the count changes
  const levelGroup = group("LoD");
  let levelButtons: { button: HTMLButtonElement; value: "auto" | number }[] = [];
  refreshers.push(() => {
    const count = levels();
    if (levelButtons.length !== count + 1) {
      levelGroup.querySelectorAll("button").forEach((button) => button.remove());
      levelButtons = (["auto", ...Array.from({ length: count }, (_, i) => i)] as ("auto" | number)[]).map((value) => {
        const button = Object.assign(document.createElement("button"), {
          textContent: value === "auto" ? "auto" : `L${value}`,
          title: value === "auto" ? "Per cell, by distance" : `Level ${value} everywhere`,
          onclick: () => (settings.level = value),
        });
        levelGroup.append(button);
        return { button, value };
      });
    }
    levelButtons.forEach(({ button, value }) => button.classList.toggle("active", value === settings.level));
  });

  segmented(group("SH"), [[true, "on"], [false, "off"]], () => state.sh.enabled && hasSh(), (v) => (state.sh.enabled = v), () => !hasSh());
  const env = group("env");
  env.title = "environment.bin: background splats outside the grid";
  segmented(env, [[true, "on"], [false, "off"]], () => settings.environment && hasEnvironment(), (v) => (settings.environment = v), () => !hasEnvironment());

  const methods: ProjectionMethod[] = ["ewa", "3dgut", "htgs", "raygs"];
  segmented(group("method"), methods.map((m) => [m, m]), () => splats.method, (v) => (splats.method = v));
  const sort = group("sort");
  sort.title = webgpu ? "gpu: WgpuSplatSorter; cpu: the WebGL2 fallback's worker sort" : "The GPU sort needs WebGPU";
  segmented<"gpu" | "cpu">(sort, [["gpu", "gpu"], ["cpu", "cpu"]], () => splats.sortMode, (v) => (splats.sortMode = v), () => !webgpu);
  segmented<SortKeyBits>(group("bits"), [[16, "16"], [24, "24"], [32, "32"]], () => splats.sortBits, (v) => (splats.sortBits = v));
  const camera = group("camera");
  camera.title = "F switches orbit / fly, G walks (scenes with collision)";
  segmented<CameraControlsMode | "walk">(camera, [["orbit", "orbit"], ["fly", "fly"]], () => (walk.active() ? "walk" : controls.mode), (v) => {
    walk.set(false);
    controls.mode = v as CameraControlsMode;
  });
  const walkButton = Object.assign(document.createElement("button"), { textContent: "walk", onclick: () => walk.set(!walk.active()) });
  camera.append(walkButton);
  refreshers.push(() => {
    walkButton.classList.toggle("active", walk.active());
    walkButton.disabled = !walk.available();
    walkButton.title = walk.available() ? "Walk on the collision mesh (G); Space jumps, Shift runs" : "This scene has no collision mesh";
  });
  const px = group("px");
  px.title = `Pixel ratio: 1 or the device's (${devicePixelRatio})`;
  segmented(px, [[false, "1x"], [true, "device"]], () => state.devicePixels, (v) => (state.devicePixels = v));

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
      "G: walk on the collision mesh (scenes that have one), Space: jump, Shift: run",
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
