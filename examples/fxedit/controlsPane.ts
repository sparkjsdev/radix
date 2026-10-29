// Tweakpane folder for Radix's CameraControls: every setting, saved as it
// changes (personal settings for all pages, the rest for the page's
// storageKey), plus buttons to reset them.
import type { FolderApi } from "tweakpane";
import type { CameraControls, CameraControlsSettings } from "@sparkjsdev/radix";

export function addControlsFolder(parent: Pick<FolderApi, "addFolder">, controls: CameraControls) {
  const folder = parent.addFolder({ title: "Controls", expanded: false });
  // Bindings edit a copy; set() applies and saves each change (not the
  // changes refresh() makes while following the controls)
  const state = structuredClone(controls.settings);
  let syncing = false;
  const apply = (settings: Partial<CameraControlsSettings>) => {
    if (!syncing) {
      controls.set(settings);
    }
  };
  const bind = <K extends keyof CameraControlsSettings>(key: K, options: Record<string, unknown> = {}) =>
    folder.addBinding(state, key, options).on("change", () => apply({ [key]: structuredClone(state[key]) }));

  bind("mode", { options: { fly: "fly", orbit: "orbit" } });
  bind("pointerLock", { label: "lock pointer (fly)" });
  bind("moveSpeed", { label: "move speed", min: 0.05, max: 20 });
  bind("capsMultiplier", { label: "caps lock x", min: 1, max: 100 });
  bind("lookSpeed", { label: "turn speed", min: 0.1, max: 6 });
  bind("pointerLookSpeed", { label: "drag look", min: 0.0005, max: 0.01, step: 0.0005 });
  bind("pointerPanSpeed", { label: "drag pan", min: 0.0002, max: 0.01, step: 0.0002 });
  bind("zoomSpeed", { label: "zoom", min: 0.0002, max: 0.01, step: 0.0001 });
  bind("doublePress", { label: "double press ms", min: 0, max: 600, step: 10 });

  const invert = folder.addFolder({ title: "invert", expanded: false });
  for (const [key, label] of [["invertLookX", "look x"], ["invertLookY", "look y"], ["invertPan", "pan"], ["invertZoom", "zoom"], ["invertStickY", "stick y"]] as const) {
    invert.addBinding(state, key, { label }).on("change", () => apply({ [key]: state[key] }));
  }

  const inertia = folder.addFolder({ title: "inertia (s)", expanded: false });
  for (const [key, label] of [["pointerLook", "drag look"], ["pointerMove", "drag pan"], ["look", "key turn"], ["move", "key move"]] as const) {
    inertia.addBinding(state.inertia, key, { label, min: 0, max: 1 }).on("change", () => apply({ inertia: { ...state.inertia } }));
  }

  folder.addButton({ title: "reset this page" }).on("click", () => controls.reset());
  folder.addButton({ title: "reset all (personal too)" }).on("click", () => controls.reset({ personal: true }));

  // Follow changes made elsewhere (the mode key, the quick bar, reset, code)
  controls.onChange = (settings) => {
    const { inertia: inertiaValues, ...rest } = structuredClone(settings);
    Object.assign(state, rest);
    Object.assign(state.inertia, inertiaValues);
    syncing = true;
    folder.refresh();
    syncing = false;
  };
}
