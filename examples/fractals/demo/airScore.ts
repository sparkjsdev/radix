// The teasers' instruments, for the GPU synthesizer of film/gpuAudio.ts,
// on film/score.ts's Score: glassy FM bells, a kalimba, airy pads, a
// choir, pitched vocal chops, ocean and wind, soft drums, and the house
// kit. Every instrument the picture follows leaves a mark (kicks, melodic
// hits, chord changes, impacts, risers), so the film's bloom, sparkle,
// colors and flashes move with the music it hears (film.ts).
import { Score, env, midi } from "../../film/score.js";

export type MarkKind = "kick" | "hit" | "chord" | "impact" | "rise";

export interface Mark {
  kind: MarkKind;
  at: number;
  weight: number;
  // A rise's end
  until?: number;
}

export class AirScore extends Score {
  marks: Mark[] = [];
  // Seconds of a beat, for the swing and the rolls
  beat = 0.5;

  mark(kind: MarkKind, at: number, weight = 1, until?: number) {
    this.marks.push({ kind, at, weight, until });
  }

  // --- Melodic ---

  // A hollow FM bell (ratio 2) that blooms bright and settles to a sine
  glass(at: number, note: number, level = 0.05, { decay = 4, pan = 0, delay = 0.42 } = {}) {
    const f = midi(note);
    this.add({
      start: at,
      stop: at + decay,
      oscs: [{ wave: "sine", freq: f }, { wave: "sine", freq: f * 2.002, gain: 0.1 }],
      fm: { ratio: 2, index: { initial: f * 1.1, points: [[at, f * 1.1, "set"], [at + decay * 0.35, f * 0.03, "exp"]] } },
      gain: env(at, 0.004, 0, decay, level),
      reverb: 0.75,
      delay,
      pan,
    });
    this.mark("hit", at, level / 0.05);
  }

  // A plucked tine: a triangle and its octave, and a short inharmonic ping
  kalimba(at: number, note: number, level = 0.05, { pan = 0, decay = 0.8, mark = 0.6 } = {}) {
    const f = midi(note);
    this.add({
      start: at,
      stop: at + decay + 0.1,
      oscs: [{ wave: "triangle", freq: f, filtered: true }, { wave: "sine", freq: f * 2, gain: 0.25, filtered: true }],
      filter: { type: "lowpass", q: 0.7, freq: { initial: 4200, points: [[at, 4200, "set"], [at + decay, 1200, "exp"]] } },
      gain: env(at, 0.002, 0, decay, level),
      reverb: 0.45,
      delay: 0.3,
      pan,
    });
    this.add({
      start: at,
      stop: at + 0.12,
      oscs: [{ wave: "sine", freq: f * 5.43 }],
      gain: env(at, 0.001, 0, 0.08, level * 0.3),
      reverb: 0.3,
      pan,
    });
    if (mark > 0) {
      this.mark("hit", at, (level / 0.05) * mark);
    }
  }

  // Detuned saws and a sine, opening slowly, with a long tail into the reverb
  air(at: number, length: number, notes: number[], level = 0.03, bright = 1800, { ducked = false, spread = 0.9 } = {}) {
    notes.forEach((note, i) => this.add({
      start: at,
      stop: at + length + 4,
      oscs: [
        { wave: "saw", freq: midi(note), cents: -11, filtered: true },
        { wave: "saw", freq: midi(note), cents: 9, filtered: true },
        { wave: "sine", freq: midi(note), gain: 0.6, filtered: true },
      ],
      filter: { type: "lowpass", q: 0.3, freq: { initial: bright * 0.3, points: [[at, bright * 0.25, "set"], [at + length * 0.6, bright, "linear"], [at + length + 3, bright * 0.4, "linear"]] } },
      gain: env(at, Math.min(2.5, length * 0.5), Math.max(0, length - 2.5), 3.5, level),
      dry: 0.5,
      reverb: 0.9,
      delay: 0.12,
      pan: (i / Math.max(1, notes.length - 1) - 0.5) * spread,
      ducked,
    }));
  }

  // Saws through a moving vowel (a bandpass from "oo" to "ah"), with vibrato
  choir(at: number, length: number, notes: number[], level = 0.05) {
    notes.forEach((note, i) => {
      const f = midi(note);
      this.add({
        start: at,
        stop: at + length + 3,
        oscs: [{ wave: "saw", freq: f, filtered: true }, { wave: "saw", freq: f, cents: 7, filtered: true }, { wave: "triangle", freq: f / 2, gain: 0.3, filtered: true }],
        fm: { ratio: 5.2 / f, index: { initial: f * 0.004 } },
        filter: { type: "bandpass", q: 1.6, freq: { initial: 650, points: [[at, 600, "set"], [at + length * 0.5, 1100, "linear"], [at + length + 2.5, 700, "linear"]] } },
        gain: env(at, Math.min(1.8, length * 0.5), Math.max(0, length - 1.8), 2.6, level),
        dry: 0.4,
        reverb: 0.95,
        pan: (i / Math.max(1, notes.length - 1) - 0.5) * 1.2,
      });
    });
  }

