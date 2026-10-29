// Main-thread side of the game: the simulation itself runs in simWorker.ts
// (doomgeneric in WASM, 35 Hz on its own timer, a module worker). This
// proxy keeps the last two tick snapshots for interpolation, the latest
// software frame (2D overlay with alpha), forwards keyboard/mouse input to
// the worker, plays the worker's sound/music events through DoomAudio, and
// derives the camera from the console player. main.ts reads `prev` /
// `curr` / `alpha()` from here each frame.

import * as THREE from "three";
import { fetchData } from "./data.js";
import { DoomAudio } from "./sim/DoomAudio.js";
import {
  GameState,
  INFO,
  PLAYER,
  TIC_MS,
  angleToRadians,
  fixedToFloat,
                   
} from "./sim/DoomSim.js";
import { DoomKey, mouseButtonMask, translateKey } from "./sim/doomkeys.js";
                                                                                         

                                  
                                                                          
                        
               
                          
                            
                                  
 

// Mouse scale on top of `sensitivity`: Doom's turning vs. the free-fly look
const GAME_TURN_SCALE = 1.5;
const FREE_LOOK_SCALE = 0.5;

export class DoomGame {
           audio           ;
           canvas                   ;
           width        ;
           height        ;
  // Maps the WAD's attract demos play, as scene ids (e1m5, ...), DEMO1 first
           demoMaps          ;
  prev             ;
  curr             ;
  levelGeneration = 0;
  // Latest 2D overlay frame (alpha 0 where the 3D view was)
  frame            ;
  // Bumped on every frame received, including re-sends while paused
  frameVersion = 0;
  // The first click happened (it unlocks audio and captures the mouse)
  started = false;
  // Mouse scale, for Doom's turning (x GAME_TURN_SCALE) and the free-fly
  // look (x FREE_LOOK_SCALE)
  sensitivity = 2.0;
  // Ticks received since the last update() call
  ticsThisFrame = 0;
  // \ (backslash) toggles this: Doom's clock is frozen and the camera is
  // free (WASD + mouse look). Otherwise the game runs (demo loop, or the
  // warped level) with the camera on the player, whether or not the mouse
  // is captured; capturing only adds mouse look.
  userPaused = false;
  // Set by the viewer while it prepares a level's splats
  holdPaused = false;
  // A mouse capture request was just refused (too soon after Esc)
  captureRetry = false;
  // Worker tick rate over the last second, for the status line
  ticksPerSecond = 0;
  // Pointer-lock mouse motion while not following (free-move look)
  onFreeLook                                   ;
  // Keys the page has pressed in Doom and not yet released (key -> typed
  // char). Presses only go through while the game runs, releases always: a
  // key let go during a pause or a level-load hold must not stay down in
  // the engine
                   heldKeys = new Map                ();

                   worker        ;
                   log                           ;
          pendingTicks = 0;
          tickCounter = 0;
          tickCounterStart = performance.now();
          sentPaused = false;
  // The initial pause is applied once the title screen has been drawn
          startupHold = true;

          constructor(worker        , audio           , canvas                   , width        , height        , demoMaps          , log                           ) {
    this.worker = worker;
    this.audio = audio;
    this.canvas = canvas;
    this.width = width;
    this.height = height;
    this.demoMaps = demoMaps;
    this.log = log;
    this.prev = emptySnapshot();
    this.curr = emptySnapshot();
    worker.onmessage = (event                             ) => this.onMessage(event.data);
    this.bindInput();
  }

