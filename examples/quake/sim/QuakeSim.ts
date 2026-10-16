// Host-side wrapper around quake.wasm (quakegeneric and its host interface).
//
// The simulation is stepped with radix_tick(1/72) at a fixed 72 Hz (WinQuake's
// frame cap). Time inside the engine is fully driven by these steps, so pausing
// is simply not ticking and the run is deterministic for a given input stream.
// After each update the exported state is copied into host-owned typed arrays
// (prev / curr) so a renderer can interpolate between ticks.
//
// Field layouts below mirror the enums of quake.wasm's host interface.

export const TICRATE = 72;
export const TIC_MS = 1000 / TICRATE;
export const TIC_DT = 1 / TICRATE;
// Doom-style catch-up cap when the host stalls.
export const MAX_TICKS_PER_UPDATE = 5;

const f32 = new Float32Array(1);
const i32 = new Int32Array(f32.buffer);

export function bitsToFloat(bits: number) {
  i32[0] = bits;
  return f32[0];
}

export const ClientState = {
  Dedicated: 0,
  Disconnected: 1,
  Connected: 2,
} as const;

export const KeyDest = {
  Game: 0,
  Console: 1,
  Message: 2,
  Menu: 3,
} as const;

export const SIGNONS = 4;

export const INFO = {
  STATE: 0,
  DEMOPLAYBACK: 1,
  KEY_DEST: 2,
  INTERMISSION: 3,
  PAUSED: 4,
  SIGNON: 5,
  TIME: 6,
  REALTIME: 7,
  LEVEL_GENERATION: 8,
  NUM_MODELS: 9,
  HAS_VIEW: 10,
  VIEWORG_X: 11,
  VIEWORG_Y: 12,
  VIEWORG_Z: 13,
  VIEWANGLE_PITCH: 14,
  VIEWANGLE_YAW: 15,
  VIEWANGLE_ROLL: 16,
  FOV: 17,
  VIEWENTITY: 18,
  HEALTH: 19,
  ARMOR: 20,
  AMMO: 21,
  ACTIVEWEAPON: 22,
  ITEMS: 23,
  CSHIFT: 24, // 4 x (r, g, b, percent)
  ENTITY_COUNT: 40,
  DLIGHT_COUNT: 41,
  PARTICLE_COUNT: 42,
  VIEWLEAF_CONTENTS: 43,
  MAXCLIENTS: 44,
  // scr_vrect: the 3D view inside the 320x240 frame (pixels)
  VIEW_X: 45,
  VIEW_Y: 46,
  VIEW_W: 47,
  VIEW_H: 48,
  COUNT: 49,
} as const;

export const ENT = {
  ID: 0,
  MODEL: 1,
  FRAME: 2,
  SUBFRAME: 3,
  SKIN: 4,
  COLORMAP: 5,
  EFFECTS: 6,
  FLAGS: 7,
  ORIGIN_X: 8,
  ORIGIN_Y: 9,
  ORIGIN_Z: 10,
  ANGLE_PITCH: 11,
  ANGLE_YAW: 12,
  ANGLE_ROLL: 13,
  AMBIENT: 14,
  SHADE: 15,
  STRIDE: 16,
} as const;

export const EntFlag = {
  VIEWMODEL: 1,
  STATIC: 2,
  TEMP: 4,
  BRUSH: 8,
  SPRITE: 16,
  ALIAS: 32,
  SELF: 64,
  STEP: 128,
} as const;

// entity_t.effects bits (server.h EF_*)
export const Effects = {
  BRIGHTFIELD: 1,
  MUZZLEFLASH: 2,
  BRIGHTLIGHT: 4,
  DIMLIGHT: 8,
} as const;

export const DLIGHT = {
  ORIGIN_X: 0,
  ORIGIN_Y: 1,
  ORIGIN_Z: 2,
  RADIUS: 3,
  KEY: 4,
  DIE: 5,
  STRIDE: 6,
} as const;

export const PARTICLE = {
  X: 0,
  Y: 1,
  Z: 2,
  COLOR: 3,
  STRIDE: 4,
} as const;

export const MAX_LIGHTSTYLES = 64;
// d_lightstylevalue for 'm' (the normal, unanimated level).
export const LIGHTSTYLE_NORMAL = 264;

