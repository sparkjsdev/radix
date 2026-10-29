// Host-side wrapper around doom.wasm (doomgeneric and its host interface).
//
// The simulation runs at Doom's fixed 35 Hz. update() must be called
// frequently (e.g. every animation frame); it only enters the WASM when at
// least one tic has elapsed so TryRunTics never spins, and Doom itself caps
// how many tics it runs per call, so a stalled tab cannot cause a catch-up
// spiral. After each tick the exported state is copied into host-owned
// typed arrays (prev / curr) so a renderer can interpolate between tics.
//
// Field layouts below mirror the enums of doom.wasm's host interface.

export const TICRATE = 35;
export const TIC_MS = 1000 / TICRATE;
export const FRACUNIT = 65536;

export function fixedToFloat(value: number) {
  return value / FRACUNIT;
}

// Doom BAM angle (unsigned 32-bit) to radians, counter-clockwise, 0 = east.
export function angleToRadians(value: number) {
  return ((value >>> 0) / 4294967296) * Math.PI * 2;
}

export const GameState = {
  Level: 0,
  Intermission: 1,
  Finale: 2,
  DemoScreen: 3,
} as const;

export const INFO = {
  NUMSECTORS: 0,
  NUMSIDES: 1,
  NUMSUBSECTORS: 2,
  NUMNODES: 3,
  NUMSEGS: 4,
  NUMLINES: 5,
  NUMVERTEXES: 6,
  GAMESTATE: 7,
  GAMEEPISODE: 8,
  GAMEMAP: 9,
  LEVELTIME: 10,
  GAMETIC: 11,
  SECTORS_PTR: 12,
  DEMOPLAYBACK: 13,
  PAUSED: 14,
  MENUACTIVE: 15,
  CONSOLEPLAYER: 16,
  GAMESKILL: 17,
  TOTALKILLS: 18,
  TOTALITEMS: 19,
  TOTALSECRET: 20,
  AUTOMAPACTIVE: 21,
  // wminfo.next + 1 during the intermission (the map about to start), else 0
  NEXTMAP: 22,
  // The 3D view window inside the 320x200 frame (R_ExecuteSetViewSize):
  // viewwindowx, viewwindowy, scaledviewwidth, viewheight
  VIEW_X: 24,
  VIEW_Y: 25,
  VIEW_W: 26,
  VIEW_H: 27,
} as const;

export const SECTOR = {
  FLOOR: 0,
  CEILING: 1,
  LIGHT: 2,
  FLOORPIC: 3,
  CEILINGPIC: 4,
  SPECIAL: 5,
  TAG: 6,
  STRIDE: 7,
} as const;

export const SIDE = {
  TEXTUREOFFSET: 0,
  ROWOFFSET: 1,
  STRIDE: 2,
} as const;

export const MOBJ = {
  ID: 0,
  X: 1,
  Y: 2,
  Z: 3,
  ANGLE: 4,
  SPRITE: 5,
  FRAME: 6,
  FLAGS: 7,
  TYPE: 8,
  HEALTH: 9,
  SECTOR: 10,
  RADIUS: 11,
  HEIGHT: 12,
  TICS: 13,
  STRIDE: 14,
} as const;

// mobj_t.frame flag
export const FF_FULLBRIGHT = 0x8000;
export const FF_FRAMEMASK = 0x7fff;

export const PLAYER = {
  X: 0,
  Y: 1,
  Z: 2,
  ANGLE: 3,
  VIEWZ: 4,
  VIEWHEIGHT: 5,
  DELTAVIEWHEIGHT: 6,
  BOB: 7,
  HEALTH: 8,
  ARMORPOINTS: 9,
  ARMORTYPE: 10,
  READYWEAPON: 11,
  PENDINGWEAPON: 12,
  POWERS: 13, // 6
  CARDS: 19, // 6
  AMMO: 25, // 4
  MAXAMMO: 29, // 4
  PSPRITES: 33, // 2 x (sprite, frame, sx, sy)
  DAMAGECOUNT: 41,
  BONUSCOUNT: 42,
  EXTRALIGHT: 43,
  FIXEDCOLORMAP: 44,
  PLAYERSTATE: 45,
  KILLCOUNT: 46,
  ITEMCOUNT: 47,
  SECRETCOUNT: 48,
  MOMX: 49,
  MOMY: 50,
  MOMZ: 51,
  SECTOR: 52,
  ATTACKDOWN: 53,
  USEDOWN: 54,
  CHEATS: 55,
  FLOORZ: 56,
  CEILINGZ: 57,
  MO_PTR: 58,
} as const;

