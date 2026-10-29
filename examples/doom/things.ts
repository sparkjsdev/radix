// Things (monsters, items, decorations, missiles) over the sprite atlas
// (sprites/sprites.rdx: every view of every sprite frame in the WAD, one
// after another; sprites.json says where each view starts).
//
// Every world thing is drawn by one object of lighting.batch (one
// projection dispatch, however many things): each thing has a slot in a
// table of poses and lights uploaded every frame, and the object's index
// list holds, per splat, the atlas splat and the slot. A view change or a
// thing coming or going makes a new list (a new collection); moves and
// light only change the table (the page asks the CPU sort to re-sort). A
// slot is reused only once no list made before it was freed is drawn, so
// an order that lags (the CPU sort) never shows a list over a table whose
// slots changed owner. The weapon's two sprites are SpriteObjects: one
// object of lighting.things each (a range of the atlas).
//
// In sim mode things mirror the mobjs the sim exports each tic,
// interpolated between the previous and current snapshot; without the sim
// they are the spawn placements in scene.json.
import * as THREE from "three";
import type { WebGPURenderer } from "three/webgpu";
import { ArrayData, GpuArrays, SplatCollection, SplatGenerator, loadSplats, type AnySplatObject } from "@sparkjsdev/radix";
import { fetchData } from "./data.js";
import { FLAG_FULLBRIGHT, FLAG_FUZZ, MAX_SLOTS, SLOT_SHIFT, THING_TABLE, type DoomLighting, type ThingLight } from "./lighting.js";
import { FF_FRAMEMASK, FF_FULLBRIGHT, MOBJ, PLAYER, type SimSnapshot } from "./sim/DoomSim.js";

// Sprite plane orientation (] key, GUI "Sprites"): true faces the direction
// the current rotation view was drawn from (turns with the thing, snaps with
// the view); false is a classic billboard facing the camera
export const spriteOptions = { idealFacing: true };

export interface AtlasView {
  id: string;
  offset: number;
  count: number;
  width: number;
  height: number;
  lift: number;
}

interface SpriteAtlasFile {
  file: string;
  unitsPerMeter: number;
  spriteNames: string[];
  views: AtlasView[];
  // sprite -> frame index -> 8 view ids (null: frame missing)
  frames: Record<string, (string[] | null)[]>;
}

// Static placement from scene.json (things[])
export interface SceneThing {
  name: string;
  sprite: string;
  frame: number;
  views: string[];
  position: [number, number, number];
  angle: number;
  sector: number;
  fullbright: boolean;
}

const MF_NOSECTOR = 8;
const MF_SHADOW = 0x40000;
// Teleports and spawns move further than this per tic: not interpolated
const SNAP_DISTANCE = 128;

export class SpriteAtlas {
  readonly splats: GpuArrays;
  readonly info: SpriteAtlasFile;
  private readonly views = new Map<string, AtlasView>();

  private constructor(info: SpriteAtlasFile, splats: GpuArrays) {
    this.info = info;
    this.splats = splats;
    for (const view of info.views) {
      this.views.set(view.id, view);
    }
  }

  static async load(url: string, renderer: WebGPURenderer) {
    const info = await (await fetchData(url)).json() as SpriteAtlasFile;
    const data = await loadSplats(new URL(info.file, url).href);
    if (data.count > 1 << SLOT_SHIFT) {
      throw new Error(`The sprite atlas has ${data.count} splats, more than the ${1 << SLOT_SHIFT} a thing list can address`);
    }
    return new SpriteAtlas(info, GpuArrays.fromData(renderer, data, { bundles: ["extSplats"] }));
  }

  get spriteNames() {
    return this.info.spriteNames;
  }

  viewById(id: string) {
    return this.views.get(id);
  }

  // View of `sprite` at frame index (0 = A) seen from rotation 0..7
  view(sprite: string, frame: number, rotation: number) {
    const ids = this.info.frames[sprite]?.[frame];
    return ids ? this.views.get(ids[rotation & 7]) : undefined;
  }

  hasFrame(sprite: string, frame: number) {
    return !!this.info.frames[sprite]?.[frame];
  }
}

