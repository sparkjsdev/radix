// Demo mode: the gallery's fractals as music videos (tunes/: Aurora,
// Tidal, Lumen), each a tune synthesized on the GPU (film/gpuAudio.ts)
// that the picture follows (video.ts).
//
// A menu picks sound on or off, how the music plays (music.ts: by default
// the tune rendered ahead of time to a small file, decoded whole; or live
// on the GPU, WebGPU only, ?music=gpu), and a demo. Picking one starts
// preparing it: the score (CPU) and its marks; the tune's bake programs
// compiled; its fractals baked in the order the video needs them
// (library.ts), as fast as the GPU goes; their transition orders sorted on
// a pool of workers; the draw programs compiled; with sound, the music
// loaded (or its first seconds rendered). It starts by itself once what is
// left can bake during playback before each fractal is due (and buffers,
// picture and music paused, if a slow device falls behind anyway). Music
// that fails to load is synthesized instead (or the demo plays silent).
// ?demo=aurora preselects a demo and prepares it before the click that
// starts it.
//
// Playing: controls hidden; a tap or a click (or Space) pauses and shows
// them (play, back to the start, the time, back to the menu); dragging
// turns the camera and pinching or scrolling zooms, at any time, and a
// few seconds after the last touch it drifts back to the video's own.
// At the end the menu comes back; "explore the fractals" (Esc) leaves.
//
// With ?render=1&demo=<tune> the page is a film for a frame-by-frame recorder
// (`window.film`: ready, duration, seek, audio, shots): every fractal
// baked up front, 900k samples unless ?splats= says otherwise.
                                                   
import { GpuScore } from "../../film/gpuAudio.js";
import { buildScore, toWav,                } from "../../film/score.js";
import { Budget, tableBytes,                                               } from "../device.js";
                                                     
import { AirScore,           } from "./airScore.js";
import { Library } from "./library.js";
import { FileMusic, GpuMusic, WallClock,                        } from "./music.js";
                                      
                                    
                                                   
import { AURORA } from "./tunes/aurora.js";
import { LUMEN } from "./tunes/lumen.js";
import { TIDAL } from "./tunes/tidal.js";
import { Video, cueTimes,                           } from "./video.js";

export const TUNES         = [AURORA, TIDAL, LUMEN];

// What a demo leaves the gallery: the fractal on screen (its samples when
// baked), its palette and the camera
                          
                 
                  
                     
                
                                                                          
 

                           
                           
                  
                            
                                                                            
                
                      
                                  
                 
                                    
                 
                   
                                                                        
                   
                              
                                                                            
                     
                                     
                                     
                          
                                                                          
                  
                                                                        
                                                                          
                                              
                
                
               
                                                    
                                
                                                                    
                     
 

// Share of the GPU's baking speed left to bakes while the video plays, and
// seconds to spare before each fractal is due: a phone's frames leave much
// less, so it starts later, with more baked
const PLAY_SHARE = { desktop: 0.3, phone: 0.12 };
const MARGIN = { desktop: 1.5, phone: 3 };
// Seconds of video ready before playing again after a pause to buffer
const REFILL = 8;
// Milliseconds the picture runs ahead of the music, beyond the display's
// own delay: 30 by default, which looked right by eye (?av= overrides, for
// a device whose output latency the browser misreports, like Bluetooth)
const asked = new URLSearchParams(location.search).get("av");
const AV_OFFSET = asked !== null && asked !== "" ? Number(asked) || 0 : 30;
// Seconds of music rendered (or loaded) before the start
const MUSIC_AHEAD = 3;

const device = (renderer                ) => (renderer.backend                                    ).device;
const sleep = (ms        ) => new Promise((resolve) => setTimeout(resolve, ms));
const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));

// The viewer's turn and zoom over the video's camera. A drag turns it and
// glides on after release at the drag's speed over its last 150 ms (at
// most MAX_SPIN radians a second), slowing with GLIDE seconds' time
// constant; wheel and pinch zoom ease to where they were sent. A few
// seconds after the last touch (and the glide) all of it eases back to
// none. A short tap without a drag is a tap.
const GLIDE = 0.7;
const MAX_SPIN = 4;
const TURN = 0.006;

class Steer                    {
  yaw = 0;
  pitch = 0;
  zoom = 0;
  enabled = false;
  reverse = false;
  onTap             ;
          idle = 99;
          zoomTo = 0;
  // Radians a second, after release
          spinYaw = 0;
          spinPitch = 0;
                   pointers = new Map                                  ();
          down                                         ;
          moves                                             = [];
          pinch = 0;