// Order of radix_bsp_arrays(); each entry is (ptr, count, byteStride).
export const BSP_ARRAY_NAMES = [
  "vertexes",
  "segs",
  "sectors",
  "subsectors",
  "nodes",
  "lines",
  "sides",
] as const;
export type BspArrayName = (typeof BSP_ARRAY_NAMES)[number];

export interface BspArray {
  ptr: number;
  count: number;
  byteStride: number;
}

// Callbacks the sound/music modules in i_radixsound.c invoke through EM_JS.
// Pointers refer to the module heap and are only valid during the call.
export interface RadixAudioHooks {
  sfxStart?(channel: number, lumpnum: number, ptr: number, len: number, vol: number, sep: number): number;
  sfxUpdate?(channel: number, vol: number, sep: number): void;
  sfxStop?(channel: number): void;
  sfxIsPlaying?(channel: number): boolean;
  musicRegister?(ptr: number, len: number, isMidi: number): number;
  musicUnregister?(handle: number): void;
  musicPlay?(handle: number, looping: number): void;
  musicStop?(): void;
  musicPause?(): void;
  musicResume?(): void;
  musicSetVolume?(volume: number): void;
  musicIsPlaying?(): boolean;
}

// The subset of the Emscripten module we use.
export interface DoomModule {
  HEAP8: Int8Array;
  HEAPU8: Uint8Array;
  HEAP32: Int32Array;
  HEAPU32: Uint32Array;
  FS: {
    mkdir(path: string): void;
    writeFile(path: string, data: Uint8Array): void;
    readFile(path: string, opts?: { encoding: "binary" }): Uint8Array;
    analyzePath(path: string): { exists: boolean };
    stat(path: string): { mtime: Date; size: number };
  };
  _malloc(size: number): number;
  _free(ptr: number): void;
  stringToUTF8(str: string, ptr: number, maxBytes: number): void;
  lengthBytesUTF8(str: string): number;
  setValue(ptr: number, value: number, type: string): void;
  getValue(ptr: number, type: string): number;
  radixAudio?: RadixAudioHooks;

  _doomgeneric_Create(argc: number, argv: number): void;
  _doomgeneric_Tick(): void;
  _radix_framebuffer(): number;
  _radix_framebuffer_width(): number;
  _radix_framebuffer_height(): number;
  _radix_post_key(pressed: number, key: number, typed: number): void;
  _radix_post_mouse(buttons: number, dx: number, dy: number): void;
  _radix_level_info(out: number): void;
  _radix_level_info_count(): number;
  _radix_sector_stride(): number;
  _radix_snapshot_sectors(out: number, max: number): number;
  _radix_side_stride(): number;
  _radix_snapshot_sides(out: number, max: number): number;
  _radix_mobj_stride(): number;
  _radix_snapshot_mobjs(out: number, max: number): number;
  _radix_mobj_count(): number;
  _radix_player_count(): number;
  _radix_snapshot_player(out: number): number;
  _radix_point_in_sector(x: number, y: number): number;
  _radix_point_in_subsector(x: number, y: number): number;
  _radix_bsp_array_count(): number;
  _radix_bsp_arrays(out: number): void;
  _radix_clear_visible_subsectors(): void;
  _radix_visible_subsectors(): number;
  _radix_visible_subsectors_capacity(): number;
  _radix_set_paused(paused: number): void;
  _radix_overlay_mask_ptr(): number;
}

export interface DoomModuleOptions {
  print?: (text: string) => void;
  printErr?: (text: string) => void;
  preRun?: Array<(module: DoomModule) => void>;
  locateFile?: (path: string, prefix: string) => string;
}

export type CreateDoomModule = (options?: DoomModuleOptions) => Promise<DoomModule>;

export interface SimSnapshot {
  // Wall-clock time (performance.now) when this snapshot was taken.
  time: number;
  gametic: number;
  info: Int32Array;
  hasPlayer: boolean;
  player: Int32Array;
  sectorCount: number;
  sectors: Int32Array;
  sideCount: number;
  sides: Int32Array;
  mobjCount: number;
  mobjs: Int32Array;
  // One byte per subsector, 1 if the BSP renderer visited it this tick.
  visibleSubsectors: Uint8Array;
}

