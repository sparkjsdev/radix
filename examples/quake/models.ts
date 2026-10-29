// The hosted model atlas (every .mdl / .spr / b_*.bsp as splats) and the
// generator that draws one entity from it.
//
// models.rdx holds the splats of every model (extSplats) and, per alias
// model splat, its triangle's three vertex indices (bundle mdlBind); an
// entity draws one model, or one sprite view, as a range of the atlas.
// frames.rdx (bundle mdlFrames) holds the quantized vertices of every pose
// (trivertx: x, y, z, lightnormalindex). Per alias model splat the
// generator reads its triangle in the reference pose and in the two poses
// being blended, builds the affine map between the two triangles (edges plus
// a scaled normal) and pushes the splat's center and covariance through it,
// so the skin deforms with the mesh (MdlDeform). It lights the model like
// R_AliasSetupLighting (ambient + shade * facing, through the colormap LUT),
// ammo boxes like world faces, and leaves sprites unlit.
import * as THREE from "three";
import type { WebGPURenderer } from "three/webgpu";
import {
  GpuArrayReader, GpuArrays, GpuExtSplatReader, GpuSplatMath, GpuSplats, RdxFile, TSL, defineBundle, loadSplats, type SplatGenerator, type TslNode,
} from "@sparkjsdev/radix";
import { fetchData } from "./data.js";
import type { QuakeLighting } from "./lighting.js";
import { LIGHTSTYLE_NORMAL } from "./sim/QuakeSim.js";

const { If, abs, cross, dot, float, int, length, mat3, max, mix, normalize, sqrt, transpose, uint, uniform, vec3, vec4 } = TSL;

export interface AtlasFrame {
  name?: string;
  firstPose: number;
  numPoses: number;
  intervals?: number[];
}

interface AtlasModelBase {
  name: string;
  splatOffset: number;
  splatCount: number;
  bounds: { min: [number, number, number]; max: [number, number, number] };
  frames: AtlasFrame[];
}

export interface AtlasMdl extends AtlasModelBase {
  kind: "mdl";
  vertBase: number;
  numVerts: number;
  numTris: number;
  numPoses: number;
  scale: [number, number, number];
  origin: [number, number, number];
  flags: number;
  radius: number;
}

export interface AtlasSpr extends AtlasModelBase {
  kind: "spr";
  type: number;
  views: { offset: number; count: number; width: number; height: number }[];
}

export interface AtlasBsp extends AtlasModelBase {
  kind: "bsp";
}

export type AtlasModel = AtlasMdl | AtlasSpr | AtlasBsp;

export interface ModelAtlasFile {
  file: string;
  framesFile: string;
  unitsPerMeter: number;
  count: number;
  frameVertexCount: number;
  palette: number[];
  models: AtlasModel[];
}

// A splat range of the atlas: a whole model, or one sprite view
export interface AtlasRange {
  key: string;
  offset: number;
  count: number;
}

// An entity as the generator reads it at its dispatch (entities.ts keeps
// it current): one model, posed and lit
export interface EntityState {
  model: AtlasModel;
  poseA: number;
  poseB: number;
  lerp: number;
  // R_DrawEntitiesOnList's alias lighting, 0..255
  ambient: number;
  shade: number;
  // Object space direction that lights surfaces facing it
  lightDir: THREE.Vector3;
  // Object to world
  matrixWorld: THREE.Matrix4;
}

// The data of an entity's splat object: the range it draws
export interface EntityDraw {
  entity: EntityState;
  range: AtlasRange;
}

const BIND = defineBundle({ bind: "uint32x4" });
const VERTICES = defineBundle({ vertex: "uint8x4" });
const MODE = { sprite: 0, mdl: 1, bsp: 2 } as const;

export class ModelAtlas {
  readonly info: ModelAtlasFile;
  readonly splats: GpuArrays;
  readonly frames: GpuArrays;
  readonly bytes: number;
  readonly generator: SplatGenerator<EntityDraw>;
  private readonly byName = new Map<string, AtlasModel>();
  // One object per key: entities compare ranges by identity
  private readonly ranges = new Map<string, AtlasRange>();

  private constructor(info: ModelAtlasFile, splats: GpuArrays, frames: GpuArrays, bytes: number, lighting: QuakeLighting) {
    this.info = info;
    this.splats = splats;
    this.frames = frames;
    this.bytes = bytes;
    for (const model of info.models) {
      this.byName.set(model.name.toLowerCase(), model);
    }
    this.generator = entityGenerator(this, lighting);
  }