  // A sung chop: a saw and a breath through a vowel that opens, scooped up
  // into the note
  vox(at: number, note: number, length = 0.35, level = 0.06, pan = 0) {
    const f = midi(note);
    this.add({
      start: at,
      stop: at + length + 0.35,
      oscs: [{ wave: "saw", freq: f, filtered: true }],
      noise: { gain: 0.12, filtered: true },
      pitch: { initial: f * 0.89, points: [[at, f * 0.89, "set"], [at + 0.06, f, "exp"], [at + length, f, "set"], [at + length + 0.25, f * 0.94, "exp"]] },
      filter: { type: "bandpass", q: 3, freq: { initial: 600, points: [[at, 600, "set"], [at + length * 0.5, 1500, "exp"], [at + length + 0.3, 800, "exp"]] } },
      gain: env(at, 0.012, length * 0.6, 0.28, level),
      reverb: 0.6,
      delay: 0.5,
      pan,
    });
    this.mark("hit", at, level / 0.06);
  }

  // A sine under the bass line, ducked by the kick; it can glide to the next note
  sub(at: number, note: number, length: number, level = 0.16, glideTo?: number) {
    const f = midi(note - 12);
    this.add({
      start: at,
      stop: at + length + 0.1,
      oscs: [{ wave: "sine", freq: f }, { wave: "triangle", freq: f, gain: 0.12 }],
      pitch: glideTo === undefined ? undefined : { initial: f, points: [[at, f, "set"], [at + length - 0.12, f, "set"], [at + length, midi(glideTo - 12), "exp"]] },
      gain: env(at, 0.02, Math.max(0, length - 0.1), 0.12, level),
      ducked: true,
    });
  }

  // --- Air ---

  // Noise through a slowly sweeping band: wind, or the sea
  breath(at: number, until: number, level = 0.03, { from = 350, to = 1500, pan = 0 } = {}) {
    this.add({
      start: at,
      stop: until,
      noise: { gain: 1, filtered: true },
      filter: { type: "bandpass", q: 0.9, freq: { initial: from, points: [[at, from, "set"], [(at + until) / 2, to, "exp"], [until, from, "exp"]] } },
      gain: { initial: 0, points: [[at, 1e-4, "set"], [at + (until - at) * 0.4, level, "exp"], [until - 0.5, level * 0.8, "linear"], [until, 1e-4, "exp"]] },
      reverb: 0.6,
      pan,
    });
  }

  // A cymbal played backwards: noise that swells into `until`
  swell(at: number, until: number, level = 0.1) {
    this.add({
      start: at,
      stop: until + 0.02,
      noise: { gain: 1, filtered: true },
      filter: { type: "highpass", q: 0.6, freq: { initial: 2500, points: [[at, 2500, "set"], [until, 8000, "exp"]] } },
      gain: { initial: 0, points: [[at, 1e-4, "set"], [until - 0.01, level, "exp"], [until, 0, "linear"]] },
      reverb: 0.3,
      pan: -0.2,
    });
  }

  // A noise sweep falling away after a hit
  fall(at: number, length = 1.6, level = 0.07) {
    this.add({
      start: at,
      stop: at + length,
      noise: { gain: 1, filtered: true },
      filter: { type: "bandpass", q: 1.6, freq: { initial: 7000, points: [[at, 7000, "set"], [at + length, 250, "exp"]] } },
      gain: env(at, 0.01, 0.1, length - 0.15, level),
      reverb: 0.5,
      pan: 0.25,
    });
  }

  // The riser and impact of Score, marked for the picture
  lift(at: number, until: number, level = 0.12) {
    this.riser(at, until, level);
    this.mark("rise", at, 1, until);
  }

  boom(at: number, level = 0.6) {
    this.impact(at, level);
    this.mark("impact", at, level / 0.6);
  }

  chord(at: number) {
    this.mark("chord", at);
  }

  // --- Drums ---

  // A round, soft kick (it ducks the ducked bus too)
  thump(at: number, level = 0.4) {
    this.add({
      start: at,
      stop: at + 0.7,
      oscs: [{ wave: "sine", freq: 120 }],
      pitch: { initial: 120, points: [[at, 132, "set"], [at + 0.09, 46, "exp"]] },
      gain: env(at, 0.003, 0.04, 0.5, level),
    });
    this.add({
      start: at,
      stop: at + 0.02,
      noise: { gain: 1, filtered: true },
      filter: { type: "lowpass", q: 0.7, freq: { initial: 1800 } },
      gain: env(at, 0.001, 0, 0.012, level * 0.15),
    });
    this.kicks.push(at);
    this.mark("kick", at, level / 0.45);
  }

