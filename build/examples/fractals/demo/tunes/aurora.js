// Aurora: dream pop at 84 BPM in D lydian (Dmaj9, Bm11, Gmaj9#11, A6sus).
// Glass bells sing a four-bar hook over airy pads; a choir opens on the
// chorus; the kick is soft and laid back (one, and the "and" of three), the
// shakers swing. Wind under the intro, a breakdown of bells at half speed
// for the 4D Buddhabrot, the hook an octave up in the last chorus, and a
// long D major chord under the title.
import { tempo } from "../../../film/timeline.js";
                                               
                                       

const { BEAT, bars, beats } = tempo(84);

const CHORDS = [
  { root: 38, notes: [54, 57, 61, 64, 69] },
  { root: 35, notes: [50, 54, 57, 61, 64] },
  { root: 31, notes: [50, 54, 57, 59, 61] },
  { root: 33, notes: [50, 52, 57, 59, 62] },
];
const at4 = (bar        ) => ((Math.floor(bar) % 4) + 4) % 4;
const chordAt = (bar        ) => CHORDS[at4(bar)];

// [beat, note] per bar of the progression
const HOOK                       = [
  [[0, 76], [0.5, 73], [1, 69], [1.5, 73], [2.5, 71], [3, 69]],
  [[0, 66], [0.5, 69], [1, 73], [2, 76], [2.5, 78], [3.5, 76]],
  [[0, 74], [0.5, 71], [1, 69], [1.5, 71], [2.5, 73], [3, 71]],
  [[0, 69], [1, 71], [1.5, 69], [2, 66], [3, 64]],
];
const ARP = [0, 2, 4, 2, 1, 3, 4, 3];

function hook(s          , bar        , level        , { octave = 0, sparse = false, decay = 3.2 } = {}) {
  HOOK[at4(bar)].forEach(([beat, note], i) => {
    if (!sparse || i % 2 === 0) {
      s.glass(bars(bar) + beats(beat), note + octave, level, { decay, pan: i % 2 ? 0.35 : -0.35 });
    }
  });
}

// The verse and chorus bed: pads, the sub, a laid-back kick, a snap on
// three, swung shakers and a kalimba in eighths
function groove(s          , from        , to        , { chorus = false, arps = 0.03, double = false } = {}) {
  for (let bar = from; bar < to; bar += 1) {
    const chord = chordAt(bar);
    const start = bars(bar);
    s.air(start, bars(1), chord.notes, chorus ? 0.018 : 0.022, chorus ? 2000 : 1500, { ducked: true });
    s.sub(start, chord.root, bars(1) - 0.05, 0.13, chordAt(bar + 1).root);
    s.thump(start, chorus ? 0.42 : 0.36);
    s.thump(start + beats(2.5), chorus ? 0.3 : 0.24);
    if (chorus && bar % 2 === 1) {
      s.thump(start + beats(3.75), 0.16);
    }
    s.snap(start + beats(2), chorus ? 0.11 : 0.085);
    for (let i = 0; i < 16; i += 1) {
      s.shaker(start + beats(i / 4 + (i % 2 ? 0.06 : 0)), i % 4 === 2 ? 0.03 : 0.015, i % 2 ? 0.3 : -0.2);
    }
    if (chorus) {
      s.hat(start + beats(3.5), 0.028, true, 0.25);
    }
    const steps = double ? 16 : 8;
    for (let j = 0; j < steps; j += 1) {
      const note = chord.notes[ARP[j % 8] % chord.notes.length] + 12 + (double && j >= 8 ? 12 : 0);
      s.kalimba(start + beats((j * 4) / steps), note, arps * (double ? 0.8 : 1), { pan: j % 2 ? 0.5 : -0.5, mark: 0.25 });
    }
  }
}

