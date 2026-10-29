// Main-thread side of the game: the simulation itself runs in simWorker.ts
// (quakegeneric in WASM, 72 Hz on its own timer). This proxy keeps the last
// two tick snapshots for interpolation, the latest software frame (2D
// overlay with alpha), forwards keyboard/mouse input to the worker, plays the
// worker's mixed audio, and derives the camera from the exported view.
// main.ts reads `prev` / `curr` / `alpha()` from here each frame. The engine
// (quake.js, quake.wasm) and pak0.pak come from the data folder's engine/.

import * as THREE from "three";
import { fetchData } from "./data.js";
import {
  ClientState,
  INFO,
  KeyDest,
  LIGHTSTYLE_NORMAL,
  MAX_LIGHTSTYLES,
  SIGNONS,
  TIC_MS,
  bitsToFloat,
  mapIdFromModelName,
  readView,
                   
                 
} from "./sim/QuakeSim.js";
import { QuakeKey, STARTUP_BINDS, translateKey } from "./sim/quakekeys.js";
                                                                                           

                                   
                                                         
               
                          
                            
                                  
 

// Mouse scale on top of `sensitivity`: Quake's look vs. the free-fly look
const GAME_TURN_SCALE = 1.5;
const FREE_LOOK_SCALE = 0.5;

export class QuakeGame {
           canvas                   ;
           width        ;
           height        ;
           audio            ;
  prev             ;
  curr             ;
  levelGeneration = 0;
  // Latest 2D overlay frame (alpha 0 where the 3D view was)
  frame            ;
  // Bumped on every frame received, including re-sends while paused
  frameVersion = 0;
  // The first click happened (it unlocks audio and captures the mouse)
  started = false;
  // Mouse scale, for Quake's look (x GAME_TURN_SCALE) and the free-fly look
  // (x FREE_LOOK_SCALE)
  sensitivity = 1.0;
  // Ticks received since the last update() call
  ticksThisFrame = 0;
  // \ (backslash) toggles this: Quake's clock is frozen and the camera is
  // free (WASD + mouse look). Otherwise the game runs with the camera on the
  // player, whether or not the mouse is captured.
  userPaused = false;
  // Set by the viewer while it prepares a level's splats
  holdPaused = false;
  // A mouse capture request was just refused (too soon after Esc)
  captureRetry = false;
  // Worker tick rate over the last second, for the status line
  ticksPerSecond = 0;
  // Pointer-lock mouse motion while not following (free-move look)
  onFreeLook                                   ;
  // Keys (and mouse buttons) the page has pressed in Quake and not yet
  // released. Presses only go through while the game runs, releases always:
  // a key let go during a pause or a level-load hold must not stay down in
  // the engine (Quake keeps key states across map changes)
                   heldKeys = new Set        ();

                   worker        ;
                   log                           ;
          pendingTicks = 0;
          tickCounter = 0;
          tickCounterStart = performance.now();
          sentPaused = false;
          startupHold = true;
          modelNames           = [""];

          constructor(worker        , audio            , canvas                   , width        , height        , log                           ) {
    this.worker = worker;
    this.audio = audio;
    this.canvas = canvas;
    this.width = width;
    this.height = height;
    this.log = log;
    this.prev = emptySnapshot();
    this.curr = emptySnapshot();
    worker.onmessage = (event                              ) => this.onMessage(event.data);
    this.bindInput();
  }