  constructor(canvas                   ) {
    const spread = () => {
      const [a, b] = [...this.pointers.values()];
      return Math.hypot(a.x - b.x, a.y - b.y);
    };
    canvas.addEventListener("pointerdown", (event) => {
      if (!this.enabled) {
        return;
      }
      canvas.setPointerCapture(event.pointerId);
      this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      this.down = this.pointers.size === 1 ? { x: event.clientX, y: event.clientY, time: performance.now() } : undefined;
      this.spinYaw = this.spinPitch = 0;
      this.moves = [];
      if (this.pointers.size === 2) {
        this.pinch = spread();
      }
    });
    canvas.addEventListener("pointermove", (event) => {
      const last = this.pointers.get(event.pointerId);
      if (!this.enabled || !last) {
        return;
      }
      const sign = this.reverse ? -1 : 1;
      const dx = (event.clientX - last.x) * sign;
      const dy = (event.clientY - last.y) * sign;
      last.x = event.clientX;
      last.y = event.clientY;
      if (this.down && Math.hypot(event.clientX - this.down.x, event.clientY - this.down.y) > 8) {
        this.down = undefined;
      }
      if (this.pointers.size === 1 && !this.down) {
        this.yaw -= dx * TURN;
        this.pitch = Math.max(-1.2, Math.min(1.2, this.pitch + dy * TURN));
        this.moves.push({ time: event.timeStamp, dx, dy });
      } else if (this.pointers.size === 2) {
        const d = spread();
        this.zoomTo = Math.max(-1.2, Math.min(1.2, this.zoomTo - Math.log(d / Math.max(this.pinch, 1))));
        this.pinch = d;
        this.moves = [];
      }
      this.idle = 0;
    });
    const up = (event              ) => {
      if (!this.pointers.delete(event.pointerId)) {
        return;
      }
      if (this.down && performance.now() - this.down.time < 350 && event.type === "pointerup") {
        this.onTap?.();
      } else if (this.pointers.size === 0) {
        // The drag's speed over its last 150 ms (none after a pause), at
        // most MAX_SPIN
        const from = event.timeStamp - 150;
        const recent = this.moves.filter((move) => move.time > from);
        const seconds = Math.max(event.timeStamp - (recent[0]?.time ?? event.timeStamp), 16) / 1000;
        const yaw = -recent.reduce((sum, move) => sum + move.dx, 0) * TURN / seconds;
        const pitch = recent.reduce((sum, move) => sum + move.dy, 0) * TURN / seconds;
        const scale = Math.min(1, MAX_SPIN / Math.max(Math.hypot(yaw, pitch), 1e-6));
        this.spinYaw = yaw * scale;
        this.spinPitch = pitch * scale;
      }
      this.down = undefined;
      this.moves = [];
    };
    canvas.addEventListener("pointerup", up);
    canvas.addEventListener("pointercancel", up);
    canvas.addEventListener("wheel", (event) => {
      if (!this.enabled) {
        return;
      }
      event.preventDefault();
      this.zoomTo = Math.max(-1.2, Math.min(1.2, this.zoomTo + event.deltaY * (event.deltaMode === 1 ? 33 : 1) * 0.0012));
      this.idle = 0;
    }, { passive: false });
  }

  update(seconds        ) {
    // The glide
    if (this.pointers.size === 0 && (this.spinYaw !== 0 || this.spinPitch !== 0)) {
      this.yaw += this.spinYaw * seconds;
      this.pitch = Math.max(-1.2, Math.min(1.2, this.pitch + this.spinPitch * seconds));
      const k = Math.exp(-seconds / GLIDE);
      this.spinYaw *= k;
      this.spinPitch *= k;
      if (Math.hypot(this.spinYaw, this.spinPitch) < 0.01) {
        this.spinYaw = this.spinPitch = 0;
      } else {
        this.idle = 0;
      }
    }
    this.zoom += (this.zoomTo - this.zoom) * (1 - Math.exp(-seconds / 0.12));
    // Home again
    this.idle += seconds;
    if (this.idle > 2.5 && this.pointers.size === 0) {
      const k = 1 - Math.exp(-seconds * 0.9);
      this.yaw -= this.yaw * k;
      this.pitch -= this.pitch * k;
      this.zoomTo -= this.zoomTo * k;
    }
  }

  reset() {
    this.yaw = this.pitch = this.zoom = this.zoomTo = 0;
    this.spinYaw = this.spinPitch = 0;
    this.idle = 99;
  }
}

// One demo being prepared or played
               
             
                   
               
                  
                
                                              
                
               
                                                       
               
                                                                           
                
                 
                    
                          
                 
                                                        
                     
                  
 

const ICONS = {
  pause: '<svg viewBox="0 0 24 24"><rect x="5" y="4" width="5" height="16" rx="1"/><rect x="14" y="4" width="5" height="16" rx="1"/></svg>',
  play: '<svg viewBox="0 0 24 24"><path d="M7 4.5v15a1 1 0 0 0 1.5.86l12-7.5a1 1 0 0 0 0-1.72l-12-7.5A1 1 0 0 0 7 4.5z"/></svg>',
  restart: '<svg viewBox="0 0 24 24"><path d="M12 4a8 8 0 1 1-7.75 10h2.1A6 6 0 1 0 12 6v3L7 5l5-4v3z"/></svg>',
  sound: '<svg class="demo-sound-icon" viewBox="0 0 24 24"><path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M16 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  soft: '<svg viewBox="0 0 24 24"><path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M16 8.5a5 5 0 0 1 0 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  muted: '<svg class="demo-sound-icon" viewBox="0 0 24 24"><path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M16.5 9.5l5 5M21.5 9.5l-5 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  close: '<svg viewBox="0 0 24 24"><path d="M6.4 5 12 10.6 17.6 5 19 6.4 13.4 12l5.6 5.6-1.4 1.4-5.6-5.6L6.4 19 5 17.6l5.6-5.6L5 6.4z"/></svg>',
};

