import type { FolderApi } from "tweakpane";
import type { CameraControls, CameraControlsSettings } from "@sparkjsdev/radix";

export function addControlsFolder(parent: Pick<FolderApi, "addFolder">, controls: CameraControls) {
  const folder = parent.addFolder({ title: "Controls", expanded: false });
  // Bindings edit a copy, and set() applies the user's changes but not refresh()'s
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

  folder.addButton({ title: "reset" }).on("click", () => controls.reset());

  // Follow changes made elsewhere, such as the bar's mode buttons and reset
  controls.onChange = (settings) => {
    const { inertia: inertiaValues, ...rest } = structuredClone(settings);
    Object.assign(state, rest);
    Object.assign(state.inertia, inertiaValues);
    syncing = true;
    folder.refresh();
    syncing = false;
  };
}
