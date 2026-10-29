// Lumen: melodic house at 118 BPM in E dorian (Em9, Cmaj9, G6/9, D6). A
// kalimba arpeggio in dotted eighths runs three against the four of the
// beat the whole way; a rolling bass in sixteenths; a soft kick on every
// beat and snaps on two and four; a choir and a glass hook in the drops;
// a breakdown for the tree in blossom; the last chord moves to G major
// under the title.
import { tempo } from "../../../film/timeline.js";
                                               
                                       

const { BEAT, bars, beats } = tempo(118);

const CHORDS = [
  { root: 40, notes: [55, 59, 62, 66] },
  { root: 36, notes: [52, 55, 59, 62] },
  { root: 43, notes: [55, 57, 59, 64] },
  { root: 38, notes: [54, 57, 59, 62] },
];
const at4 = (bar        ) => ((Math.floor(bar) % 4) + 4) % 4;
const chordAt = (bar        ) => CHORDS[at4(bar)];

const HOOK                       = [
  [[0, 71], [0.75, 74], [1.5, 76], [3, 74]],
  [[0, 71], [0.75, 69], [1.5, 67], [3, 69]],
  [[0, 74], [0.75, 76], [1.5, 79], [3, 78]],
  [[0, 76], [1, 74], [2, 71], [3, 69]],
];

function hook(s          , bar        , level        , { octave = 0, slow = false } = {}) {
  HOOK[at4(bar)].forEach(([beat, note], i) => s.glass(bars(bar) + beats(slow ? beat * 2 : beat), note + octave, level, { decay: slow ? 4 : 2.8, pan: i % 2 ? 0.3 : -0.3 }));
}

// Dotted eighths from `from` to `to`, up and down the chord under each
function arp(s          , from        , to        , level                         ) {
  for (let k = 0; bars(from) + beats(k * 0.75) < bars(to) - 1e-6; k += 1) {
    const t = bars(from) + beats(k * 0.75);
    const bar = from + Math.floor((t - bars(from)) / bars(1));
    const notes = chordAt(bar).notes;
    const climb = [0, 1, 2, 3, 2, 1][k % 6];
    s.kalimba(t, notes[climb] + 12 + (k % 12 >= 6 ? 12 : 0), level(bar), { pan: Math.sin(k * 0.9) * 0.55, mark: 0.3 });
  }
}

function bassline(s          , bar        , cutoff        , level = 0.1) {
  const root = chordAt(bar).root;
  for (let b = 0; b < 4; b += 1) {
    [0, 12, 7, 12].forEach((step, i) => s.bass(bars(bar) + beats(b + i / 4), root + step, beats(0.2), level * (i === 0 ? 1.2 : 0.8), cutoff));
  }
}

function drums(s          , bar        , { kick = 0.44, snaps = true, hats = true } = {}) {
  const start = bars(bar);
  for (let b = 0; b < 4; b += 1) {
    s.thump(start + beats(b), kick);
    if (snaps && b % 2 === 1) {
      s.snap(start + beats(b), 0.1);
    }
    if (hats) {
      s.hat(start + beats(b + 0.5), 0.03, true, 0.2);
    }
  }
  for (let i = 0; i < 16; i += 1) {
    s.shaker(start + beats(i / 4), i % 4 === 2 ? 0.026 : 0.013, i % 2 ? 0.3 : -0.25);
  }
}

function compose(s          ) {
  s.beat = BEAT;
  for (let bar = 0; bar < 27; bar += 1) {
    s.chord(bars(bar));
  }

  // --- 0-4: the choir, the arp alone ---
  s.breath(0, bars(4.5), 0.03, { from: 400, to: 1800 });
  s.drone(0, bars(4.2), 28, 0.08);
  for (let bar = 0; bar < 4; bar += 1) {
    s.choir(bars(bar), bars(1), chordAt(bar).notes, 0.04);
  }
  arp(s, 0.5, 4, (bar) => 0.018 + bar * 0.004);
  s.swell(bars(3), bars(4), 0.08);
  s.lift(bars(3), bars(4), 0.07);

  // --- 4-12: the beat comes in, then the bass, then the snaps ---
  arp(s, 4, 12, () => 0.03);
  for (let bar = 4; bar < 12; bar += 1) {
    const chord = chordAt(bar);
    s.air(bars(bar), bars(1), chord.notes, 0.02, 1400 + (bar - 4) * 150, { ducked: true });
    drums(s, bar, { kick: bar < 6 ? 0.32 : 0.4, snaps: bar >= 8, hats: bar >= 6 });
    if (bar >= 6) {
      bassline(s, bar, 500 + (bar - 6) * 110);
    }
    if (bar >= 8) {
      hook(s, bar, 0.03);
    }
  }
  s.swell(bars(11), bars(12), 0.1);
  s.lift(bars(10), bars(12), 0.13);
  s.roll(bars(11), bars(12), 0.1);

  // --- 12-20: the drop ---
  s.boom(bars(12), 0.55);
  s.crash(bars(12), 0.1);
  s.fall(bars(12), 2, 0.06);
  arp(s, 12, 20, () => 0.028);
  for (let bar = 12; bar < 20; bar += 1) {
    const chord = chordAt(bar);
    s.air(bars(bar), bars(1), chord.notes, 0.018, 2400, { ducked: true });
    s.choir(bars(bar), bars(1), chord.notes, 0.04);
    drums(s, bar);
    bassline(s, bar, 1300, 0.11);
    hook(s, bar, 0.05);
    if (bar % 2 === 1) {
      s.vox(bars(bar) + beats(3.5), chord.notes[3] + 12, 0.3, 0.035, 0.35);
    }
  }
  s.crash(bars(16), 0.08);
  s.fall(bars(19.5), 1.5, 0.05);

  // --- 20-22: the breakdown, the hook at half speed ---
  s.boom(bars(20), 0.25);
  for (let bar = 20; bar < 22; bar += 1) {
    s.air(bars(bar), bars(1), chordAt(bar).notes, 0.03, 2200);
    s.choir(bars(bar), bars(1), chordAt(bar).notes, 0.05);
    s.sub(bars(bar), chordAt(bar).root, bars(1) - 0.05, 0.1, chordAt(bar + 1).root);
  }
  hook(s, 20, 0.045, { octave: 12, slow: true });
  arp(s, 20, 22, () => 0.018);
  s.breath(bars(20), bars(22), 0.035, { from: 500, to: 2600 });
  s.swell(bars(21), bars(22), 0.1);
  s.lift(bars(21), bars(22), 0.12);
  s.roll(bars(21.5), bars(22), 0.1);

  // --- 22-26: the last drop ---
  s.boom(bars(22), 0.6);
  s.crash(bars(22), 0.1);
  s.fall(bars(22), 2, 0.06);
  arp(s, 22, 26, () => 0.028);
  for (let bar = 22; bar < 26; bar += 1) {
    const chord = chordAt(bar);
    s.air(bars(bar), bars(1), chord.notes, 0.018, 2800, { ducked: true });
    s.choir(bars(bar), bars(1), chord.notes, 0.042);
    drums(s, bar);
    bassline(s, bar, 1500, 0.11);
    hook(s, bar, 0.05);
    hook(s, bar, 0.02, { octave: 12 });
  }

  // --- 26-28: G major, under the title ---
  s.boom(bars(26), 0.35);
  s.air(bars(26), bars(1.6), [55, 59, 62, 66, 69], 0.03, 2200);
  s.choir(bars(26), bars(1.5), [59, 62, 66, 69], 0.045);
  s.drone(bars(26), bars(28), 31, 0.08);
  s.sub(bars(26), 43, bars(1.6), 0.12);
  [[0, 79], [0.75, 78], [1.5, 74], [3, 71], [4.5, 74]].forEach(([beat, note], i) => s.glass(bars(26) + beats(beat), note, 0.05 - i * 0.005, { decay: 5 }));
}