const el =                                        (tag   , className        , html = "") => Object.assign(document.createElement(tag), { className, innerHTML: html });
const clock = (seconds        ) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;

export class DemoMode {
  // "film": a film for a frame-by-frame recorder (the gallery stays stopped)
  state                                                                                = "closed";
  sound         ;
  // How the music plays: the rendered file, or synthesized on the GPU
  music                ;
  // The listener's volume (0..1) and mute, for this visit
  volume = 0.8;
  muted = false;
  // Each pause to buffer: film time, and what it waited for
           stalls                                                     = [];
          job      ;
                   host          ;
                   steer       ;
          budget         ;
  // Rows a second baked while playing (smoothed)
          bakeRate = 0;
          shownT = 0;
  // Buffering: play() rather than resume() once ready (after a restart)
          needsPlay = false;
          hintTimer = 0;
                   ui   
                                                                                                                                                                                    
                                                                                                      
                                                                                                                                     
                                                                     
   ;

  constructor(host          , { sound = true } = {}) {
    this.host = host;
    this.sound = sound;
    this.music = host.webgpu && new URLSearchParams(location.search).get("music") === "gpu" ? "gpu" : "file";
    document.head.append(Object.assign(document.createElement("link"), { rel: "stylesheet", href: new URL("./demo.css", import.meta.url).href }));
    this.steer = new Steer(host.canvas);
    this.steer.onTap = () => this.toggle();

    // --- The menu ---
    const menu = el("div", "demo-menu");
    const panel = el("div", "demo-panel");
    panel.append(
      el("p", "demo-kicker", "Spark Radix demos"),
      el("h1", "demo-title", "FRACTALS"),
      el("p", "demo-sub", "Three short music videos, rendered live from millions of Gaussian splats, with music made on the GPU."),
    );
    const soundButton = el("button", "demo-sound")                     ;
    soundButton.onclick = () => {
      this.sound = !this.sound;
      this.paint();
    };
    const cards = new Map                     ();
    const row = el("div", "demo-cards");
    TUNES.forEach((tune, i) => {
      const card = el("button", "demo-card",
        `<span class="demo-letter">${"ABC"[i]}</span><span class="demo-name">${tune.title}</span><span class="demo-blurb">${tune.blurb}</span>` +
        '<span class="demo-progress"><i></i></span><span class="demo-state">play</span>');
      card.style.setProperty("--a", tune.colors[0]);
      card.style.setProperty("--b", tune.colors[1]);
      card.onclick = () => this.pick(tune);
      cards.set(tune.name, card);
      row.append(card);
    });
    const hiDpi = el("button", "demo-hidpi")                     ;
    hiDpi.onclick = () => {
      host.setHiDpi(!host.hiDpi());
      this.paint();
    };
    const music = el("button", "demo-hidpi")                     ;
    music.onclick = () => {
      this.music = this.music === "gpu" ? "file" : "gpu";
      this.paint();
    };
    music.disabled = !host.webgpu;
    const quality = el("button", "demo-hidpi")                     ;
    quality.onclick = () => {
      host.setQuality(host.quality() === "high" ? "standard" : "high");
      // A demo prepared at the other count starts over when picked
      if (this.job && this.job.library.count !== this.count) {
        this.drop();
        this.state = "menu";
      }
      this.paint();
    };
    const info = el("p", "demo-info");
    const explore = el("button", "demo-explore",
      '<span class="demo-explore-name">Explore the fractals</span><span class="demo-explore-note">Pick fractals and tweak them yourself. No music.</span><small>esc</small>')                     ;
    explore.onclick = () => this.close();
    const options = el("div", "demo-options");
    options.append(music, quality, hiDpi, info);
    panel.append(soundButton, row, explore);
    // The options stay at the bottom of the screen, however short, below the
    // panel (which scrolls when it doesn't fit) rather than over it
    const scroll = el("div", "demo-scroll");
    scroll.append(panel);
    menu.append(scroll, options);
    menu.hidden = true;

    // --- The frame's finish and type, over the canvas ---
    const stage = el("div", "demo-stage");
    const overlay = el("div", "demo-overlay");
    const [flash, fade, dim] = ["demo-flash", "demo-fade", "demo-dim"].map((name) => el("div", name));
    stage.append(dim, overlay, flash, fade, el("div", "demo-vignette"));
    stage.hidden = true;

    // --- Playback controls, shown while paused ---
    const controls = el("div", "demo-controls");
    const toggle = el("button", "", ICONS.play)                     ;
    toggle.title = "Play / pause (space)";
    toggle.onclick = () => this.toggle();
    const restart = el("button", "", ICONS.restart)                     ;
    restart.title = "Back to the start (R)";
    restart.onclick = () => this.restart();
    const time = el("span", "demo-time");
    const bar = el("span", "demo-timeline", "<i></i>");
    const exit = el("button", "", ICONS.close)                     ;
    exit.title = "Back to the demos (esc)";
    exit.onclick = () => this.toMenu();
    controls.append(toggle, restart, time, bar, exit);
    controls.hidden = true;
    const hint = el("div", "demo-hint", "Drag to look around. Tap to pause.");

    // --- The volume, on the right while a demo plays ---
    const volume = el("div", "demo-volume", '<div class="demo-volume-track"><i></i><b></b><span></span></div>');
    const track = volume.firstElementChild               ;
    const level = track.querySelector("span") ;
    const mute = el("button", "demo-volume-button")                     ;
    mute.title = "Mute (M)";
    mute.onclick = () => this.setVolume(this.volume, !this.muted);
    volume.append(mute);
    volume.hidden = true;
    const fromPointer = (event              ) => {
      const rect = track.getBoundingClientRect();
      this.setVolume(1 - (event.clientY - rect.top) / rect.height, false);
    };
    track.addEventListener("pointerdown", (event) => {
      track.setPointerCapture(event.pointerId);
      volume.classList.add("dragging");
      fromPointer(event);
    });
    track.addEventListener("pointermove", (event) => track.hasPointerCapture(event.pointerId) && fromPointer(event));
    const release = () => volume.classList.remove("dragging");
    track.addEventListener("pointerup", release);
    track.addEventListener("pointercancel", release);
    volume.addEventListener("wheel", (event) => {
      event.preventDefault();
      this.setVolume(this.volume - event.deltaY * 0.0015, false);
    }, { passive: false });
    const buffering = el("div", "demo-buffering", "buffering");
    buffering.hidden = true;

    document.body.append(stage, menu, controls, hint, buffering, volume);
    this.ui = { menu, cards, sound: soundButton, music, hiDpi, quality, info, stage, overlay, flash, fade, dim, controls, toggle, time, bar, hint, buffering, volume, mute, level };
    this.setVolume(this.volume, false);

    addEventListener("keydown", (event) => {
      if (this.state === "closed" || event.metaKey || event.ctrlKey) {
        return;
      }
      if (event.code === "Escape") {
        if (this.state === "menu" || this.state === "preparing") {
          this.close();
        } else {
          this.toMenu();
        }
      } else if ((event.code === "Space" || event.code === "KeyK") && this.state !== "menu" && this.state !== "preparing") {
        event.preventDefault();
        this.toggle();
      } else if (event.code === "KeyR" && this.state === "paused") {
        this.restart();
      } else if (this.state !== "menu" && this.state !== "preparing" && (event.code === "KeyM" || event.code === "ArrowUp" || event.code === "ArrowDown")) {
        event.preventDefault();
        if (event.code === "KeyM") {
          this.setVolume(this.volume, !this.muted);
        } else {
          this.setVolume(this.volume + (event.code === "ArrowUp" ? 0.1 : -0.1), false);
        }
      }
    });
  }

