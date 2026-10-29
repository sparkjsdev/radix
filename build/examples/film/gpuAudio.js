// The score rendered on the GPU: Radix's WgpuCompute kernels synthesize
// it in chunks of CHUNK stereo frames at 48 kHz, every stage in TSL:
//
//   voices  one thread per voice sounding in the chunk, sample by sample:
//           band-limited oscillators (PolyBLEP saw and square), FM, stereo
//           noise, a Web Audio biquad (lowpass / highpass / bandpass, its
//           cutoff automated), the waveshaper, the gain curve and the pan
//   mix     one thread per frame: every voice into the dry bus, the
//           sidechain-ducked bus (kicks duck it), the reverb and delay sends
//   delay   the ping-pong delay (the score's time each way, the feedback
//           through a lowpass): the feedback filter is a one-thread scan,
//           the rest one thread per frame (the delay is longer than a chunk)
//   reverb  a 4 s stereo convolution reverb (a decaying sparse noise
//           impulse, lowpassed): one thread per frame over 7200 taps a side
//   master  one thread: the reverb's lowpass, the compressor, the output
//           gain, a limiter and the end fade
//
// Chunks run in order (the delay, reverb and filters carry state from one
// to the next) and are read back into a Float32Array of interleaved L, R.
import { TSL, WgpuBuffer, WgpuCompute, WgpuComputeBatch,              } from "@sparkjsdev/radix";
                                                   
import { RATE, VOICE, buildScore,                } from "./score.js";
import { random } from "./timeline.js";

const { If, Loop, abs, bool, clamp, cos, exp2, float, fract, hash, log2, max, min, mix, pow, round, select, sin, uint, uniform, vec2 } = TSL;

// 0.2 s: shorter than the delay, so each chunk's delay reads come from
// earlier chunks
export const CHUNK = 9600;
// Chunks rendered per readback
const BATCH = 16;
const TWO_PI = Math.PI * 2;
const DELAY_RING = 1 << 16;
const REVERB_RING = 1 << 18;
const REVERB_TAPS = 7200;
const REVERB_SECONDS = 4;
// Per voice: 3 oscillator phases, the FM phase, biquad state (x1, x2, y1,
// y2) for L then R
const STATE = 16;

// The master: the old score's compressor settings (threshold, knee, ratio
// in dB, as Web Audio's DynamicsCompressorNode), output gain and limiter
// ceiling
const MASTER = { gain: 0.7, threshold: -14, knee: 30, ratio: 3, attack: 0.01, release: 0.25, output: 2.1, ceiling: 0.84, limiterRelease: 0.08 };

// A biquad's coefficients (Web Audio's formulas), for the delay's filter
function lowpass(freq        , qDb        ) {
  const w0 = (TWO_PI * freq) / RATE;
  const alpha = Math.sin(w0) / (2 * 10 ** (qDb / 20));
  const a0 = 1 + alpha;
  const b0 = (1 - Math.cos(w0)) / 2 / a0;
  return { b0, b1: (1 - Math.cos(w0)) / a0, b2: b0, a1: (-2 * Math.cos(w0)) / a0, a2: (1 - alpha) / a0 };
}

// StereoPannerNode on a stereo input: [ll, rl, rr, lr]
function stereoPan(pan        ) {
  const x = (pan <= 0 ? pan + 1 : pan) * (Math.PI / 2);
  return pan <= 0 ? [1, Math.cos(x), Math.sin(x), 0] : [Math.cos(x), 0, 1, Math.sin(x)];
}

