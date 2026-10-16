// Color palettes: five-stop gradients (0..1 runs through the stops, 1..2
// back, so cycling never jumps) or Inigo Quilez's cosine palettes, a + b cos(2 pi (c t + d))
// (iquilezles.org/articles/palettes). Each one also sets the sky (zenith and
// horizon, which is also the fog), the key light's color and the hemisphere
// light under it.
export type Rgb = [number, number, number];

export interface Palette {
  stops?: string[];
  cosine?: [Rgb, Rgb, Rgb, Rgb];
  sky: [string, string];
  key?: string;
  ground?: string;
}

export const PALETTES: Record<string, Palette> = {
  gold: { stops: ["#1c0b03", "#6b300a", "#c27a22", "#f2c76b", "#fff3d1"], sky: ["#0b0806", "#2e2219"], key: "#ffe2b8" },
  sakura: { stops: ["#3a2420", "#6e4638", "#e892ad", "#ffc8d7", "#fff6f8"], sky: ["#8fb8e8", "#fde3ec"], key: "#fff4e6", ground: "#d9b8b0" },
  ice: { stops: ["#071a36", "#1a5c8c", "#58b4dc", "#bde9f7", "#ffffff"], sky: ["#01040b", "#0b2035"], key: "#e6f4ff" },
  inferno: { stops: ["#0d0221", "#5b0e5c", "#c0392b", "#f39c12", "#fff3b0"], sky: ["#040106", "#1c0710"], key: "#ffd6a8" },
  aurora: { stops: ["#071f3a", "#0b8a7a", "#33d17a", "#b5f5c9", "#e6ccff"], sky: ["#01040c", "#0a1e2c"], key: "#dafff0" },
  vaporwave: { stops: ["#2b0f54", "#ab1f65", "#ff4f81", "#ff9e3d", "#2de2e6"], sky: ["#0d0320", "#3b0c4d"], key: "#ffd0f0" },
  ocean: { stops: ["#03045e", "#0077b6", "#00b4d8", "#90e0ef", "#e8fbff"], sky: ["#000c17", "#073049"], key: "#e0f7ff" },
  jade: { stops: ["#05201b", "#14463c", "#2f7a5f", "#9fd4a8", "#efffe9"], sky: ["#030a09", "#13302a"], key: "#f3ffe0" },
  candy: { stops: ["#ff8fc2", "#fff1a8", "#b8f2d0", "#9fd6ff", "#e2b8ff"], sky: ["#c7b8ff", "#fff0f8"], key: "#ffffff", ground: "#ffd6e8" },
  desert: { stops: ["#3d2312", "#8c5a3c", "#c98b5e", "#ecc9a0", "#fbeedd"], sky: ["#5d88b8", "#f5d8b8"], key: "#fff0d8", ground: "#b88a66" },
  opal: { cosine: [[0.8, 0.78, 0.82], [0.2, 0.22, 0.2], [1, 1, 1], [0, 0.33, 0.67]], sky: ["#14161f", "#383c52"], key: "#ffffff" },
  rainbow: { cosine: [[0.5, 0.5, 0.5], [0.5, 0.5, 0.5], [1, 1, 1], [0, 0.33, 0.67]], sky: ["#030304", "#121218"], key: "#ffffff" },
  psychedelic: { cosine: [[0.5, 0.5, 0.5], [0.5, 0.5, 0.5], [2, 1, 0], [0.5, 0.2, 0.25]], sky: ["#07000f", "#250040"], key: "#fff0ff" },
  sunset: { stops: ["#2d1b4e", "#7b2e6d", "#e2546b", "#f9a26c", "#fde4a6"], sky: ["#140d2a", "#7a3a5a"], key: "#ffcf9e", ground: "#4a2a4a" },
  clay: { stops: ["#262626", "#6b6560", "#b0a89f", "#e0dad2", "#ffffff"], sky: ["#2b2b30", "#64646d"], key: "#fff8f0" },
  cyber: { stops: ["#02031a", "#1235ff", "#00e5ff", "#ff2bd6", "#ffffff"], sky: ["#000003", "#06061c"], key: "#d6f0ff" },
  nebula: { stops: ["#120025", "#4b1d9e", "#2e86de", "#7ee8fa", "#fff6e0"], sky: ["#000000", "#05030c"], key: "#ffffff" },
  fire: { stops: ["#1a0000", "#8a0a00", "#ff4a00", "#ffc21a", "#ffffe8"], sky: ["#000000", "#140500"], key: "#ffe0b0" },
  amethyst: { cosine: [[0.6, 0.45, 0.7], [0.35, 0.3, 0.3], [1, 1, 1], [0.15, 0.3, 0.45]], sky: ["#08030f", "#251238"], key: "#f6e8ff" },
  toxic: { cosine: [[0.5, 0.5, 0.3], [0.5, 0.5, 0.4], [1, 1, 0.5], [0.8, 0.9, 0.3]], sky: ["#020500", "#0f1f08"], key: "#f0ffd8" },
};

export function hexToRgb(hex: string): Rgb {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

// The palette at t on the CPU (the gallery swatches)
export function paletteAt(palette: Palette, t: number): Rgb {
  if (palette.cosine) {
    const [a, b, c, d] = palette.cosine;
    return [0, 1, 2].map((k) => a[k] + b[k] * Math.cos(Math.PI * 2 * (c[k] * t + d[k]))) as Rgb;
  }
  const stops = palette.stops!.map(hexToRgb);
  const x = (1 - Math.abs((((t / 2) % 1) + 1) % 1 * 2 - 1)) * (stops.length - 1);
  const i = Math.min(Math.floor(x), stops.length - 2);
  const f = x - i;
  return [0, 1, 2].map((k) => stops[i][k] * (1 - f) + stops[i + 1][k] * f) as Rgb;
}
