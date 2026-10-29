// One map's world (the hosted scene.json): every
// object's splats on the GPU (extSplats; its LoD tree in the LodSelector's
// worker), drawn through the lighting's world generator with the index
// list the selector picked. Brush models (doors, platforms) move with their
// entities (matrices only), animated textures show one frame at a time,
// submodels only while an entity references them.
//
// Residency: each LoD node costs 32 bytes on the GPU (a Quake map has 18-47M
// nodes, 0.6-1.5 GB). With `residentNodes` below a map's total (the WebGL2
// default), only the objects nearest the camera within that many nodes stay
// on the GPU: the rest are not selected or drawn, and are fetched again when
// the camera comes near (residency()), farther ones freed once no
// collection draws them.
import * as THREE from "three";
import type { WebGPURenderer } from "three/webgpu";
import { GpuArrays, SplatCollection, loadSplats, type AnySplatObject } from "@sparkjsdev/radix";
import { fetchData } from "./data.js";
import type { LodObject, LodSelector } from "./lod/LodSelector.js";
import type { LightMode, QuakeLighting, SurfaceEffect, SurfaceLight } from "./lighting.js";
import { EntFlag, readEntity, type EntityView, type SimSnapshot } from "./sim/QuakeSim.js";

export interface SceneObject {
  id: string;
  kind: "chunk" | "styles" | "anim" | "liquid" | "bmodel" | "sky";
  mode: LightMode;
  file: string;
  count: number;
  lodCount: number;
  bytes: number;
  bounds: { min: [number, number, number]; max: [number, number, number] };
  matrixWorld: number[];
  styles?: [number, number];
  // Inline submodel (entity model "*n") this object is part of
  submodel?: number;
  // Frame `index` of `total` of a texture's base (+0..) or alternate (+a..)
  // sequence
  anim?: { base: string; index: number; total: number; alternate: boolean; hasAlternate: boolean };
  liquid?: { texture: string; width: number; height: number };
}

export interface SceneFile {
  game: string;
  map: string;
  title: string;
  unitsPerMeter: number;
  skyRadius: number;
  skyRgba?: string;
  player: { position: [number, number, number]; yaw: number };
  lightLut: number[];
  objects: SceneObject[];
  // models.json relative to this file
  models: string;
  // Attract demo -> map id
  demos: Record<string, string>;
}

export class WorldObject {
  readonly info: SceneObject;
  readonly url: string;
  readonly light: SurfaceLight;
  readonly bounds: THREE.Box3;
  lod!: LodObject;
  splats?: GpuArrays;
  loading = false;
  // Animated texture frame and submodel presence, from the game
  shown = true;
  present = true;
  // Collection objects holding the splats, and whether to free them at 0
  drawn = 0;
  evicted = false;

  constructor(info: SceneObject, url: string) {
    this.info = info;
    this.url = url;
    const effect: SurfaceEffect = info.kind === "sky" ? "sky" : info.liquid ? "liquid" : "none";
    this.light = { mode: info.mode, styles: info.styles ?? [0, -1], effect, matrixWorld: new THREE.Matrix4().fromArray(info.matrixWorld) };
    this.bounds = new THREE.Box3(new THREE.Vector3().fromArray(info.bounds.min), new THREE.Vector3().fromArray(info.bounds.max));
  }

  get matrixWorld() {
    return this.light.matrixWorld;
  }
}

interface BrushState { x: number; y: number; z: number; frame: number }

export class World {
  readonly file: SceneFile;
  readonly url: string;
  readonly objects: WorldObject[];
  readonly residentNodes: number;
  loadMs = 0;
  private readonly renderer: WebGPURenderer;
  private readonly selector: LodSelector;
  private readonly lighting: QuakeLighting;
  private readonly brushCurr = new Map<number, BrushState>();
  private readonly brushPrev = new Map<number, BrushState>();
  private brushTick = -1;
  private residencyAt = new THREE.Vector3(Infinity, 0, 0);
  private disposed = false;

  private constructor(url: string, file: SceneFile, renderer: WebGPURenderer, selector: LodSelector, lighting: QuakeLighting, residentNodes: number) {
    this.url = url;
    this.file = file;
    this.renderer = renderer;
    this.selector = selector;
    this.lighting = lighting;
    this.residentNodes = residentNodes;
    this.objects = file.objects.map((info) => new WorldObject(info, new URL(info.file, url).href));
  }

  // scene.json and every object; trees go to the selector, splats to the
  // GPU nearest `from` first while they fit in `residentNodes`
  static async load(url: string, { renderer, selector, lighting, residentNodes, onProgress }: {
    renderer: WebGPURenderer; selector: LodSelector; lighting: QuakeLighting; residentNodes: number; onProgress?: (loaded: number, total: number) => void;
  }): Promise<World> {
    const start = performance.now();
    const file = await (await fetchData(url)).json() as SceneFile;
    if (file.game !== "quake") {
      throw new Error(`${url} is not a Quake scene.json`);
    }
    const world = new World(url, file, renderer, selector, lighting, residentNodes);
    const from = new THREE.Vector3().fromArray(file.player.position);
    const queue = world.byDistance(from);
    let budget = residentNodes;
    const resident = new Set(queue.filter((object) => (budget -= object.info.lodCount) >= 0 || object.info.kind === "sky"));
    let loaded = 0;
    const loadOne = async () => {
      for (let object = queue.shift(); object; object = queue.shift()) {
        const data = await loadSplats(object.url);
        if (resident.has(object)) {
          object.splats = GpuArrays.fromData(renderer, data, { bundles: ["extSplats"] });
        }
        // add() hands the data's arrays to the worker: upload first
        object.lod = selector.add({ data, matrixWorld: object.matrixWorld });
        object.lod.visible = resident.has(object);
        onProgress?.((loaded += 1), world.objects.length);
      }
    };
    await Promise.all(Array.from({ length: 8 }, loadOne));
    world.loadMs = performance.now() - start;
    return world;
  }