  get active() {
    return this.state !== "closed";
  }

  // Phones and tablets bake the whole demo before it starts
          get phone() {
    return this.host.platform !== "desktop";
  }

          get share() {
    return this.host.platform === "desktop" ? PLAY_SHARE.desktop : PLAY_SHARE.phone;
  }

          get margin() {
    return this.host.platform === "desktop" ? MARGIN.desktop : MARGIN.phone;
  }

  // The menu open with no demo prepared: the gallery behind may bake ahead
  get idle() {
    return this.state === "menu" && !this.job;
  }

  get count() {
    const asked = Number(new URLSearchParams(location.search).get("splats"));
    return asked || this.host.splats;
  }

  // Shows the menu; with a tune, starts preparing it (and plays it on
  // `start`, which must come from a click for the sound)
  open(name         , start = false) {
    if (this.state === "closed") {
      this.host.enter();
    }
    this.state = "menu";
    this.steer.enabled = false;
    this.ui.menu.hidden = false;
    this.ui.stage.hidden = true;
    this.ui.controls.hidden = true;
    this.ui.buffering.hidden = true;
    const tune = TUNES.find((each) => each.name === name);
    if (tune) {
      this.pick(tune, start);
    }
    this.paint();
  }

  // Back to the gallery
  close() {
    this.drop();
    this.state = "closed";
    this.steer.enabled = false;
    for (const element of [this.ui.menu, this.ui.stage, this.ui.controls, this.ui.buffering]) {
      element.hidden = true;
    }
    this.host.exit();
  }

          drop() {
    const job = this.job;
    if (!job) {
      return;
    }
    this.job = undefined;
    job.audio?.dispose();
    job.video.dispose();
    job.library.dispose();
    this.ui.overlay.replaceChildren();
  }