export const LUMEN       = {
  name: "lumen",
  title: "Lumen",
  blurb: "melodic house · 118 BPM · 57 s",
  colors: ["#ffb347", "#ff4f8b"],
  bpm: 118,
  end: 28,
  outro: 26,
  compose,
  mix: { delay: BEAT * 0.75, feedback: 0.42, reverb: 0.46, output: 1.35 },
  cues: [
    { bar: 0, preset: "Sierpinski Spire", style: "stardust", beats: 8, move: { distance: 3.6, orbit: 6, push: 0.04 } },
    { bar: 2, preset: "Julia Bowl", style: "swirl", beats: 4, move: { orbit: -7 } },
    { bar: 4, preset: "Golden Hour Bulb", style: "orb", beats: 4, move: { orbit: 8 } },
    { bar: 6, preset: "Totem", style: "swirl", beats: 4, move: { orbit: -8 } },
    { bar: 8, preset: "Candy Sponge", style: "ripple", beats: 4, move: { orbit: 9 }, palettes: { from: 0, names: ["sunset"] } },
    { bar: 10, preset: "Sandstone Ruins", style: "fountain", beats: 4, move: { orbit: -9, rise: 3 } },
    { bar: 12, preset: "Spectral Flame", style: "burst", beats: 2, move: { distance: 2.8, orbit: 14 } },
    { bar: 14, preset: "Halvorsen Bloom", style: "galaxy", beats: 4, move: { orbit: -14 } },
    { bar: 16, preset: "Candy Sponge", style: "swirl", beats: 3, move: { orbit: 14 }, palettes: { from: 1, names: ["sunset", "aurora", "vaporwave", "psychedelic", "opal", "ice", "gold", "sunset"] } },
    { bar: 18, preset: "Menger Dust", style: "burst", beats: 2, move: { orbit: -14 } },
    { bar: 20, preset: "Sakura", style: "fountain", beats: 6, move: { orbit: 5, push: 0.02 } },
    { bar: 22, preset: "Neon Grove", style: "burst", beats: 2, move: { orbit: 14 } },
    { bar: 24, preset: "Ninefold Pearl", style: "orb", beats: 3, move: { orbit: -14 } },
    { bar: 26, preset: "Golden Hour Bulb", style: "galaxy", beats: 4, move: { distance: 5.2, elevation: 14, orbit: 6, push: 0.03 } },
  ],
  lines: [
    { at: 0.4, until: 1.9, html: "every point of light is a Gaussian splat", className: "lower" },
    { at: 2.2, until: 3.9, html: "millions of them, baked on the GPU", className: "lower" },
    { at: 8.2, until: 9.9, html: "lit every frame: the light can move", className: "lower" },
    { at: 12, until: 13.8, html: "FRACTALS", className: "title", anim: "slam", enter: 0.25 },
    { at: 12.35, until: 13.8, html: "in Gaussian splats", className: "subtitle", anim: "rise" },
    { at: 14.2, until: 15.9, html: "strange attractors, as threads of light", className: "lower" },
    { at: 17, until: 17.9, html: "twenty palettes, live", className: "lower" },
    { at: 20.2, until: 21.9, html: "a tree in blossom, in the wind", className: "lower" },
    { at: 26.3, until: 27.7, html: "SPARK RADIX", className: "title brand", enter: 0.9 },
    { at: 26.7, until: 27.7, html: "3D fractals in splats", className: "subtitle", anim: "rise", enter: 0.8 },
  ],
};


//# sourceURL=examples/fractals/demo/tunes/lumen.ts