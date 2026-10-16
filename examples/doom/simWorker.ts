// Module worker that hosts the Doom simulation (sim/DoomSim.ts over
// doom.wasm) so the main thread only renders. It ticks on its own 35 Hz
// timer, posts one snapshot per tick (game state arrays plus the software
// frame with the overlay mask as alpha), forwards Doom's sound/music
// callbacks to the main thread as messages (the AudioContext lives there),
// and applies the input/pause messages the page sends. Message shapes are
// the DoomWorkerIn / DoomWorkerOut unions below; game.ts is the other end.
// No import map applies in a worker: relative imports only.

import { DoomSim, TIC_MS, type DoomModule, type RadixAudioHooks } from "./sim/DoomSim.js";

// A savegame file (doomsav<slot>.dsg) to restore into, or written by, Doom's
// in-memory filesystem
export interface SaveFile {
  name: string;
  bytes: Uint8Array;
}

export type DoomWorkerIn =
  | { type: "init"; moduleUrl: string; wasmUrl: string; wad: Uint8Array; wadName?: string; args: string[]; saves?: SaveFile[] }
  | { type: "key"; key: number; pressed: boolean; typed: number }
  | { type: "mouse"; dx: number }
  | { type: "buttons"; mask: number }
  | { type: "pause"; paused: boolean }
  | { type: "opaqueFrame"; on: boolean }
  | { type: "audioState"; running: boolean };

export interface TickMessage {
  type: "tick";
  // Wall clock of the snapshot as epoch ms (performance.timeOrigin + now),
  // comparable across threads
  timeEpoch: number;
  gametic: number;
  // Game tics Doom advanced in this tick call
  tics: number;
  levelGeneration: number;
  info: Int32Array;
  hasPlayer: boolean;
  player: Int32Array;
  sectorCount: number;
  sectors: Int32Array;
  sideCount: number;
  sides: Int32Array;
  mobjCount: number;
  mobjs: Int32Array;
  visibleSubsectors: Uint8Array;
  // 320x200 RGBA, alpha from the overlay mask (or opaque when requested)
  frame: Uint8ClampedArray;
  width: number;
  height: number;
}

export type AudioMessage =
  | { type: "audio"; event: "sfxStart"; channel: number; lumpnum: number; bytes?: Uint8Array; vol: number; sep: number }
  | { type: "audio"; event: "sfxUpdate"; channel: number; vol: number; sep: number }
  | { type: "audio"; event: "sfxStop"; channel: number }
  | { type: "audio"; event: "musicRegister"; handle: number; bytes: Uint8Array }
  | { type: "audio"; event: "musicUnregister"; handle: number }
  | { type: "audio"; event: "musicPlay"; handle: number; looping: boolean }
  | { type: "audio"; event: "musicStop" }
  | { type: "audio"; event: "musicPause" }
  | { type: "audio"; event: "musicResume" }
  | { type: "audio"; event: "musicSetVolume"; volume: number };

export type DoomWorkerOut =
  | { type: "ready"; width: number; height: number }
  | { type: "error"; message: string }
  | { type: "log"; text: string }
  // Doom wrote a savegame (the page persists it)
  | { type: "save"; file: SaveFile }
  | TickMessage
  | AudioMessage;

let sim: DoomSim | undefined;
let module: DoomModule | undefined;
let opaqueFrame = false;
let audioRunning = false;
let lastTicksRun = 0;

function post(message: DoomWorkerOut, transfer: Transferable[] = []) {
  self.postMessage(message, { transfer });
}

// ---- audio proxy -----------------------------------------------------------
// Doom calls these synchronously and expects answers (channel handle, is the
// sound still playing, song handle), so the worker keeps enough local state
// to answer while the main thread does the actual playback.

const sentLumps = new Set<number>();
const sfxEndTime = new Map<number, number>();
let nextSongHandle = 1;
let musicPlaying = false;