// One view of the atlas at a pose, lit by its state: an object of
// lighting.things (the weapon's sprites)
export class SpriteObject {
  readonly matrix = new THREE.Matrix4();
  readonly light: ThingLight = { light: 255, depth: 0, fullbright: false, fuzz: false };
  view?: AtlasView;
  readonly lighting: DoomLighting;
  readonly atlas: SpriteAtlas;
  private made?: { view: AtlasView; matrixWorld: THREE.Matrix4; object: AnySplatObject };

  constructor(lighting: DoomLighting, atlas: SpriteAtlas) {
    this.lighting = lighting;
    this.atlas = atlas;
  }

  // The splat object of the current view at `matrixWorld` (made once for
  // each), or undefined without a view
  object(matrixWorld: THREE.Matrix4 = this.matrix): AnySplatObject | undefined {
    const view = this.view;
    if (!view) {
      return undefined;
    }
    if (this.made?.view !== view || this.made.matrixWorld !== matrixWorld) {
      this.made = {
        view,
        matrixWorld,
        object: SplatCollection.object({ generator: this.lighting.things, data: { atlas: this.atlas.splats, offset: view.offset, state: this.light }, count: view.count, matrixWorld }),
      };
    }
    return this.made.object;
  }
}

interface Thing {
  slot: number;
  view?: AtlasView;
  // Three.js position of the feet and Doom angle (radians, 0 = east)
  position: THREE.Vector3;
  angle: number;
  sector: number;
  spriteIndex: number;
  frame: number;
  fullbright: boolean;
  fuzz: boolean;
  seen: boolean;
  prev: { x: number; y: number; z: number; angle: number };
  curr: { x: number; y: number; z: number; angle: number };
}

// A table of slots and the lists made over it (one per level)
class Batch {
  readonly table: GpuArrays;
  readonly data = new ArrayData({ count: MAX_SLOTS }).addBundle("table", THING_TABLE);
  slots = 0;
  // Lists made (their serials) and not yet released; freed slots with the
  // serial of the last list made when they were freed
  serial = 0;
  readonly live = new Set<number>();
  readonly freed: { slot: number; serial: number }[] = [];
  retired = false;

  constructor(renderer: WebGPURenderer) {
    this.table = new GpuArrays({ renderer, bundles: { table: THING_TABLE }, capacity: MAX_SLOTS });
  }

  allocate(): number {
    let oldest = Infinity;
    for (const serial of this.live) {
      oldest = Math.min(oldest, serial);
    }
    const i = this.freed.findIndex((f) => f.serial < oldest);
    if (i >= 0) {
      return this.freed.splice(i, 1)[0].slot;
    }
    return this.slots < MAX_SLOTS ? this.slots++ : -1;
  }

  free(slot: number) {
    this.freed.push({ slot, serial: this.serial });
  }

  released(serial: number) {
    this.live.delete(serial);
    if (this.retired && this.live.size === 0) {
      this.table.dispose();
    }
  }
}

export class ThingManager {
  readonly atlas: SpriteAtlas;
  // Whether a pose changed in the last updateViews (the CPU sort cannot see it)
  moved = false;
  private readonly renderer: WebGPURenderer;
  private readonly lighting: DoomLighting;
  private readonly unitsPerMeter: number;
  private batch: Batch;
  private things = new Map<number, Thing>();
  private readonly prevIndex = new Map<number, number>();
  private lastGametic = -1;
  private readonly warned = new Set<string>();
  // Bumped when a view changes or a thing comes or goes: a new list
  private version = 0;
  private made?: { version: number; object?: AnySplatObject };
  private readonly pool: GpuArrays[] = [];

  constructor(atlas: SpriteAtlas, lighting: DoomLighting, renderer: WebGPURenderer) {
    this.atlas = atlas;
    this.lighting = lighting;
    this.renderer = renderer;
    this.unitsPerMeter = atlas.info.unitsPerMeter;
    this.batch = new Batch(renderer);
  }

  get count() {
    return this.things.size;
  }

  private add(key: number): Thing | undefined {
    const slot = this.batch.allocate();
    if (slot < 0) {
      this.warnOnce(`More than ${MAX_SLOTS} things: some are not drawn`);
      return undefined;
    }
    const thing: Thing = {
      slot,
      position: new THREE.Vector3(),
      angle: 0,
      sector: -1,
      spriteIndex: -1,
      frame: -1,
      fullbright: false,
      fuzz: false,
      seen: false,
      prev: { x: 0, y: 0, z: 0, angle: 0 },
      curr: { x: 0, y: 0, z: 0, angle: 0 },
    };
    this.things.set(key, thing);
    this.version += 1;
    return thing;
  }