// The impulse: a sparse random-sign tap every RATE / density frames, its
// energy in each 25 ms window set to exp(-3.2 t) (so both channels decay
// alike from the first window), in all the energy of the old score's
// ConvolverNode (its noise impulse normalized as Web Audio does: 0.257 a
// channel, measured in Chrome, after the lowpass)
function reverbTaps() {
  const next = random(2026);
  const spacing = (REVERB_SECONDS * RATE) / REVERB_TAPS;
  const window = 1200;
  const windows = Math.ceil((REVERB_SECONDS * RATE) / window);
  const target = Array.from({ length: windows }, (_, w) => Math.exp((-3.2 * (w + 0.5) * window) / RATE));
  const total = target.reduce((sum, e) => sum + e, 0);
  // The one-pole lowpass after it passes a / (2 - a) of white noise's power
  const energy = 0.257 / (0.35 / 1.65);
  const taps = new Float32Array(REVERB_TAPS * 4);
  for (const channel of [0, 1]) {
    const sums = new Float64Array(windows);
    for (let k = 0; k < REVERB_TAPS; k += 1) {
      const offset = Math.floor((k + next()) * spacing);
      taps[k * 4 + channel * 2] = offset;
      taps[k * 4 + channel * 2 + 1] = next() < 0.5 ? -1 : 1;
      sums[Math.floor(offset / window)] += 1;
    }
    for (let k = 0; k < REVERB_TAPS; k += 1) {
      const w = Math.floor(taps[k * 4 + channel * 2] / window);
      taps[k * 4 + channel * 2 + 1] *= Math.sqrt((energy * target[w]) / total / sums[w]);
    }
  }
  return taps;
}

                 
                 
                   
                                                   
 

// Web Audio's AudioParam timeline: before the first event the initial
// value; a set holds the previous value until its time; a linear or
// exponential ramp runs from the previous event to its own
function curveAt(c       , t         ) {
  let result = c.initial;
  let prevT          = float(-1e9);
  let prevV = c.initial;
  let settled          = bool(false);
  c.points.forEach((p, i) => {
    const valid = c.count.greaterThan(i + 0.5);
    const passed = valid.and(t.greaterThanEqual(p.t)).toVar();
    const open = valid.and(passed.not()).and(settled.not()).toVar();
    const u = clamp(t.sub(prevT).div(max(p.t.sub(prevT), 1e-6)), 0, 1);
    const from = max(prevV, 1e-7);
    const exponential = from.mul(pow(max(p.v, 1e-7).div(from), u));
    const segment = select(p.r.greaterThan(1.5), exponential, select(p.r.greaterThan(0.5), mix(prevV, p.v, u), prevV));
    result = select(open, segment, select(passed, p.v, result)).toVar();
    settled = settled.or(open).toVar();
    prevT = select(passed, p.t, prevT).toVar();
    prevV = select(passed, p.v, prevV).toVar();
  });
  return result;
}

// PolyBLEP: the band-limited step correction near a wrap
function blep(x         , dt         ) {
  const a = x.div(dt);
  const b = x.sub(1).div(dt);
  return select(x.lessThan(dt), a.add(a).sub(a.mul(a)).sub(1), select(x.greaterThan(float(1).sub(dt)), b.mul(b).add(b).add(b).add(1), float(0)));
}

// Web Audio's built-in waves: each starts at 0 (saw and triangle rising,
// square high), with saw and square scaled by 0.851 as Chrome normalizes
// their band-limited tables to a peak of 1 (the Gibbs overshoot)
const GIBBS = 0.851;
function wave(kind         , phase         , dt         ) {
  const sine = sin(phase.mul(TWO_PI));
  const half = fract(phase.add(0.5));
  const saw = half.mul(2).sub(1).sub(blep(half, dt)).mul(GIBBS);
  const square = select(phase.lessThan(0.5), float(1), float(-1)).add(blep(phase, dt)).sub(blep(half, dt)).mul(GIBBS);
  const triangle = float(1).sub(abs(fract(phase.add(0.25)).sub(0.5)).mul(4));
  return select(kind.lessThan(0.5), float(0), select(kind.lessThan(1.5), sine, select(kind.lessThan(2.5), saw, select(kind.lessThan(3.5), square, triangle))));
}

export class GpuScore {
           renderer                ;
           score           ;
           duration        ;
           chunks        ;
          lists                            ;
          u = { frame0: uniform(0, "uint"), active: uniform(0, "uint"), outBase: uniform(0, "uint") };
          buffers                        = [];
          state                       ;
          fx                         ;
          rings                           ;
          active                      ;
          out                         ;
          kernels                                                                                                                                   ;
          batch                  ;