  rim(at: number, level = 0.06, pan = 0.2) {
    this.add({
      start: at,
      stop: at + 0.06,
      oscs: [{ wave: "triangle", freq: 1750, gain: 0.6 }],
      noise: { gain: 0.5, filtered: true },
      filter: { type: "bandpass", q: 2, freq: { initial: 2800 } },
      gain: env(at, 0.001, 0, 0.035, level),
      reverb: 0.3,
      delay: 0.2,
      pan,
    });
  }

  shaker(at: number, level = 0.025, pan = -0.2) {
    this.add({
      start: at,
      stop: at + 0.08,
      noise: { gain: 1, filtered: true },
      filter: { type: "highpass", q: 0.7, freq: { initial: 7000 } },
      gain: env(at, 0.008, 0, 0.05, level),
      reverb: 0.15,
      pan,
    });
  }

  // Two quick bursts into a long room
  snap(at: number, level = 0.12) {
    [0, 0.014].forEach((offset, i) => this.add({
      start: at + offset,
      stop: at + offset + 0.35,
      noise: { gain: 1, filtered: true },
      filter: { type: "bandpass", q: 1.4, freq: { initial: 1800 } },
      gain: env(at + offset, 0.001, 0, i ? 0.22 : 0.03, level),
      reverb: 0.65,
      delay: 0.1,
      pan: i ? 0.1 : -0.1,
    }));
  }

  // Three noise bursts a few milliseconds apart, through a bandpass
  clap(at: number, level = 0.2) {
    [0, 0.011, 0.023].forEach((offset, i) => this.add({
      start: at + offset,
      stop: at + offset + (i === 2 ? 0.3 : 0.04),
      noise: { gain: 1, filtered: true },
      filter: { type: "bandpass", q: 1.1, freq: { initial: 1450 } },
      gain: env(at + offset, 0.001, 0, i === 2 ? 0.22 : 0.02, level * (i === 2 ? 1 : 0.7)),
      reverb: 0.4,
      pan: (i - 1) * 0.15,
    }));
  }

  crash(at: number, level = 0.12) {
    this.add({
      start: at,
      stop: at + 2.6,
      noise: { gain: 1, filtered: true },
      filter: { type: "highpass", q: 0.5, freq: { initial: 5200, points: [[at, 7000, "set"], [at + 2.5, 3500, "exp"]] } },
      gain: env(at, 0.002, 0.05, 2.4, level),
      reverb: 0.5,
      pan: 0.2,
    });
  }

  // Snares getting faster and louder into `until`: quarters, eighths,
  // sixteenths over each third
  roll(at: number, until: number, level = 0.14) {
    const third = (until - at) / 3;
    [1, 2, 4].forEach((per, k) => {
      for (let t = at + k * third; t < at + (k + 1) * third - 1e-6; t += this.beat / per) {
        this.snare(t, level * (0.4 + (0.6 * (t - at)) / (until - at)));
      }
    });
  }

  // --- The house kit (the first teaser's) ---

  stab(at: number, notes: number[], level = 0.035, bright = 3200) {
    notes.forEach((note, i) => this.add({
      start: at,
      stop: at + 0.45,
      oscs: [
        { wave: "saw", freq: midi(note + 12), cents: -14, filtered: true },
        { wave: "saw", freq: midi(note + 12), cents: 14, filtered: true },
        { wave: "saw", freq: midi(note), gain: 0.6, filtered: true },
      ],
      filter: { type: "lowpass", q: 1, freq: { initial: bright, points: [[at, bright, "set"], [at + 0.3, bright * 0.35, "exp"]] } },
      gain: env(at, 0.004, 0.06, 0.24, level),
      reverb: 0.35,
      delay: 0.15,
      pan: (i / (notes.length - 1) - 0.5) * 0.9,
      ducked: true,
    }));
  }

  lead(at: number, note: number, length: number, level = 0.06) {
    this.add({
      start: at,
      stop: at + length + 0.4,
      oscs: [
        { wave: "saw", freq: midi(note), cents: -8, filtered: true },
        { wave: "saw", freq: midi(note), cents: 8, filtered: true },
        { wave: "square", freq: midi(note + 12), gain: 0.25, filtered: true },
      ],
      filter: { type: "lowpass", q: 3, freq: { initial: 5200, points: [[at, 6500, "set"], [at + length + 0.3, 900, "exp"]] } },
      gain: env(at, 0.003, length * 0.4, 0.32, level),
      reverb: 0.35,
      delay: 0.45,
    });
    this.mark("hit", at, 0.7);
  }
}
