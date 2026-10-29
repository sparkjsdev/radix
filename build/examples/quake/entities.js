// Entities (monsters, items, gibs, torches, ammo boxes, explosions, the
// weapon) as splat objects over the model atlas (models.ts), mirroring the
// entity list the sim exports every tick, plus the particles.
//
// Each entity is one object of the atlas generator: its data is the range
// it draws (a model, or one sprite view) and its state (poses, lighting,
// matrix), which this file updates in place every frame; Radix reads it at
// the object's dispatch. A new model or sprite view makes a new object
// (counts are locked per object), and an entity whose model changes gets a
// new state, so an older collection still being drawn (the CPU sort) shows
// what it was sorted for, never another entity's splats. Sprites yaw at the
// camera; the view model hangs from the view pose with its transform
// relative to the same tick's exported view (like R_DrawViewModel),
// optionally scaled toward the eye so it sorts in front (viewmodelOptions).
//
// Every other entity is interpolated between the previous and the current
// snapshot, both taken from the snapshots themselves so the blend matches
// the camera's even when several ticks arrive in one frame. Frame
// interpolation (lerpOptions): WinQuake shows a new pose the tick the server
// sets it (10 Hz steps); "lerp" blends from the previous pose over the frame
// interval (0.1 s, or the group interval), optionally quantized to `animHz`
// steps; step-movetype entities (monsters) also blend their origin over 0.1 s.
import * as THREE from "three";
                                                   
import { ArrayData, GpuArrayReader, GpuArrays, GpuSplats, SplatCollection, TSL, defineBundle,                                                            } from "@sparkjsdev/radix";
                                                                                               
import { ENT, EntFlag, PARTICLE, bitsToFloat, readEntity, readView,                                                   } from "./sim/QuakeSim.js";
import { lerpAngle } from "./game.js";

const { vec3, vec4 } = TSL;

export const lerpOptions = {
  // Blend poses (and step movement) instead of snapping like WinQuake
  lerp: true,
  // Quantize the blend to this many steps per second (0 = every frame)
  animHz: 0,
  // Blend step-movetype origins over 0.1 s
  lerpMove: true,
};

export const viewmodelOptions = {
  // Uniform scale of the view model about the eye: the image is unchanged
  // under perspective but its splats sort that much nearer, so the weapon is
  // drawn over walls in the player's face (WinQuake's ziscale * 3); 1 = off
  depthScale: 1 / 3,
};

// Sprite orientation types (spritegn.h)
const SPR_ORIENTED = 3;
// Teleports and spawns move further than this per tick; do not interpolate
const SNAP_DISTANCE = 128;
// Default frame interval for single-frame animations (QuakeC think rate)
const FRAME_INTERVAL = 0.1;
const MAX_PARTICLES = 2048;
// Particle splat radius (Quake units); vanilla draws them 1-2 pixels wide
const PARTICLE_RADIUS = 0.8;

                
                                  
                                           
 

                  
             
                
                
                     
                     
                                                
             
             
                          
                        
                   
               
                   
                   
                       
                                                                    
                          
 

export class EntityManager {
           atlas            ;
           particles           ;
  // Show the view model (the GUI's weapon toggle)
  showViewmodel = true;
                   unitsPerMeter        ;
                   byId = new Map                ();
                   prevIndex = new Map                ();
                   viewPose = new THREE.Matrix4();
          viewFrozen = false;
          viewmodel         ;
          lastTick = -1;
          modelNames           = [];
                   warned = new Set        ();
  // Wall clock (s) of the current frame, for pose timing
          now = 0;

  constructor(renderer                , atlas            ) {
    this.atlas = atlas;
    this.unitsPerMeter = atlas.info.unitsPerMeter;
    this.particles = new Particles(renderer, atlas);
  }

  // The pose the view model hangs from: the camera while following, the
  // pose following ended at in free fly (`frozen` turns the depth scale
  // off, since it is only invisible from the eye it scales toward)
  setViewPose(pose               , frozen         ) {
    this.viewPose.copy(pose);
    this.viewFrozen = frozen;
  }

  // Every shown entity's object (and the particles'), in a stable order
  objects()                   {
    const out                   = [];
    for (const entity of this.byId.values()) {
      if (entity.seen && entity.range) {
        out.push(this.objectOf(entity, entity.range));
      }
    }
    const viewmodel = this.viewmodel;
    if (viewmodel?.seen && viewmodel.range && this.showViewmodel) {
      out.push(this.objectOf(viewmodel, viewmodel.range));
    }
    if (this.particles.count > 0) {
      out.push(this.particles.object);
    }
    return out;
  }

  get count() {
    return this.byId.size;
  }

