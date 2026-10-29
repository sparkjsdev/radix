// The score as data for the GPU synthesizer (gpuAudio.ts): the music of the
// film (compose, on the bars of timeline.ts: 100 BPM, D minor) played by
// instruments that each add voices to a table rather than build Web Audio
// nodes. A voice is up to three oscillators and stereo noise, through one
// biquad filter, a waveshaper and a gain, with automation curves for the
// gain, the first oscillator's pitch, the filter's cutoff and an FM index,
// then panned and sent to the buses (dry or sidechain-ducked, reverb, the
// ping-pong delay). Sections follow the shots:
//   0-2    a drone and one bell: one Gaussian
//   2-4    a pluck on every doubling of the splat count, faster and faster
//   4-8.5  pads as the galaxy condenses into the capture
//   8.5    a shutter, then a clock ticking in the silence (the photograph)
//   9.3    a riser into the drop at bar 10: the title, half-time drums
//   13-34  the groove under the features (arps from 15, zaps on the
//          modifier wipes, hits on the numbers, an 8-bit bass for Doom)
//   34-36  hits on the montage words; 36-38 the breakdown; 38 the end chord
import { BAR, BEAT, bars, beats } from "./timeline.js";

export const RATE = 48000;
export const midi = (n        ) => 440 * 2 ** ((n - 69) / 12);

// The voice table: VOICE.stride floats per voice
export const VOICE = {
  stride: 96,
  start: 0,
  stop: 1,
  // Pan matrix (Web Audio's StereoPannerNode for a mono or stereo input):
  // left = inL * ll + inR * rl, right = inR * rr + inL * lr
  ll: 2,
  rl: 3,
  rr: 4,
  lr: 5,
  dry: 6,
  ducked: 7,
  reverb: 8,
  delay: 9,
  // 0 none, 1 lowpass, 2 highpass, 3 bandpass; Q in dB for the first two,
  // linear for bandpass (as Web Audio's BiquadFilterNode)
  filterType: 10,
  filterQ: 11,
  shaper: 12,
  noiseGain: 13,
  noiseFiltered: 14,
  fmRatio: 15,
  // Three oscillators of 5 floats: wave (0 none, 1 sine, 2 saw, 3 square,
  // 4 triangle), frequency, detune ratio, gain, filtered
  osc: 16,
  oscStride: 5,
  // Four curves of 16 floats: point count, initial value, 2 unused, then 4
  // points of (time, value, ramp: 0 set, 1 linear, 2 exponential)
  gain: 32,
  pitch: 48,
  filter: 64,
  fm: 80,
}         ;

const WAVES = { sine: 1, saw: 2, square: 3, triangle: 4 }         ;
const FILTERS = { lowpass: 1, highpass: 2, bandpass: 3 }         ;

                                                                                  
                        
                  
                   
 
                      
                           
               
                 
                
                     
 
                        
                
               
               
                                               
                                                                   
              
                
                                       
                   
               
               
                   
                  
                 
 

// D minor: a chord per bar of the groove (bass root, then voicing)
const D2 = 38;
const CHORDS                                                    = {
  Dm9: { root: D2, notes: [53, 57, 60, 64, 69] },
  Bbmaj7: { root: D2 - 4, notes: [50, 53, 57, 60, 65] },
  Fmaj7: { root: D2 - 5 + 12, notes: [53, 57, 60, 64, 67] },
  Cadd9: { root: D2 - 2, notes: [52, 55, 60, 62, 67] },
  Gm9: { root: D2 + 5, notes: [53, 57, 58, 62, 65] },
  Dmaj9: { root: D2, notes: [54, 57, 61, 64, 69, 76] },
};
const PROGRESSION = ["Dm9", "Bbmaj7", "Fmaj7", "Cadd9"];
const chordAt = (bar        ) => CHORDS[PROGRESSION[((Math.floor(bar) % 4) + 4) % 4]];

// Web Audio's GainNode envelope of the old score: 0, a linear attack to
// peak, a hold, an exponential release to 1e-4
export const env = (at        , attack        , hold        , release        , peak        )        => ({
  initial: 0,
  points: [[at, 0, "set"], [at + attack, peak, "linear"], [at + attack + hold, peak, "set"], [at + attack + hold + release, 1e-4, "exp"]],
});