export interface DoomSimOptions {
  // URL of prebuilt/doom.js (an ES module exporting the factory as default).
  moduleUrl: string;
  // Optional explicit URL of doom.wasm; defaults to next to moduleUrl.
  wasmUrl?: string;
  // IWAD bytes; mounted at /doom/<wadName>.
  wad: Uint8Array;
  wadName?: string;
  // Extra command line arguments, e.g. ["-warp", "1", "1", "-skill", "3"].
  args?: string[];
  audio?: RadixAudioHooks;
  // Called with the instantiated module before Doom starts (D_DoomMain may
  // already register music and play sounds during startup).
  onModule?: (module: DoomModule) => void;
  print?: (text: string) => void;
  printErr?: (text: string) => void;
}

export class DoomSim {
  readonly module: DoomModule;
  readonly width: number;
  readonly height: number;

  prev: SimSnapshot;
  curr: SimSnapshot;
  // Increments whenever the level (sectors array) changes.
  levelGeneration = 0;
  ticksRun = 0;
  paused = false;

  private readonly framebufferPtr: number;
  private readonly infoCount: number;
  private readonly infoPtr: number;
  private readonly playerCount: number;
  private readonly playerPtr: number;
  private readonly sectorStride: number;
  private readonly sideStride: number;
  private readonly mobjStride: number;
  private sectorCapacity = 0;
  private sectorPtr = 0;
  private sideCapacity = 0;
  private sidePtr = 0;
  private mobjCapacity = 0;
  private mobjPtr = 0;
  private readonly bspPtr: number;

  private lastSectorsPtr = 0;
  private lastTickTime = Number.NEGATIVE_INFINITY;
  private mouseDx = 0;
  private mouseDy = 0;
  private mouseButtons = 0;
  private lastPostedButtons = 0;

  private constructor(module: DoomModule) {
    this.module = module;
    this.width = module._radix_framebuffer_width();
    this.height = module._radix_framebuffer_height();
    this.framebufferPtr = module._radix_framebuffer();
    this.infoCount = module._radix_level_info_count();
    this.infoPtr = module._malloc(this.infoCount * 4);
    this.playerCount = module._radix_player_count();
    this.playerPtr = module._malloc(this.playerCount * 4);
    this.sectorStride = module._radix_sector_stride();
    this.sideStride = module._radix_side_stride();
    this.mobjStride = module._radix_mobj_stride();
    this.bspPtr = module._malloc(module._radix_bsp_array_count() * 3 * 4);
    if (this.sectorStride !== SECTOR.STRIDE || this.sideStride !== SIDE.STRIDE || this.mobjStride !== MOBJ.STRIDE) {
      throw new Error("doom.wasm snapshot layout does not match DoomSim.ts");
    }
    this.prev = this.makeSnapshot();
    this.curr = this.makeSnapshot();
    this.snapshot(this.curr, performance.now());
  }

  static async create(options: DoomSimOptions): Promise<DoomSim> {
    const wadName = options.wadName ?? "doom1.wad";
    const factoryModule = (await import(/* @vite-ignore */ options.moduleUrl)) as { default: CreateDoomModule };
    const wasmUrl = options.wasmUrl ?? new URL("doom.wasm", options.moduleUrl).href;

    const module = await factoryModule.default({
      print: options.print ?? (() => {}),
      printErr: options.printErr ?? ((text) => console.warn("[doom]", text)),
      locateFile: (path, prefix) => (path.endsWith(".wasm") ? wasmUrl : prefix + path),
      preRun: [
        (m) => {
          m.FS.mkdir("/doom");
          m.FS.writeFile(`/doom/${wadName}`, options.wad);
        },
      ],
    });
    if (options.audio) {
      module.radixAudio = options.audio;
    }
    options.onModule?.(module);

    const argv = ["doom", "-iwad", `/doom/${wadName}`, ...(options.args ?? [])];
    const argPtrs = argv.map((arg) => {
      const length = module.lengthBytesUTF8(arg) + 1;
      const ptr = module._malloc(length);
      module.stringToUTF8(arg, ptr, length);
      return ptr;
    });
    const argvPtr = module._malloc(argPtrs.length * 4);
    argPtrs.forEach((ptr, index) => module.setValue(argvPtr + index * 4, ptr, "i32"));
    // Runs D_DoomMain up to (and including) the first tic; argv must stay
    // alive because Doom keeps myargv pointing at it.
    module._doomgeneric_Create(argv.length, argvPtr);

    return new DoomSim(module);
  }