  // `raw`: the master without its compressor, output gain, limiter and
  // fade (for comparing instruments)
  constructor(renderer                , duration        , { score = buildScore(), raw = false }                                       = {}) {
    this.renderer = renderer;
    this.duration = duration;
    this.score = score;
    this.chunks = Math.ceil((duration * RATE) / CHUNK);
    const { u } = this;

    // The voices sounding in each chunk
    this.lists = Array.from({ length: this.chunks }, (_, k) => {
      const from = (k * CHUNK) / RATE;
      const to = ((k + 1) * CHUNK) / RATE;
      const ids           = [];
      for (let i = 0; i < score.count && score.starts[i] < to; i += 1) {
        if (score.stops[i] > from) {
          ids.push(i);
        }
      }
      return Uint32Array.from(ids);
    });
    const maxActive = Math.max(1, ...this.lists.map((list) => list.length));

    const buffer =                                                             (format   , count        ) => {
      const made = new WgpuBuffer({ renderer, format, count });
      this.buffers.push(made);
      return made;
    };
    const voices = buffer("float32", score.table.length);
    voices.upload(score.table);
    const kicks = buffer("float32", Math.max(1, score.kicks.length));
    kicks.upload(score.kicks);
    const taps = buffer("float32x4", REVERB_TAPS);
    taps.upload(reverbTaps());
    this.state = buffer("float32", score.count * STATE);
    this.active = buffer("uint32", maxActive);
    const slots = buffer("float32x2", maxActive * CHUNK);
    const master = buffer("float32x2", CHUNK);
    const delayed = buffer("float32x2", CHUNK);
    const wet = buffer("float32x2", CHUNK);
    const reverbIn = buffer("float32x2", REVERB_RING);
    const delayIn = buffer("float32x2", DELAY_RING);
    const delayA = buffer("float32x2", DELAY_RING);
    const delayLp = buffer("float32x2", DELAY_RING);
    this.rings = [reverbIn, delayIn, delayA, delayLp];
    // Effect state: the delay filter's x1, x2, y1, y2, the reverb lowpass,
    // (compressor reduction in dB, limiter gain)
    this.fx = buffer("float32x2", 8);
    this.out = buffer("float32x2", CHUNK * BATCH);
    const out = this.out;
    const { state, fx, active } = this;
    const DELAY = Math.round(score.mix.delay * RATE);
    if (DELAY <= CHUNK || DELAY >= DELAY_RING - CHUNK) {
      throw new Error(`A delay of ${score.mix.delay} s: it reads earlier chunks only, so 0.2 to 1.3 s`);
    }
    const v = (base         , k        ) => voices.element(base.add(uint(k)));
    const delayRing = (frame         ) => frame.bitAnd(uint(DELAY_RING - 1));
    const reverbRing = (frame         ) => frame.bitAnd(uint(REVERB_RING - 1));

    const voiceKernel = new WgpuCompute({
      label: "scoreVoices",
      workgroupSize: [32],
      body: ({ index }) => {
        If(index.lessThan(u.active), () => {
          const id = active.element(index).toVar();
          const base = id.mul(uint(VOICE.stride)).toVar();
          const p = (k        ) => v(base, k).toVar();
          const [start, stop, ll, rl, rr, lr] = [VOICE.start, VOICE.stop, VOICE.ll, VOICE.rl, VOICE.rr, VOICE.lr].map(p);
          const [filterType, filterQ, shaper, noiseGain, noiseFiltered, fmRatio] = [VOICE.filterType, VOICE.filterQ, VOICE.shaper, VOICE.noiseGain, VOICE.noiseFiltered, VOICE.fmRatio].map(p);
          const oscs = [0, 1, 2].map((k) => {
            const at = VOICE.osc + k * VOICE.oscStride;
            return { kind: p(at), freq: p(at + 1), detune: p(at + 2), gain: p(at + 3), filtered: p(at + 4) };
          });
          const curve = (at        )        => ({
            count: p(at),
            initial: p(at + 1),
            points: [0, 1, 2, 3].map((i) => ({ t: p(at + 4 + i * 3), v: p(at + 5 + i * 3), r: p(at + 6 + i * 3) })),
          });
          const gainCurve = curve(VOICE.gain);
          const pitchCurve = curve(VOICE.pitch);
          const filterCurve = curve(VOICE.filter);
          const fmCurve = curve(VOICE.fm);

          const stateBase = id.mul(uint(STATE)).toVar();
          const s = (k        ) => state.element(stateBase.add(uint(k)));
          const phases = [0, 1, 2].map((k) => s(k).toVar());
          const fmPhase = s(3).toVar();
          const z = [4, 5, 6, 7, 8, 9, 10, 11].map((k) => s(k).toVar());
          const [b0, b1, b2, a1, a2] = [1, 0, 0, 0, 0].map((c) => float(c).toVar());
          // Q in dB for lowpass and highpass, linear for bandpass
          const q = select(filterType.greaterThan(2.5), filterQ, pow(float(10), filterQ.div(20))).toVar();
          const lp = filterType.lessThan(1.5);
          const hp = filterType.lessThan(2.5);
          const none = filterType.lessThan(0.5);

          Loop({ start: uint(0), end: uint(CHUNK), type: "uint", condition: "<" }, ({ i }                ) => {
            const frame = u.frame0.add(i).toVar();
            const t = float(frame).div(RATE).toVar();
            // Oscillators start at phase 0 at the voice's start, as Web Audio's
            const running = t.greaterThanEqual(start);

            // The filter's coefficients every 16 frames, from its cutoff curve
            If(i.bitAnd(uint(15)).equal(uint(0)), () => {
              const f = clamp(curveAt(filterCurve, t), 10, RATE * 0.49);
              const w0 = f.mul(TWO_PI / RATE);
              const cw = cos(w0).toVar();
              const alpha = sin(w0).div(q.mul(2)).toVar();
              const a0 = alpha.add(1).toVar();
              const nb0 = select(lp, float(1).sub(cw).mul(0.5), select(hp, cw.add(1).mul(0.5), alpha)).toVar();
              const nb1 = select(lp, float(1).sub(cw), select(hp, cw.add(1).negate(), float(0)));
              const nb2 = select(hp, nb0, alpha.negate());
              b0.assign(select(none, float(1), nb0.div(a0)));
              b1.assign(select(none, float(0), nb1.div(a0)));
              b2.assign(select(none, float(0), nb2.div(a0)));
              a1.assign(select(none, float(0), cw.mul(-2).div(a0)));
              a2.assign(select(none, float(0), float(1).sub(alpha).div(a0)));
            });

            // Oscillators: the first follows the pitch curve, frequency-
            // modulated when the voice has an FM ratio
            const pitch = curveAt(pitchCurve, t).toVar();
            const modulator = sin(fmPhase.mul(TWO_PI)).toVar();
            fmPhase.assign(select(running, fract(fmPhase.add(pitch.mul(fmRatio).div(RATE))), float(0)));
            const carrier = pitch.add(select(fmRatio.greaterThan(0), curveAt(fmCurve, t).mul(modulator), float(0))).toVar();
            const filtered = float(0).toVar();
            const direct = float(0).toVar();
            oscs.forEach((o, k) => {
              const f = (k === 0 ? carrier : o.freq).mul(o.detune).toVar();
              const dt = clamp(abs(f).div(RATE), 1e-6, 0.5);
              const sample = wave(o.kind, phases[k], dt).mul(o.gain).toVar();
              phases[k].assign(select(running, fract(phases[k].add(f.div(RATE))), float(0)));
              filtered.addAssign(sample.mul(o.filtered));
              direct.addAssign(sample.mul(float(1).sub(o.filtered)));
            });

            // Stereo noise, hashed from the frame and the voice
            const seed = frame.mul(uint(2)).add(id.mul(uint(0x9e3779b1)));
            const noiseL = hash(seed).mul(2).sub(1).mul(noiseGain).toVar();
            const noiseR = hash(seed.add(uint(1))).mul(2).sub(1).mul(noiseGain).toVar();
            const xL = filtered.add(noiseL.mul(noiseFiltered)).toVar();
            const xR = filtered.add(noiseR.mul(noiseFiltered)).toVar();

            // The biquad, direct form I, per channel
            const yL = b0.mul(xL).add(b1.mul(z[0])).add(b2.mul(z[1])).sub(a1.mul(z[2])).sub(a2.mul(z[3])).toVar();
            const yR = b0.mul(xR).add(b1.mul(z[4])).add(b2.mul(z[5])).sub(a1.mul(z[6])).sub(a2.mul(z[7])).toVar();
            z[1].assign(z[0]);
            z[0].assign(xL);
            z[3].assign(z[2]);
            z[2].assign(yL);
            z[5].assign(z[4]);
            z[4].assign(xR);
            z[7].assign(z[6]);
            z[6].assign(yR);

            const unfiltered = float(1).sub(noiseFiltered);
            const preL = yL.add(direct).add(noiseL.mul(unfiltered)).toVar();
            const preR = yR.add(direct).add(noiseR.mul(unfiltered)).toVar();
            // The 8-bit curve
            const shapedL = select(shaper.greaterThan(0.5), round(preL.mul(6)).div(6), preL);
            const shapedR = select(shaper.greaterThan(0.5), round(preR.mul(6)).div(6), preR);
            const sounding = select(t.greaterThanEqual(start).and(t.lessThan(stop)), float(1), float(0));
            const gain = curveAt(gainCurve, t).mul(sounding).toVar();
            const outL = shapedL.mul(gain).toVar();
            const outR = shapedR.mul(gain).toVar();
            slots.element(index.mul(uint(CHUNK)).add(i)).assign(vec2(outL.mul(ll).add(outR.mul(rl)), outR.mul(rr).add(outL.mul(lr))));
          });

          phases.forEach((phase, k) => s(k).assign(phase));
          s(3).assign(fmPhase);
          z.forEach((value, k) => s(4 + k).assign(value));
        });
      },
    });

    const kickCount = score.kicks.length;
    const mixKernel = new WgpuCompute({
      label: "scoreMix",
      body: ({ index }) => {
        If(index.lessThan(uint(CHUNK)), () => {
          const frame = u.frame0.add(index).toVar();
          const t = float(frame).div(RATE).toVar();
          const dry = vec2(0).toVar();
          const duck = vec2(0).toVar();
          const reverb = vec2(0).toVar();
          const delay = vec2(0).toVar();
          Loop({ start: uint(0), end: u.active, type: "uint", condition: "<" }, ({ i }                ) => {
            const base = active.element(i).mul(uint(VOICE.stride)).toVar();
            const sample = slots.element(i.mul(uint(CHUNK)).add(index)).toVar();
            const level = v(base, VOICE.dry).toVar();
            const ducked = v(base, VOICE.ducked).toVar();
            dry.addAssign(sample.mul(level.mul(float(1).sub(ducked))));
            duck.addAssign(sample.mul(level.mul(ducked)));
            reverb.addAssign(sample.mul(v(base, VOICE.reverb)));
            delay.addAssign(sample.mul(v(base, VOICE.delay)));
          });
          // The sidechain: down to 0.35 at each kick, back to 1 over 0.42 s
          const duckGain = float(1).toVar();
          Loop({ start: uint(0), end: uint(kickCount), type: "uint", condition: "<" }, ({ i }                ) => {
            const kick = kicks.element(i).toVar();
            If(kick.lessThanEqual(t), () => {
              duckGain.assign(clamp(t.sub(kick).div(0.42).mul(0.65).add(0.35), 0.35, 1));
            });
          });
          const ducked = duck.mul(duckGain).toVar();
          // The ducked bus feeds the master and the reverb
          master.element(index).assign(dry.add(ducked));
          reverbIn.element(reverbRing(frame)).assign(reverb.add(ducked));
          delayIn.element(delayRing(frame)).assign(delay);
          delayed.element(index).assign(delayA.element(delayRing(frame.sub(uint(DELAY)))));
        });
      },
    });

    // The feedback lowpass of the delay, over the chunk in order
    const f = lowpass(3200, 0.7);
    const delayFilterKernel = new WgpuCompute({
      label: "scoreDelayFilter",
      workgroupSize: [1],
      body: ({ index }) => {
        If(index.equal(uint(0)), () => {
          const [x1, x2, y1, y2] = [0, 1, 2, 3].map((k) => fx.element(uint(k)).toVar());
          Loop({ start: uint(0), end: uint(CHUNK), type: "uint", condition: "<" }, ({ i }                ) => {
            const x = delayed.element(i).toVar();
            const y = x.mul(f.b0).add(x1.mul(f.b1)).add(x2.mul(f.b2)).sub(y1.mul(f.a1)).sub(y2.mul(f.a2)).toVar();
            x2.assign(x1);
            x1.assign(x);
            y2.assign(y1);
            y1.assign(y);
            delayLp.element(delayRing(u.frame0.add(i))).assign(y);
          });
          [x1, x2, y1, y2].forEach((value, k) => fx.element(uint(k)).assign(value));
        });
      },
    });

    // a = the delayed input plus the filtered feedback; b = a delayed again;
    // a to the left, b to the right, the left into the reverb too
    const [lll, lrl, lrr, llr] = stereoPan(-0.7);
    const [rll, rrl, rrr, rlr] = stereoPan(0.7);
    const delayKernel = new WgpuCompute({
      label: "scoreDelay",
      body: ({ index }) => {
        If(index.lessThan(uint(CHUNK)), () => {
          const frame = u.frame0.add(index).toVar();
          const past = delayRing(frame.sub(uint(DELAY))).toVar();
          const a = delayIn.element(past).add(delayLp.element(past).mul(score.mix.feedback)).toVar();
          delayA.element(delayRing(frame)).assign(a);
          const b = delayed.element(index).toVar();
          const left = vec2(a.x.mul(lll).add(a.y.mul(lrl)), a.y.mul(lrr).add(a.x.mul(llr))).toVar();
          const right = vec2(b.x.mul(rll).add(b.y.mul(rrl)), b.y.mul(rrr).add(b.x.mul(rlr)));
          master.element(index).addAssign(left.add(right));
          reverbIn.element(reverbRing(frame)).addAssign(left);
        });
      },
    });

    const reverbKernel = new WgpuCompute({
      label: "scoreReverb",
      body: ({ index }) => {
        If(index.lessThan(uint(CHUNK)), () => {
          const frame = u.frame0.add(index).toVar();
          const sum = vec2(0).toVar();
          Loop({ start: uint(0), end: uint(REVERB_TAPS), type: "uint", condition: "<" }, ({ i }                ) => {
            const tap = taps.element(i).toVar();
            const left = reverbIn.element(reverbRing(frame.sub(uint(tap.x)))).x.mul(tap.y);
            const right = reverbIn.element(reverbRing(frame.sub(uint(tap.z)))).y.mul(tap.w);
            sum.addAssign(vec2(left, right));
          });
          wet.element(index).assign(sum);
        });
      },
    });

    const attack = Math.exp(-1 / (MASTER.attack * RATE));
    const release = Math.exp(-1 / (MASTER.release * RATE));
    const limiterRelease = 1 - Math.exp(-1 / (MASTER.limiterRelease * RATE));
    const slope = 1 / MASTER.ratio - 1;
    const masterKernel = new WgpuCompute({
      label: "scoreMaster",
      workgroupSize: [1],
      body: ({ index }) => {
        If(index.equal(uint(0)), () => {
          const reverbLp = fx.element(uint(4)).toVar();
          const dynamics = fx.element(uint(5)).toVar();
          const reduction = dynamics.x.toVar();
          const limiter = dynamics.y.toVar();
          Loop({ start: uint(0), end: uint(CHUNK), type: "uint", condition: "<" }, ({ i }                ) => {
            const t = float(u.frame0.add(i)).div(RATE);
            // The reverb impulse's lowpass, then the wet level
            reverbLp.addAssign(wet.element(i).sub(reverbLp).mul(0.35));
            const x = master.element(i).add(reverbLp.mul(score.mix.reverb)).mul(MASTER.gain).toVar();

            // Compressor: a soft knee above the threshold, attack and
            // release on the reduction in dB
            const level = max(abs(x.x), abs(x.y));
            const over = log2(max(level, 1e-6)).mul(6.0206).sub(MASTER.threshold).toVar();
            const target = select(over.lessThanEqual(0), float(0), select(over.lessThan(MASTER.knee), over.mul(over).mul(slope / (2 * MASTER.knee)), over.sub(MASTER.knee / 2).mul(slope))).toVar();
            reduction.assign(target.add(reduction.sub(target).mul(select(target.lessThan(reduction), float(attack), float(release)))));
            const y = x.mul(exp2(reduction.div(6.0206))).mul(MASTER.output * score.mix.output).toVar();

            // Limiter: instant down, slow back up; then the end's fade
            const peak = max(abs(y.x), abs(y.y));
            limiter.assign(min(min(float(1), float(MASTER.ceiling).div(max(peak, 1e-9))), limiter.add(float(1).sub(limiter).mul(limiterRelease))));
            const fade = clamp(float(this.duration).sub(t).div(1.5), 0, 1);
            out.element(u.outBase.add(i)).assign(raw ? x : clamp(y.mul(limiter), -1, 1).mul(fade));
          });
          fx.element(uint(4)).assign(reverbLp);
          fx.element(uint(5)).assign(vec2(reduction, limiter));
        });
      },
    });

    this.kernels = { voices: voiceKernel, mix: mixKernel, delayFilter: delayFilterKernel, delay: delayKernel, reverb: reverbKernel, master: masterKernel };
    this.batch = new WgpuComputeBatch(renderer);
    this.reset();
  }