          makeJob(tune      )      {
    const { renderer } = this.host;
    const count = this.count;
    const times = cueTimes(tune);
    // Phones keep only what is on screen and next on the GPU (3 tables)
    const maxTables = this.phone ? 3 : Math.floor(this.host.memory / tableBytes(count));
    // Phones bake the whole demo before it starts (all but the first fractals
    // kept in CPU memory)
    const library = new Library(renderer, this.host.kinds, this.host.bakeU, tune.cues, times, count, maxTables, { stash: this.phone });
    const score = new AirScore();
    const data = buildScore(tune.compose, tune.mix, score);
    const video = new Video(renderer, library, tune, score.marks, this.ui.overlay);
    return { tune, library, video, data, marks: score.marks, times, clock: new WallClock(), rate: 0, kinds: library.kinds(), warmed: 0, compiled: false, wantStart: false, played: false };
  }

  // Sound on: the music as asked (the file, or the GPU's), replacing music
  // of the other kind; called from a click, which lets the audio start
          withSound(job     ) {
    const kind = this.music === "gpu" && this.host.webgpu ? "gpu" : "file";
    if (job.audio && (!this.sound || job.audio.kind !== kind)) {
      job.audio.dispose();
      job.audio = undefined;
      job.clock = new WallClock();
    }
    if (this.sound && !job.audio) {
      job.audio = kind === "gpu" ? new GpuMusic(this.host.renderer, job.video.duration, job.data) : new FileMusic(job.tune.name);
      job.clock = job.audio;
    }
    job.audio?.setVolume(this.muted ? 0 : this.volume);
    job.audio?.unlock();
  }

  // Music that failed to load: synthesized on the GPU instead, or none
          fallback(job     ) {
    job.audio?.dispose();
    if (this.host.webgpu) {
      this.music = "gpu";
    }
    job.audio = this.host.webgpu ? new GpuMusic(this.host.renderer, job.video.duration, job.data) : undefined;
    job.clock = job.audio ?? new WallClock();
    job.audio?.setVolume(this.muted ? 0 : this.volume);
    job.audio?.unlock();
    console.warn(`No music file for ${job.tune.name}: ${job.audio ? "synthesizing it on the GPU" : "playing silent"}`);
  }

          pick(tune      , start = true) {
    if (this.job?.tune !== tune || this.job.library.count !== this.count) {
      this.drop();
      this.host.yield();
      this.job = this.makeJob(tune);
    }
    const job = this.job ;
    if (start) {
      job.wantStart = true;
      this.withSound(job);
    }
    if (job.played) {
      job.played = false;
      job.clock.restart();
      this.needsPlay = false;
    }
    if (this.state !== "preparing") {
      this.state = "preparing";
      job.error = undefined;
      this.prepare(job).catch((error         ) => {
        console.error("Preparing the demo failed:", error);
        job.error = error instanceof Error ? error.message : String(error);
        if (this.job === job && this.state === "preparing") {
          this.state = "menu";
        }
        this.paint();
      });
    }
    this.paint();
  }

  // Bakes, sorts and compiles until the job can start, then starts it if
  // asked; keeps baking ahead while it waits for the click
          async prepare(job     ) {
    const { renderer, webgpu } = this.host;
    const library = job.library;
    const maxChunk = this.host.platform === "desktop" ? 1 << 19 : 1 << 17;
    let chunk = 1 << 15;
    let rows = 0;
    let seconds = 0;

    const idle = () => (webgpu ? device(renderer).queue.onSubmittedWorkDone() : frame());
    let warmTurn = false;

    while (this.job === job && this.state === "preparing") {
      // Every other turn compiles one of the tune's bake programs, in the
      // order they are needed (kept out of the bake rate)
      if (warmTurn && job.warmed < job.kinds.length) {
        library.warmKind(job.kinds[job.warmed]);
        job.warmed += 1;
        await idle();
        warmTurn = false;
        this.paint();
        continue;
      }
      warmTurn = true;
      const started = performance.now();
      const n = library.bake(chunk, 0, this.phone);
      library.sort(0);
      if (n > 0) {
        await idle();
        const ms = performance.now() - started;
        rows += n;
        seconds += ms / 1000;
        job.rate = rows / Math.max(seconds, 1e-3);
        chunk = ms < 25 ? Math.min(chunk * 1.5, maxChunk) : ms > 60 ? Math.max(chunk / 2, 4096) : chunk;
      } else {
        await sleep(30);
      }
      if (this.job !== job || this.state !== "preparing") {
        return;
      }
      if (!job.compiled && library.ready(0, true) && library.ready(0, false)) {
        this.compile(job);
      }
      this.paint();
      const stuck = n === 0 && library.pending(0);
      const baked = this.phone ? library.stocked() : !library.pending(0) || stuck || library.fits(job.rate * this.share, this.margin);
      const enough = job.compiled && job.warmed >= job.kinds.length && library.ready(0, true) && baked;
      if (job.audio?.failed) {
        this.fallback(job);
      }
      if (enough && job.wantStart && (!job.audio || job.audio.ready(MUSIC_AHEAD))) {
        this.start(job);
        return;
      }
    }
  }