  // Steps the simulation if at least one tic has elapsed since the previous
  // step. Returns the number of game tics Doom advanced (0 if not due).
  //
  // A single doomgeneric_Tick runs every tic that elapsed since the previous
  // call (TryRunTics reads the real clock and caps itself at 5 buffered
  // tics), so one call per update is enough. Calling it any sooner would make
  // TryRunTics busy-wait for the next tic boundary, hence the gate.
  update(nowMs = performance.now()): number {
    if (this.paused || nowMs - this.lastTickTime < TIC_MS) {
      return 0;
    }
    this.flushMouse();
    this.module._radix_clear_visible_subsectors();
    this.module._doomgeneric_Tick();
    // Keep a steady 35 Hz cadence: advance from the previous boundary unless
    // we fell more than a tic behind (then restart from now)
    this.lastTickTime = nowMs - this.lastTickTime < 2 * TIC_MS ? this.lastTickTime + TIC_MS : nowMs;
    this.ticksRun += 1;
    [this.prev, this.curr] = [this.curr, this.prev];
    this.snapshot(this.curr, nowMs);
    return Math.max(0, this.curr.gametic - this.prev.gametic);
  }

  // When update() will next run a tick (performance.now() ms)
  get nextTickTime() {
    return this.lastTickTime + TIC_MS;
  }

  // Fraction of a tic elapsed since the current snapshot, for interpolation
  // between prev and curr.
  alpha(nowMs = performance.now()): number {
    const span = Math.max(TIC_MS, this.curr.time - this.prev.time);
    return Math.min(1, Math.max(0, (nowMs - this.curr.time) / span));
  }

  get gameState(): number {
    return this.curr.info[INFO.GAMESTATE];
  }

  get inLevel(): boolean {
    return this.gameState === GameState.Level && this.curr.hasPlayer;
  }

  // ---- input -------------------------------------------------------------

  postKey(doomKey: number, pressed: boolean, typedChar = 0) {
    this.module._radix_post_key(pressed ? 1 : 0, doomKey, typedChar);
  }

  // Accumulates relative mouse motion; flushed as one ev_mouse per tick.
  addMouseMotion(dx: number, dy: number) {
    this.mouseDx += dx;
    this.mouseDy += dy;
  }

  // Bit mask: 1 = left (fire), 2 = right (strafe), 4 = middle (forward).
  setMouseButtons(mask: number) {
    this.mouseButtons = mask & 7;
  }

  private flushMouse() {
    const dx = Math.round(this.mouseDx);
    const dy = Math.round(this.mouseDy);
    if (dx !== 0 || dy !== 0 || this.mouseButtons !== this.lastPostedButtons) {
      this.module._radix_post_mouse(this.mouseButtons, dx, dy);
      this.lastPostedButtons = this.mouseButtons;
    }
    this.mouseDx -= dx;
    this.mouseDy -= dy;
  }

  // Freezes Doom's clock (DG_GetTicksMs) so no game time passes while the
  // host is busy (e.g. loading a level's splats); resuming continues from
  // where it stopped instead of catching up.
  setPaused(paused: boolean) {
    this.paused = paused;
    this.module._radix_set_paused(paused ? 1 : 0);
  }

  // ---- framebuffer -------------------------------------------------------

  // Copies the 0x00RRGGBB framebuffer into RGBA pixels. With `alphaFromMask`
  // the alpha comes from the overlay mask (1 where 2D drawing wrote the
  // pixel this frame, 0 in the 3D view), otherwise it is opaque.
  blitFramebuffer(target: ImageData | { data: Uint8ClampedArray | Uint8Array }, alphaFromMask = false) {
    const count = this.width * this.height;
    const src = this.module.HEAPU32.subarray(this.framebufferPtr >>> 2, (this.framebufferPtr >>> 2) + count);
    const dst = new Uint32Array(target.data.buffer, target.data.byteOffset, count);
    if (alphaFromMask) {
      const maskPtr = this.module._radix_overlay_mask_ptr();
      const mask = this.module.HEAPU8.subarray(maskPtr, maskPtr + count);
      for (let i = 0; i < count; i += 1) {
        const v = src[i];
        dst[i] = (mask[i] ? 0xff000000 : 0) | ((v & 0xff) << 16) | (v & 0xff00) | ((v >>> 16) & 0xff);
      }
    } else {
      for (let i = 0; i < count; i += 1) {
        const v = src[i];
        dst[i] = 0xff000000 | ((v & 0xff) << 16) | (v & 0xff00) | ((v >>> 16) & 0xff);
      }
    }
  }