  // A new level: a new table (the old one goes once no list over it is drawn)
  clear() {
    this.batch.retired = true;
    if (this.batch.live.size === 0) {
      this.batch.table.dispose();
    }
    this.batch = new Batch(this.renderer);
    this.things = new Map();
    this.lastGametic = -1;
    this.version += 1;
  }

  // Spawn placements from scene.json (no sim)
  setStatic(placements: SceneThing[]) {
    this.clear();
    placements.forEach((info, i) => {
      if (info.views.some((id) => !this.atlas.viewById(id))) {
        this.warnOnce(`Thing ${info.name}: missing sprite view ${info.views.join(",")}`);
        return;
      }
      const thing = this.add(i);
      if (thing) {
        thing.position.fromArray(info.position);
        thing.angle = info.angle;
        thing.sector = info.sector;
        thing.fullbright = info.fullbright;
        thing.spriteIndex = this.atlas.spriteNames.indexOf(info.sprite);
        thing.frame = info.frame;
      }
    });
  }

  // Mirror the sim's mobjs: state is re-read once per new tic, positions
  // interpolated every frame
  updateFromSim(prev: SimSnapshot, curr: SimSnapshot, alpha: number) {
    if (curr.gametic !== this.lastGametic) {
      this.lastGametic = curr.gametic;
      this.readTic(prev, curr);
    }
    const s = 1 / this.unitsPerMeter;
    for (const thing of this.things.values()) {
      const { prev: a, curr: b } = thing;
      thing.position.set((a.x + (b.x - a.x) * alpha) * s, (a.z + (b.z - a.z) * alpha) * s, -(a.y + (b.y - a.y) * alpha) * s);
      thing.angle = lerpAngle(a.angle, b.angle, alpha);
    }
  }

  private readTic(prev: SimSnapshot, curr: SimSnapshot) {
    const playerMo = curr.hasPlayer ? curr.player[PLAYER.MO_PTR] : 0;
    for (const thing of this.things.values()) {
      thing.seen = false;
    }
    const d = curr.mobjs;
    const sameLevel = prev.gametic > 0 && curr.gametic - prev.gametic <= 5;
    // Previous state from the previous snapshot (not this thing's last
    // read): with two tics in one frame the camera lerps from the snapshot
    // before this one, and so must every thing
    const prevIndex = this.prevIndex;
    prevIndex.clear();
    if (sameLevel) {
      for (let i = 0; i < prev.mobjCount; i += 1) {
        prevIndex.set(prev.mobjs[i * MOBJ.STRIDE + MOBJ.ID], i * MOBJ.STRIDE);
      }
    }
    for (let i = 0; i < curr.mobjCount; i += 1) {
      const o = i * MOBJ.STRIDE;
      const id = d[o + MOBJ.ID];
      const flags = d[o + MOBJ.FLAGS];
      if (id === playerMo || (flags & MF_NOSECTOR) !== 0) {
        continue;
      }
      const sprite = d[o + MOBJ.SPRITE];
      const rawFrame = d[o + MOBJ.FRAME];
      const frame = rawFrame & FF_FRAMEMASK;
      const name = this.atlas.spriteNames[sprite];
      if (!name || !this.atlas.hasFrame(name, frame)) {
        this.warnOnce(`No sprite view for ${name ?? sprite} frame ${frame}`);
        continue;
      }
      const known = this.things.get(id);
      const thing = known ?? this.add(id);
      if (!thing) {
        continue;
      }
      thing.seen = true;
      thing.spriteIndex = sprite;
      thing.frame = frame;
      thing.fullbright = (rawFrame & FF_FULLBRIGHT) !== 0;
      thing.fuzz = (flags & MF_SHADOW) !== 0;
      thing.sector = d[o + MOBJ.SECTOR];
      const c = thing.curr;
      c.x = d[o + MOBJ.X] / 65536;
      c.y = d[o + MOBJ.Y] / 65536;
      c.z = d[o + MOBJ.Z] / 65536;
      c.angle = ((d[o + MOBJ.ANGLE] >>> 0) / 4294967296) * Math.PI * 2;
      const po = prevIndex.get(id);
      if (po !== undefined) {
        const p = prev.mobjs;
        thing.prev.x = p[po + MOBJ.X] / 65536;
        thing.prev.y = p[po + MOBJ.Y] / 65536;
        thing.prev.z = p[po + MOBJ.Z] / 65536;
        thing.prev.angle = ((p[po + MOBJ.ANGLE] >>> 0) / 4294967296) * Math.PI * 2;
      } else {
        Object.assign(thing.prev, c);
      }
      if (!known || !sameLevel || Math.hypot(c.x - thing.prev.x, c.y - thing.prev.y) > SNAP_DISTANCE) {
        Object.assign(thing.prev, c);
      }
    }
    for (const [id, thing] of this.things) {
      if (!thing.seen) {
        this.things.delete(id);
        this.batch.free(thing.slot);
        this.version += 1;
      }
    }
  }