export class Score {
  voices          = [];
  kicks           = [];

  add(voice       ) {
    this.voices.push(voice);
  }

  pad(at        , length        , notes          , level = 0.05, bright = 1400) {
    notes.forEach((note, i) => this.add({
      start: at,
      stop: at + length + 3,
      oscs: [
        { wave: "saw", freq: midi(note), cents: -9, filtered: true },
        { wave: "saw", freq: midi(note), cents: 7, filtered: true },
        { wave: "triangle", freq: midi(note - 12), filtered: true },
      ],
      filter: { type: "lowpass", q: 0.5, freq: { initial: bright * 0.5, points: [[at, bright * 0.4, "set"], [at + length * 0.5, bright, "linear"], [at + length + 1.5, bright * 0.6, "linear"]] } },
      gain: env(at, Math.min(1.2, length * 0.4), Math.max(0, length - 1.2), 2.2, level),
      dry: 0.8,
      reverb: 0.6,
      pan: (i / Math.max(1, notes.length - 1) - 0.5) * 0.8,
      ducked: true,
    }));
  }

  pluck(at        , note        , level = 0.1, { delay = 0.35, pan = 0, decay = 0.45 } = {}) {
    this.add({
      start: at,
      stop: at + decay + 0.1,
      oscs: [{ wave: "triangle", freq: midi(note), filtered: true }, { wave: "square", freq: midi(note), cents: 5, gain: 0.3, filtered: true }],
      filter: { type: "lowpass", q: 2, freq: { initial: 5000, points: [[at, 6000, "set"], [at + decay, 700, "exp"]] } },
      gain: env(at, 0.003, 0, decay, level),
      reverb: 0.35,
      delay,
      pan,
    });
  }

  bell(at        , note        , level = 0.12, decay = 4) {
    this.add({
      start: at,
      stop: at + decay,
      oscs: [{ wave: "sine", freq: midi(note) }],
      fm: { ratio: 3.5, index: { initial: midi(note) * 2.2, points: [[at, midi(note) * 2.2, "set"], [at + decay * 0.6, 1, "exp"]] } },
      gain: env(at, 0.004, 0, decay, level),
      reverb: 0.8,
      delay: 0.25,
    });
  }

  drone(at        , until        , note        , level = 0.12) {
    this.add({
      start: at,
      stop: until,
      oscs: [
        { wave: "sine", freq: midi(note) },
        { wave: "saw", freq: midi(note), cents: -6, gain: 0.35, filtered: true },
        { wave: "saw", freq: midi(note), cents: 6, gain: 0.35, filtered: true },
      ],
      filter: { type: "lowpass", q: 0.8, freq: { initial: 300, points: [[at, 140, "set"], [(at + until) / 2, 420, "linear"], [until, 200, "linear"]] } },
      gain: { initial: 1, points: [[at, 0, "set"], [at + 2.5, level, "linear"], [until - 1.5, level, "set"], [until, 0, "linear"]] },
      reverb: 0.4,
    });
  }

  kick(at        , level = 0.5) {
    this.add({
      start: at,
      stop: at + 0.6,
      oscs: [{ wave: "sine", freq: 150 }],
      pitch: { initial: 150, points: [[at, 160, "set"], [at + 0.12, 44, "exp"]] },
      gain: env(at, 0.002, 0.03, 0.42, level),
    });
    this.add({
      start: at,
      stop: at + 0.02,
      noise: { gain: 1, filtered: true },
      filter: { type: "highpass", q: 0.7, freq: { initial: 2500 } },
      gain: env(at, 0.001, 0, 0.015, level * 0.3),
    });
    // Ducks the pads and bass under it (the ducked bus)
    this.kicks.push(at);
  }

  snare(at        , level = 0.22) {
    this.add({
      start: at,
      stop: at + 0.3,
      noise: { gain: 1, filtered: true },
      filter: { type: "bandpass", q: 0.8, freq: { initial: 2200 } },
      gain: env(at, 0.001, 0.01, 0.2, level),
      reverb: 0.35,
    });
    this.add({
      start: at,
      stop: at + 0.2,
      oscs: [{ wave: "triangle", freq: 190 }],
      pitch: { initial: 190, points: [[at, 190, "set"], [at + 0.1, 140, "exp"]] },
      gain: env(at, 0.001, 0, 0.1, level * 0.6),
      reverb: 0.2,
    });
  }

