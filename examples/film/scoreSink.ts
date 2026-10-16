// The AudioWorklet that plays the GPU-rendered score (audioStream.ts):
// runs of chunks of interleaved stereo frames arrive by postMessage (their
// buffers transferred), from a first chunk index on; "start" maps the context's frames to
// the film's. Each output frame plays the film frame it maps to, so the
// sound stays on the film's clock: a chunk that has not arrived plays as
// silence rather than shifting what follows.
export {};

declare const currentFrame: number;
declare function registerProcessor(name: string, processor: unknown): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}

type Message =
  | { type: "chunks"; index: number; samples: Float32Array }
  | { type: "start"; offset: number }
  | { type: "stop" };

class ScoreSink extends AudioWorkletProcessor {
  private chunks = new Map<number, Float32Array>();
  // Context frame minus film frame; NaN until started
  private offset = NaN;
  // Frames per chunk, and in the film
  private size: number;
  private frames: number;
  // Film frames played as silence because their chunk had not arrived
  private missing = 0;
  private reported = 0;

  constructor(options: { processorOptions: { chunk: number; frames: number } }) {
    super();
    this.size = options.processorOptions.chunk;
    this.frames = options.processorOptions.frames;
    this.port.onmessage = ({ data }: MessageEvent<Message>) => {
      if (data.type === "chunks") {
        const frames = this.size * 2;
        for (let k = 0; k * frames < data.samples.length; k += 1) {
          this.chunks.set(data.index + k, data.samples.subarray(k * frames, (k + 1) * frames));
        }
      } else if (data.type === "start") {
        this.offset = data.offset;
      } else {
        this.offset = NaN;
        this.chunks.clear();
      }
    };
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]) {
    const [left, right] = outputs[0];
    let playing = -1;
    for (let i = 0; i < left.length; i += 1) {
      const frame = currentFrame + i - this.offset;
      const index = Math.floor(frame / this.size);
      const samples = frame >= 0 ? this.chunks.get(index) : undefined;
      if (samples) {
        const at = (frame - index * this.size) * 2;
        left[i] = samples[at];
        right[i] = samples[at + 1];
        playing = index;
      } else {
        left[i] = 0;
        right[i] = 0;
        this.missing += frame >= 0 && frame < this.frames ? 1 : 0;
      }
    }
    // Chunks behind the playhead are done
    for (const index of this.chunks.keys()) {
      if (playing >= 0 && index < playing) {
        this.chunks.delete(index);
      }
    }
    if (this.missing !== this.reported) {
      this.reported = this.missing;
      this.port.postMessage({ type: "missing", frames: this.missing });
    }
    return true;
  }
}

registerProcessor("film-score", ScoreSink);
