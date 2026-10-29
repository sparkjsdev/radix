// Vanilla Doom sector lighting inside the generators that draw the game (a
// renderer modifier costs several times more on WebGL2):
// - level: a remap "indices" generator over a level object's splats; each
//   splat's sector comes from its `sector` bundle (the exporter's, SKY_SECTOR
//   for the unlit sky) and its light from a table uploaded each tic;
// - things: one view of the sprite atlas per object, splat i being atlas
//   splat offset + i, lit by the object's own light and depth (the weapon);
// - batch: every world thing in one object, each list entry naming an atlas
//   splat and a slot of a table of poses and lights (things.ts).
// The bake stores raw palette colors with two hints per splat: roughness =
// (fake contrast + 1) / 2 and metallic = 1 for flats, 0 for walls and
// sprites. The math reproduces r_main.c R_InitLightTables and the
// wall / plane / sprite lookups:
//   lightnum = clamp((light >> 4) + contrast + extralight, 0, 15)
//   startmap = (15 - lightnum) * 4
//   walls/sprites: index = startmap - min(2560 / z, 47) / 2   (scalelight)
//   planes:        index = startmap - 80 / (floor(z / 16) + 1)  (zlight)
// with z the view depth in map units; the colormap index 0..31 becomes a
// brightness factor through a LUT of each colormap's mean palette luminance
// ratio. fixedcolormap 1..31 forces that map, 32 is the invulnerability
// inverse; FF_FULLBRIGHT uses map 0; MF_SHADOW is a dark, translucent,
// jittered silhouette (an approximation of the fuzz effect).
import * as THREE from "three";
                                                   
import { ArrayData, GpuArrayReader, GpuArrays, GpuExtSplatReader, TSL, defineBundle,                                                   } from "@sparkjsdev/radix";

const { clamp, cos, dot, float, floor, fract, int, max, min, mix, select, sin, uint, uniform, vec3, vec4 } = TSL;

export const SECTOR_BUNDLE = defineBundle({ value: "uint16" });
export const SKY_SECTOR = 0xffff;
const TABLE = defineBundle({ value: "float32" });
// Table entries: 32 light colormaps, the inverse map, then one light per sector
const INVERSE_COLORMAP = 32;
const SECTOR_BASE = 33;

const ENABLED = 1;
const QUANTIZE = 2;
const DIMINISH = 4;
const CONTRAST = 8;

                            
                    
                     
                             
 

// A thing's light, updated by the page every frame (read at its dispatch)
                             
                
                                                                    
                
                      
                
 

                            
                   
                 
                    
 

// Every world thing in one object: list entry i is atlas splat (entry &
// ATLAS_MASK) of the thing in table slot (entry >> SLOT_SHIFT); the table
// holds each slot's pose (x, y, z, yaw) and light (light, depth, flags)
export const THING_TABLE = defineBundle({ pose: "float32x4", light: "float32x4" });
export const SLOT_SHIFT = 21;
export const MAX_SLOTS = 1 << (32 - SLOT_SHIFT);
export const FLAG_FULLBRIGHT = 16;
export const FLAG_FUZZ = 32;
                                 
                   
                  
                   
 

export class DoomLighting {
           options = { enabled: true, quantize: false, diminish: true, contrast: true };
  unitsPerMeter = 32;
  extraLight = 0;
  fixedColormap = 0;
           cameraPosition = new THREE.Vector3();
           cameraForward = new THREE.Vector3(0, 0, -1);
           level                           ;
           things                           ;
           batch                                ;

          sectorLight = new Float32Array(0);
                   lut = new Float32Array(SECTOR_BASE);
                   table           ;
          tableDirty = true;
          frame = 0;
                   tableReader = new GpuArrayReader(TABLE);
                   u = {
    flags: uniform(0, "int"),
    extra: uniform(0),
    fixed: uniform(0),
    units: uniform(32),
    cameraPosition: uniform(new THREE.Vector3()),
    cameraForward: uniform(new THREE.Vector3()),
    jitter: uniform(0),
  };

  constructor(renderer                ) {
    this.table = new GpuArrays({ renderer, bundles: { table: TABLE } });
    this.setLut(Array.from({ length: 32 }, (_, i) => 1 - i / 32), 1);
    this.level = this.levelGenerator();
    this.things = this.thingGenerator();
    this.batch = this.batchGenerator();
  }

  // Brightness factor of each of the 32 light colormaps and of the inverse map
  setLut(levels                   , inverse        ) {
    for (let i = 0; i < 32; i += 1) {
      this.lut[i] = levels[i] ?? 0;
    }
    this.lut[INVERSE_COLORMAP] = inverse;
    this.tableDirty = true;
  }