  static async create({ base, params, canvas, log = () => {} }                  ) {
    const pakUrl = params.get("pak") ?? new URL("engine/pak0.pak", base).href;
    const pakResponse = await fetchData(pakUrl);
    const pak = new Uint8Array(await pakResponse.arrayBuffer());
    const args = buildArgs(params);
    const commands = [...STARTUP_BINDS];
    if (params.has("nosound")) commands.push("volume 0");
    const worker = new Worker(new URL("./simWorker.js", import.meta.url), { type: "module" });
    const early                   = [];
    const ready = new Promise                                                      ((resolve, reject) => {
      worker.onmessage = (event                              ) => {
        const message = event.data;
        if (message.type === "ready") {
          resolve(message);
        } else if (message.type === "error") {
          reject(new Error(message.message));
        } else if (message.type === "log") {
          log(message.text);
        } else {
          early.push(message);
        }
      };
    });
    const saves = loadSaves();
    if (saves.length) log(`savegames restored from localStorage: ${saves.map((s) => s.name).join(", ")}`);
    const init                = {
      type: "init",
      moduleUrl: new URL("engine/quake.js", base).href,
      wasmUrl: new URL("engine/quake.wasm", base).href,
      pak,
      args,
      commands,
      saves,
    };
    worker.postMessage(init, { transfer: [pak.buffer] });
    const { width, height, audioRate } = await ready;
    log(`Quake started in worker: args ${args.join(" ") || "(none)"}; audio ${audioRate ? `${audioRate} Hz` : "off"}`);
    const audio = new QuakeAudio(audioRate, log);
    const game = new QuakeGame(worker, audio, canvas, width, height, log);
    for (const message of early) {
      game.onMessage(message);
    }
    game.sensitivity = Number(params.get("sensitivity") ?? game.sensitivity) || game.sensitivity;
    return game;
  }

          send(message               ) {
    this.worker.postMessage(message);
  }

  onMessage(message                ) {
    switch (message.type) {
      case "tick":
        this.onTick(message);
        break;
      case "audio":
        this.audio.enqueue(message.samples);
        break;
      case "log":
        this.log(message.text);
        break;
      case "save":
        this.log(storeSave(message.file));
        break;
      case "error":
        this.log(`! ${message.message}`);
        break;
      case "ready":
        break;
    }
  }

          onTick(tick             ) {
    [this.prev, this.curr] = [this.curr, this.prev];
    const c = this.curr;
    c.time = tick.timeEpoch - performance.timeOrigin;
    c.tick = tick.tick;
    c.info = tick.info;
    c.mapName = tick.mapName;
    if (tick.modelNames.length) this.modelNames = tick.modelNames;
    c.modelNames = this.modelNames;
    c.entityCount = tick.entityCount;
    c.entities = tick.entities;
    c.dlightCount = tick.dlightCount;
    c.dlights = tick.dlights;
    c.lightstyles = tick.lightstyles;
    c.particleCount = tick.particleCount;
    c.particles = tick.particles;
    this.levelGeneration = tick.levelGeneration;
    if (!this.frame || this.frame.width !== tick.width || this.frame.height !== tick.height) {
      this.frame = new ImageData(tick.width, tick.height);
    }
    this.frame.data.set(tick.frame);
    this.frameVersion += 1;
    if (this.startupHold && tick.tick >= 2) {
      this.startupHold = false;
      this.applyPause();
    }
    this.pendingTicks += tick.ticks;
    this.tickCounter += tick.ticks;
    const now = performance.now();
    if (now - this.tickCounterStart >= 1000) {
      this.ticksPerSecond = this.tickCounter;
      this.tickCounter = 0;
      this.tickCounterStart = now;
    }
  }

  // Must run inside a user gesture: enables audio and captures the mouse.
  async start() {
    this.started = true;
    this.requestCapture();
    await this.audio.unlock();
    this.send({ type: "audioState", running: this.audio.running });
  }

  get mouseCaptured() {
    return document.pointerLockElement === this.canvas;
  }

          requestCapture() {
    try {
      const result = this.canvas.requestPointerLock?.()           ;
      if (result && typeof (result                 ).catch === "function") {
        (result                 ).catch((error         ) => this.captureFailed(error));
      }
    } catch (error) {
      this.captureFailed(error);
    }
  }