// BSP leaf contents relevant for the view.
export const Contents = {
  EMPTY: -1,
  SOLID: -2,
  WATER: -3,
  SLIME: -4,
  LAVA: -5,
  SKY: -6,
} as const;

// The subset of the Emscripten module we use.
export interface QuakeModule {
  HEAP8: Int8Array;
  HEAPU8: Uint8Array;
  HEAP32: Int32Array;
  HEAPU32: Uint32Array;
  HEAPF32: Float32Array;
  FS: {
    mkdir(path: string): void;
    writeFile(path: string, data: Uint8Array): void;
    readFile(path: string, opts?: { encoding: "binary" }): Uint8Array;
    analyzePath(path: string): { exists: boolean };
    stat(path: string): { mtime: Date; size: number };
    readdir(path: string): string[];
  };
  _malloc(size: number): number;
  _free(ptr: number): void;
  stringToUTF8(str: string, ptr: number, maxBytes: number): void;
  lengthBytesUTF8(str: string): number;
  UTF8ToString(ptr: number): string;
  setValue(ptr: number, value: number, type: string): void;
  getValue(ptr: number, type: string): number;

  _radix_create(argc: number, argv: number, memoryMb: number): void;
  _radix_tick(dt: number): void;
  _radix_time(): number;
  _radix_framebuffer(): number;
  _radix_framebuffer_width(): number;
  _radix_framebuffer_height(): number;
  _radix_palette_ptr(): number;
  _radix_overlay_mask_ptr(): number;
  _radix_has_3d_view(): number;
  _radix_frame_rgba(out: number, alphaFromMask: number): void;
  _radix_post_key(key: number, down: number): void;
  _radix_post_mouse(dx: number, dy: number): void;
  _radix_command(text: number): void;
  _radix_info_count(): number;
  _radix_info(out: number): void;
  _radix_map_name(): number;
  _radix_model_names(out: number, max: number): number;
  _radix_entity_stride(): number;
  _radix_snapshot_entities(out: number, max: number): number;
  _radix_dlight_stride(): number;
  _radix_snapshot_dlights(out: number, max: number): number;
  _radix_lightstyle_count(): number;
  _radix_lightstyles(out: number): void;
  _radix_particle_stride(): number;
  _radix_snapshot_particles(out: number, max: number): number;
  _radix_point_in_leaf(x: number, y: number, z: number): number;
  _radix_light_point(x: number, y: number, z: number): number;
  _radix_audio_read?(out: number, maxSamples: number): number;
  _radix_audio_rate?(): number;
}

export interface QuakeModuleOptions {
  print?: (text: string) => void;
  printErr?: (text: string) => void;
  preRun?: Array<(module: QuakeModule) => void>;
  locateFile?: (path: string, prefix: string) => string;
}

export type CreateQuakeModule = (options?: QuakeModuleOptions) => Promise<QuakeModule>;

export interface SimSnapshot {
  // Wall-clock time (performance.now) when this snapshot was taken.
  time: number;
  // Number of ticks run so far.
  tick: number;
  info: Int32Array;
  // "maps/e1m1.bsp" or "" outside a level.
  mapName: string;
  // Model precache names, index = precache index (0 unused).
  modelNames: string[];
  entityCount: number;
  entities: Int32Array;
  dlightCount: number;
  dlights: Int32Array;
  lightstyles: Int32Array;
  particleCount: number;
  particles: Int32Array;
}

export interface QuakeSimOptions {
  // URL of prebuilt/quake.js (an ES module exporting the factory as default).
  moduleUrl: string;
  // Optional explicit URL of quake.wasm; defaults to next to moduleUrl.
  wasmUrl?: string;
  // pak0.pak bytes; mounted at /id1/pak0.pak.
  pak: Uint8Array;
  // Extra command line arguments, e.g. ["+map", "e1m1", "+skill", "2"].
  args?: string[];
  // Console commands run right after Host_Init (binds, +mlook, ...).
  commands?: string[];
  // Engine hunk size in MB.
  memoryMb?: number;
  // Called with the instantiated module before Quake starts.
  onModule?: (module: QuakeModule) => void;
  print?: (text: string) => void;
  printErr?: (text: string) => void;
}

export class QuakeSim {
  readonly module: QuakeModule;
  readonly width: number;
  readonly height: number;