  static async create({ base, params, canvas, log = () => {} }                 ) {
    const engine = new URL("engine/", base).href;
    const wadResponse = await fetchData(params.get("wad") ?? `${engine}doom1.wad`);
    const wad = new Uint8Array(await wadResponse.arrayBuffer());
    const demoMaps = readDemoMaps(wad);
    const music = !params.has("nomusic") && !params.has("nosound");
    const audio = new DoomAudio({
      oplModuleUrl: `${engine}libadlmidi.js`,
      oplProcessorUrl: music ? `${engine}libadlmidi.nuked.processor.js` : undefined,
      oplWasmUrl: `${engine}libadlmidi.nuked.core.wasm`,
      // 4x DoomAudio's default (0.6) on top of Doom's own music volume: the
      // OPL3 synth is quiet next to the sound effects at the default settings
      musicGain: 2.4,
      log,
    });
    const args = buildArgs(params);
    const worker = new Worker(new URL("./simWorker.js", import.meta.url), { type: "module" });
    // D_DoomMain already registers/plays music and sounds (with -warp) before
    // the worker reports ready; keep those messages for the game object
    const early                  = [];
    const ready = new Promise                                   ((resolve, reject) => {
      worker.onmessage = (event                             ) => {
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
      worker.onerror = (event) => reject(new Error(`Doom worker: ${event.message || "failed to start"}`));
    });
    const saves = loadSaves();
    if (saves.length) log(`savegames restored from localStorage: ${saves.map((s) => s.name).join(", ")}`);
    const init               = {
      type: "init",
      moduleUrl: `${engine}doom.js`,
      wasmUrl: `${engine}doom.wasm`,
      wad,
      args,
      saves,
    };
    worker.postMessage(init, { transfer: [wad.buffer] });
    const { width, height } = await ready;
    log(`Doom started in worker: args ${args.join(" ") || "(none)"}; demos ${demoMaps.join(", ")}`);
    const game = new DoomGame(worker, audio, canvas, width, height, demoMaps, log);
    for (const message of early) {
      game.onMessage(message);
    }
    // ?sensitivity= overrides the default set on the field (2.0)
    game.sensitivity = Number(params.get("sensitivity") ?? game.sensitivity) || game.sensitivity;
    return game;
  }

          send(message              ) {
    this.worker.postMessage(message);
  }

  onMessage(message               ) {
    switch (message.type) {
      case "tick":
        this.onTick(message);
        break;
      case "audio":
        this.onAudio(message);
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
    c.gametic = tick.gametic;
    c.info = tick.info;
    c.hasPlayer = tick.hasPlayer;
    c.player = tick.player;
    c.sectorCount = tick.sectorCount;
    c.sectors = tick.sectors;
    c.sideCount = tick.sideCount;
    c.sides = tick.sides;
    c.mobjCount = tick.mobjCount;
    c.mobjs = tick.mobjs;
    c.visibleSubsectors = tick.visibleSubsectors;
    this.levelGeneration = tick.levelGeneration;
    if (!this.frame || this.frame.width !== tick.width || this.frame.height !== tick.height) {
      this.frame = new ImageData(tick.width, tick.height);
    }
    this.frame.data.set(tick.frame);
    this.frameVersion += 1;
    if (this.startupHold && tick.gametic >= 2) {
      // Title screen (or the warped level's first frame) is up: hold here
      this.startupHold = false;
      this.applyPause();
    }
    this.pendingTicks += 1;
    this.tickCounter += 1;
    const now = performance.now();
    if (now - this.tickCounterStart >= 1000) {
      this.ticksPerSecond = this.tickCounter;
      this.tickCounter = 0;
      this.tickCounterStart = now;
    }
  }

          onAudio(message                                           ) {
    const { audio } = this;
    switch (message.event) {
      case "sfxStart":
        audio.startSfx(message.channel, message.lumpnum, message.bytes ?? null, message.vol, message.sep);
        break;
      case "sfxUpdate":
        audio.updateSfx(message.channel, message.vol, message.sep);
        break;
      case "sfxStop":
        audio.stopSfx(message.channel);
        break;
      case "musicRegister":
        audio.registerMusic(message.handle, message.bytes);
        break;
      case "musicUnregister":
        audio.unregisterMusic(message.handle);
        break;
      case "musicPlay":
        audio.playMusic(message.handle, message.looping);
        break;
      case "musicStop":
        audio.stopMusic();
        break;
      case "musicPause":
        audio.pauseMusic();
        break;
      case "musicResume":
        if (!this.paused) audio.resumeMusic();
        break;
      case "musicSetVolume":
        audio.setMusicVolume(message.volume);
        break;
    }
  }

  // Must run inside a user gesture: enables audio and captures the mouse.
  // Later clicks only re-capture the mouse (see bindInput).
  async start() {
    this.started = true;
    // Pointer lock first: it needs the click's activation, audio can wait
    this.requestCapture();
    await this.audio.unlock();
    this.send({ type: "audioState", running: this.audio.context.state === "running" });
  }

  get mouseCaptured() {
    return document.pointerLockElement === this.canvas;
  }

  // Chrome rejects pointer lock requests made within about a second of an
  // Esc exit (SecurityError); report it through the hint instead of throwing
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

  get menuActive() {
    return this.curr.info[INFO.MENUACTIVE] !== 0;
  }

  // The camera is on the player whenever the game runs; paused = free fly
  get follow() {
    return !this.userPaused;
  }

  // Keyboard goes to Doom whenever its clock runs (paused: WASD flies)
  get forwardsKeys() {
    return !this.paused;
  }

          tapKey(key        ) {
    this.send({ type: "key", key, pressed: true, typed: key < 128 ? key : 0 });
    this.send({ type: "key", key, pressed: false, typed: key < 128 ? key : 0 });
  }

  // Doom's clock is frozen (nothing catches up on resume) while the user has
  // it paused or the viewer holds it for a level load; music pauses too
  get paused() {
    return this.userPaused || this.holdPaused;
  }

  // Playing: the clock runs, the camera follows the player, input reaches Doom
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
  // not deliver the Esc keydown, so it is sent to Doom here: its menu opens
  // like in the original (any key does during a demo). The game itself is
  // not paused by this; the menu freezes the world in single player anyway.
          onMouseReleased() {
    this.releaseKeys();
    if (!this.paused && !this.menuActive) {
      this.tapKey(DoomKey.ESCAPE);
    }
  }

          applyPause() {
    if (this.startupHold) return;
    const paused = this.paused;
    if (paused === this.sentPaused) return;
    this.sentPaused = paused;
    this.send({ type: "pause", paused });
    if (paused) {
      this.audio.pauseMusic();
    } else {
      this.audio.resumeMusic();
    }
  }

  // Debug: send the whole software frame opaque (vanilla view for comparison)
  setOpaqueFrame(on         ) {
    this.send({ type: "opaqueFrame", on });
  }

  // Number of ticks that arrived since the previous call
  update()         {
    this.ticsThisFrame = this.pendingTicks;
    this.pendingTicks = 0;
    return this.ticsThisFrame;
  }

  // Fraction of a tic elapsed since the current snapshot
  alpha(nowMs = performance.now())         {
    const span = Math.max(TIC_MS, this.curr.time - this.prev.time);
    return Math.min(1, Math.max(0, (nowMs - this.curr.time) / span));
  }

  get gameState()         {
    return this.curr.info[INFO.GAMESTATE];
  }

  get inLevel()          {
    return this.gameState === GameState.Level && this.curr.hasPlayer;
  }

  // Current episode/map as a scene directory name (e1m5), or undefined
  get mapId() {
    const info = this.curr.info;
    if (info[INFO.GAMESTATE] !== GameState.Level || info[INFO.GAMEMAP] <= 0) {
      return undefined;
    }
    return `e${info[INFO.GAMEEPISODE]}m${info[INFO.GAMEMAP]}`;
  }

  // During the intermission: the map about to start (e1m9 after a secret exit)
  get nextMap() {
    const info = this.curr.info;
    const next = info[INFO.NEXTMAP];
    return next > 0 ? `e${info[INFO.GAMEEPISODE]}m${next}` : undefined;
  }

  get demoPlayback() {
    return this.curr.info[INFO.DEMOPLAYBACK] !== 0;
  }

  // Interpolated player eye in Doom units and view angle in radians
  playerView(alpha        , out = { x: 0, y: 0, z: 0, angle: 0 }) {
    const { prev, curr } = this;
    const b = curr.player;
    if (!prev.hasPlayer || prev.player[PLAYER.MO_PTR] !== b[PLAYER.MO_PTR] || curr.gametic - prev.gametic > 5) {
      out.x = fixedToFloat(b[PLAYER.X]);
      out.y = fixedToFloat(b[PLAYER.Y]);
      out.z = fixedToFloat(b[PLAYER.VIEWZ]);
      out.angle = angleToRadians(b[PLAYER.ANGLE]);
      return out;
    }
    const a = prev.player;
    const ax = fixedToFloat(a[PLAYER.X]);
    const ay = fixedToFloat(a[PLAYER.Y]);
    const az = fixedToFloat(a[PLAYER.VIEWZ]);
    const bx = fixedToFloat(b[PLAYER.X]);
    const by = fixedToFloat(b[PLAYER.Y]);
    const bz = fixedToFloat(b[PLAYER.VIEWZ]);
    // Teleports: snap
    if (Math.hypot(bx - ax, by - ay) > 128) {
      alpha = 1;
    }
    out.x = ax + (bx - ax) * alpha;
    out.y = ay + (by - ay) * alpha;
    out.z = az + (bz - az) * alpha;
    const aa = angleToRadians(a[PLAYER.ANGLE]);
    const ba = angleToRadians(b[PLAYER.ANGLE]);
    let delta = (ba - aa) % (Math.PI * 2);
    if (delta > Math.PI) delta -= Math.PI * 2;
    if (delta < -Math.PI) delta += Math.PI * 2;
    out.angle = aa + delta * alpha;
    return out;
  }

  // Place `camera` at the player's eye: Doom (x, y, z) -> Three (x/s, z/s, -y/s),
  // yaw = Doom angle - 90 degrees
  applyCamera(camera              , alpha        , unitsPerMeter        ) {
    if (!this.curr.hasPlayer) return false;
    const view = this.playerView(alpha, playerViewScratch);
    const s = 1 / unitsPerMeter;
    camera.position.set(view.x * s, view.z * s, -view.y * s);
    camera.rotation.set(0, view.angle - Math.PI / 2, 0, "YXZ");
    camera.updateMatrixWorld();
    return true;
  }

          pressKey(key        , typed        ) {
    this.heldKeys.set(key, typed);
    this.send({ type: "key", key, pressed: true, typed });
  }

  // Returns whether the key was down
          releaseKey(key        ) {
    const typed = this.heldKeys.get(key);
    if (typed === undefined) return false;
    this.heldKeys.delete(key);
    this.send({ type: "key", key, pressed: false, typed });
    return true;
  }

          releaseKeys() {
    for (const key of [...this.heldKeys.keys()]) this.releaseKey(key);
    this.send({ type: "buttons", mask: 0 });
  }

          bindInput() {
    const { canvas } = this;
    // Chrome swallows the Esc keydown while the pointer is locked and only
    // reports the lock ending, so the exit itself is treated as Doom's Esc
    // (see onMouseReleased). Keys reach Doom whenever it runs, captured or
    // not and before the first click, so the menu can be used; Esc is
    // delivered normally while uncaptured and opens/closes it.
    document.addEventListener("pointerlockchange", () => {
      if (!this.started) return;
      if (!this.mouseCaptured) {
        this.onMouseReleased();
      }
    });
    document.addEventListener("pointerlockerror", () => {
      // The request's promise rejection usually reported this already
      if (!this.captureRetry) this.captureFailed();
    });
    document.addEventListener("keydown", (event) => {
      // \ toggles play/pause anywhere (Doom does not use the key)
      if (event.code === "Backslash") {
        if (!event.repeat) this.togglePlay();
        event.preventDefault();
        return;
      }
      if (!this.forwardsKeys) return;
      const translated = translateKey(event);
      if (!translated) return;
      if (!event.repeat) this.pressKey(translated.key, translated.typed);
      event.preventDefault();
    });
    document.addEventListener("keyup", (event) => {
      if (event.code === "Backslash") return;
      const translated = translateKey(event);
      if (!translated) return;
      // Whether or not keys are forwarded right now: only a key Doom holds
      // is released, and it always is
      if (this.releaseKey(translated.key)) event.preventDefault();
    });
    window.addEventListener("blur", () => this.releaseKeys());
    document.addEventListener("mousemove", (event) => {
      if (!this.mouseCaptured) return;
      if (this.follow) {
        if (this.playing) this.send({ type: "mouse", dx: event.movementX * this.sensitivity * GAME_TURN_SCALE });
      } else {
        const scale = this.sensitivity * FREE_LOOK_SCALE;
        this.onFreeLook?.(event.movementX * scale, event.movementY * scale);
      }
    });
    // Presses need the game running and the mouse captured; a release
    // always goes through (the mask is what is still held)
    document.addEventListener("mousedown", (event) => {
      if (this.playing && this.mouseCaptured) {
        this.send({ type: "buttons", mask: mouseButtonMask(event.buttons) });
        event.preventDefault();
      }
    });
    document.addEventListener("mouseup", (event) => {
      this.send({ type: "buttons", mask: mouseButtonMask(event.buttons) });
      if (this.mouseCaptured) event.preventDefault();
    });
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

const playerViewScratch = { x: 0, y: 0, z: 0, angle: 0 };

function emptySnapshot()              {
  return {
    time: 0,
    gametic: 0,
    info: new Int32Array(24),
    hasPlayer: false,
    player: new Int32Array(64),
    sectorCount: 0,
    sectors: new Int32Array(0),
    sideCount: 0,
    sides: new Int32Array(0),
    mobjCount: 0,
    mobjs: new Int32Array(0),
    visibleSubsectors: new Uint8Array(0),
  };
}

// ?warp=E,M or ?warp=M (episode 1), ?skill=1-5, ?nomusic, ?nosound
function buildArgs(params                 )           {
  const args           = [];
  const warp = params.get("warp");
  if (warp) {
    const parts = warp.split(/[,x.\s]+/).map(Number).filter(Number.isFinite);
    if (parts.length === 1) {
      args.push("-warp", "1", String(parts[0]));
    } else if (parts.length >= 2) {
      args.push("-warp", String(parts[0]), String(parts[1]));
    }
    args.push("-skill", params.get("skill") ?? "3");
  }
  if (params.has("nomusic")) args.push("-nomusic");
  if (params.has("nosound")) args.push("-nosound");
  return args;
}

// Savegames persist in localStorage as base64 (vanilla caps a save at
// SAVEGAMESIZE 0x2c000 = 176 KB, so six slots stay well inside the ~5 MB
// quota), keyed by the file name Doom uses
const SAVE_KEY_PREFIX = "radix-doom.save.";

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
    console.warn("[doom] could not read savegames from localStorage", error);
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

// The maps the attract demos play: DEMO1..3 lump headers are
// (version, skill, episode, map, ...), see G_DoPlayDemo
function readDemoMaps(wad            )           {
  const view = new DataView(wad.buffer, wad.byteOffset, wad.byteLength);
  const count = view.getInt32(4, true);
  const directory = view.getInt32(8, true);
  const lumps = new Map                                          ();
  for (let i = 0; i < count; ++i) {
    const entry = directory + i * 16;
    if (entry + 16 > wad.byteLength) break;
    const offset = view.getInt32(entry, true);
    const size = view.getInt32(entry + 4, true);
    let name = "";
    for (let c = 0; c < 8; ++c) {
      const code = wad[entry + 8 + c];
      if (!code) break;
      name += String.fromCharCode(code);
    }
    lumps.set(name, { offset, size });
  }
  const maps           = [];
  for (let n = 1; n <= 3; ++n) {
    const lump = lumps.get(`DEMO${n}`);
    if (!lump || lump.size < 4) continue;
    const episode = wad[lump.offset + 2];
    const map = wad[lump.offset + 3];
    maps.push(`e${episode}m${map}`);
  }
  return maps;
}


//# sourceURL=examples/doom/game.ts