  // The draw programs (at rest and in a transition), compiled on frames
  // drawn under the menu; the first fractal stays there as a preview
          compile(job     ) {
    job.video.warm(innerWidth / innerHeight);
    this.applyFinish({ fade: 0, flash: 0, dim: 0 });
    job.compiled = true;
  }

          start(job     ) {
    this.state = "playing";
    job.wantStart = false;
    job.library.endPrep();
    this.ui.menu.hidden = true;
    this.ui.stage.hidden = false;
    this.ui.controls.hidden = true;
    this.steer.reset();
    this.steer.enabled = true;
    this.steer.reverse = this.host.reverse();
    this.budget = new Budget(this.host.pace, 1024, 1 << 18, 1 << 13);
    this.bakeRate = job.rate * this.share;
    this.shownT = 0;
    job.clock.play();
    this.needsPlay = false;
    this.ui.hint.classList.add("on");
    clearTimeout(this.hintTimer);
    this.hintTimer = window.setTimeout(() => this.ui.hint.classList.remove("on"), 3500);
    this.paint();
  }

          toggle() {
    const job = this.job;
    if (!job) {
      return;
    }
    if (this.state === "playing" || this.state === "buffering") {
      if (this.state === "playing") {
        job.clock.pause();
      }
      this.state = "paused";
      this.ui.buffering.hidden = true;
    } else if (this.state === "paused") {
      job.audio?.unlock();
      if (this.needsPlay) {
        this.state = "buffering";
      } else {
        job.clock.resume();
        this.state = "playing";
      }
    }
    this.paint();
  }

          restart() {
    const job = this.job;
    if (!job) {
      return;
    }
    job.clock.restart();
    job.audio?.unlock();
    this.shownT = 0;
    this.needsPlay = true;
    this.state = "buffering";
    this.ui.buffering.textContent = "starting over";
    this.paint();
  }

  // Stops the video and shows the menu (the demo stays prepared); the
  // gallery behind it takes the fractal on screen
          toMenu() {
    const job = this.job;
    if (job && (this.state === "playing" || this.state === "buffering" || this.state === "paused")) {
      if (this.state === "playing") {
        job.clock.pause();
      }
      job.played = true;
      this.handOver(job);
    }
    this.open();
  }

  // The fractal on screen, its samples, palette and camera, to the gallery
          handOver(job     ) {
    const name = job.tune.cues[job.library.cueAt(this.shownT)].preset;
    this.host.adopt({
      preset: name, palette: job.video.paletteFor(this.shownT), arrays: job.library.take(name), count: job.library.count, camera: job.video.pose(),
    });
  }

  // Every animation frame while the demo is open
  frame(dt        ) {
    const job = this.job;
    if (!job || this.state === "menu" || this.state === "preparing" || this.state === "closed") {
      return;
    }
    const { library, video } = job;
    const seconds = Math.min(dt, 100) / 1000;
    this.steer.update(seconds);
    // With music, each frame is drawn for when it will be on screen: about
    // a frame and a half after it is drawn (the GPU, then the compositor)
    const lead = job.audio ? (this.host.pace.base * 1.5 + AV_OFFSET) / 1000 : 0;
    let t = Math.max(0, Math.min(job.clock.time() + lead, video.duration));

    if (this.state === "playing") {
      if (t >= video.duration - 0.02) {
        job.clock.pause();
        job.played = true;
        this.handOver(job);
        this.open();
        return;
      }
      const music = !job.audio || job.audio.ready(0.4);
      const fractals = library.canShow(Math.min(t + 0.35, video.duration - 0.05));
      if (!fractals || !music) {
        job.clock.pause();
        this.state = "buffering";
        this.stalls.push({ at: t, waitingFor: fractals ? "music" : "fractals" });
        this.ui.buffering.textContent = fractals ? "loading music" : "baking ahead";
      }
    }
    if (this.state === "buffering") {
      t = this.needsPlay ? 0 : this.shownT;
      if (library.canShowThrough(t, Math.min(t + REFILL, video.duration - 0.05)) && (!job.audio || job.audio.ready(this.needsPlay ? MUSIC_AHEAD : 1))) {
        if (this.needsPlay) {
          job.clock.play();
          this.needsPlay = false;
        } else {
          job.clock.resume();
        }
        this.state = "playing";
      }
    }

    // Bake ahead in what the frame leaves; when the next fractal would be
    // late (or while buffering), frames may slow to about 30 fps instead.
    // Hold back while the music's lead is short: its readbacks queue
    // behind the frames' GPU work
    const urgent = this.state === "buffering" || library.needed(t) > this.bakeRate * 0.9;
    const pace = this.host.pace;
    const musicLow = job.audio && !job.audio.ready(4);
    let baked = 0;
    if (pace.bakes() && !(musicLow && job.audio .ahead() < 2)) {
      // Urgent: frames may slow to about half the device's rate
      const rows = this.budget.next(dt, urgent ? pace.base : 4);
      baked = library.bake(musicLow ? Math.min(rows, 1 << 13) : rows, t);
    }
    if (baked > 0) {
      this.bakeRate += (baked / Math.max(seconds, 1e-3) - this.bakeRate) * 0.1;
    } else {
      this.host.pace.update(dt);
    }
    library.sort(t);

    if (library.canShow(t)) {
      this.shownT = t;
    }
    if (library.canShow(this.shownT)) {
      this.applyFinish(video.draw(this.shownT, this.steer, innerWidth / innerHeight));
      video.render();
      this.ui.volume.style.setProperty("--pulse", this.state === "playing" ? video.pulse(this.shownT).toFixed(3) : "0");
    }
    this.host.resolution?.update(dt, baked > 0);
    this.paintPlayback();
  }