  setSectorLights(lights                   , stride = 1, offset = 0, count = Math.floor(lights.length / stride)) {
    if (this.sectorLight.length !== count) {
      this.sectorLight = new Float32Array(count);
      this.tableDirty = true;
    }
    for (let i = 0; i < count; i += 1) {
      const light = lights[i * stride + offset];
      if (this.sectorLight[i] !== light) {
        this.sectorLight[i] = light;
        this.tableDirty = true;
      }
    }
  }

  lightOf(sector        ) {
    return sector >= 0 && sector < this.sectorLight.length ? this.sectorLight[sector] : 255;
  }

  // View depth of a world point in map units
  depthOf(position               ) {
    return Math.max(0, scratch.copy(position).sub(this.cameraPosition).dot(this.cameraForward)) * this.unitsPerMeter;
  }

  // Per frame, before rendering: the camera and the game's light state
  update(camera              ) {
    camera.updateMatrixWorld();
    camera.getWorldPosition(this.cameraPosition);
    camera.getWorldDirection(this.cameraForward);
    const { options, u } = this;
    u.flags.value = (options.enabled ? ENABLED : 0) | (options.quantize ? QUANTIZE : 0) | (options.diminish ? DIMINISH : 0) | (options.contrast ? CONTRAST : 0);
    u.extra.value = this.extraLight;
    u.fixed.value = this.fixedColormap;
    u.units.value = this.unitsPerMeter;
    u.cameraPosition.value.copy(this.cameraPosition);
    u.cameraForward.value.copy(this.cameraForward);
    this.frame += 1;
    u.jitter.value = (this.frame % 64) * 7.31;
    if (this.tableDirty) {
      this.tableDirty = false;
      const data = new ArrayData({ count: SECTOR_BASE + this.sectorLight.length }).addBundle("table", TABLE);
      const values = data.bundles.table.channels.value.data;
      values.set(this.lut);
      values.set(this.sectorLight, SECTOR_BASE);
      this.table.upload(data);
      this.tableReader.bind(this.table, "table");
    }
  }

  // Colormap index 0..31 -> brightness, interpolated unless quantized
          lutLookup(levelIn         )          {
    const quantized = select(this.flag(QUANTIZE), floor(levelIn.add(0.5)), levelIn);
    const level = clamp(quantized, 0.0, 31.0).toVar();
    const lo = uint(floor(level)).toVar();
    const hi = min(lo.add(uint(1)), uint(31));
    return mix(this.tableReader.load("value", lo), this.tableReader.load("value", hi), level.sub(float(lo)));
  }

          flag(bit        , flags          = this.u.flags)          {
    return flags.bitAnd(int(bit)).notEqual(int(0));
  }

  // The lit color of `rgb` (TSL), for a light level, contrast bias (-1..1),
  // view depth (map units), plane weight (metallic) and fullbright
          lit(rgb         , light         , bias         , depth         , plane         , fullbright         )          {
    const { u } = this;
    const z = select(this.flag(DIMINISH), depth, float(160.0));
    const b = select(this.flag(CONTRAST), bias, float(0.0));
    const lightnum = clamp(floor(light.add(b.mul(16.0)).div(16.0)).add(u.extra), 0.0, 15.0);
    const startmap = float(15.0).sub(lightnum).mul(4.0);
    const wall = min(float(1280.0).div(max(z, 1.0)), 23.5);
    const flat = float(1280.0).div(z.add(16.0));
    const level = select(u.fixed.greaterThan(0.5), u.fixed, select(fullbright, float(0.0), startmap.sub(mix(wall, flat, clamp(plane, 0.0, 1.0)))));
    const shaded = rgb.mul(this.lutLookup(level));
    const inverse = vec3(float(1.0).sub(dot(rgb, vec3(0.299, 0.587, 0.114)))).mul(this.tableReader.load("value", uint(INVERSE_COLORMAP)));
    return select(this.flag(ENABLED), select(u.fixed.greaterThanEqual(31.5), inverse, shaded), rgb);
  }