  // Silence: every voice, filter, delay line and the reverb start over
  reset() {
    this.state.clear();
    this.rings.forEach((ring) => ring.clear());
    this.fx.upload(new Float32Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0]));
  }

  // Chunk `chunk` (frames chunk * CHUNK on) into slot `slot` of the output
          dispatch(chunk        , slot        ) {
    const list = this.lists[chunk];
    const { u, kernels } = this;
    u.frame0.value = chunk * CHUNK;
    u.active.value = list.length;
    u.outBase.value = slot * CHUNK;
    if (list.length > 0) {
      this.active.upload(list);
    }
    this.batch
      .add(kernels.voices, list.length)
      .add(kernels.mix, CHUNK)
      .add(kernels.delayFilter, 1)
      .add(kernels.delay, CHUNK)
      .add(kernels.reverb, CHUNK)
      .add(kernels.master, 1)
      .submit();
  }

  // Chunks [first, first + count) in order, after the chunk rendered before
  // them (or a reset): interleaved L, R
  async render(first        , count = 1)                        {
    const result = new Float32Array(count * CHUNK * 2);
    for (let done = 0; done < count; done += BATCH) {
      const n = Math.min(BATCH, count - done);
      for (let k = 0; k < n; k += 1) {
        this.dispatch(first + done + k, k);
      }
      result.set(await this.out.read(0, n * CHUNK), done * CHUNK * 2);
    }
    return result;
  }

  // The whole film from the start (the film's audio track)
  async renderAll(onProgress                             ) {
    this.reset();
    const samples = new Float32Array(this.chunks * CHUNK * 2);
    for (let k = 0; k < this.chunks; k += BATCH) {
      const n = Math.min(BATCH, this.chunks - k);
      samples.set(await this.render(k, n), k * CHUNK * 2);
      onProgress?.((k + n) / this.chunks);
    }
    return samples.subarray(0, Math.round(this.duration * RATE) * 2);
  }

  dispose() {
    this.buffers.forEach((b) => b.dispose());
    Object.values(this.kernels).forEach((k) => k.dispose());
  }
}


//# sourceURL=examples/film/gpuAudio.ts