  // Whether something moves without a matrix change (poses blending,
  // particles): the CPU sort needs requestSort for it
  get animating() {
    return this.particles.count > 0 || [...this.byId.values()].some((entity) => entity.state.lerp < 1);
  }

          objectOf(entity        , range            )                          {
    let object = entity.objects.get(range.key);
    if (!object) {
      object = SplatCollection.object({ generator: this.atlas.generator, data: { entity: entity.state, range }, count: range.count, matrixWorld: entity.state.matrixWorld });
      entity.objects.set(range.key, object);
    }
    return object;
  }

          newEntity(id        , model            )         {
    const zero = () => ({ x: 0, y: 0, z: 0, pitch: 0, yaw: 0, roll: 0 });
    return {
      id, flags: 0, seen: false, objects: new Map(), prev: zero(), curr: zero(),
      state: { model, poseA: 0, poseB: 0, lerp: 1, ambient: 255, shade: 0, lightDir: new THREE.Vector3(1, 0, 0), matrixWorld: new THREE.Matrix4() },
      moveFrom: new THREE.Vector3(), moveTo: new THREE.Vector3(), moveTime: 0, pose: 0, poseFrom: 0, poseTime: 0, poseInterval: FRAME_INTERVAL, relative: new THREE.Matrix4(),
    };
  }

          poseLerp(entity        ) {
    if (!lerpOptions.lerp || entity.poseFrom === entity.pose) {
      return 1;
    }
    const t = Math.min(1, Math.max(0, (this.now - entity.poseTime) / entity.poseInterval));
    if (lerpOptions.animHz > 0) {
      const steps = Math.max(1, Math.round(lerpOptions.animHz * entity.poseInterval));
      return Math.floor(t * steps) / steps;
    }
    return t;
  }

  // Every frame: the state is read again whenever a new tick arrived,
  // positions and poses are interpolated every frame (`now` in ms)
  update(prev             , curr             , alpha        , camera              , now        ) {
    this.now = now / 1000;
    if (curr.tick !== this.lastTick) {
      this.lastTick = curr.tick;
      this.modelNames = curr.modelNames;
      this.readTick(prev, curr);
      this.particles.read(curr, this.unitsPerMeter);
    }
    this.place(alpha, camera);
  }

          readTick(prev             , curr             ) {
    for (const entity of this.byId.values()) {
      entity.seen = false;
    }
    if (this.viewmodel) {
      this.viewmodel.seen = false;
    }
    const sameLevel = prev.mapName === curr.mapName && prev.tick > 0 && curr.tick - prev.tick <= 5;
    // The previous state comes from the previous snapshot, not this
    // entity's last read: with two ticks in one frame the camera lerps from
    // the snapshot before this one, and so must every entity
    const prevIndex = this.prevIndex;
    prevIndex.clear();
    if (sameLevel) {
      for (let i = 0; i < prev.entityCount; i += 1) {
        prevIndex.set(prev.entities[i * ENT.STRIDE + ENT.ID], i);
      }
    }
    const view = entityScratch;
    for (let i = 0; i < curr.entityCount; i += 1) {
      readEntity(curr, i, view);
      if (view.flags & EntFlag.SELF) {
        continue;
      }
      const name = this.modelNames[view.model];
      // Inline brush models (*n: doors, platforms) are world objects (world.ts)
      if (!name || name[0] === "*") {
        continue;
      }
      const model = this.atlas.model(name);
      if (!model) {
        this.warnOnce(`No atlas model for ${name}`);
        continue;
      }
      const isViewmodel = (view.flags & EntFlag.VIEWMODEL) !== 0;
      let entity = isViewmodel ? this.viewmodel : this.byId.get(view.id);
      const fresh = !entity || entity.state.model !== model;
      if (!entity || fresh) {
        entity = this.newEntity(view.id, model);
        if (isViewmodel) {
          this.viewmodel = entity;
        } else {
          this.byId.set(view.id, entity);
        }
      }
      entity.seen = true;
      entity.flags = view.flags;

      const frame = model.frames[Math.min(Math.max(0, view.frame), model.frames.length - 1)];
      const pose = frame ? frame.firstPose + Math.min(view.subframe, frame.numPoses - 1) : 0;
      if (fresh || !sameLevel) {
        entity.pose = pose;
        entity.poseFrom = pose;
      } else if (pose !== entity.pose) {
        entity.poseFrom = entity.pose;
        entity.pose = pose;
        entity.poseTime = this.now;
        entity.poseInterval = frame?.intervals ? groupInterval(frame.intervals, view.subframe) : FRAME_INTERVAL;
      }
      entity.range = this.atlas.range(model, model.kind === "spr" ? pose : 0);
      entity.state.ambient = view.ambient;
      entity.state.shade = view.shade;

      const c = entity.curr;
      const p = entity.prev;
      const [lastX, lastY, lastZ] = [c.x, c.y, c.z];
      Object.assign(c, { x: view.x, y: view.y, z: view.z, pitch: view.pitch, yaw: view.yaw, roll: view.roll });
      const prevAt = prevIndex.get(view.id);
      if (prevAt !== undefined) {
        readEntity(prev, prevAt, prevScratch);
        Object.assign(p, { x: prevScratch.x, y: prevScratch.y, z: prevScratch.z, pitch: prevScratch.pitch, yaw: prevScratch.yaw, roll: prevScratch.roll });
      } else {
        Object.assign(p, c);
      }
      if (fresh || !sameLevel || Math.hypot(c.x - p.x, c.y - p.y, c.z - p.z) > SNAP_DISTANCE) {
        Object.assign(p, c);
        entity.moveFrom.set(c.x, c.y, c.z);
        entity.moveTo.set(c.x, c.y, c.z);
        entity.moveTime = 0;
      } else if ((view.flags & EntFlag.STEP) && (c.x !== lastX || c.y !== lastY || c.z !== lastZ)) {
        entity.moveFrom.copy(entity.moveTo);
        entity.moveTo.set(c.x, c.y, c.z);
        entity.moveTime = this.now;
      }
      if (isViewmodel) {
        // Relative to this same tick's view, like R_DrawViewModel draws
        // cl.viewent against r_refdef; applied under the interpolated camera
        const s = 1 / this.unitsPerMeter;
        const gameView = readView(curr, viewScratch);
        viewPosition.set(gameView.x * s, gameView.z * s, -gameView.y * s);
        viewEuler.set(THREE.MathUtils.degToRad(-gameView.pitch), THREE.MathUtils.degToRad(gameView.yaw - 90), THREE.MathUtils.degToRad(-gameView.roll), "YXZ");
        viewMatrix.compose(viewPosition, viewRotation.setFromEuler(viewEuler), unitScale);
        poseTransform(model, c.x, c.y, c.z, c.pitch, c.yaw, c.roll, s, position, rotation);
        entity.relative.copy(viewMatrix.invert()).multiply(entityMatrix.compose(position, rotation, unitScale));
      }
    }
    for (const [id, entity] of this.byId) {
      if (!entity.seen) {
        this.byId.delete(id);
      }
    }
  }