  static async load(url: string, renderer: WebGPURenderer, lighting: QuakeLighting): Promise<ModelAtlas> {
    const info = await (await fetchData(url)).json() as ModelAtlasFile;
    const [splats, frames] = await Promise.all([
      loadSplats(new URL(info.file, url).href),
      fetchData(new URL(info.framesFile, url).href).then(async (response) => RdxFile.decode(new Uint8Array(await response.arrayBuffer()))),
    ]);
    const bytes = splats.capacity * 48 + frames.capacity * 4;
    return new ModelAtlas(info, GpuArrays.fromData(renderer, splats), GpuArrays.fromData(renderer, frames), bytes, lighting);
  }

  model(name: string) {
    return this.byName.get(name.toLowerCase());
  }

  // Palette RGB 0..1
  color(index: number, out: THREE.Color) {
    const p = this.info.palette;
    return out.setRGB(p[index * 3] / 255, p[index * 3 + 1] / 255, p[index * 3 + 2] / 255);
  }

  // Splat range of a model, or of one sprite pose; the same object every
  // call for the same model and pose
  range(model: AtlasModel, pose = 0): AtlasRange | undefined {
    const key = model.kind === "spr" ? `${model.name}#${pose}` : model.name;
    let range = this.ranges.get(key);
    if (!range) {
      if (model.kind === "spr") {
        const view = model.views[Math.min(pose, model.views.length - 1)];
        if (!view) {
          return undefined;
        }
        range = { key, offset: view.offset, count: view.count };
      } else {
        range = { key, offset: model.splatOffset, count: model.splatCount };
      }
      this.ranges.set(key, range);
    }
    return range;
  }

  dispose() {
    this.splats.dispose();
    this.frames.dispose();
  }
}