          levelGenerator()                            {
    const ext = new GpuExtSplatReader();
    const list = new GpuArrayReader(ArrayData.INDICES);
    const sectors = new GpuArrayReader(SECTOR_BUNDLE);
    const toWorld = uniform(new THREE.Matrix4());
    return {
      generateSplat: (i) => {
        const index = list.load("index", i).toVar();
        const splat = ext.loadSplat(index).toVar();
        const pbr = ext.loadPbr(index);
        const sector = sectors.load("value", index).toVar();
        const center = toWorld.mul(vec4(splat.get("center"), 1.0)).xyz;
        const depth = max(dot(center.sub(this.u.cameraPosition), this.u.cameraForward), 0.0).mul(this.u.units);
        const light = this.tableReader.load("value", sector.add(uint(SECTOR_BASE)));
        const rgb = this.lit(splat.get("rgb"), light, pbr.get("roughness").mul(2.0).sub(1.0), depth, pbr.get("metallic"), TSL.bool(false));
        splat.get("rgb").assign(select(sector.equal(uint(SKY_SECTOR)), splat.get("rgb"), rgb));
        return splat             ;
      },
      bind: ({ splats, indices, matrixWorld }) => {
        ext.bind(splats);
        sectors.bind(splats, "sector");
        list.bind(indices, "indices");
        toWorld.value.copy(matrixWorld);
      },
    };
  }

  // A sprite splat (a var) lit at one light level and depth, in place;
  // fuzz: dark, translucent, its rows jittered by a texel
          shadeThing(splat           , index         , light         , depth         , flags         ) {
    const rgb = this.lit(splat.get("rgb"), light, float(0.0), depth, float(0.0), this.flag(FLAG_FULLBRIGHT, flags));
    const fuzz = this.flag(FLAG_FUZZ, flags).and(this.flag(ENABLED));
    const c = splat.get("center");
    const jitter = fract(sin(float(index.mod(uint(65536))).mul(12.9898).add(this.u.jitter)).mul(43758.5453)).sub(0.5).mul(2.0).div(this.u.units);
    splat.get("rgb").assign(select(fuzz, vec3(0.0), rgb));
    splat.get("opacity").assign(select(fuzz, splat.get("opacity").mul(0.35), splat.get("opacity")));
    splat.get("center").assign(vec3(c.x, select(fuzz, c.y.add(jitter), c.y), c.z));
  }

          thingGenerator()                            {
    const ext = new GpuExtSplatReader();
    const offset = uniform(0, "uint");
    const light = uniform(255);
    const depth = uniform(0);
    const flags = uniform(0, "int");
    return {
      generateSplat: (i) => {
        const index = i.add(offset).toVar();
        const splat = ext.loadSplat(index).toVar();
        this.shadeThing(splat, index, light, depth, flags);
        return splat;
      },
      bind: ({ atlas, offset: first, state }) => {
        ext.bind(atlas);
        offset.value = first;
        light.value = state.light;
        depth.value = state.depth;
        flags.value = (state.fullbright ? FLAG_FULLBRIGHT : 0) | (state.fuzz ? FLAG_FUZZ : 0);
      },
    };
  }

          batchGenerator()                                 {
    const ext = new GpuExtSplatReader();
    const list = new GpuArrayReader(ArrayData.INDICES);
    const table = new GpuArrayReader(THING_TABLE);
    return {
      generateSplat: (i) => {
        const entry = list.load("index", i).toVar();
        const index = entry.bitAnd(uint((1 << SLOT_SHIFT) - 1)).toVar();
        const slot = entry.shiftRight(uint(SLOT_SHIFT)).toVar();
        const pose = table.load("pose", slot).toVar();
        const state = table.load("light", slot).toVar();
        const splat = ext.loadSplat(index).toVar();
        this.shadeThing(splat, index, state.x, state.y, int(state.z));
        // Turned by the yaw about +y, then moved to the position
        const c = splat.get("center").toVar();
        const cy = cos(pose.w).toVar();
        const sy = sin(pose.w).toVar();
        splat.get("center").assign(vec3(c.x.mul(cy).add(c.z.mul(sy)), c.y, c.z.mul(cy).sub(c.x.mul(sy))).add(pose.xyz));
        const q = splat.get("quaternion").toVar();
        const ch = cos(pose.w.mul(0.5)).toVar();
        const sh = sin(pose.w.mul(0.5)).toVar();
        splat.get("quaternion").assign(vec4(ch.mul(q.x).add(sh.mul(q.z)), ch.mul(q.y).add(sh.mul(q.w)), ch.mul(q.z).sub(sh.mul(q.x)), ch.mul(q.w).sub(sh.mul(q.y))));
        return splat;
      },
      bind: ({ atlas, list: entries, table: slots }) => {
        ext.bind(atlas);
        list.bind(entries, "indices");
        table.bind(slots, "table");
      },
    };
  }
}

const scratch = new THREE.Vector3();


//# sourceURL=examples/doom/lighting.ts