  // Interpolates and places every shown entity
          place(alpha        , camera              ) {
    const s = 1 / this.unitsPerMeter;
    const eye = camera.getWorldPosition(eyeScratch);
    const entities = this.viewmodel ? [...this.byId.values(), this.viewmodel] : this.byId.values();
    for (const entity of entities) {
      if (!entity.seen) {
        continue;
      }
      const { prev: a, curr: b, state } = entity;
      const model = state.model;
      state.poseA = entity.poseFrom;
      state.poseB = entity.pose;
      state.lerp = this.poseLerp(entity);
      if (entity === this.viewmodel) {
        poseTransform(model, b.x, b.y, b.z, b.pitch, b.yaw, b.roll, s, position, rotation);
        const k = this.viewFrozen ? 1 : Math.max(0.01, Math.min(1, viewmodelOptions.depthScale));
        state.matrixWorld.copy(this.viewPose).multiply(depthScaleMatrix.makeScale(k, k, k)).multiply(entity.relative);
        rotation.setFromRotationMatrix(rotationScratch.extractRotation(state.matrixWorld));
      } else {
        let x = a.x + (b.x - a.x) * alpha;
        let y = a.y + (b.y - a.y) * alpha;
        let z = a.z + (b.z - a.z) * alpha;
        if (lerpOptions.lerp && lerpOptions.lerpMove && (entity.flags & EntFlag.STEP) && entity.moveTime > 0) {
          const t = Math.min(1, Math.max(0, (this.now - entity.moveTime) / FRAME_INTERVAL));
          x = entity.moveFrom.x + (entity.moveTo.x - entity.moveFrom.x) * t;
          y = entity.moveFrom.y + (entity.moveTo.y - entity.moveFrom.y) * t;
          z = entity.moveFrom.z + (entity.moveTo.z - entity.moveFrom.z) * t;
        }
        if (model.kind === "spr" && model.type !== SPR_ORIENTED) {
          // Billboard: face the camera around the vertical axis
          position.set(x * s, z * s, -y * s);
          rotation.setFromAxisAngle(upAxis, Math.atan2(eye.x - position.x, eye.z - position.z));
        } else {
          poseTransform(model, x, y, z, lerpAngle(a.pitch, b.pitch, alpha), lerpAngle(a.yaw, b.yaw, alpha), lerpAngle(a.roll, b.roll, alpha), s, position, rotation);
        }
        state.matrixWorld.compose(position, rotation, unitScale);
      }
      // World +x brightens (lightvec (-1, 0, 0)), in object space
      state.lightDir.set(1, 0, 0).applyQuaternion(rotation.invert());
    }
  }

