// A demo's music and the clock the picture follows. Two sources, the same
// mix: the tune rendered ahead of time to an AAC file (by default: a small
// download, decoded whole into Web Audio, so
// it never starves and the clock stays sample-accurate) or synthesized live
// on the GPU (film/gpuAudio.ts, streamed to an AudioWorklet; WebGPU only).
// The file is looked for at ?audio= (a folder), else the hosted folder,
// else build/data/fractals/ from the server's root (npm run serve);
// `failed` once none has it (the demo then synthesizes or plays silent).
// Both pause by suspending their audio context, which stops the clock.
                                                   
import { ScoreStream, heardTime } from "../../film/audioStream.js";
import { GpuScore } from "../../film/gpuAudio.js";
                                                     

// The hosted files: the dated GCS folder of scripts/data.mjs
export const AUDIO_ROOT = "https://storage.googleapis.com/forge-dev-public/asundqui/radix/261011/fractals/";

                        
                 
               
                
                 
                  
 

                                      
                       
                  
                                                                       
                                  
                  
                                                      
                 
                                                             
                                  
                  
 

export class WallClock                  {
          at = 0;
          since = NaN;
  time() {
    return Number.isNaN(this.since) ? this.at : this.at + (performance.now() - this.since) / 1000;
  }
  play() {
    this.since = performance.now();
  }
  pause() {
    this.at = this.time();
    this.since = NaN;
  }
  resume() {
    this.play();
  }
  restart() {
    this.at = 0;
    this.since = NaN;
  }
}

// The folders the file may be in, in order
function audioFolders() {
  const asked = new URLSearchParams(location.search).get("audio");
  return asked ? [asked] : [AUDIO_ROOT, new URL("/build/data/fractals/", location.origin).href];
}

export class FileMusic                  {
           kind = "file";
  failed = false;
                   context = new AudioContext({ latencyHint: "playback" });
                   gain = this.context.createGain();
          buffer              ;
          source                        ;
  // Context time at which film time 0 plays (NaN: not started)
          startAt = NaN;

  constructor(name        ) {
    this.gain.connect(this.context.destination);
    void this.load(name);
  }

          async load(name        ) {
    for (const folder of audioFolders()) {
      try {
        const response = await fetch(new URL(`${name}.m4a`, folder));
        if (response.ok) {
          this.buffer = await this.context.decodeAudioData(await response.arrayBuffer());
          return;
        }
      } catch {
        // The next folder
      }
    }
    this.failed = true;
  }

  time() {
    return Number.isNaN(this.startAt) ? 0 : heardTime(this.context) - this.startAt;
  }

  play() {
    if (!this.buffer) {
      return;
    }
    this.source?.stop();
    const source = this.context.createBufferSource();
    source.buffer = this.buffer;
    source.connect(this.gain);
    this.startAt = this.context.currentTime + 0.05;
    source.start(this.startAt);
    this.source = source;
    void this.context.resume();
  }

  pause() {
    void this.context.suspend();
  }

  resume() {
    void this.context.resume();
  }

  restart() {
    this.source?.stop();
    this.source = undefined;
    this.startAt = NaN;
  }

  ready() {
    return Boolean(this.buffer);
  }

  ahead() {
    return this.buffer ? Infinity : 0;
  }

  unlock() {
    void this.context.resume();
  }

  setVolume(volume        ) {
    this.gain.gain.setTargetAtTime(volume * volume, this.context.currentTime, 0.02);
  }

  dispose() {
    this.source?.stop();
    void this.context.close();
  }
}

export class GpuMusic                  {
           kind = "gpu";
           failed = false;
                   score          ;
                   stream             ;

  constructor(renderer                , duration        , data           ) {
    this.score = new GpuScore(renderer, duration, { score: data });
    this.stream = new ScoreStream(this.score);
    this.stream.prepare(0);
  }

  time() {
    return this.stream.clock();
  }

  play() {
    void this.stream.play();
  }

  pause() {
    this.stream.pause();
  }

  resume() {
    this.stream.resume();
  }

  restart() {
    this.stream.restart(0);
  }

  ready(seconds        ) {
    return this.stream.ahead() >= seconds || this.stream.rendered >= this.score.chunks;
  }

  ahead() {
    return this.stream.ahead();
  }

  unlock() {
    void this.stream.context.resume();
  }

  setVolume(volume        ) {
    this.stream.gain.gain.setTargetAtTime(volume * volume, this.stream.context.currentTime, 0.02);
  }

  dispose() {
    this.stream.stop();
    void this.stream.context.close();
    this.score.dispose();
  }
}


//# sourceURL=examples/fractals/demo/music.ts