  prev: SimSnapshot;
  curr: SimSnapshot;
  // Increments whenever the world model changes (level load).
  levelGeneration = 0;
  ticksRun = 0;
  paused = false;

  private readonly infoCount: number;
  private readonly infoPtr: number;
  private readonly entityStride: number;
  private readonly dlightStride: number;
  private readonly particleStride: number;
  private readonly lightstylePtr: number;
  private readonly namesPtr: number;
  private readonly namesCapacity = 16384;
  private readonly commandPtr: number;
  private readonly commandCapacity = 1024;
  private entityCapacity = 0;
  private entityPtr = 0;
  private dlightCapacity = 0;
  private dlightPtr = 0;
  private particleCapacity = 0;
  private particlePtr = 0;

  private lastLevelGeneration = -1;
  private lastModelNames: string[] = [];
  private lastTickTime = Number.NEGATIVE_INFINITY;
  private mouseDx = 0;
  private mouseDy = 0;

  private constructor(module: QuakeModule) {
    this.module = module;
    this.width = module._radix_framebuffer_width();
    this.height = module._radix_framebuffer_height();
    this.infoCount = module._radix_info_count();
    this.infoPtr = module._malloc(this.infoCount * 4);
    this.entityStride = module._radix_entity_stride();
    this.dlightStride = module._radix_dlight_stride();
    this.particleStride = module._radix_particle_stride();
    this.lightstylePtr = module._malloc(MAX_LIGHTSTYLES * 4);
    this.namesPtr = module._malloc(this.namesCapacity);
    this.commandPtr = module._malloc(this.commandCapacity);
    if (
      this.infoCount !== INFO.COUNT || this.entityStride !== ENT.STRIDE ||
      this.dlightStride !== DLIGHT.STRIDE || this.particleStride !== PARTICLE.STRIDE ||
      module._radix_lightstyle_count() !== MAX_LIGHTSTYLES
    ) {
      throw new Error("quake.wasm snapshot layout does not match QuakeSim.ts");
    }
    this.prev = this.makeSnapshot();
    this.curr = this.makeSnapshot();
    this.snapshot(this.curr, performance.now());
  }

  static async create(options: QuakeSimOptions): Promise<QuakeSim> {
    const factoryModule = (await import(/* @vite-ignore */ options.moduleUrl)) as { default: CreateQuakeModule };
    const wasmUrl = options.wasmUrl ?? new URL("quake.wasm", options.moduleUrl).href;

    const module = await factoryModule.default({
      print: options.print ?? (() => {}),
      printErr: options.printErr ?? ((text) => console.warn("[quake]", text)),
      locateFile: (path, prefix) => (path.endsWith(".wasm") ? wasmUrl : prefix + path),
      preRun: [
        (m) => {
          m.FS.mkdir("/id1");
          m.FS.writeFile("/id1/pak0.pak", options.pak);
        },
      ],
    });
    options.onModule?.(module);

    const argv = ["quake", ...(options.args ?? [])];
    const argPtrs = argv.map((arg) => {
      const length = module.lengthBytesUTF8(arg) + 1;
      const ptr = module._malloc(length);
      module.stringToUTF8(arg, ptr, length);
      return ptr;
    });
    const argvPtr = module._malloc(argPtrs.length * 4);
    argPtrs.forEach((ptr, index) => module.setValue(argvPtr + index * 4, ptr, "i32"));
    // Host_Init; argv must stay alive because Quake keeps com_argv pointing at it.
    module._radix_create(argv.length, argvPtr, options.memoryMb ?? 32);

    const sim = new QuakeSim(module);
    for (const command of options.commands ?? []) {
      sim.command(command);
    }
    return sim;
  }

  // Runs every tick that has become due since the previous call (at most
  // MAX_TICKS_PER_UPDATE) and refreshes the snapshots. Returns the number of
  // ticks run.
  update(nowMs = performance.now()): number {
    if (this.paused) {
      this.lastTickTime = nowMs;
      return 0;
    }
    if (this.lastTickTime === Number.NEGATIVE_INFINITY) {
      this.lastTickTime = nowMs - TIC_MS;
    }
    let ticks = 0;
    while (nowMs - this.lastTickTime >= TIC_MS && ticks < MAX_TICKS_PER_UPDATE) {
      this.flushMouse();
      this.module._radix_tick(TIC_DT);
      this.lastTickTime += TIC_MS;
      this.ticksRun += 1;
      ticks += 1;
    }
    if (nowMs - this.lastTickTime >= TIC_MS) {
      // Fell too far behind: drop the backlog instead of spiralling.
      this.lastTickTime = nowMs;
    }
    if (ticks > 0) {
      [this.prev, this.curr] = [this.curr, this.prev];
      this.snapshot(this.curr, nowMs);
    }
    return ticks;
  }