// Splat i of an entity: atlas splat range.offset + i, deformed and lit
function entityGenerator(atlas: ModelAtlas, lighting: QuakeLighting): SplatGenerator<EntityDraw> {
  const reader = new GpuExtSplatReader().bind(atlas.splats);
  const binds = new GpuArrayReader(BIND).bind(atlas.splats, "mdlBind");
  const vertices = new GpuArrayReader(VERTICES).bind(atlas.frames, "mdlFrames");
  const u = {
    mode: uniform(0, "int"),
    offset: uniform(0, "uint"),
    vertBase: uniform(0, "uint"),
    numVerts: uniform(0, "uint"),
    poseA: uniform(0, "uint"),
    poseB: uniform(0, "uint"),
    lerp: uniform(0),
    scale: uniform(new THREE.Vector3(1, 1, 1)),
    origin: uniform(new THREE.Vector3()),
    units: uniform(atlas.info.unitsPerMeter),
    ambient: uniform(255),
    shade: uniform(0),
    lightDir: uniform(new THREE.Vector3(1, 0, 0)),
    toWorld: uniform(new THREE.Matrix4()),
  };

  // Vertex v of pose `pose` in object (three) space
  const vertex = (pose: TslNode, v: TslNode): TslNode => {
    const bytes = vertices.fetch("vertex", u.vertBase.add(pose.mul(u.numVerts)).add(v)).toVar();
    const q = vec3(float(bytes.x), float(bytes.y), float(bytes.z)).mul(u.scale).add(u.origin);
    return vec3(q.x, q.z, q.y.negate()).div(u.units);
  };

  // A triangle's basis: two edges and a normal scaled to the edge lengths,
  // so the third axis behaves like the others under the affine map
  const basis = (p0: TslNode, p1: TslNode, p2: TslNode) => {
    const e1 = p1.sub(p0).toVar();
    const e2 = p2.sub(p0).toVar();
    const n = cross(e1, e2).toVar();
    const area2 = length(n);
    return [e1, e2, n.mul(sqrt(area2).div(max(area2, 1e-12))).toVar()];
  };

  const deform = (cov: TslNode, index: TslNode) => {
    const packed = binds.fetch("bind", index).x.toVar();
    const v = [packed.bitAnd(uint(0x3ff)), packed.shiftRight(uint(10)).bitAnd(uint(0x3ff)), packed.shiftRight(uint(20)).bitAnd(uint(0x3ff))];
    // The reference pose (pose 0, where the splats were baked) and the blend of A and B
    const p = v.map((each) => vertex(uint(0), each).toVar());
    const q = v.map((each) => mix(vertex(u.poseA, each), vertex(u.poseB, each), u.lerp).toVar());
    const [c0, c1, c2] = basis(p[0], p[1], p[2]);
    const f = basis(q[0], q[1], q[2]);
    const center = cov.get("center");
    // E^-1 by cross products of E's columns; a triangle degenerate in the
    // reference pose (common in weapon models) translates with its centroid
    const det = dot(c0, cross(c1, c2)).toVar();
    const reference = length(c0).mul(length(c1)).mul(length(c2)).toVar();
    If(abs(det).lessThan(reference.mul(1e-3)).or(reference.lessThan(1e-18)), () => {
      center.addAssign(q[0].add(q[1]).add(q[2]).sub(p[0]).sub(p[1]).sub(p[2]).div(3.0));
    }).Else(() => {
      const r0 = cross(c1, c2).div(det).toVar();
      const r1 = cross(c2, c0).div(det).toVar();
      const r2 = cross(c0, c1).div(det).toVar();
      const F = mat3(f[0], f[1], f[2]);
      const M = mat3(F.mul(vec3(r0.x, r1.x, r2.x)), F.mul(vec3(r0.y, r1.y, r2.y)), F.mul(vec3(r0.z, r1.z, r2.z))).toVar();
      center.assign(M.mul(center.sub(p[0])).add(q[0]));
      const sigma = M.mul(GpuSplatMath.covMatrix(cov.get("xxyyzz"), cov.get("xyxzyz"))).mul(transpose(M)).toVar();
      cov.get("xxyyzz").assign(vec3(sigma.element(0).x, sigma.element(1).y, sigma.element(2).z));
      cov.get("xyxzyz").assign(vec3(sigma.element(0).y, sigma.element(0).z, sigma.element(1).z));
      cov.get("normal").assign(normalize(cross(q[1].sub(q[0]), q[2].sub(q[0]))));
    });
  };

  return {
    generateCovSplat: (i) => {
      const at = u.offset.add(i);
      const cov = GpuSplats.toCov(reader.loadSplat(at)).toVar();
      const bz = reader.load("extB", at).z;
      const fullbright = float(bz.shiftRight(uint(16)).bitAnd(uint(0xff))).greaterThan(254.5);
      cov.get("normal").assign(reader.loadPbr(at).get("normal"));
      If(u.mode.equal(int(MODE.mdl)), () => {
        deform(cov, at);
        If(lighting.enabledNode.and(fullbright.not()), () => {
          const facing = max(dot(cov.get("normal"), u.lightDir), 0.0);
          cov.get("rgb").mulAssign(lighting.lightFactor(u.ambient.add(u.shade.mul(facing))));
        });
      });
      // Ammo boxes carry their own lightmaps (mode static)
      If(u.mode.equal(int(MODE.bsp)).and(lighting.enabledNode).and(fullbright.not()), () => {
        const world = u.toWorld.mul(vec4(cov.get("center"), 1.0)).xyz;
        cov.get("rgb").mulAssign(lighting.surfaceLight(world, float(bz.shiftRight(uint(24))), float(0.0), float(LIGHTSTYLE_NORMAL), float(0.0)));
      });
      return cov;
    },
    bind: ({ entity, range }) => {
      const { model } = entity;
      u.offset.value = range.offset;
      u.mode.value = model.kind === "mdl" ? MODE.mdl : model.kind === "bsp" ? MODE.bsp : MODE.sprite;
      if (model.kind === "mdl") {
        u.vertBase.value = model.vertBase;
        u.numVerts.value = model.numVerts;
        u.poseA.value = Math.max(0, Math.min(model.numPoses - 1, entity.poseA));
        u.poseB.value = Math.max(0, Math.min(model.numPoses - 1, entity.poseB));
        u.lerp.value = entity.lerp;
        u.scale.value.fromArray(model.scale);
        u.origin.value.fromArray(model.origin);
      }
      u.ambient.value = entity.ambient;
      u.shade.value = entity.shade;
      u.lightDir.value.copy(entity.lightDir);
      u.toWorld.value.copy(entity.matrixWorld);
    },
  };
}
