// Tidal: future garage at 100 BPM in F minor (Fm9, Dbmaj9, Abmaj7, Eb6).
// The sea under everything; a 2-step beat (the kick on one and the "and" of
// three, snaps on two and four, swung shakers, a rim before the backbeat);
// a sub that glides from bar to bar; pitched vocal chops singing a
// syncopated hook; glass pings in the delay. A breakdown of choir and slow
// chops for the Buddhabrot and its inverse, and a second groove with a
// glass arp over it.
import { tempo } from "../../../film/timeline.js";
import type { AirScore } from "../airScore.js";
import type { Tune } from "../tune.js";

const { BEAT, bars, beats } = tempo(100);

const CHORDS = [
  { root: 41, notes: [56, 60, 63, 67] },
  { root: 37, notes: [53, 56, 60, 63] },
  { root: 44, notes: [55, 60, 63, 68] },
  { root: 39, notes: [55, 58, 60, 63] },
];
const at4 = (bar: number) => ((Math.floor(bar) % 4) + 4) % 4;
const chordAt = (bar: number) => CHORDS[at4(bar)];

// The chops: [beat, note] per bar, off the beat
const HOOK: [number, number][][] = [
  [[0.75, 72], [1.5, 75], [2.25, 72], [3.5, 68]],
  [[0.75, 72], [1.5, 77], [2.25, 75], [3.5, 72]],
  [[0.75, 75], [1.5, 79], [2.25, 75], [3.5, 72]],
  [[0.75, 70], [1.5, 72], [2.25, 67], [3.5, 70]],
];

function chops(s: AirScore, bar: number, level: number, { octave = 0, slow = false } = {}) {
  HOOK[at4(bar)].forEach(([beat, note], i) => {
    s.vox(bars(bar) + beats(slow ? beat * 2 : beat), note + octave, slow ? 0.6 : 0.32, level, [-0.3, 0.3, -0.15, 0.15][i]);
  });
}

// Pings on the chord's top notes, every other beat, into the delay
function pings(s: AirScore, bar: number, level: number) {
  const notes = chordAt(bar).notes;
  [0, 2].forEach((beat, i) => s.glass(bars(bar) + beats(beat + 0.5), notes[(i + bar) % notes.length] + 24, level, { decay: 2.5, pan: i ? 0.5 : -0.5, delay: 0.6 }));
}

function garage(s: AirScore, from: number, to: number, { full = true } = {}) {
  for (let bar = from; bar < to; bar += 1) {
    const chord = chordAt(bar);
    const start = bars(bar);
    s.air(start, bars(1), chord.notes, 0.02, 1700, { ducked: true });
    s.sub(start, chord.root, bars(1) - 0.04, 0.17, chordAt(bar + 1).root);
    s.thump(start, 0.42);
    s.thump(start + beats(2.5), 0.32);
    if (bar % 2 === 1) {
      s.thump(start + beats(3.75), 0.18);
    }
    s.snap(start + beats(1), 0.11);
    s.snap(start + beats(3), 0.12);
    s.rim(start + beats(2.75), 0.035, -0.3);
    for (let i = 0; i < 16; i += 1) {
      s.shaker(start + beats(i / 4 + (i % 2 ? 0.08 : 0)), [0.03, 0.012, 0.02, 0.012][i % 4], i % 2 ? 0.35 : -0.15);
    }
    if (full) {
      s.hat(start + beats(1.5), 0.022, true, 0.3);
      s.hat(start + beats(3.5), 0.022, true, 0.3);
    }
  }
}