  get nodes() {
    return this.objects.reduce((sum, object) => sum + object.info.lodCount, 0);
  }

  get resident() {
    return this.objects.reduce((sum, object) => sum + (object.splats ? object.info.lodCount : 0), 0);
  }

  get limited() {
    return this.residentNodes < this.nodes;
  }

  private byDistance(point: THREE.Vector3) {
    return [...this.objects].sort((a, b) => a.bounds.distanceToPoint(point) - b.bounds.distanceToPoint(point));
  }

  // Under a residency limit: after the camera moved 4 m, keeps the nearest
  // objects that fit resident, fetching what came in reach and freeing what
  // left it (once no collection draws it)
  residency(camera: THREE.Camera) {
    const position = camera.getWorldPosition(new THREE.Vector3());
    if (!this.limited || position.distanceTo(this.residencyAt) < 4) {
      return;
    }
    this.residencyAt.copy(position);
    let budget = this.residentNodes;
    for (const object of this.byDistance(position)) {
      const keep = (budget -= object.info.lodCount) >= 0 || object.info.kind === "sky";
      if (keep && object.evicted) {
        object.evicted = false;
        object.lod.visible = object.present;
      } else if (keep && !object.splats && !object.loading) {
        object.loading = true;
        void loadSplats(object.url).then((data) => {
          object.loading = false;
          if (!this.disposed && !object.evicted) {
            object.splats = GpuArrays.fromData(this.renderer, data, { bundles: ["extSplats"] });
            object.lod.visible = object.present;
          }
        });
      } else if (!keep && object.splats && !object.evicted) {
        object.evicted = true;
        object.lod.visible = false;
        this.free(object);
      }
    }
  }

  private free(object: WorldObject) {
    if (object.evicted && object.drawn === 0) {
      object.splats?.dispose();
      object.splats = undefined;
      object.evicted = false;
    }
  }

  // Brush models at their entities (interpolated between ticks; id1's brush
  // entities only translate), animated texture frames (R_TextureAnimation:
  // 10 Hz, the alternate sequence while the entity's frame is nonzero) and
  // submodel presence; whether what is drawn changed
  update(game: { inLevel: boolean; time: number; prev: SimSnapshot; curr: SimSnapshot } | undefined, alpha: number): boolean {
    const inLevel = !!game?.inLevel;
    if (game && inLevel && game.curr.tick !== this.brushTick) {
      this.brushTick = game.curr.tick;
      readBrushes(game.prev, this.brushPrev);
      readBrushes(game.curr, this.brushCurr);
    }
    const s = 1 / this.file.unitsPerMeter;
    const animFrame = Math.floor((inLevel ? game!.time : performance.now() / 1000) * 10);
    let changed = false;
    for (const object of this.objects) {
      const { info } = object;
      const brush = info.submodel !== undefined && inLevel ? this.brushCurr.get(info.submodel) : undefined;
      const present = info.submodel === undefined || !inLevel || brush !== undefined;
      let shown = true;
      if (info.anim) {
        const alternate = (brush?.frame ?? 0) !== 0 && info.anim.hasAlternate;
        shown = info.anim.alternate === alternate && animFrame % info.anim.total === info.anim.index;
      }
      if (shown !== object.shown || present !== object.present) {
        changed = true;
        object.shown = shown;
        object.present = present;
        if (object.lod) {
          object.lod.visible = present && !!object.splats && !object.evicted;
        }
      }
      if (brush) {
        const from = this.brushPrev.get(info.submodel!) ?? brush;
        const x = from.x + (brush.x - from.x) * alpha;
        const y = from.y + (brush.y - from.y) * alpha;
        const z = from.z + (brush.z - from.z) * alpha;
        object.matrixWorld.fromArray(info.matrixWorld);
        object.matrixWorld.setPosition(info.matrixWorld[12] + x * s, info.matrixWorld[13] + z * s, info.matrixWorld[14] - y * s);
      }
    }
    return changed;
  }

  // The objects to draw now: shown, present and resident, with a selection
  splatObjects(): AnySplatObject[] {
    const generator = this.lighting.generator;
    return this.objects.flatMap((object): AnySplatObject[] => {
      if (!object.splats || object.evicted || !object.shown || !object.present || !object.lod) {
        return [];
      }
      const made = this.selector.splatObject(object.lod, (list) => {
        object.drawn += 1;
        return SplatCollection.object({
          generator, data: { source: object, indices: list.indices }, count: list.count, matrixWorld: object.matrixWorld,
          release: () => {
            object.drawn -= 1;
            this.free(object);
          },
        });
      });
      return made ? [made] : [];
    });
  }

  // Off the selector; the splats are freed as their objects are released
  dispose() {
    this.disposed = true;
    for (const object of this.objects) {
      if (object.lod) {
        this.selector.remove(object.lod);
      }
      object.evicted = true;
      this.free(object);
    }
  }
}

const entityScratch = {} as EntityView;

function readBrushes(snapshot: SimSnapshot, into: Map<number, BrushState>) {
  into.clear();
  for (let i = 0; i < snapshot.entityCount; i += 1) {
    const e = readEntity(snapshot, i, entityScratch);
    const name = snapshot.modelNames[e.model];
    if (e.flags & EntFlag.BRUSH && name?.[0] === "*") {
      into.set(Number(name.slice(1)), { x: e.x, y: e.y, z: e.z, frame: e.frame });
    }
  }
}