  // The volume (0..1) and mute: heard at once, shown on the slider (level,
  // knob, a readout while dragging) and the speaker (waves by level)
          setVolume(volume        , muted         ) {
    this.volume = Math.min(1, Math.max(0, volume));
    this.muted = muted || this.volume === 0;
    this.job?.audio?.setVolume(this.muted ? 0 : this.volume);
    const { volume: root, mute, level } = this.ui;
    root.style.setProperty("--level", (this.muted ? 0 : this.volume).toFixed(3));
    const wasMuted = root.classList.contains("muted");
    root.classList.toggle("muted", this.muted);
    if (this.muted && !wasMuted) {
      // Restart the shake
      mute.style.animation = "none";
      void mute.offsetWidth;
      mute.style.animation = "";
    }
    const icon = this.muted ? ICONS.muted : this.volume < 0.5 ? ICONS.soft : ICONS.sound;
    if (mute.innerHTML !== icon) {
      mute.innerHTML = icon;
    }
    level.textContent = this.muted ? "muted" : String(Math.round(this.volume * 100));
  }

          applyFinish(fx        ) {
    this.ui.fade.style.opacity = String(fx.fade);
    this.ui.flash.style.opacity = String(fx.flash);
    this.ui.dim.style.opacity = String(fx.dim);
  }

  // The menu's and the controls' state
          paint() {
    const { ui, job } = this;
    const [icon, label, note] = this.sound ? [ICONS.sound, "Sound on", "Tap to mute"] : [ICONS.muted, "Sound off", "Tap for music"];
    const sound = `${icon}<span class="demo-sound-label">${label}</span><span class="demo-sound-note">${note}</span>`;
    if (ui.sound.innerHTML !== sound) {
      ui.sound.innerHTML = sound;
    }
    ui.sound.classList.toggle("on", this.sound);
    const live = this.music === "gpu";
    const music = !this.host.webgpu ? "Music <b>from a file</b><span>GPU music needs WebGPU</span>"
      : `Music <b>${live ? "made on the GPU" : "from a file"}</b><span>tap to switch</span>`;
    if (ui.music.innerHTML !== music) {
      ui.music.innerHTML = music;
    }
    ui.music.classList.toggle("on", live);
    ui.music.hidden = !this.sound;
    const sharp = this.host.hiDpi();
    const dpi = `HiDPI <b>${sharp ? "on" : "off"}</b><span>${sharp ? "tap for faster" : "tap for sharper"}</span>`;
    if (ui.hiDpi.innerHTML !== dpi) {
      ui.hiDpi.innerHTML = dpi;
    }
    ui.hiDpi.classList.toggle("on", sharp);
    const high = this.host.quality() === "high";
    const millions = (n        ) => (n >= 1e6 ? `${n / 1e6}M` : `${n / 1e3}k`);
    const other = millions(this.host.splatsAt(high ? "standard" : "high"));
    const splats = `Splats <b>${millions(this.host.splatsAt(this.host.quality()))}</b><span>tap for ${other}</span>`;
    if (ui.quality.innerHTML !== splats) {
      ui.quality.innerHTML = splats;
    }
    ui.quality.classList.toggle("on", high);
    ui.info.textContent = `${this.host.webgpu ? "WebGPU" : "WebGL2"}, ${this.host.platform}`;
    for (const tune of TUNES) {
      const card = ui.cards.get(tune.name) ;
      const mine = job?.tune === tune;
      const preparing = mine && this.state === "preparing";
      card.classList.toggle("active", Boolean(mine));
      card.classList.toggle("dim", Boolean(job && !mine && this.state === "preparing"));
      const bar = card.querySelector             (".demo-progress i") ;
      const label = card.querySelector             (".demo-state") ;
      const readiness = mine ? this.readiness(job ) : undefined;
      // Live while preparing (or where an error stopped it); full once started
      bar.style.width = `${!readiness ? 0 : preparing || job .error ? 100 * readiness.progress : 100}%`;
      if (!mine) {
        label.textContent = "Play";
      } else if (job .error) {
        label.textContent = `Couldn't prepare (${job .error}). Tap to retry.`;
      } else if (preparing) {
        const { progress, waiting } = readiness ;
        label.textContent = waiting ? `${Math.round(100 * progress)}%: ${waiting}` : job .wantStart ? "Starting" : "Ready";
      } else {
        label.textContent = job .played ? "Play again" : "Play";
      }
    }
    this.paintPlayback();
  }