  // Steps exactly one tick regardless of wall time (headless tests).
  step(): void {
    this.flushMouse();
    this.module._radix_tick(TIC_DT);
    this.ticksRun += 1;
    [this.prev, this.curr] = [this.curr, this.prev];
    this.snapshot(this.curr, performance.now());
  }

  // When update() will next run a tick (performance.now() ms)
  get nextTickTime() {
    return this.lastTickTime + TIC_MS;
  }

  // Fraction of a tick elapsed since the current snapshot, for interpolation
  // between prev and curr.
  alpha(nowMs = performance.now()): number {
    const span = Math.max(TIC_MS, this.curr.time - this.prev.time);
    return Math.min(1, Math.max(0, (nowMs - this.curr.time) / span));
  }

  get inLevel(): boolean {
    const info = this.curr.info;
    return info[INFO.STATE] === ClientState.Connected && info[INFO.SIGNON] === SIGNONS && this.curr.mapName !== "";
  }

  // ---- input -------------------------------------------------------------

  postKey(key: number, pressed: boolean) {
    this.module._radix_post_key(key, pressed ? 1 : 0);
  }

  // Accumulates relative mouse motion; flushed before each tick.
  addMouseMotion(dx: number, dy: number) {
    this.mouseDx += dx;
    this.mouseDy += dy;
  }

  private flushMouse() {
    const dx = Math.round(this.mouseDx);
    const dy = Math.round(this.mouseDy);
    if (dx !== 0 || dy !== 0) {
      this.module._radix_post_mouse(dx, dy);
    }
    this.mouseDx -= dx;
    this.mouseDy -= dy;
  }

  // Queues a console command (executed by the next tick's Cbuf_Execute).
  command(text: string) {
    const length = this.module.lengthBytesUTF8(text) + 1;
    if (length > this.commandCapacity) {
      throw new Error("command too long");
    }
    this.module.stringToUTF8(text, this.commandPtr, length);
    this.module._radix_command(this.commandPtr);
  }

  // Paused = no ticks run; Quake's clock stands still (Sys_FloatTime is
  // driven by radix_tick), so nothing catches up on resume.
  setPaused(paused: boolean) {
    this.paused = paused;
  }

  // ---- framebuffer -------------------------------------------------------

  // Copies the paletted framebuffer into RGBA pixels. With `alphaFromMask`
  // the alpha is 255 where 2D drawing covers the frame and 0 in the 3D view.
  blitFramebuffer(target: ImageData | { data: Uint8ClampedArray | Uint8Array }, alphaFromMask = false) {
    const count = this.width * this.height;
    const scratch = this.module._malloc(count * 4);
    this.module._radix_frame_rgba(scratch, alphaFromMask ? 1 : 0);
    const dst = new Uint32Array(target.data.buffer, target.data.byteOffset, count);
    dst.set(this.module.HEAPU32.subarray(scratch >>> 2, (scratch >>> 2) + count));
    this.module._free(scratch);
  }

  // ---- world queries -----------------------------------------------------

  pointInLeaf(x: number, y: number, z: number): number {
    return this.module._radix_point_in_leaf(x, y, z);
  }

  lightPoint(x: number, y: number, z: number): number {
    return this.module._radix_light_point(x, y, z);
  }

  // ---- snapshots ---------------------------------------------------------

  private makeSnapshot(): SimSnapshot {
    return {
      time: 0,
      tick: 0,
      info: new Int32Array(this.infoCount),
      mapName: "",
      modelNames: [],
      entityCount: 0,
      entities: new Int32Array(0),
      dlightCount: 0,
      dlights: new Int32Array(0),
      lightstyles: new Int32Array(MAX_LIGHTSTYLES),
      particleCount: 0,
      particles: new Int32Array(0),
    };
  }