  hat(at        , level = 0.05, open = false, pan = 0.2) {
    this.add({
      start: at,
      stop: at + (open ? 0.4 : 0.08),
      noise: { gain: 1, filtered: true },
      filter: { type: "highpass", q: 0.7, freq: { initial: 7500 } },
      gain: env(at, 0.001, 0, open ? 0.28 : 0.04, level),
      pan,
      reverb: 0.1,
    });
  }

  bass(at        , note        , length        , level = 0.16, cutoff = 700) {
    this.add({
      start: at,
      stop: at + length + 0.1,
      oscs: [{ wave: "saw", freq: midi(note), filtered: true }, { wave: "sine", freq: midi(note - 12), gain: 0.8, filtered: true }],
      filter: { type: "lowpass", q: 3, freq: { initial: cutoff, points: [[at, cutoff * 2.2, "set"], [at + length, cutoff * 0.6, "exp"]] } },
      gain: env(at, 0.005, length * 0.5, length * 0.5, level),
      ducked: true,
    });
  }

  // A square wave through a stepped curve: 8 bits for Doom
  chip(at        , note        , length        , level = 0.07) {
    this.add({
      start: at,
      stop: at + length + 0.05,
      oscs: [{ wave: "square", freq: midi(note) }],
      shaper: true,
      gain: env(at, 0.002, length * 0.7, length * 0.3, level),
      reverb: 0.1,
      delay: 0.1,
    });
  }

  impact(at        , level = 0.6) {
    this.add({
      start: at,
      stop: at + 3,
      oscs: [{ wave: "sine", freq: 60 }],
      pitch: { initial: 60, points: [[at, 70, "set"], [at + 1.8, 28, "exp"]] },
      gain: env(at, 0.005, 0.1, 2.2, level * 0.8),
    });
    this.add({
      start: at,
      stop: at + 3,
      noise: { gain: 1, filtered: true },
      filter: { type: "lowpass", q: 0.5, freq: { initial: 8000, points: [[at, 9000, "set"], [at + 1.5, 300, "exp"]] } },
      gain: env(at, 0.002, 0.05, 1.6, level * 0.5),
      reverb: 0.9,
    });
  }

  riser(at        , until        , level = 0.12) {
    this.add({
      start: at,
      stop: until + 0.05,
      noise: { gain: 1, filtered: true },
      filter: { type: "bandpass", q: 2, freq: { initial: 300, points: [[at, 250, "set"], [until, 9000, "exp"]] } },
      gain: { initial: 1, points: [[at, 1e-4, "set"], [until - 0.02, level, "exp"], [until, 0, "linear"]] },
      reverb: 0.4,
    });
  }

  whoosh(at        , level = 0.08, length = 0.5) {
    const from = at - length * 0.7;
    this.add({
      start: from,
      stop: at + length * 0.5,
      noise: { gain: 1, filtered: true },
      filter: { type: "bandpass", q: 1.2, freq: { initial: 600, points: [[from, 400, "set"], [at, 5000, "exp"], [at + length * 0.5, 800, "exp"]] } },
      gain: { initial: 1, points: [[from, 1e-4, "set"], [at, level, "exp"], [at + length * 0.5, 1e-4, "exp"]] },
      reverb: 0.3,
      pan: -0.2,
    });
  }

  zap(at        , level = 0.06) {
    this.add({
      start: at,
      stop: at + 0.2,
      oscs: [{ wave: "square", freq: 1800, filtered: true }],
      pitch: { initial: 1800, points: [[at, 2400, "set"], [at + 0.15, 180, "exp"]] },
      filter: { type: "lowpass", q: 0.7, freq: { initial: 4000 } },
      gain: env(at, 0.001, 0, 0.14, level),
      delay: 0.4,
      pan: 0.3,
    });
  }

  shutter(at        , level = 0.35) {
    for (const [offset, freq] of [[0, 3000], [0.07, 1800]]         ) {
      this.add({
        start: at + offset,
        stop: at + offset + 0.05,
        noise: { gain: 1, filtered: true },
        filter: { type: "bandpass", q: 1.5, freq: { initial: freq } },
        gain: env(at + offset, 0.001, 0, 0.035, level),
        reverb: 0.15,
      });
    }
  }