          captureFailed(error          ) {
    if (error) this.log(`pointer lock refused: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
    else this.log("pointer lock refused (pointerlockerror)");
    this.captureRetry = true;
    window.setTimeout(() => {
      this.captureRetry = false;
    }, 1500);
  }

  // \ (backslash) toggles play/pause; the mouse capture is not involved
  togglePlay() {
    if (this.holdPaused) return;
    if (!this.userPaused) this.releaseKeys();
    this.setUserPaused(!this.userPaused);
  }

  get keyDest()         {
    return this.curr.info[INFO.KEY_DEST];
  }

  get menuActive() {
    return this.keyDest === KeyDest.Menu;
  }

  get consoleActive() {
    return this.keyDest === KeyDest.Console;
  }

  // The camera is on the player whenever the game runs; paused = free fly
  get follow() {
    return !this.userPaused;
  }

  get forwardsKeys() {
    return !this.paused;
  }

  // Queue a console command in the game
  command(text        ) {
    this.send({ type: "command", text });
  }

          tapKey(key        ) {
    this.send({ type: "key", key, pressed: true });
    this.send({ type: "key", key, pressed: false });
  }

  get paused() {
    return this.userPaused || this.holdPaused;
  }

  get playing() {
    return !this.paused;
  }

  // Viewer-side hold, e.g. while a level's splats load
  pause(hold         ) {
    this.holdPaused = hold;
    this.applyPause();
  }

  setUserPaused(paused         ) {
    if (this.userPaused === paused) return;
    this.userPaused = paused;
    this.applyPause();
  }

  // The mouse was released (Esc, or the browser took it back). Chrome does
  // not deliver the Esc keydown, so it is sent to Quake here: its menu opens
  // like in the original.
          onMouseReleased() {
    this.releaseKeys();
    if (!this.paused && !this.menuActive && !this.consoleActive) {
      this.tapKey(QuakeKey.ESCAPE);
    }
  }

          applyPause() {
    if (this.startupHold) return;
    const paused = this.paused;
    if (paused === this.sentPaused) return;
    this.sentPaused = paused;
    this.send({ type: "pause", paused });
    this.audio.setPaused(paused);
  }

  // Debug: send the whole software frame opaque (vanilla view for comparison)
  setOpaqueFrame(on         ) {
    this.send({ type: "opaqueFrame", on });
  }

  // Number of ticks that arrived since the previous call
  update()         {
    this.ticksThisFrame = this.pendingTicks;
    this.pendingTicks = 0;
    return this.ticksThisFrame;
  }

  // Fraction of a tick elapsed since the current snapshot
  alpha(nowMs = performance.now())         {
    const span = Math.max(TIC_MS, this.curr.time - this.prev.time);
    return Math.min(1, Math.max(0, (nowMs - this.curr.time) / span));
  }

  get connected()          {
    return this.curr.info[INFO.STATE] === ClientState.Connected && this.curr.info[INFO.SIGNON] === SIGNONS;
  }

  get inLevel()          {
    return this.connected && this.curr.mapName !== "" && this.curr.info[INFO.HAS_VIEW] !== 0;
  }

  get intermission()         {
    return this.curr.info[INFO.INTERMISSION];
  }

  // Current map as a scene directory name (e1m1), or undefined
  get mapId() {
    if (!this.connected) return undefined;
    const id = mapIdFromModelName(this.curr.mapName);
    return id || undefined;
  }

  get demoPlayback() {
    return this.curr.info[INFO.DEMOPLAYBACK] !== 0;
  }

  // Game seconds (cl.time) of the current snapshot
  get time() {
    return bitsToFloat(this.curr.info[INFO.TIME]);
  }

  // Interpolated view (Quake units / degrees)
  playerView(alpha        , out            = viewScratch)            {
    const b = readView(this.curr, viewB);
    const a = readView(this.prev, viewA);
    const sameLevel = this.prev.mapName === this.curr.mapName && a.hasView && this.curr.tick - this.prev.tick <= 5;
    if (!sameLevel || Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) > 128) {
      Object.assign(out, b);
      return out;
    }
    out.x = a.x + (b.x - a.x) * alpha;
    out.y = a.y + (b.y - a.y) * alpha;
    out.z = a.z + (b.z - a.z) * alpha;
    out.pitch = lerpAngle(a.pitch, b.pitch, alpha);
    out.yaw = lerpAngle(a.yaw, b.yaw, alpha);
    out.roll = lerpAngle(a.roll, b.roll, alpha);
    out.fov = b.fov;
    out.hasView = b.hasView;
    return out;
  }

  // Place `camera` at the view: Quake (x, y, z) -> Three (x/s, z/s, -y/s);
  // Quake pitch is positive downwards, yaw 0 = +x, roll positive dips the
  // right side.
  applyCamera(camera              , alpha        , unitsPerMeter        ) {
    if (!this.inLevel) return false;
    const view = this.playerView(alpha);
    const s = 1 / unitsPerMeter;
    camera.position.set(view.x * s, view.z * s, -view.y * s);
    camera.rotation.set(
      THREE.MathUtils.degToRad(-view.pitch),
      THREE.MathUtils.degToRad(view.yaw - 90),
      THREE.MathUtils.degToRad(-view.roll),
      "YXZ",
    );
    camera.updateMatrixWorld();
    return true;
  }

          pressKey(key        ) {
    this.heldKeys.add(key);
    this.send({ type: "key", key, pressed: true });
  }

  // Returns whether the key was down
          releaseKey(key        ) {
    if (!this.heldKeys.delete(key)) return false;
    this.send({ type: "key", key, pressed: false });
    return true;
  }

          releaseKeys() {
    for (const key of [...this.heldKeys]) this.releaseKey(key);
  }

          bindInput() {
    const { canvas } = this;
    document.addEventListener("pointerlockchange", () => {
      if (!this.started) return;
      if (!this.mouseCaptured) {
        this.onMouseReleased();
      }
    });
    document.addEventListener("pointerlockerror", () => {
      if (!this.captureRetry) this.captureFailed();
    });
    document.addEventListener("keydown", (event) => {
      // \ toggles play/pause anywhere (Quake does not use the key); ` and ~
      // both go to Quake as ~, its default toggleconsole bind
      if (event.code === "Backslash") {
        if (!event.repeat) this.togglePlay();
        event.preventDefault();
        return;
      }
      if (!this.forwardsKeys) return;
      const key = event.code === "Backquote" ? "~".charCodeAt(0) : translateKey(event);
      if (key === undefined) return;
      if (!event.repeat) this.pressKey(key);
      event.preventDefault();
    });
    document.addEventListener("keyup", (event) => {
      if (event.code === "Backslash") return;
      const key = event.code === "Backquote" ? "~".charCodeAt(0) : translateKey(event);
      if (key === undefined) return;
      // Whether or not keys are forwarded right now: only a key Quake holds
      // is released, and it always is
      if (this.releaseKey(key)) event.preventDefault();
    });
    window.addEventListener("blur", () => this.releaseKeys());
    document.addEventListener("mousemove", (event) => {
      if (!this.mouseCaptured) return;
      if (this.follow) {
        if (this.playing) {
          const scale = this.sensitivity * GAME_TURN_SCALE;
          this.send({ type: "mouse", dx: event.movementX * scale, dy: event.movementY * scale });
        }
      } else {
        const scale = this.sensitivity * FREE_LOOK_SCALE;
        this.onFreeLook?.(event.movementX * scale, event.movementY * scale);
      }
    });
    const mouseKey = (button        ) => (button === 0 ? QuakeKey.MOUSE1 : button === 2 ? QuakeKey.MOUSE2 : button === 1 ? QuakeKey.MOUSE3 : undefined);
    document.addEventListener("mousedown", (event) => {
      if (!this.playing || !this.mouseCaptured) return;
      const key = mouseKey(event.button);
      if (key !== undefined) this.pressKey(key);
      event.preventDefault();
    });
    document.addEventListener("mouseup", (event) => {
      const key = mouseKey(event.button);
      if (key !== undefined && this.releaseKey(key)) event.preventDefault();
    });
    document.addEventListener("wheel", (event) => {
      if (!this.playing || !this.mouseCaptured) return;
      this.tapKey(event.deltaY < 0 ? QuakeKey.MWHEELUP : QuakeKey.MWHEELDOWN);
    }, { passive: true });
    document.addEventListener("contextmenu", (event) => {
      if (this.mouseCaptured) event.preventDefault();
    });
    canvas.addEventListener("click", () => {
      if (!this.started) {
        void this.start();
      } else if (!this.mouseCaptured) {
        this.requestCapture();
      }
    });
  }
}

