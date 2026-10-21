import { THEMES, type MotionPreset, type ThemeName } from "./themes.js";

export interface EditorSettings {
  theme: ThemeName;
  // No springs: everything jumps into place
  instant: boolean;
  motion: Record<ThemeName, MotionPreset>;
  // Flow preview cycles per second
  flowSpeed: number;
  muted: boolean;
  volume: number;
  // Editor pane width as a fraction of the window
  split: number;
  // The display's pixel ratio, at most 2, instead of 1, for objects and for scenes
  hiDpi: boolean;
  hiDpiScenes: boolean;
  layerSpacing: number;
  nodeSpacing: number;
}

const KEY = "radix-fxedit";

export function defaultSettings(): EditorSettings {
  return {
    theme: "glass",
    instant: false,
    motion: {
      neon: { ...THEMES.neon.motion },
      toybox: { ...THEMES.toybox.motion },
      glass: { ...THEMES.glass.motion },
    },
    flowSpeed: 0.7,
    muted: true,
    volume: 0.5,
    split: 0.56,
    hiDpi: false,
    hiDpiScenes: true,
    layerSpacing: 48,
    nodeSpacing: 22,
  };
}

export function loadSettings(): EditorSettings {
  const settings = defaultSettings();
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<EditorSettings>;
    const { motion, ...rest } = saved;
    Object.assign(settings, rest);
    for (const name of Object.keys(settings.motion) as ThemeName[]) {
      Object.assign(settings.motion[name], motion?.[name]);
    }
    if (!(settings.theme in THEMES)) {
      settings.theme = "glass";
    }
  } catch {
    // Unreadable settings: the defaults
  }
  return settings;
}

export function saveSettings(settings: EditorSettings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    // Private mode or full storage: settings last for this page only
  }
}