  // ---- BSP ---------------------------------------------------------------

  pointInSector(x: number, y: number): number {
    return this.module._radix_point_in_sector(x | 0, y | 0);
  }

  pointInSubsector(x: number, y: number): number {
    return this.module._radix_point_in_subsector(x | 0, y | 0);
  }

  // Raw level arrays in the WASM heap. Pointers change on every level load.
  bspArrays(): Record<BspArrayName, BspArray> {
    this.module._radix_bsp_arrays(this.bspPtr);
    const words = this.module.HEAP32.subarray(this.bspPtr >>> 2, (this.bspPtr >>> 2) + BSP_ARRAY_NAMES.length * 3);
    const result = {} as Record<BspArrayName, BspArray>;
    BSP_ARRAY_NAMES.forEach((name, index) => {
      result[name] = { ptr: words[index * 3], count: words[index * 3 + 1], byteStride: words[index * 3 + 2] };
    });
    return result;
  }

  // ---- snapshots ---------------------------------------------------------

  private makeSnapshot(): SimSnapshot {
    return {
      time: 0,
      gametic: 0,
      info: new Int32Array(this.infoCount),
      hasPlayer: false,
      player: new Int32Array(this.playerCount),
      sectorCount: 0,
      sectors: new Int32Array(0),
      sideCount: 0,
      sides: new Int32Array(0),
      mobjCount: 0,
      mobjs: new Int32Array(0),
      visibleSubsectors: new Uint8Array(0),
    };
  }

  private ensureScratch(kind: "sector" | "side" | "mobj", count: number) {
    const stride = kind === "sector" ? this.sectorStride : kind === "side" ? this.sideStride : this.mobjStride;
    const capacity = kind === "sector" ? this.sectorCapacity : kind === "side" ? this.sideCapacity : this.mobjCapacity;
    if (count <= capacity) {
      return;
    }
    const newCapacity = Math.max(count, capacity * 2, 64);
    const ptr = this.module._malloc(newCapacity * stride * 4);
    if (kind === "sector") {
      if (this.sectorPtr) this.module._free(this.sectorPtr);
      this.sectorPtr = ptr;
      this.sectorCapacity = newCapacity;
    } else if (kind === "side") {
      if (this.sidePtr) this.module._free(this.sidePtr);
      this.sidePtr = ptr;
      this.sideCapacity = newCapacity;
    } else {
      if (this.mobjPtr) this.module._free(this.mobjPtr);
      this.mobjPtr = ptr;
      this.mobjCapacity = newCapacity;
    }
  }

  private snapshot(out: SimSnapshot, time: number) {
    const m = this.module;
    out.time = time;

    m._radix_level_info(this.infoPtr);
    out.info.set(m.HEAP32.subarray(this.infoPtr >>> 2, (this.infoPtr >>> 2) + this.infoCount));
    out.gametic = out.info[INFO.GAMETIC];

    const sectorsPtr = out.info[INFO.SECTORS_PTR];
    if (sectorsPtr !== this.lastSectorsPtr) {
      this.lastSectorsPtr = sectorsPtr;
      this.levelGeneration += 1;
    }

    out.hasPlayer = m._radix_snapshot_player(this.playerPtr) !== 0;
    out.player.set(m.HEAP32.subarray(this.playerPtr >>> 2, (this.playerPtr >>> 2) + this.playerCount));

    const numSectors = out.info[INFO.NUMSECTORS];
    this.ensureScratch("sector", numSectors);
    out.sectorCount = numSectors > 0 ? m._radix_snapshot_sectors(this.sectorPtr, numSectors) : 0;
    out.sectors = copyInts(m, out.sectors, this.sectorPtr, out.sectorCount * this.sectorStride);

    const numSides = out.info[INFO.NUMSIDES];
    this.ensureScratch("side", numSides);
    out.sideCount = numSides > 0 ? m._radix_snapshot_sides(this.sidePtr, numSides) : 0;
    out.sides = copyInts(m, out.sides, this.sidePtr, out.sideCount * this.sideStride);

    const numMobjs = m._radix_mobj_count();
    this.ensureScratch("mobj", numMobjs);
    out.mobjCount = numMobjs > 0 ? m._radix_snapshot_mobjs(this.mobjPtr, this.mobjCapacity) : 0;
    out.mobjs = copyInts(m, out.mobjs, this.mobjPtr, out.mobjCount * this.mobjStride);

    const visiblePtr = m._radix_visible_subsectors();
    const visibleCount = Math.min(m._radix_visible_subsectors_capacity(), out.info[INFO.NUMSUBSECTORS]);
    if (out.visibleSubsectors.length !== visibleCount) {
      out.visibleSubsectors = new Uint8Array(visibleCount);
    }
    if (visiblePtr && visibleCount > 0) {
      out.visibleSubsectors.set(m.HEAPU8.subarray(visiblePtr, visiblePtr + visibleCount));
    }
  }
}