function compose(s: AirScore) {
  s.beat = BEAT;
  for (let bar = 0; bar < 23; bar += 1) {
    s.chord(bars(bar));
  }

  // --- 0-4: the sea, pads, the chops far away ---
  s.breath(0, bars(5), 0.04, { from: 250, to: 900 });
  s.breath(bars(1), bars(4.5), 0.02, { from: 900, to: 3000, pan: 0.4 });
  s.drone(0, bars(4.2), 29, 0.08);
  for (let bar = 0; bar < 4; bar += 1) {
    s.air(bars(bar), bars(1), chordAt(bar).notes, 0.026, 1000 + bar * 200);
    pings(s, bar, 0.025);
  }
  chops(s, 2, 0.03);
  chops(s, 3, 0.035);
  s.swell(bars(3), bars(4), 0.08);
  s.lift(bars(3), bars(4), 0.08);

  // --- 4-12: the groove ---
  s.boom(bars(4), 0.4);
  s.fall(bars(4), 2, 0.05);
  garage(s, 4, 12);
  for (let bar = 4; bar < 12; bar += 1) {
    chops(s, bar, 0.055);
    pings(s, bar, 0.02);
    if (bar >= 8) {
      const notes = chordAt(bar).notes;
      for (let j = 0; j < 8; j += 1) {
        s.kalimba(bars(bar) + beats(j / 2 + (j % 2 ? 0.08 : 0)), notes[[0, 2, 1, 3][j % 4]] + 12, 0.022, { pan: j % 2 ? 0.45 : -0.45, mark: 0.2 });
      }
    }
  }
  s.crash(bars(8), 0.06);

  // --- 12-16: the breakdown ---
  s.boom(bars(12), 0.3);
  for (let bar = 12; bar < 16; bar += 1) {
    const chord = chordAt(bar);
    s.air(bars(bar), bars(1), chord.notes, 0.03, 2000);
    s.choir(bars(bar), bars(1), chord.notes, 0.05);
    s.sub(bars(bar), chord.root, bars(1) - 0.04, 0.1, chordAt(bar + 1).root);
    s.rim(bars(bar) + beats(1), 0.03, 0.3);
    s.rim(bars(bar) + beats(3), 0.03, -0.3);
    for (let i = 0; i < 8; i += 1) {
      s.shaker(bars(bar) + beats(i / 2 + (i % 2 ? 0.16 : 0)), 0.014, i % 2 ? 0.3 : -0.3);
    }
  }
  chops(s, 12, 0.045, { octave: 12, slow: true });
  chops(s, 14, 0.045, { octave: 12, slow: true });
  s.breath(bars(12), bars(16), 0.035, { from: 300, to: 1200 });
  s.swell(bars(15), bars(16), 0.1);
  s.lift(bars(15), bars(16), 0.1);
  s.roll(bars(15.5), bars(16), 0.08);

  // --- 16-22: the groove, with a glass arp over it ---
  s.boom(bars(16), 0.5);
  s.crash(bars(16), 0.08);
  s.fall(bars(16), 2, 0.05);
  garage(s, 16, 22);
  for (let bar = 16; bar < 22; bar += 1) {
    chops(s, bar, 0.055);
    const notes = chordAt(bar).notes;
    for (let i = 0; i < 16; i += 1) {
      s.glass(bars(bar) + beats(i / 4 + (i % 2 ? 0.08 : 0)), notes[[0, 1, 2, 3, 2, 1][i % 6]] + 24, 0.014, { decay: 1.2, pan: Math.sin(i * 1.7) * 0.6, delay: 0.3 });
    }
  }
  s.crash(bars(20), 0.06);

  // --- 22-24: the tide goes out ---
  s.boom(bars(22), 0.3);
  s.air(bars(22), bars(1.6), [56, 60, 63, 67, 70], 0.03, 1800);
  s.choir(bars(22), bars(1.4), [60, 63, 67], 0.045);
  s.drone(bars(22), bars(24), 29, 0.08);
  s.sub(bars(22), 41, bars(1.5), 0.12);
  s.breath(bars(22), bars(24), 0.035, { from: 900, to: 250 });
  [[0.75, 72], [1.5, 75], [2.25, 72], [3.5, 68], [5, 67]].forEach(([beat, note], i) => s.vox(bars(22) + beats(beat), note, 0.5, 0.045 - i * 0.004, i % 2 ? 0.3 : -0.3));
}

export const TIDAL: Tune = {
  name: "tidal",
  title: "Tidal",
  blurb: "future garage · 100 BPM · 58 s",
  colors: ["#2b6cff", "#ff5fd2"],
  bpm: 100,
  end: 24,
  outro: 22,
  compose,
  mix: { delay: BEAT * 0.75, feedback: 0.48, reverb: 0.5, output: 1.5 },
  cues: [
    { bar: 0, preset: "Quaternion Bloom", style: "stardust", beats: 8, move: { distance: 4.3, azimuth: 0, elevation: 10, orbit: 5, push: 0.04 } },
    { bar: 2, preset: "Thomas Knot", style: "swirl", beats: 4, move: { orbit: -6 } },
    { bar: 4, preset: "Crystal Lattice", style: "ripple", beats: 4, move: { orbit: 8 } },
    { bar: 6, preset: "Amethyst Geode", style: "swirl", beats: 4, move: { orbit: -8 } },
    { bar: 8, preset: "Kleinian Forest", style: "galaxy", beats: 4, move: { orbit: 9, rise: 3 } },
    { bar: 10, preset: "Aizawa Silk", style: "sweep", beats: 4, move: { orbit: -10 } },
    { bar: 12, preset: "Buddha in 4D", style: "dissolve", beats: 6, move: { orbit: 3, push: 0.03 } },
    { bar: 14, preset: "Anti-Buddha", style: "dissolve", beats: 4, move: { orbit: -3, push: 0.03 } },
    { bar: 16, preset: "Neon Bulb", style: "burst", beats: 2, move: { orbit: 10 } },
    { bar: 18, preset: "Apollonian Pearl", style: "orb", beats: 4, move: { orbit: -10 } },
    { bar: 20, preset: "Halvorsen Bloom", style: "swirl", beats: 4, move: { orbit: 10, rise: 4 } },
    { bar: 22, preset: "Quaternion Bloom", style: "galaxy", beats: 4, move: { distance: 5.2, orbit: 4 } },
  ],
  lines: [
    { at: 0.4, until: 1.9, html: "every point of light is a Gaussian splat", className: "lower" },
    { at: 2.2, until: 3.9, html: "baked on the GPU, drawn by Spark Radix", className: "lower" },
    { at: 4, until: 5.8, html: "FRACTALS", className: "title", anim: "slam", enter: 0.3 },
    { at: 4.35, until: 5.8, html: "in Gaussian splats", className: "subtitle", anim: "rise" },
    { at: 8.2, until: 9.9, html: "kaleidoscopes, sponges, Kleinian forests", className: "lower" },
    { at: 12.2, until: 13.9, html: "a Buddhabrot, turned through four dimensions", className: "lower" },
    { at: 14.2, until: 15.9, html: "and its inverse", className: "lower" },
    { at: 16.2, until: 17.9, html: "each one becomes the next, splat for splat", className: "lower" },
    { at: 20.2, until: 21.9, html: "strange attractors, as threads of light", className: "lower" },
    { at: 22.3, until: 23.7, html: "SPARK RADIX", className: "title brand", enter: 0.9 },
    { at: 22.7, until: 23.7, html: "3D fractals in splats", className: "subtitle", anim: "rise", enter: 0.8 },
  ],
};
