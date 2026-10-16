// Module worker that hosts the Quake simulation (sim/QuakeSim.ts over
// quake.wasm) so the main thread only renders; module workers get no import
// map, so it imports relative files only (not @sparkjsdev/radix or three). It
// ticks on its own 72 Hz
// timer, posts one snapshot per tick batch (game state arrays plus the
// software frame with the overlay mask as alpha), forwards mixed audio to the
// main thread, and applies the input/pause messages the page sends. Message
// shapes are the QuakeWorkerIn / QuakeWorkerOut unions below; game.ts is the
// other end.

import { QuakeSim, TIC_MS, type QuakeModule } from "./sim/QuakeSim.js";

// A savegame file (s<slot>.sav) to restore into, or written by, Quake's
// in-memory filesystem
export interface SaveFile {
  name: string;
  bytes: Uint8Array;
}

export type QuakeWorkerIn =
  | { type: "init"; moduleUrl: string; wasmUrl: string; pak: Uint8Array; args: string[]; commands: string[]; saves?: SaveFile[] }
  | { type: "key"; key: number; pressed: boolean }
  | { type: "mouse"; dx: number; dy: number }
  | { type: "command"; text: string }
  | { type: "pause"; paused: boolean }
  | { type: "opaqueFrame"; on: boolean }
  | { type: "audioState"; running: boolean };

export interface TickMessage {
  type: "tick";
  // Wall clock of the snapshot as epoch ms (performance.timeOrigin + now),
  // comparable across threads
  timeEpoch: number;
  tick: number;
  // Ticks run in this update
  ticks: number;
  levelGeneration: number;
  info: Int32Array;
  mapName: string;
  modelNames: string[];
  entityCount: number;
  entities: Int32Array;
  dlightCount: number;
  dlights: Int32Array;
  lightstyles: Int32Array;
  particleCount: number;
  particles: Int32Array;
  // 320x240 RGBA, alpha from the overlay mask (or opaque when requested)
  frame: Uint8ClampedArray;
  width: number;
  height: number;
}

export type QuakeWorkerOut =
  | { type: "ready"; width: number; height: number; audioRate: number }
  | { type: "error"; message: string }
  | { type: "log"; text: string }
  // Quake wrote a savegame (the page persists it)
  | { type: "save"; file: SaveFile }
  // Mixed PCM, interleaved stereo int16
  | { type: "audio"; samples: Int16Array }
  | TickMessage;

let sim: QuakeSim | undefined;
let module: QuakeModule | undefined;
let opaqueFrame = false;
let audioRunning = false;
let lastTicksRun = 0;
let lastModelNames: string[] | undefined;
let audioScratch = 0;
const AUDIO_SCRATCH_SAMPLES = 8192;

function post(message: QuakeWorkerOut, transfer: Transferable[] = []) {
  self.postMessage(message, { transfer });
}

// ---- tick loop -----------------------------------------------------------------

function postTick(ticks: number) {
  if (!sim) return;
  const { curr } = sim;
  const frame = new Uint8ClampedArray(sim.width * sim.height * 4);
  sim.blitFramebuffer({ data: frame }, !opaqueFrame);
  const message: TickMessage = {
    type: "tick",
    timeEpoch: performance.timeOrigin + curr.time,
    tick: curr.tick,
    ticks,
    levelGeneration: sim.levelGeneration,
    info: curr.info.slice(),
    mapName: curr.mapName,
    // The names only change with the level; structured clone is cheap anyway
    modelNames: curr.modelNames === lastModelNames ? [] : (lastModelNames = curr.modelNames),
    entityCount: curr.entityCount,
    entities: curr.entities.slice(),
    dlightCount: curr.dlightCount,
    dlights: curr.dlights.slice(),
    lightstyles: curr.lightstyles.slice(),
    particleCount: curr.particleCount,
    particles: curr.particles.slice(),
    frame,
    width: sim.width,
    height: sim.height,
  };
  post(message, [
    message.info.buffer, message.entities.buffer, message.dlights.buffer, message.lightstyles.buffer,
    message.particles.buffer, frame.buffer,
  ]);
}

function postAudio() {
  if (!sim || !module || !audioRunning || !module._radix_audio_read) return;
  if (!audioScratch) {
    audioScratch = module._malloc(AUDIO_SCRATCH_SAMPLES * 2);
  }
  for (;;) {
    const count = module._radix_audio_read(audioScratch, AUDIO_SCRATCH_SAMPLES);
    if (count <= 0) break;
    const samples = new Int16Array(count);
    samples.set(new Int16Array(module.HEAP8.buffer, audioScratch, count));
    post({ type: "audio", samples }, [samples.buffer]);
    if (count < AUDIO_SCRATCH_SAMPLES) break;
  }
}

// ---- savegames -----------------------------------------------------------------
// Quake keeps its save slots at /id1/s<n>.sav in Emscripten's in-memory
// filesystem, which does not outlive the page. The page hands the persisted
// files back at init, and after every tick batch the slots' mtimes are
// checked so a new save is posted back to the page.

const SAVE_DIR = "/id1";
const SAVE_SLOTS = 12;
const saveStamps = new Map<string, number>();

function saveName(slot: number) {
  return `s${slot}.sav`;
}

function restoreSaves(m: QuakeModule, saves: SaveFile[]) {
  for (const { name, bytes } of saves) {
    const path = `${SAVE_DIR}/${name}`;
    m.FS.writeFile(path, bytes);
    saveStamps.set(name, saveStamp(m, path));
  }
}

function saveStamp(m: QuakeModule, path: string) {
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

// ---- tick loop -----------------------------------------------------------------

function loop() {
  if (!sim) return;
  const now = performance.now();
  const ticks = sim.update(now);
  if (sim.ticksRun !== lastTicksRun) {
    lastTicksRun = sim.ticksRun;
    postTick(ticks);
    postAudio();
    checkSaves();
  }
  // Wake at the next tick boundary; update() itself enforces the rate if the
  // timer fires early
  const wait = sim.paused ? TIC_MS : Math.max(0, Math.min(TIC_MS, sim.nextTickTime - performance.now()));
  setTimeout(loop, wait);
}

async function init(message: Extract<QuakeWorkerIn, { type: "init" }>) {
  sim = await QuakeSim.create({
    moduleUrl: message.moduleUrl,
    wasmUrl: message.wasmUrl,
    pak: message.pak,
    args: message.args,
    commands: message.commands,
    onModule: (m) => {
      module = m;
      if (message.saves?.length) restoreSaves(m, message.saves);
    },
    print: (text) => post({ type: "log", text }),
    printErr: (text) => post({ type: "log", text: `! ${text}` }),
  });
  lastTicksRun = sim.ticksRun;
  const audioRate = module?._radix_audio_rate?.() ?? 0;
  post({ type: "ready", width: sim.width, height: sim.height, audioRate });
  // The first snapshot before the first tick
  postTick(0);
  loop();
}

self.onmessage = (event: MessageEvent<QuakeWorkerIn>) => {
  const message = event.data;
  switch (message.type) {
    case "init":
      init(message).catch((error: unknown) => {
        post({ type: "error", message: error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error) });
      });
      break;
    case "key":
      sim?.postKey(message.key, message.pressed);
      break;
    case "mouse":
      sim?.addMouseMotion(message.dx, message.dy);
      break;
    case "command":
      sim?.command(message.text);
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