  tick(at        , level = 0.08, high = true) {
    this.add({
      start: at,
      stop: at + 0.06,
      oscs: [{ wave: "sine", freq: high ? 2100 : 1600 }],
      gain: env(at, 0.001, 0, 0.04, level),
      reverb: 0.25,
      pan: high ? 0.25 : -0.25,
    });
  }
}

// Times of the doublings in shots/genesis.ts: grow runs from -23.5 to 0 as
// 1 - (1 - g)^1.6 over bars 2-4, and the count doubles at each integer
function doublings() {
  const times           = [];
  for (let n = -23; n <= 0; n += 1) {
    const g = 1 - (-n / 23.5) ** 0.625;
    times.push(bars(2) + g * bars(2));
  }
  return times;
}

function compose(s       ) {
  // --- Act one ---
  s.drone(0, bars(4.3), D2 - 12, 0.28);
  s.drone(0.4, bars(4.3), D2 - 5, 0.11);
  s.bell(bars(0.5), 74, 0.22, 5);
  s.bell(bars(1.25), 81, 0.11, 4);
  const arp = [50, 53, 57, 60, 64];
  doublings().forEach((at, i) => s.pluck(at, arp[i % 5] + 12 * Math.floor(i / 5), 0.11 + i * 0.007, { delay: 0.3, pan: ((i % 4) - 1.5) * 0.3, decay: 0.5 }));
  s.riser(bars(3.2), bars(4), 0.14);

  s.pad(bars(4), BAR, CHORDS.Dm9.notes, 0.06, 1100);
  s.pad(bars(5), BAR, CHORDS.Bbmaj7.notes, 0.06, 1300);
  s.pad(bars(6), BAR, CHORDS.Fmaj7.notes, 0.06, 1500);
  s.pad(bars(7), BAR, CHORDS.Cadd9.notes, 0.058, 1300);
  s.pad(bars(8), beats(2), CHORDS.Dm9.notes, 0.055, 1000);
  s.bell(bars(5.4), 76, 0.16, 4);
  s.bell(bars(7.1), 72, 0.12, 4);
  [69, 67, 65, 64].forEach((note, i) => s.pluck(bars(7.5) + beats(i), note, 0.11, { delay: 0.4, decay: 0.9 }));

  // The photograph: a shutter, then only the clock
  s.shutter(bars(8.5), 0.45);
  for (let i = 0; i < 4; i += 1) {
    s.tick(bars(8.5) + beats(1 + i * 0.7), 0.085, i % 2 === 0);
  }
  s.riser(bars(9.3), bars(10), 0.2);
  s.pad(bars(9.3), beats(2.8), [62, 65, 69], 0.028, 2600);

  // --- The drop: half time under the title ---
  s.impact(bars(10), 0.7);
  for (let bar = 10; bar < 13; bar += 1) {
    const chord = chordAt(bar);
    s.pad(bars(bar), BAR, chord.notes, 0.032, 1800);
    s.bass(bars(bar), chord.root, BAR - 0.05, 0.14, 500);
    s.kick(bars(bar), 0.55);
    s.kick(bars(bar) + beats(2.5), 0.35);
    s.snare(bars(bar) + beats(2), 0.24);
    for (let b = 0; b < 4; b += 1) {
      s.hat(bars(bar) + beats(b + 0.5), 0.035);
    }
  }
  s.bell(bars(10.25), 74, 0.09, 5);
  s.bell(bars(11), 81, 0.06, 5);

  // --- The groove: bars 13-34 ---
  for (let bar = 13; bar < 34; bar += 1) {
    const chord = chordAt(bar);
    const intense = bar >= 29 && bar < 32;
    const games = bar >= 32;
    s.pad(bars(bar), BAR, chord.notes, intense ? 0.03 : 0.026, intense ? 2600 : 1700);
    for (let b = 0; b < 4; b += 1) {
      const at = bars(bar) + beats(b);
      s.kick(at, 0.5);
      if (b === 1 || b === 3) {
        s.snare(at, 0.2);
      }
      s.hat(at + beats(0.5), 0.045, intense && b % 2 === 1);
      if (intense || bar >= 24) {
        s.hat(at + beats(0.25), 0.018, false, -0.3);
        s.hat(at + beats(0.75), 0.018, false, -0.3);
      }
      // Eighths of bass: root, root, octave, root
      for (let e = 0; e < 2; e += 1) {
        const note = chord.root + (e === 1 && b % 2 === 1 ? 12 : 0);
        if (games) {
          s.chip(at + beats(e / 2), note + 12, beats(0.45), 0.05);
        } else {
          s.bass(at + beats(e / 2), note, beats(0.45), 0.12, intense ? 1100 : 750);
        }
      }
    }
    // Arps from the generators on: sixteenths over the chord
    if (bar >= 15) {
      for (let i = 0; i < 16; i += 1) {
        const notes = chord.notes;
        const note = notes[[0, 2, 4, 2, 1, 3, 4, 3][i % 8] % notes.length] + (i >= 8 ? 12 : 0);
        s.pluck(bars(bar) + beats(i / 4), note, games ? 0.025 : 0.035, { delay: 0.3, pan: i % 2 ? 0.35 : -0.35, decay: 0.22 });
      }
    }
  }
  // Each feature arrives with a whoosh
  for (const bar of [13, 15, 18, 21, 24, 27, 29, 32]) {
    s.whoosh(bars(bar), 0.09);
  }
  // A crash of sorts on the section starts
  for (const bar of [15, 21, 29]) {
    s.hat(bars(bar), 0.08, true, 0);
    s.bell(bars(bar), 81, 0.04, 3);
  }
  // Zaps on the modifier wipes
  for (let k = 1; k <= 5; k += 1) {
    s.zap(bars(21) + beats(2 * k));
  }
  // The numbers
  s.impact(bars(29.25), 0.35);
  s.impact(bars(30.2), 0.4);
  s.tick(bars(31.05), 0.05);
  // Doom, then Quake
  s.impact(bars(32), 0.3);
  s.impact(bars(33), 0.45);

  // --- The montage: a hit per word ---
  for (const [i, bar] of [34, 34.5, 35, 35.5].entries()) {
    s.impact(bars(bar), 0.45 + i * 0.05);
    s.pad(bars(bar), beats(2), CHORDS[["Dm9", "Bbmaj7", "Fmaj7", "Cadd9"][i]].notes, 0.04, 3000);
    for (let b = 0; b < 2; b += 1) {
      s.kick(bars(bar) + beats(b), 0.5);
      s.hat(bars(bar) + beats(b + 0.5), 0.05);
      s.bass(bars(bar) + beats(b), CHORDS[["Dm9", "Bbmaj7", "Fmaj7", "Cadd9"][i]].root, beats(0.9), 0.13, 1200);
    }
    s.snare(bars(bar) + beats(1), 0.22);
  }
  s.riser(bars(35.5), bars(36), 0.1);

  // --- The breakdown under the last line ---
  s.pad(bars(36), BAR, CHORDS.Bbmaj7.notes, 0.04, 1200);
  s.pad(bars(37), beats(2), CHORDS.Gm9.notes, 0.04, 1200);
  s.pad(bars(37.5), beats(2), CHORDS.Cadd9.notes, 0.04, 1400);
  s.drone(bars(36), bars(38.2), D2 - 4 - 12, 0.08);
  [69, 67, 65, 64, 65, 67, 69, 72].forEach((note, i) => s.pluck(bars(36) + beats(i), note, 0.055, { delay: 0.45, decay: 1.4 }));
  s.riser(bars(37.4), bars(38), 0.08);

  // --- The end: D major, and a long tail ---
  s.impact(bars(38), 0.5);
  s.pad(bars(38), bars(3.2), CHORDS.Dmaj9.notes, 0.04, 2000);
  s.drone(bars(38), bars(42), D2 - 12, 0.1);
  s.bell(bars(38), 74, 0.1, 6);
  s.bell(bars(38.5), 78, 0.07, 6);
  s.bell(bars(39), 81, 0.06, 6);
  s.bell(bars(40.2), 85, 0.04, 6);
  s.bell(bars(40.8), 86, 0.035, 6);
}

                            
                                                   
                                   
                
                                    
                                   
                                          
                                   
                          
 

