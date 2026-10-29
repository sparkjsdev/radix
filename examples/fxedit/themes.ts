// The three looks of the editor: the same behavior with a different skin
// (fxedit.css under body[data-theme]) and different motion and effects.
export type ThemeName = "neon" | "toybox" | "glass";

export interface MotionPreset {
  // Spring constant (1/s^2) and damping ratio (1 = no overshoot)
  stiffness: number;
  damping: number;
  // Degrees of tilt per px/s of horizontal speed while a node moves
  tilt: number;
  // Squash on drop (scale velocity kick)
  squash: number;
  // Delay per world px of x when nodes fly to a new layout (ms)
  stagger: number;
}

export interface Theme {
  name: ThemeName;
  label: string;
  motion: MotionPreset;
  // Rope wires sag and swing (Verlet); bezier wires are drawn exactly
  wire: "bezier" | "rope";
  burst: "sparks" | "confetti" | "ripple";
  // Render full-bleed behind a translucent editor instead of side by side
  overlay: boolean;
  colors: string[];
}

export const THEMES: Record<ThemeName, Theme> = {
  neon: {
    name: "neon",
    label: "Neon Circuit",
    motion: { stiffness: 340, damping: 0.7, tilt: 0.012, squash: 3, stagger: 0.25 },
    wire: "bezier",
    burst: "sparks",
    overlay: false,
    colors: ["#39f3ff", "#ff3df2", "#b8ff3d", "#ffe53d"],
  },
  toybox: {
    name: "toybox",
    label: "Toybox",
    motion: { stiffness: 230, damping: 0.45, tilt: 0.025, squash: 6, stagger: 0.6 },
    wire: "rope",
    burst: "confetti",
    overlay: false,
    colors: ["#ff6b6b", "#ffd93d", "#6bcB77", "#4d96ff", "#c77dff"],
  },
  glass: {
    name: "glass",
    label: "Lab Glass",
    motion: { stiffness: 150, damping: 1, tilt: 0, squash: 0.8, stagger: 0.15 },
    wire: "bezier",
    burst: "ripple",
    overlay: true,
    colors: ["#9fd8ff", "#d3b8ff", "#b8ffe4"],
  },
};

export function themeByName(name: string | null | undefined): Theme | undefined {
  return name && name in THEMES ? THEMES[name as ThemeName] : undefined;
}
