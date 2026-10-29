// A demo: a tune and the video on its bars. The cue list says which
// fractal lands on which bar and how (a morph.ts style over some beats, a
// camera move around the preset's view, sometimes a palette per beat), the
// lines are the type over it, and `compose` writes the music onto an
// AirScore, whose marks the picture follows (video.ts).
import type { ScoreMix } from "../../film/score.js";
import type { AirScore } from "./airScore.js";

export interface Move {
  // Degrees and display units over the preset's view
  azimuth?: number;
  elevation?: number;
  distance?: number;
  // Per bar: degrees around, degrees up, a share of the distance closer
  orbit?: number;
  rise?: number;
  push?: number;
}

export interface Cue {
  bar: number;
  preset: string;
  // The transition into it, and its length in beats
  style: string;
  beats: number;
  move: Move;
  // A palette per beat from `from` bars into the cue
  palettes?: { from: number; names: string[] };
}

export interface Line {
  // Bars
  at: number;
  until: number;
  html: string;
  className: string;
  anim?: "slam" | "letters" | "rise" | "fade" | "type" | "wipe";
  enter?: number;
}

export interface Tune {
  name: string;
  // The menu's card: a title, a line about the music, two colors
  title: string;
  blurb: string;
  colors: [string, string];
  bpm: number;
  // The video's length, and where the closing title starts (bars)
  end: number;
  outro: number;
  cues: Cue[];
  lines: Line[];
  compose(score: AirScore): void;
  mix: ScoreMix;
}