// Interpolate Quake angles (degrees) the short way round
export function lerpAngle(a        , b        , t        ) {
  let delta = (b - a) % 360;
  if (delta > 180) delta -= 360;
  if (delta < -180) delta += 360;
  return a + delta * t;
}

const viewScratch = {}             ;
const viewA = {}             ;
const viewB = {}             ;
function emptySnapshot()              {
  return {
    time: 0,
    tick: 0,
    info: new Int32Array(INFO.COUNT),
    mapName: "",
    modelNames: [""],
    entityCount: 0,
    entities: new Int32Array(0),
    dlightCount: 0,
    dlights: new Int32Array(0),
    lightstyles: new Int32Array(MAX_LIGHTSTYLES).fill(LIGHTSTYLE_NORMAL),
    particleCount: 0,
    particles: new Int32Array(0),
  };
}

// ?map=e1m1 ?skill=0-3 start a game instead of the demo loop; ?nosound
function buildArgs(params                 )           {
  const args           = [];
  const map = params.get("map") ?? params.get("warp");
  if (map) {
    if (params.has("skill")) args.push("+skill", params.get("skill") );
    args.push("+map", map);
  }
  if (params.has("nosound")) args.push("-nosound");
  return args;
}

// ---- audio -----------------------------------------------------------------------
// The worker delivers Quake's own mix (interleaved int16 stereo at `rate`);
// chunks are scheduled back to back on an AudioContext.