  // Per frame: the rotation view the camera angle asks for (r_things.c
  // R_ProjectSprite: (angle to thing - thing angle + ANG45/2*9) >> 29), the
  // plane's yaw (at the camera, or toward where that view was drawn from,
  // thing angle + rotation * 45 degrees) and the light, into the table
  updateViews(eye: THREE.Vector3) {
    const { idealFacing } = spriteOptions;
    const { pose, light } = this.batch.data.bundles.table.channels;
    this.moved = false;
    for (const thing of this.things.values()) {
      const { position } = thing;
      const toThing = Math.atan2(-(position.z - eye.z), position.x - eye.x);
      const relative = (((toThing - thing.angle + (Math.PI / 8) * 9) % TWO_PI) + TWO_PI) % TWO_PI;
      const rotation = Math.floor(relative / (Math.PI / 4)) & 7;
      let yaw;
      if (idealFacing) {
        const d = thing.angle + rotation * (Math.PI / 4);
        yaw = Math.atan2(Math.cos(d), -Math.sin(d));
      } else {
        yaw = Math.atan2(eye.x - position.x, eye.z - position.z);
      }
      const name = this.atlas.spriteNames[thing.spriteIndex];
      const view = name ? this.atlas.view(name, thing.frame, rotation) : undefined;
      if (view !== thing.view) {
        thing.view = view;
        this.version += 1;
      }
      const at = thing.slot * 4;
      const p = pose.data;
      const was = [p[at], p[at + 1], p[at + 2], p[at + 3]];
      p.set([position.x, position.y, position.z, yaw], at);
      this.moved ||= was.some((value, i) => value !== p[at + i]);
      light.data.set([this.lighting.lightOf(thing.sector), this.lighting.depthOf(position), (thing.fullbright ? FLAG_FULLBRIGHT : 0) | (thing.fuzz ? FLAG_FUZZ : 0), 0], at);
    }
    if (this.batch.slots > 0) {
      this.batch.table.upload(this.batch.data, { count: this.batch.slots });
    }
  }

  // The things' object: made again when a view changes or a thing comes or goes
  objects(): AnySplatObject[] {
    if (this.made?.version !== this.version) {
      this.made = { version: this.version, object: this.makeObject() };
    }
    return this.made.object ? [this.made.object] : [];
  }

  private makeObject(): AnySplatObject | undefined {
    let count = 0;
    for (const { view } of this.things.values()) {
      count += view?.count ?? 0;
    }
    if (count === 0) {
      return undefined;
    }
    const entries = new Uint32Array(count);
    let n = 0;
    for (const { view, slot } of this.things.values()) {
      for (let k = 0; view && k < view.count; k += 1) {
        entries[n++] = ((view.offset + k) | (slot << SLOT_SHIFT)) >>> 0;
      }
    }
    const batch = this.batch;
    const serial = (batch.serial += 1);
    batch.live.add(serial);
    const list = SplatGenerator.indices(this.renderer, entries, this.pool.pop());
    return SplatCollection.object({
      generator: this.lighting.batch,
      data: { atlas: this.atlas.splats, list, table: batch.table },
      count,
      release: () => {
        this.pool.push(list);
        batch.released(serial);
      },
    });
  }

  private warnOnce(message: string) {
    if (!this.warned.has(message)) {
      this.warned.add(message);
      console.warn(message);
    }
  }
}

const TWO_PI = Math.PI * 2;

function lerpAngle(a: number, b: number, t: number) {
  let delta = (b - a) % TWO_PI;
  if (delta > Math.PI) delta -= TWO_PI;
  if (delta < -Math.PI) delta += TWO_PI;
  return a + delta * t;
}