function audioHooks(): RadixAudioHooks {
  return {
    sfxStart: (channel, lumpnum, ptr, len, vol, sep) => {
      if (!module || !audioRunning) {
        return -1;
      }
      const heap = module.HEAPU8;
      // DMX header: u16 format, u16 rate, u32 sample count (+32 padding)
      const rate = heap[ptr + 2] | (heap[ptr + 3] << 8);
      const count = (heap[ptr + 4] | (heap[ptr + 5] << 8) | (heap[ptr + 6] << 16) | (heap[ptr + 7] << 24)) >>> 0;
      if (rate <= 0 || count <= 32 || len <= 8 + 32) {
        return -1;
      }
      sfxEndTime.set(channel, performance.now() + ((count - 32) / rate) * 1000);
      let bytes: Uint8Array | undefined;
      if (!sentLumps.has(lumpnum)) {
        bytes = heap.slice(ptr, ptr + len);
        sentLumps.add(lumpnum);
      }
      post({ type: "audio", event: "sfxStart", channel, lumpnum, bytes, vol, sep }, bytes ? [bytes.buffer] : []);
      return channel;
    },
    sfxUpdate: (channel, vol, sep) => post({ type: "audio", event: "sfxUpdate", channel, vol, sep }),
    sfxStop: (channel) => {
      sfxEndTime.delete(channel);
      post({ type: "audio", event: "sfxStop", channel });
    },
    sfxIsPlaying: (channel) => (sfxEndTime.get(channel) ?? 0) > performance.now(),
    musicRegister: (ptr, len, isMidi) => {
      if (!module || isMidi === 0) {
        return 0;
      }
      const handle = nextSongHandle++;
      const bytes = module.HEAPU8.slice(ptr, ptr + len);
      post({ type: "log", text: `music: registered song ${handle} (${len} bytes)` });
      post({ type: "audio", event: "musicRegister", handle, bytes }, [bytes.buffer]);
      return handle;
    },
    musicUnregister: (handle) => post({ type: "audio", event: "musicUnregister", handle }),
    musicPlay: (handle, looping) => {
      musicPlaying = true;
      post({ type: "audio", event: "musicPlay", handle, looping: looping !== 0 });
    },
    musicStop: () => {
      musicPlaying = false;
      post({ type: "audio", event: "musicStop" });
    },
    musicPause: () => post({ type: "audio", event: "musicPause" }),
    musicResume: () => post({ type: "audio", event: "musicResume" }),
    musicSetVolume: (volume) => post({ type: "audio", event: "musicSetVolume", volume }),
    musicIsPlaying: () => musicPlaying,
  };
}

// ---- tick loop ---------------------------------------------------------------

function postTick(tics: number) {
  if (!sim) return;
  const { curr } = sim;
  const frame = new Uint8ClampedArray(sim.width * sim.height * 4);
  sim.blitFramebuffer({ data: frame }, !opaqueFrame);
  const message: TickMessage = {
    type: "tick",
    timeEpoch: performance.timeOrigin + curr.time,
    gametic: curr.gametic,
    tics,
    levelGeneration: sim.levelGeneration,
    info: curr.info.slice(),
    hasPlayer: curr.hasPlayer,
    player: curr.player.slice(),
    sectorCount: curr.sectorCount,
    sectors: curr.sectors.slice(),
    sideCount: curr.sideCount,
    sides: curr.sides.slice(),
    mobjCount: curr.mobjCount,
    mobjs: curr.mobjs.slice(),
    visibleSubsectors: curr.visibleSubsectors.slice(),
    frame,
    width: sim.width,
    height: sim.height,
  };
  post(message, [
    message.info.buffer, message.player.buffer, message.sectors.buffer, message.sides.buffer,
    message.mobjs.buffer, message.visibleSubsectors.buffer, frame.buffer,
  ]);
}