// The effects' settings a score chooses: the ping-pong delay's time (more
// than a chunk, 0.2 s, and under 1.3 s) and feedback, the reverb's level in
// the master, and a gain into the limiter
                           
                 
                    
                  
                  
 

const RAMPS = { set: 0, linear: 1, exp: 2 }         ;

function writeCurve(table              , at        , curve       ) {
  const points = curve.points ?? [];
  if (points.length > 4) {
    throw new Error("a curve has at most 4 points");
  }
  table[at] = points.length;
  table[at + 1] = curve.initial;
  points.forEach(([time, value, ramp], i) => table.set([time, value, RAMPS[ramp]], at + 4 + i * 3));
}

// StereoPannerNode: equal-power gains of a mono input, or the stereo law
function panMatrix(pan        , stereo         ) {
  if (!stereo) {
    const x = ((pan + 1) / 2) * (Math.PI / 2);
    return { ll: Math.cos(x), rl: 0, rr: Math.sin(x), lr: 0 };
  }
  const x = (pan <= 0 ? pan + 1 : pan) * (Math.PI / 2);
  return pan <= 0 ? { ll: 1, rl: Math.cos(x), rr: Math.sin(x), lr: 0 } : { ll: Math.cos(x), rl: 0, rr: 1, lr: Math.sin(x) };
}

