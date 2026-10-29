// The gallery: a kind with parameters, a palette, a lighting style, a view
// and the light. Anything left out keeps the kind's or the style's default.
import type { Look } from "./shade.js";

export interface Preset {
  name: string;
  kind: string;
  params?: Record<string, number>;
  palette: string;
  style: string;
  look?: Partial<Look>;
  // Degrees, display units
  view?: { distance?: number; azimuth?: number; elevation?: number; fov?: number; target?: [number, number, number] };
  light?: { azimuth: number; elevation: number };
  sampling?: "orbit" | "camera";
  bloom?: number;
  exposure?: number;
  // Depth of field (tangent of the aperture's half-angle)
  aperture?: number;
  // 4D turn, radians per second
  turn?: number;
}

export const PRESETS: Preset[] = [
  {
    name: "Golden Hour Bulb", kind: "mandelbulb", palette: "gold", style: "gilded",
    look: { frequency: 1.1, shift: 0.05, accent: 0.25 }, view: { distance: 3.4, azimuth: 30, elevation: 18 }, light: { azimuth: 35, elevation: 38 }, bloom: 0.35,
  },
  {
    name: "Neon Bulb", kind: "mandelbulb", params: { power: 8, twist: 0.6 }, palette: "cyber", style: "neon",
    look: { frequency: 1.6, cycle: 0.03, accent: 0.6 }, view: { distance: 3.3, azimuth: -20, elevation: 25 }, light: { azimuth: -60, elevation: 30 }, bloom: 1,
  },
  {
    name: "Ninefold Pearl", kind: "mandelbulb", params: { power: 9 }, palette: "opal", style: "dreamy",
    look: { frequency: 2.2 }, view: { distance: 3.2, azimuth: 60, elevation: 40 }, light: { azimuth: 120, elevation: 55 }, bloom: 0.45,
  },
  {
    name: "Julia Bowl", kind: "mandelbulb", params: { power: 4, julia: 1, cx: 0.3, cy: -0.5, cz: 0.4 }, palette: "sunset", style: "studio",
    look: { frequency: 1.3, accent: 0.5 }, view: { distance: 3.2, azimuth: 10, elevation: 35 }, light: { azimuth: 50, elevation: 45 }, bloom: 0.5,
  },
  {
    name: "Totem", kind: "mandelbulb", params: { power: 3 }, palette: "psychedelic", style: "studio",
    look: { frequency: 0.7, shift: 0.15, accent: 0.4, saturation: 0.9 }, view: { distance: 3.1, azimuth: 20, elevation: 12 }, light: { azimuth: -40, elevation: 40 }, bloom: 0.5,
  },
  {
    name: "Sandstone Ruins", kind: "mandelbox", params: { scale: -2.6, iterations: 14 }, palette: "desert", style: "dramatic",
    look: { frequency: 1.3, accent: 0.4, ambient: 0.7, fog: 0.05 }, view: { distance: 3.2, azimuth: 40, elevation: 30 }, light: { azimuth: 60, elevation: 35 }, bloom: 0.25,
  },
  {
    name: "Ice Cathedral", kind: "mandelbox", params: { scale: 3, minRadius: 0.5, iterations: 14 }, palette: "ice", style: "studio", sampling: "camera",
    look: { frequency: 1.8, accent: 0.5, ambient: 1.4, shadows: 0.3, key: 2.2, fog: 0.6 }, view: { distance: 0.45, azimuth: 30, elevation: 20 },
    light: { azimuth: -40, elevation: 50 }, bloom: 0.6,
  },
  {
    name: "Golden Reliquary", kind: "mandelbox", params: { scale: 3, minRadius: 0.5, iterations: 14 }, palette: "gold", style: "gilded", sampling: "camera",
    look: { frequency: 1.2, ambient: 1.2, shadows: 0.4, key: 2.2, fog: 0.5 }, view: { distance: 0.6, azimuth: 45, elevation: 30 },
    light: { azimuth: 30, elevation: 40 }, bloom: 0.5,
  },
  {
    name: "Candy Sponge", kind: "menger", params: { angleA: 0.05, angleB: 0.08 }, palette: "candy", style: "dreamy",
    look: { frequency: 1.6, accent: 0.5 }, view: { distance: 3.6, azimuth: 30, elevation: 28 }, light: { azimuth: 40, elevation: 55 }, bloom: 0.3, exposure: 0.9,
  },
  {
    name: "Clay Menger", kind: "menger", palette: "clay", style: "clay",
    view: { distance: 3.4, azimuth: 35, elevation: 30 }, light: { azimuth: 50, elevation: 40 }, bloom: 0.1,
  },
  {
    name: "Sierpinski Spire", kind: "sierpinski", params: { scale: 2.3, offset: 0.9 }, palette: "sunset", style: "studio",
    look: { frequency: 1.5, accent: 0.4 }, view: { distance: 2.9, azimuth: 45, elevation: 32 }, light: { azimuth: -30, elevation: 40 }, bloom: 0.5,
  },
  {
    name: "Crystal Lattice", kind: "octahedral", params: { ox: 1, oy: 1, oz: 1, angleA: 0.04, angleB: 0.03, scale: 2.5 }, palette: "aurora", style: "hologram",
    look: { frequency: 1.4, opacity: 0.85 }, view: { distance: 3.9, azimuth: 25, elevation: 30 }, light: { azimuth: 40, elevation: 50 }, bloom: 1.1,
  },
  {
    name: "Amethyst Geode", kind: "octahedral", params: { ox: 1, oy: 1, oz: 0, angleA: 0.12, angleB: -0.08, scale: 2.1 }, palette: "amethyst", style: "gilded",
    look: { frequency: 1.2, accent: 0.4 }, view: { distance: 3.3, azimuth: -30, elevation: 20 }, light: { azimuth: 70, elevation: 35 }, bloom: 0.5,
  },
  {
    name: "Faceted Gem", kind: "octahedral", params: { ox: 1, oy: 0.6, oz: 0, angleA: 0.05, angleB: 0, scale: 2.4 }, palette: "ice", style: "gilded",
    look: { frequency: 1.5, accent: 0.5 }, view: { distance: 3.3, azimuth: 20, elevation: 25 }, light: { azimuth: -50, elevation: 45 }, bloom: 0.7,
  },
  {
    name: "Quaternion Bloom", kind: "quaternion", palette: "ocean", style: "studio",
    look: { frequency: 1.5, accent: 0.5, rim: 0.5 }, view: { distance: 3.2, azimuth: 0, elevation: 15 }, light: { azimuth: 40, elevation: 45 }, bloom: 0.55,
  },
  {
    name: "Apollonian Pearl", kind: "apollonian", palette: "opal", style: "studio",
    look: { frequency: 1.2 }, view: { distance: 3.6, azimuth: 25, elevation: 25 }, light: { azimuth: 45, elevation: 50 }, bloom: 0.4,
  },
  {
    name: "Kleinian Forest", kind: "kleinian", palette: "jade", style: "bioluminescent",
    look: { frequency: 1.6, accent: 0.5 }, view: { distance: 3.5, azimuth: 15, elevation: 30 }, light: { azimuth: 30, elevation: 60 }, bloom: 0.9,
  },
  {
    name: "Ember Flame", kind: "flame", params: { form: 0, seed: 512 }, palette: "inferno", style: "neon",
    look: { frequency: 1, opacity: 0.16, glow: 2.8 }, view: { distance: 3.4, azimuth: 0, elevation: 10 }, bloom: 0.9,
  },
  {
    name: "Spectral Flame", kind: "flame", params: { form: 0, seed: 300, symmetry: 2 }, palette: "rainbow", style: "neon",
    look: { frequency: 1, opacity: 0.16, glow: 2.6, twinkle: 0.2 }, view: { distance: 3.4, azimuth: 20, elevation: 15 }, bloom: 0.8,
  },
  {
    name: "Sierpinski Dust", kind: "flame", params: { form: 1, size: 0.002 }, palette: "aurora", style: "neon",
    look: { frequency: 1, opacity: 0.3, glow: 2, twinkle: 0.3 }, view: { distance: 3.3, azimuth: 45, elevation: 35 }, bloom: 0.8,
  },
  {
    name: "Menger Dust", kind: "flame", params: { form: 2, size: 0.002 }, palette: "vaporwave", style: "neon",
    look: { frequency: 1, opacity: 0.22, glow: 2 }, view: { distance: 3.4, azimuth: 35, elevation: 30 }, bloom: 0.8,
  },
  {
    name: "Buddha in 4D", kind: "nebula", params: { size: 0.0015 }, palette: "nebula", style: "neon",
    look: { frequency: 1.6, shift: -0.25, opacity: 0.03, glow: 6, twinkle: 0.15 }, view: { distance: 3, azimuth: 0, elevation: 0 }, bloom: 0.45, turn: 0.05,
  },
  {
    name: "Anti-Buddha", kind: "nebula", params: { inverted: 1, maxIterations: 200, size: 0.0015 }, palette: "amethyst", style: "neon",
    look: { frequency: 2, opacity: 0.05, glow: 5 }, view: { distance: 2.8, azimuth: 0, elevation: 0 }, bloom: 0.5, turn: 0.04,
  },
  {
    name: "Aizawa Silk", kind: "aizawa", palette: "rainbow", style: "studio",
    look: { frequency: 0.6, accent: 1, pulse: 0.7, opacity: 0.3 }, view: { distance: 3.2, azimuth: 30, elevation: 12 }, light: { azimuth: 30, elevation: 60 }, bloom: 0.8,
  },
  {
    name: "Lorenz Fire", kind: "lorenz", palette: "fire", style: "neon",
    look: { frequency: 1, pulse: 0.8, opacity: 0.35, glow: 1.6 }, view: { distance: 3.3, azimuth: 0, elevation: 5 }, bloom: 0.7,
  },
  {
    name: "Thomas Knot", kind: "thomas", palette: "ocean", style: "studio",
    look: { frequency: 1, pulse: 0.6 }, view: { distance: 3.2, azimuth: 40, elevation: 30 }, light: { azimuth: 30, elevation: 50 }, bloom: 0.8,
  },
  {
    name: "Halvorsen Bloom", kind: "halvorsen", palette: "vaporwave", style: "neon",
    look: { frequency: 1, pulse: 0.7 }, view: { distance: 3.4, azimuth: 45, elevation: 35 }, bloom: 1,
  },
  {
    name: "Dadras Orbit", kind: "dadras", palette: "toxic", style: "studio",
    look: { frequency: 1, pulse: 0.6 }, view: { distance: 3.4, azimuth: 10, elevation: 20 }, light: { azimuth: -20, elevation: 50 }, bloom: 0.8,
  },
  {
    name: "Sakura", kind: "tree", palette: "sakura", style: "studio",
    look: { frequency: 1, sway: 1, petals: 1, ambient: 0.6, fog: 0.1 }, view: { distance: 4.4, azimuth: 20, elevation: 6, target: [0, -0.15, 0] }, light: { azimuth: 50, elevation: 45 }, bloom: 0.35,
  },
  {
    name: "Neon Grove", kind: "tree", params: { branches: 2, spread: 0.55, depth: 12, blossoms: 0.1, blossomSize: 0.005, seed: 4 }, palette: "cyber", style: "neon",
    look: { frequency: 1, sway: 0.7, petals: 0.6 }, view: { distance: 4.4, azimuth: -20, elevation: 10, target: [0, -0.15, 0] }, light: { azimuth: 50, elevation: 45 }, bloom: 1,
  },
];