  // Forgets the sim mapping (a new level)
  clear() {
    this.byId.clear();
    this.viewmodel = undefined;
    this.particles.clear();
    this.lastTick = -1;
  }

  dispose() {
    this.clear();
    this.particles.dispose();
  }

          warnOnce(message        ) {
    if (!this.warned.has(message)) {
      this.warned.add(message);
      console.warn(`[quake] ${message}`);
    }
  }
}

const PARTICLES = defineBundle({ center: "float32x4", color: "uint8x4" });

// The particles: one object of MAX_PARTICLES splats over arrays written every
// tick; slots past the tick's count read zero, so their opacity is 0 and the
// projection drops them
class Particles {
           object                        ;
  count = 0;
                   data = new ArrayData({ count: 0, capacity: MAX_PARTICLES }).addBundle("particles", PARTICLES);
                   arrays           ;
                   atlas            ;

  constructor(renderer                , atlas            ) {
    this.atlas = atlas;
    this.arrays = new GpuArrays({ renderer, bundles: { particles: PARTICLES }, capacity: MAX_PARTICLES });
    this.object = SplatCollection.object({ generator: particleGenerator(atlas.info.unitsPerMeter), data: this.arrays, count: MAX_PARTICLES });
  }

  read(curr             , unitsPerMeter        ) {
    const s = 1 / unitsPerMeter;
    const count = Math.min(MAX_PARTICLES, curr.particleCount);
    const { center, color } = this.data.bundles.particles.channels;
    const d = curr.particles;
    for (let i = 0; i < count; i += 1) {
      const o = i * PARTICLE.STRIDE;
      center.data.set([bitsToFloat(d[o + PARTICLE.X]) * s, bitsToFloat(d[o + PARTICLE.Z]) * s, -bitsToFloat(d[o + PARTICLE.Y]) * s, 0], i * 4);
      this.atlas.color(d[o + PARTICLE.COLOR] & 255, particleColor);
      color.data.set([particleColor.r * 255, particleColor.g * 255, particleColor.b * 255, 255], i * 4);
    }
    this.data.count = count;
    if (count > 0 || this.count > 0) {
      this.arrays.upload(this.data);
    }
    this.count = count;
  }

  clear() {
    this.count = 0;
  }

  dispose() {
    this.arrays.dispose();
  }
}

function particleGenerator(unitsPerMeter        )                            {
  const reader = new GpuArrayReader(PARTICLES);
  const radius = PARTICLE_RADIUS / unitsPerMeter;
  return {
    generateSplat: (i) => {
      const color = vec4(reader.load("color", i)).div(255.0).toVar();
      return GpuSplats.Splat(reader.load("center", i).xyz, vec3(radius), vec4(0, 0, 0, 1), color.rgb, color.a, i);
    },
    bind: (arrays) => {
      reader.bind(arrays, "particles");
    },
  };
}

// Time from pose `sub` to the next pose in a frame group (cumulative intervals)
function groupInterval(intervals          , sub        ) {
  const end = intervals[Math.min(sub, intervals.length - 1)];
  const start = sub > 0 ? intervals[sub - 1] : 0;
  return Math.max(0.01, end - start);
}

// Quake origin (units) and angles (degrees) -> three position and rotation
// for a model: yaw about Y, pitch about -Z (alias models negate the pitch,
// R_AliasSetUpTransform), roll about X
function poseTransform(model            , x        , y        , z        , pitch        , yaw        , roll        , s        , outPosition               , outRotation                  ) {
  outPosition.set(x * s, z * s, -y * s);
  const pitchQ = model.kind === "mdl" ? -pitch : pitch;
  euler.set(THREE.MathUtils.degToRad(roll), THREE.MathUtils.degToRad(yaw), THREE.MathUtils.degToRad(-pitchQ), "YZX");
  outRotation.setFromEuler(euler);
}

const entityScratch = {}              ;
const prevScratch = {}              ;
const viewScratch = {}             ;
const depthScaleMatrix = new THREE.Matrix4();
const rotationScratch = new THREE.Matrix4();
const eyeScratch = new THREE.Vector3();
const position = new THREE.Vector3();
const rotation = new THREE.Quaternion();
const euler = new THREE.Euler();
const upAxis = new THREE.Vector3(0, 1, 0);
const unitScale = new THREE.Vector3(1, 1, 1);
const particleColor = new THREE.Color();
const viewPosition = new THREE.Vector3();
const viewEuler = new THREE.Euler();
const viewRotation = new THREE.Quaternion();
const viewMatrix = new THREE.Matrix4();
const entityMatrix = new THREE.Matrix4();


//# sourceURL=examples/quake/entities.ts