  private ensureScratch(kind: "entity" | "dlight" | "particle", count: number) {
    const stride = kind === "entity" ? this.entityStride : kind === "dlight" ? this.dlightStride : this.particleStride;
    const capacity = kind === "entity" ? this.entityCapacity : kind === "dlight" ? this.dlightCapacity : this.particleCapacity;
    if (count <= capacity) {
      return;
    }
    const newCapacity = Math.max(count, capacity * 2, 64);
    const ptr = this.module._malloc(newCapacity * stride * 4);
    if (kind === "entity") {
      if (this.entityPtr) this.module._free(this.entityPtr);
      this.entityPtr = ptr;
      this.entityCapacity = newCapacity;
    } else if (kind === "dlight") {
      if (this.dlightPtr) this.module._free(this.dlightPtr);
      this.dlightPtr = ptr;
      this.dlightCapacity = newCapacity;
    } else {
      if (this.particlePtr) this.module._free(this.particlePtr);
      this.particlePtr = ptr;
      this.particleCapacity = newCapacity;
    }
  }

  private snapshot(out: SimSnapshot, time: number) {
    const m = this.module;
    out.time = time;
    out.tick = this.ticksRun;

    m._radix_info(this.infoPtr);
    out.info.set(m.HEAP32.subarray(this.infoPtr >>> 2, (this.infoPtr >>> 2) + this.infoCount));

    const generation = out.info[INFO.LEVEL_GENERATION];
    out.mapName = m.UTF8ToString(m._radix_map_name());
    if (generation !== this.lastLevelGeneration) {
      this.lastLevelGeneration = generation;
      this.levelGeneration += 1;
      const used = m._radix_model_names(this.namesPtr, this.namesCapacity);
      const names: string[] = [""];
      let start = this.namesPtr;
      const end = this.namesPtr + used;
      while (start < end) {
        const name = m.UTF8ToString(start);
        names.push(name);
        start += m.lengthBytesUTF8(name) + 1;
      }
      this.lastModelNames = names;
    }
    out.modelNames = this.lastModelNames;

    const numEntities = out.info[INFO.ENTITY_COUNT];
    this.ensureScratch("entity", numEntities);
    out.entityCount = numEntities > 0 ? m._radix_snapshot_entities(this.entityPtr, this.entityCapacity) : 0;
    out.entities = copyInts(m, out.entities, this.entityPtr, out.entityCount * this.entityStride);

    const numDlights = out.info[INFO.DLIGHT_COUNT];
    this.ensureScratch("dlight", numDlights);
    out.dlightCount = numDlights > 0 ? m._radix_snapshot_dlights(this.dlightPtr, this.dlightCapacity) : 0;
    out.dlights = copyInts(m, out.dlights, this.dlightPtr, out.dlightCount * this.dlightStride);

    m._radix_lightstyles(this.lightstylePtr);
    out.lightstyles.set(m.HEAP32.subarray(this.lightstylePtr >>> 2, (this.lightstylePtr >>> 2) + MAX_LIGHTSTYLES));

    const numParticles = out.info[INFO.PARTICLE_COUNT];
    this.ensureScratch("particle", numParticles);
    out.particleCount = numParticles > 0 ? m._radix_snapshot_particles(this.particlePtr, this.particleCapacity) : 0;
    out.particles = copyInts(m, out.particles, this.particlePtr, out.particleCount * this.particleStride);
  }
}

// Copies `length` int32 values from the heap into `target`, reallocating it
// only when the size changes. Returns the (possibly new) target array.
function copyInts(module: QuakeModule, target: Int32Array, ptr: number, length: number): Int32Array {
  if (target.length !== length) {
    target = new Int32Array(length);
  }
  if (length > 0) {
    target.set(module.HEAP32.subarray(ptr >>> 2, (ptr >>> 2) + length));
  }
  return target;
}

// Convenience accessors over a snapshot.

export interface ViewState {
  x: number;
  y: number;
  z: number;
  pitch: number;
  yaw: number;
  roll: number;
  fov: number;
  hasView: boolean;
}