// Copies `length` int32 values from the heap into `target`, reallocating it
// only when the size changes. Returns the (possibly new) target array.
function copyInts(module: DoomModule, target: Int32Array, ptr: number, length: number): Int32Array {
  if (target.length !== length) {
    target = new Int32Array(length);
  }
  if (length > 0) {
    target.set(module.HEAP32.subarray(ptr >>> 2, (ptr >>> 2) + length));
  }
  return target;
}

// Convenience accessors over a snapshot.

export function sectorFloor(snapshot: SimSnapshot, index: number) {
  return fixedToFloat(snapshot.sectors[index * SECTOR.STRIDE + SECTOR.FLOOR]);
}

export function sectorCeiling(snapshot: SimSnapshot, index: number) {
  return fixedToFloat(snapshot.sectors[index * SECTOR.STRIDE + SECTOR.CEILING]);
}

export function sectorLight(snapshot: SimSnapshot, index: number) {
  return snapshot.sectors[index * SECTOR.STRIDE + SECTOR.LIGHT];
}

// Indices of sectors whose floor or ceiling height differs between snapshots.
export function changedSectors(a: SimSnapshot, b: SimSnapshot): number[] {
  const result: number[] = [];
  const count = Math.min(a.sectorCount, b.sectorCount);
  for (let i = 0; i < count; i += 1) {
    const o = i * SECTOR.STRIDE;
    if (a.sectors[o + SECTOR.FLOOR] !== b.sectors[o + SECTOR.FLOOR] || a.sectors[o + SECTOR.CEILING] !== b.sectors[o + SECTOR.CEILING]) {
      result.push(i);
    }
  }
  return result;
}

export interface MobjView {
  id: number;
  x: number;
  y: number;
  z: number;
  angle: number;
  sprite: number;
  frame: number;
  fullbright: boolean;
  flags: number;
  type: number;
  health: number;
  sector: number;
  radius: number;
  height: number;
}

export function readMobj(snapshot: SimSnapshot, index: number, out: MobjView = {} as MobjView): MobjView {
  const o = index * MOBJ.STRIDE;
  const d = snapshot.mobjs;
  out.id = d[o + MOBJ.ID];
  out.x = fixedToFloat(d[o + MOBJ.X]);
  out.y = fixedToFloat(d[o + MOBJ.Y]);
  out.z = fixedToFloat(d[o + MOBJ.Z]);
  out.angle = angleToRadians(d[o + MOBJ.ANGLE]);
  out.sprite = d[o + MOBJ.SPRITE];
  out.frame = d[o + MOBJ.FRAME] & FF_FRAMEMASK;
  out.fullbright = (d[o + MOBJ.FRAME] & FF_FULLBRIGHT) !== 0;
  out.flags = d[o + MOBJ.FLAGS];
  out.type = d[o + MOBJ.TYPE];
  out.health = d[o + MOBJ.HEALTH];
  out.sector = d[o + MOBJ.SECTOR];
  out.radius = fixedToFloat(d[o + MOBJ.RADIUS]);
  out.height = fixedToFloat(d[o + MOBJ.HEIGHT]);
  return out;
}

// Vanilla sprite rotation selection (r_things.c): which of the 8 rotation
// frames to show for a thing facing `mobjAngle` seen from direction
// `viewAngle` (both radians, Doom convention).
export function spriteRotation(viewAngleToMobj: number, mobjAngle: number): number {
  const twoPi = Math.PI * 2;
  let rel = (viewAngleToMobj - mobjAngle + twoPi + (Math.PI / 8) * 9) % twoPi;
  if (rel < 0) rel += twoPi;
  return Math.floor(rel / (Math.PI / 4)) & 7;
}
