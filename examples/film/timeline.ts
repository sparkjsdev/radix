// Time in the film: seconds, and the bars of the score (100 BPM, 4/4), so
// cuts, captions and music line up. A shot is a span of bars with its own
// scene and camera; the film draws the one under the playhead. Other
// scores, such as the fractal demo's tunes, take their tempo from tempo().
import type * as THREE from "three";

// Beats and 4/4 bars at `bpm`, in seconds
export function tempo(bpm: number) {
  const BEAT = 60 / bpm;
  const BAR = BEAT * 4;
  return { BPM: bpm, BEAT, BAR, bars: (n: number) => n * BAR, beats: (n: number) => n * BEAT };
}

export const { BPM, BEAT, BAR, bars, beats } = tempo(100);

export const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const smooth = (t: number) => {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
};
export const easeInOut = (t: number) => {
  const x = clamp01(t);
  return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2;
};
export const easeOut = (t: number) => 1 - (1 - clamp01(t)) ** 3;
export const easeIn = (t: number) => clamp01(t) ** 3;
export const expoOut = (t: number) => (t >= 1 ? 1 : 1 - 2 ** (-10 * clamp01(t)));
// 0 -> 1 over [a, b]
export const span = (t: number, a: number, b: number) => clamp01((t - a) / (b - a));
// Rises over [a, a + fade], holds, falls over [b - fade, b]
export const window = (t: number, a: number, b: number, fade: number) => Math.min(smooth((t - a) / fade), smooth((b - t) / fade));

// Deterministic randomness: one stream per seed
export function random(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Shot {
  name: string;
  // Bars from the film's start
  from: number;
  to: number;
  // Before the first frame of the shot (each time the playhead enters it),
  // and when the playhead leaves it
  enter?(): void;
  exit?(): void;
  // Seconds into the shot, the shot's length, and seconds into the film
  frame(local: number, length: number, time: number): void;
  // The draw: the scene from the camera unless the shot draws itself
  scene?: THREE.Scene;
  camera?: THREE.PerspectiveCamera;
  render?(): void;
}