export function readView(snapshot: SimSnapshot, out: ViewState = {} as ViewState): ViewState {
  const d = snapshot.info;
  out.x = bitsToFloat(d[INFO.VIEWORG_X]);
  out.y = bitsToFloat(d[INFO.VIEWORG_Y]);
  out.z = bitsToFloat(d[INFO.VIEWORG_Z]);
  out.pitch = bitsToFloat(d[INFO.VIEWANGLE_PITCH]);
  out.yaw = bitsToFloat(d[INFO.VIEWANGLE_YAW]);
  out.roll = bitsToFloat(d[INFO.VIEWANGLE_ROLL]);
  out.fov = bitsToFloat(d[INFO.FOV]);
  out.hasView = d[INFO.HAS_VIEW] !== 0;
  return out;
}

export interface EntityView {
  id: number;
  model: number;
  frame: number;
  subframe: number;
  skin: number;
  colormap: number;
  effects: number;
  flags: number;
  x: number;
  y: number;
  z: number;
  pitch: number;
  yaw: number;
  roll: number;
  ambient: number;
  shade: number;
}

export function readEntity(snapshot: SimSnapshot, index: number, out: EntityView = {} as EntityView): EntityView {
  const o = index * ENT.STRIDE;
  const d = snapshot.entities;
  out.id = d[o + ENT.ID];
  out.model = d[o + ENT.MODEL];
  out.frame = d[o + ENT.FRAME];
  out.subframe = d[o + ENT.SUBFRAME];
  out.skin = d[o + ENT.SKIN];
  out.colormap = d[o + ENT.COLORMAP];
  out.effects = d[o + ENT.EFFECTS];
  out.flags = d[o + ENT.FLAGS];
  out.x = bitsToFloat(d[o + ENT.ORIGIN_X]);
  out.y = bitsToFloat(d[o + ENT.ORIGIN_Y]);
  out.z = bitsToFloat(d[o + ENT.ORIGIN_Z]);
  out.pitch = bitsToFloat(d[o + ENT.ANGLE_PITCH]);
  out.yaw = bitsToFloat(d[o + ENT.ANGLE_YAW]);
  out.roll = bitsToFloat(d[o + ENT.ANGLE_ROLL]);
  out.ambient = d[o + ENT.AMBIENT];
  out.shade = d[o + ENT.SHADE];
  return out;
}

export interface DlightView {
  x: number;
  y: number;
  z: number;
  radius: number;
  key: number;
  die: number;
}

export function readDlight(snapshot: SimSnapshot, index: number, out: DlightView = {} as DlightView): DlightView {
  const o = index * DLIGHT.STRIDE;
  const d = snapshot.dlights;
  out.x = bitsToFloat(d[o + DLIGHT.ORIGIN_X]);
  out.y = bitsToFloat(d[o + DLIGHT.ORIGIN_Y]);
  out.z = bitsToFloat(d[o + DLIGHT.ORIGIN_Z]);
  out.radius = bitsToFloat(d[o + DLIGHT.RADIUS]);
  out.key = d[o + DLIGHT.KEY];
  out.die = bitsToFloat(d[o + DLIGHT.DIE]);
  return out;
}

// Blend color the software renderer applies to the whole screen
// (V_UpdatePalette's cshift chain), as [r, g, b, alpha] in 0..1.
export function readBlend(snapshot: SimSnapshot): [number, number, number, number] {
  const d = snapshot.info;
  let r = 0, g = 0, b = 0, a = 0;
  for (let i = 0; i < 4; i += 1) {
    const percent = d[INFO.CSHIFT + i * 4 + 3];
    if (percent <= 0) continue;
    const a2 = Math.min(1, percent / 255);
    const dr = d[INFO.CSHIFT + i * 4], dg = d[INFO.CSHIFT + i * 4 + 1], db = d[INFO.CSHIFT + i * 4 + 2];
    // Composite the shifts in order like the palette pass does.
    const total = a + a2 * (1 - a);
    if (total > 0) {
      r = (r * a * (1 - a2) + dr / 255 * a2) / total;
      g = (g * a * (1 - a2) + dg / 255 * a2) / total;
      b = (b * a * (1 - a2) + db / 255 * a2) / total;
    }
    a = total;
  }
  return [r, g, b, a];
}

// Map id ("e1m1") from a world model name ("maps/e1m1.bsp").
export function mapIdFromModelName(name: string): string {
  const match = /^maps\/(.+)\.bsp$/i.exec(name);
  return match ? match[1].toLowerCase() : "";
}
