// Plays the GPU-rendered score in real time: GpuScore renders chunks ahead
// of the playhead (from the moment prepare() is called, so they are ready
// before Play), each chunk's buffer is transferred to the AudioWorklet in
// scoreSink.ts, and the film's clock is the audio clock. Rendering keeps up
// to AHEAD seconds ahead, which rides out the film's own stalls (a shader
// compiled on a shot's first frame, the water replaying its simulation in
// the montage, the 6M-splat galaxy at a few frames a second). Each readback
// waits for the frames queued before it, so the pump tops up gently (CALM
// chunks a readback, a few ms of GPU work between frames) and only renders
// in bursts of up to BURST chunks once the lead falls under LOW seconds. A
// chunk that came too late plays as silence and is counted in `missing`
// (frames). pause() and resume() suspend the context, which stops the
// clock; restart() starts over from a film time, paused.
import { CHUNK,               } from "./gpuAudio.js";
import { RATE } from "./score.js";

const AHEAD = 10;

// The context time being heard now: the output timestamp (which counts the
// hardware's latency) carried forward on performance.now(), so it moves
// between the context's coarse audio blocks; else currentTime less the
// output latency. Frozen while the context is suspended.
export function heardTime(context              ) {
  const stamp = context.getOutputTimestamp?.();
  if (stamp?.contextTime && stamp.performanceTime) {
    const since = context.state === "running" ? (performance.now() - stamp.performanceTime) / 1000 : 0;
    return stamp.contextTime + Math.min(Math.max(since, 0), 0.1);
  }
  return context.currentTime - (context.outputLatency || 0);
}
const LOW = 4;
const CALM = 2;
const BURST = 8;

export class ScoreStream {
           score          ;
           context              ;
  // Between the worklet and the speakers: the listener's volume
           gain          ;
  missing = 0;
          node                   ;
          ready               ;
          queued                                             = [];
  // Chunks rendered so far, from the start chunk on
  rendered = 0;
          from = 0;
          next = 0;
  // Context time at which film time `from` is heard
          startAt = NaN;
          running = false;
          pumping                ;
  // Bumped by restart: chunks rendered before it are not sent
          generation = 0;
  // A film time to render from, applied by the pump between renders
          restartAt         ;

  constructor(score          ) {
    this.score = score;
    this.context = new AudioContext({ sampleRate: RATE, latencyHint: "playback" });
    this.gain = this.context.createGain();
    this.gain.connect(this.context.destination);
    this.ready = this.context.audioWorklet.addModule(new URL("./scoreSink.js", import.meta.url)).then(() => {
      const node = new AudioWorkletNode(this.context, "film-score", { numberOfInputs: 0, outputChannelCount: [2], processorOptions: { chunk: CHUNK, frames: Math.round(score.duration * RATE) } });
      node.connect(this.gain);
      node.port.onmessage = ({ data }) => {
        if (data.type === "missing") {
          this.missing = data.frames;
        }
      };
      this.node = node;
      this.queued.forEach((chunk) => this.post(chunk.index, chunk.samples));
      this.queued = [];
    });
  }

  // Film seconds being heard (before play, where it will start)
  clock() {
    if (Number.isNaN(this.startAt)) {
      return this.from;
    }
    return this.from + heardTime(this.context) - this.startAt;
  }

  // Start rendering from film time `from`
  prepare(from        ) {
    this.from = from;
    this.restartAt = from;
    this.running = true;
    this.pumping ??= this.pump().finally(() => (this.pumping = undefined));
  }

  // Call from a user gesture
  async play() {
    await this.ready;
    await this.context.resume();
    this.startAt = this.context.currentTime + 0.1;
    const offset = Math.round(this.startAt * RATE) - Math.round(this.from * RATE);
    this.node .port.postMessage({ type: "start", offset });
  }

  stop() {
    this.running = false;
    this.node?.port.postMessage({ type: "stop" });
    void this.context.suspend();
  }

  pause() {
    void this.context.suspend();
  }

  resume() {
    void this.context.resume();
  }

  // Silence, and render again from film time `from`; play() starts there
  restart(from        ) {
    this.generation += 1;
    this.queued = [];
    this.node?.port.postMessage({ type: "stop" });
    this.startAt = NaN;
    void this.context.suspend();
    this.prepare(from);
  }

  // Consecutive chunks from `index`, in one transferred buffer
          post(index        , samples              ) {
    if (!this.node) {
      this.queued.push({ index, samples });
      return;
    }
    this.node.port.postMessage({ type: "chunks", index, samples }, [samples.buffer]);
  }

  // Seconds of audio rendered past what is being heard
  ahead() {
    return (this.next * CHUNK) / RATE - this.clock();
  }

          async pump() {
    while (this.running) {
      if (this.restartAt !== undefined) {
        this.next = Math.floor((this.restartAt * RATE) / CHUNK);
        this.restartAt = undefined;
        this.score.reset();
      }
      const behind = AHEAD - this.ahead();
      if (this.next < this.score.chunks && behind > 0) {
        const index = this.next;
        const batch = this.ahead() < LOW ? BURST : CALM;
        const count = Math.min(batch, this.score.chunks - index, Math.max(1, Math.ceil(behind / (CHUNK / RATE))));
        const generation = this.generation;
        this.next += count;
        this.rendered += count;
        const samples = await this.score.render(index, count);
        if (generation === this.generation) {
          this.post(index, samples);
        }
      } else {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
  }
}


//# sourceURL=examples/film/audioStream.ts