function compose(s          ) {
  s.beat = BEAT;
  for (let bar = 0; bar < 19; bar += 1) {
    s.chord(bars(bar));
  }

  // --- 0-4: wind, the first light, the hook in fragments ---
  s.breath(0, bars(4.5), 0.03, { from: 300, to: 1400 });
  s.drone(0, bars(4.2), 26, 0.08);
  for (let bar = 0; bar < 4; bar += 1) {
    s.air(bars(bar), bars(1), chordAt(bar).notes, 0.026, 900 + bar * 250);
  }
  s.glass(beats(0.5), 81, 0.05, { decay: 5 });
  for (let bar = 1; bar < 4; bar += 1) {
    hook(s, bar, 0.034, { sparse: true, decay: 4 });
  }
  s.swell(bars(3), bars(4), 0.07);
  s.lift(bars(3), bars(4), 0.06);

  // --- 4-8: the verse ---
  groove(s, 4, 8);
  hook(s, 6, 0.03, { sparse: true });
  hook(s, 7, 0.03);
  s.swell(bars(7.5), bars(8), 0.08);
  s.lift(bars(7), bars(8), 0.09);

  // --- 8-12: the chorus ---
  s.boom(bars(8), 0.4);
  s.crash(bars(8), 0.07);
  s.fall(bars(8), 2.2, 0.05);
  groove(s, 8, 12, { chorus: true });
  for (let bar = 8; bar < 12; bar += 1) {
    s.choir(bars(bar), bars(1), chordAt(bar).notes.slice(0, 4), 0.045);
    hook(s, bar, 0.05);
    s.vox(bars(bar) + beats(3.5), chordAt(bar).notes[4] + 12, 0.3, 0.032, 0.4);
  }

  // --- 12-14: the breakdown, the hook at half speed ---
  s.boom(bars(12), 0.25);
  for (let bar = 12; bar < 14; bar += 1) {
    s.air(bars(bar), bars(1), chordAt(bar).notes, 0.032, 2200);
    s.choir(bars(bar), bars(1), chordAt(bar).notes.slice(1), 0.05);
  }
  s.drone(bars(12), bars(14.2), 26, 0.07);
  HOOK[0].concat(HOOK[1].map(([beat, note]) => [beat + 4, note]                    )).forEach(([beat, note], i) => {
    s.glass(bars(12) + beats(beat), note + 12, 0.04, { decay: 4.5, pan: i % 2 ? 0.4 : -0.4 });
  });
  s.breath(bars(12), bars(14.2), 0.035, { from: 500, to: 2400, pan: 0.2 });
  for (let i = 0; i < 16; i += 1) {
    s.shaker(bars(13) + beats(i / 4), 0.006 + i * 0.0015, i % 2 ? 0.3 : -0.3);
  }
  s.swell(bars(13), bars(14), 0.09);
  s.lift(bars(13), bars(14), 0.1);

  // --- 14-18: the last chorus, the hook doubled an octave up ---
  s.boom(bars(14), 0.45);
  s.crash(bars(14), 0.08);
  s.fall(bars(14), 2.2, 0.05);
  groove(s, 14, 18, { chorus: true, arps: 0.026, double: true });
  for (let bar = 14; bar < 18; bar += 1) {
    s.choir(bars(bar), bars(1), chordAt(bar).notes.slice(0, 4), 0.05);
    hook(s, bar, 0.05);
    hook(s, bar, 0.022, { octave: 12, sparse: true });
    s.vox(bars(bar) + beats(3.5), chordAt(bar).notes[4] + 12, 0.3, 0.034, bar % 2 ? 0.4 : -0.4);
  }

  // --- 18-20: home, under the title ---
  s.boom(bars(18), 0.3);
  s.air(bars(18), bars(1.6), [50, 54, 57, 61, 64, 69], 0.03, 2000);
  s.choir(bars(18), bars(1.4), [57, 61, 64, 69], 0.045);
  s.drone(bars(18), bars(20), 26, 0.08);
  s.sub(bars(18), 38, bars(1.5), 0.1);
  [[0, 76], [1, 73], [2, 69], [3, 66], [5, 69]].forEach(([beat, note], i) => s.glass(bars(18) + beats(beat), note, 0.05 - i * 0.005, { decay: 5 }));
}

export const AURORA       = {
  name: "aurora",
  title: "Aurora",
  blurb: "dream pop · 84 BPM · 57 s",
  colors: ["#7af3ff", "#c79bff"],
  bpm: 84,
  end: 20,
  outro: 18,
  compose,
  mix: { delay: BEAT * 0.75, feedback: 0.45, reverb: 0.5, output: 1.75 },
  cues: [
    { bar: 0, preset: "Ninefold Pearl", style: "stardust", beats: 8, move: { distance: 4.4, azimuth: 40, elevation: 30, orbit: 5, push: 0.04 } },
    { bar: 2, preset: "Quaternion Bloom", style: "swirl", beats: 4, move: { orbit: -6, push: 0.03 } },
    { bar: 4, preset: "Apollonian Pearl", style: "orb", beats: 4, move: { orbit: 8 } },
    { bar: 6, preset: "Aizawa Silk", style: "swirl", beats: 4, move: { orbit: -8, rise: 3 } },
    { bar: 8, preset: "Kleinian Forest", style: "burst", beats: 2, move: { orbit: 10, push: 0.03 } },
    { bar: 10, preset: "Crystal Lattice", style: "galaxy", beats: 4, move: { orbit: -10 } },
    { bar: 12, preset: "Buddha in 4D", style: "dissolve", beats: 6, move: { orbit: 3, push: 0.03 } },
    { bar: 14, preset: "Sakura", style: "fountain", beats: 4, move: { orbit: 6 } },
    { bar: 16, preset: "Halvorsen Bloom", style: "swirl", beats: 4, move: { orbit: -10, rise: 4 } },
    { bar: 18, preset: "Ninefold Pearl", style: "orb", beats: 4, move: { distance: 5, orbit: 5 } },
  ],
  lines: [
    { at: 0.4, until: 1.9, html: "every point of light is a Gaussian splat", className: "lower" },
    { at: 2.2, until: 3.9, html: "millions of them, baked on the GPU", className: "lower" },
    { at: 8, until: 9.8, html: "FRACTALS", className: "title", anim: "slam", enter: 0.3 },
    { at: 8.35, until: 9.8, html: "in Gaussian splats", className: "subtitle", anim: "rise" },
    { at: 12.2, until: 13.9, html: "a Buddhabrot, turned through four dimensions", className: "lower" },
    { at: 14.2, until: 15.9, html: "a tree in blossom", className: "lower" },
    { at: 16.2, until: 17.8, html: "strange attractors, as threads of light", className: "lower" },
    { at: 18.3, until: 19.7, html: "SPARK RADIX", className: "title brand", enter: 0.9 },
    { at: 18.7, until: 19.7, html: "3D fractals in splats", className: "subtitle", anim: "rise", enter: 0.8 },
  ],
};


//# sourceURL=examples/fractals/demo/tunes/aurora.ts