class QuakeAudio {
           rate        ;
           context              ;
          nextTime = 0;
                   gain          ;
                   log                           ;

  constructor(rate        , log                           ) {
    this.rate = rate;
    this.log = log;
    this.context = new AudioContext({ sampleRate: rate || 44100 });
    this.gain = this.context.createGain();
    this.gain.connect(this.context.destination);
  }

  get running() {
    return this.context.state === "running";
  }

  async unlock() {
    if (this.context.state !== "running") {
      try {
        await this.context.resume();
      } catch (error) {
        this.log(`audio: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  setPaused(paused         ) {
    this.gain.gain.value = paused ? 0 : 1;
  }

  enqueue(samples            ) {
    if (!this.running || !this.rate || samples.length < 2) return;
    const frames = samples.length >> 1;
    const buffer = this.context.createBuffer(2, frames, this.rate);
    const left = buffer.getChannelData(0);
    const right = buffer.getChannelData(1);
    for (let i = 0; i < frames; ++i) {
      left[i] = samples[i * 2] / 32768;
      right[i] = samples[i * 2 + 1] / 32768;
    }
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.gain);
    const now = this.context.currentTime;
    // Keep ~40 ms of lead; resync when the queue ran dry
    if (this.nextTime < now + 0.01) this.nextTime = now + 0.04;
    source.start(this.nextTime);
    this.nextTime += frames / this.rate;
  }
}

// Savegames persist in localStorage as base64, keyed by the file name Quake uses
const SAVE_KEY_PREFIX = "radix-quake.save.";

function loadSaves()             {
  const saves             = [];
  try {
    for (let i = 0; i < localStorage.length; ++i) {
      const key = localStorage.key(i);
      if (!key?.startsWith(SAVE_KEY_PREFIX)) continue;
      const base64 = localStorage.getItem(key);
      if (!base64) continue;
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let j = 0; j < binary.length; ++j) bytes[j] = binary.charCodeAt(j);
      saves.push({ name: key.slice(SAVE_KEY_PREFIX.length), bytes });
    }
  } catch (error) {
    console.warn("[quake] could not read savegames from localStorage", error);
  }
  return saves;
}

function storeSave({ name, bytes }          )         {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  try {
    localStorage.setItem(SAVE_KEY_PREFIX + name, btoa(binary));
    return `savegame ${name} (${bytes.length} bytes) stored in localStorage`;
  } catch (error) {
    return `! savegame ${name} not stored: ${error instanceof Error ? error.message : String(error)}`;
  }
}


//# sourceURL=examples/quake/game.ts