// The film's score, or any other written for these instruments (on a Score
// or a subclass with more of them)
export function buildScore                         (write                     = compose                      , mix           = {}, score    = new Score()     )            {
  write(score);
  const voices = [...score.voices].sort((a, b) => a.start - b.start);
  const table = new Float32Array(voices.length * VOICE.stride);
  voices.forEach((v, i) => {
    const at = i * VOICE.stride;
    const pan = panMatrix(v.pan ?? 0, Boolean(v.noise));
    table.set([v.start, v.stop, pan.ll, pan.rl, pan.rr, pan.lr, v.dry ?? 1, v.ducked ? 1 : 0, v.reverb ?? 0, v.delay ?? 0], at);
    table[at + VOICE.filterType] = v.filter ? FILTERS[v.filter.type] : 0;
    table[at + VOICE.filterQ] = v.filter?.q ?? 0.7;
    table[at + VOICE.shaper] = v.shaper ? 1 : 0;
    table[at + VOICE.noiseGain] = v.noise?.gain ?? 0;
    table[at + VOICE.noiseFiltered] = v.noise?.filtered ? 1 : 0;
    table[at + VOICE.fmRatio] = v.fm?.ratio ?? 0;
    (v.oscs ?? []).forEach((osc, k) => table.set(
      [WAVES[osc.wave], osc.freq, 2 ** ((osc.cents ?? 0) / 1200), osc.gain ?? 1, osc.filtered ? 1 : 0],
      at + VOICE.osc + k * VOICE.oscStride,
    ));
    writeCurve(table, at + VOICE.gain, v.gain);
    writeCurve(table, at + VOICE.pitch, v.pitch ?? { initial: v.oscs?.[0]?.freq ?? 0 });
    writeCurve(table, at + VOICE.filter, v.filter?.freq ?? { initial: 1000 });
    writeCurve(table, at + VOICE.fm, v.fm?.index ?? { initial: 0 });
  });
  return {
    table,
    count: voices.length,
    starts: Float32Array.from(voices, (v) => v.start),
    stops: Float32Array.from(voices, (v) => v.stop),
    kicks: Float32Array.from([...score.kicks].sort((a, b) => a - b)),
    mix: { delay: BEAT * 0.75, feedback: 0.42, reverb: 0.36, output: 1, ...mix },
  };
}

// 16-bit PCM WAV of interleaved stereo samples
export function toWav(samples              , rate = RATE) {
  const channels = 2;
  const frames = samples.length / channels;
  const out = new ArrayBuffer(44 + frames * channels * 2);
  const view = new DataView(out);
  const text = (at        , s        ) => [...s].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
  text(0, "RIFF");
  view.setUint32(4, 36 + frames * channels * 2, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, frames * channels * 2, true);
  for (let i = 0; i < samples.length; i += 1) {
    view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, samples[i])) * 32767, true);
  }
  return out;
}


//# sourceURL=examples/film/score.ts