// ---- savegames ---------------------------------------------------------------
// Doom (configdir ".", cwd "/") keeps its six slots at /.savegame/doomsav<n>.dsg
// in Emscripten's in-memory filesystem, which does not outlive the page. The
// page hands the persisted files back at init, and after every tick the
// slots' mtimes are checked so a new save (G_DoSaveGame writes temp.dsg and
// renames it) is posted back to the page.

const SAVE_DIR = "/.savegame";
const SAVE_SLOTS = 6;
const saveStamps = new Map<string, number>();

function saveName(slot: number) {
  return `doomsav${slot}.dsg`;
}

function restoreSaves(m: DoomModule, saves: SaveFile[]) {
  if (!m.FS.analyzePath(SAVE_DIR).exists) m.FS.mkdir(SAVE_DIR);
  for (const { name, bytes } of saves) {
    const path = `${SAVE_DIR}/${name}`;
    m.FS.writeFile(path, bytes);
    saveStamps.set(name, saveStamp(m, path));
  }
}

function saveStamp(m: DoomModule, path: string) {
  try {
    const stat = m.FS.stat(path);
    return stat.mtime.getTime() * 4096 + (stat.size & 4095);
  } catch {
    return 0;
  }
}

function checkSaves() {
  if (!module) return;
  for (let slot = 0; slot < SAVE_SLOTS; ++slot) {
    const name = saveName(slot);
    const path = `${SAVE_DIR}/${name}`;
    const stamp = saveStamp(module, path);
    if (!stamp || stamp === saveStamps.get(name)) continue;
    saveStamps.set(name, stamp);
    const bytes = module.FS.readFile(path, { encoding: "binary" }).slice();
    post({ type: "save", file: { name, bytes } }, [bytes.buffer]);
  }
}

// ---- tick loop ---------------------------------------------------------------

function loop() {
  if (!sim) return;
  const now = performance.now();
  const tics = sim.update(now);
  if (sim.ticksRun !== lastTicksRun) {
    lastTicksRun = sim.ticksRun;
    postTick(tics);
    checkSaves();
  }
  // Wake at the next tic boundary (the sim keeps a steady 35 Hz cadence);
  // update() itself enforces the rate if the timer fires early
  const wait = sim.paused ? TIC_MS : Math.max(0, Math.min(TIC_MS, sim.nextTickTime - performance.now()));
  setTimeout(loop, wait);
}

async function init(message: Extract<DoomWorkerIn, { type: "init" }>) {
  sim = await DoomSim.create({
    moduleUrl: message.moduleUrl,
    wasmUrl: message.wasmUrl,
    wad: message.wad,
    wadName: message.wadName,
    args: message.args,
    audio: audioHooks(),
    onModule: (m) => {
      module = m;
      if (message.saves?.length) restoreSaves(m, message.saves);
    },
    print: (text) => post({ type: "log", text }),
    printErr: (text) => post({ type: "log", text: `! ${text}` }),
  });
  lastTicksRun = sim.ticksRun;
  post({ type: "ready", width: sim.width, height: sim.height });
  // The first snapshot (title screen) before the first tic
  postTick(0);
  loop();
}

self.onmessage = (event: MessageEvent<DoomWorkerIn>) => {
  const message = event.data;
  switch (message.type) {
    case "init":
      init(message).catch((error: unknown) => {
        post({ type: "error", message: error instanceof Error ? error.message : String(error) });
      });
      break;
    case "key":
      sim?.postKey(message.key, message.pressed, message.typed);
      break;
    case "mouse":
      sim?.addMouseMotion(message.dx, 0);
      break;
    case "buttons":
      sim?.setMouseButtons(message.mask);
      break;
    case "pause":
      sim?.setPaused(message.paused);
      break;
    case "opaqueFrame":
      opaqueFrame = message.on;
      // Re-send the current frame with the new alpha so the toggle shows
      // immediately, even while the game is paused and no tick will
      if (sim) postTick(0);
      break;
    case "audioState":
      audioRunning = message.running;
      break;
  }
};