  // How ready a demo is to start (0..1) and what it waits on: its bake
  // programs, the bakes before the start, the first pairing, the music
          readiness(job     ) {
    const library = job.library;
    const kinds = job.warmed / Math.max(1, job.kinds.length);
    const bake = this.phone ? library.stockProgress() : library.startProgress(job.rate * this.share, this.margin);
    const paired = library.ready(0, true) && job.compiled ? 1 : 0;
    const audio = job.audio;
    const music = !audio || audio.ready(MUSIC_AHEAD) ? 1 : audio.kind === "gpu" ? Math.min(1, audio.ahead() / MUSIC_AHEAD) : 0;
    const waiting = [
      bake < 1 ? "baking" : "",
      kinds < 1 ? `shaders ${job.warmed}/${job.kinds.length}` : "",
      bake >= 1 && !paired ? "pairing" : "",
      music < 1 ? "music" : "",
    ].filter(Boolean).join(", ");
    return { progress: 0.15 * kinds + 0.6 * Math.min(bake, 1) + 0.1 * paired + 0.15 * music, waiting };
  }

          painted = "";

  // The controls (shown while paused), the buffering note and the time
          paintPlayback() {
    const { ui, job } = this;
    const playing = this.state === "playing" || this.state === "buffering";
    const paused = this.state === "paused";
    const time = job ? `${clock(this.shownT)} / ${clock(job.video.duration)}` : "";
    const key = `${this.state}|${time}`;
    if (key === this.painted) {
      return;
    }
    this.painted = key;
    ui.controls.hidden = !paused;
    ui.buffering.hidden = this.state !== "buffering";
    ui.volume.hidden = !(job?.audio && (playing || paused));
    ui.toggle.innerHTML = playing ? ICONS.pause : ICONS.play;
    if (job && (playing || paused)) {
      ui.time.textContent = time;
      (ui.bar.firstElementChild               ).style.width = `${(100 * this.shownT) / job.video.duration}%`;
    }
  }

  // --- Frame by frame, for a recorder ---

  async film(name        ) {
    const tune = TUNES.find((each) => each.name === name) ?? TUNES[0];
    const { renderer } = this.host;
    this.host.enter();
    this.host.yield();
    this.state = "film";
    const count = Number(new URLSearchParams(location.search).get("splats")) || 900_000;
    const times = cueTimes(tune);
    // A small GPU pool and the rest in CPU memory, uploaded as the frames
    // reach it (every fractal of a demo on the GPU at once fails silently
    // at a few million samples each)
    const library = new Library(renderer, this.host.kinds, this.host.bakeU, tune.cues, times, count, 4, { stash: true });
    const score = new AirScore();
    const data = buildScore(tune.compose, tune.mix, score);
    const video = new Video(renderer, library, tune, score.marks, this.ui.overlay);
    const idle = () => (this.host.webgpu ? device(renderer).queue.onSubmittedWorkDone() : frame());
    library.warm();
    while (!library.stocked()) {
      const n = library.bake(1 << 17, 0, true);
      library.sort(0);
      await (n === 0 ? sleep(20) : idle());
    }
    library.endPrep();
    // What film time t draws: baked, uploaded and paired
    const ready = async (t        ) => {
      while (!library.canShow(t)) {
        const n = library.bake(1 << 18, t);
        library.sort(t);
        await (n === 0 ? sleep(5) : idle());
      }
    };
    this.ui.stage.hidden = false;
    const none = { yaw: 0, pitch: 0, zoom: 0 };
    const seek = async (t        ) => {
      await ready(t);
      this.applyFinish(video.draw(t, none, innerWidth / innerHeight));
      video.render();
      await device(renderer).queue.onSubmittedWorkDone();
    };
    // Every program compiled before the first frame is timed
    await seek(0.05);
    await seek(times.ends[0] + 0.5);
    const audio = async () => {
      const gpu = new GpuScore(renderer, video.duration, { score: data });
      const bytes = new Uint8Array(toWav(await gpu.renderAll()));
      gpu.dispose();
      let text = "";
      for (let i = 0; i < bytes.length; i += 0x8000) {
        text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      }
      return btoa(text);
    };
    const shots = tune.cues.map((cue, i) => ({ name: `${String(i).padStart(2, "0")} ${cue.preset}`, from: times.starts[i], to: times.starts[i + 1] ?? video.duration }));
    Object.assign(window, { film: { ready: true, duration: video.duration, seek, audio, shots, renderer, library } });
  }
}


//# sourceURL=examples/fractals/demo/demo.ts