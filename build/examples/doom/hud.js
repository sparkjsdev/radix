// The 2D layer over the splat view, all from the sim: the software frame
// (alpha from the sim's overlay mask: menus, status bar, messages, title and
// intermission pages; the 3D view area see-through) drawn as one splat per
// pixel, or blitted to a canvas for comparison; the palette flash as a
// tint; the control hint; the player's weapon sprites placed like
// R_DrawPSprite; and the LoadingPanel.
//
// While following the player the frame and the weapon are drawn by a second
// SplatRenderer in an overlay scene, over the world (depth cleared), from a
// fixed camera at the origin with the main camera's projection, so their
// matrices stay in view space and its order (view "hud") is sorted only
// when its collection or the frame's mask changes. In free fly they move
// into the world renderer, posed at the view following ended at.
import * as THREE from "three";
                                                   
import { ArrayData, GpuArrayReader, GpuArrays, GpuSplats, SplatCollection, SplatRenderer, TSL, defineBundle,                                          } from "@sparkjsdev/radix";
                                          
                                                  
import { FF_FRAMEMASK, FF_FULLBRIGHT, PLAYER } from "./sim/DoomSim.js";
import { SpriteObject,                  } from "./things.js";

const { float, uint, uniform, vec3, vec4 } = TSL;

const SCREEN_WIDTH = 320;
const SCREEN_HEIGHT = 200;
// Vanilla 4:3 display of the 320x200 frame (1.2 pixel aspect)
const DISPLAY_ASPECT = 4 / 3;
// Frame splat radius in pixels (the bake's texel splat scale)
const PIXEL_RADIUS = 0.7;
// Doom's horizontal fov across the view window (FIELDOFVIEW = ANG90)
const TAN_HALF_FOV = 1;
// The frame screen's distance ahead of the view: in front of the weapon
// over the world, 1 m (about 2 m wide) as a screen in the world
const FRAME_DISTANCE_OVERLAY = 0.2;
const FRAME_DISTANCE_WORLD = 1;
// Weapon plane distance (m) and the scale making one sprite texel span
// 1/320 of the 90 degree view
const WEAPON_DISTANCE = 0.4;
const WEAPON_SCALE = WEAPON_DISTANCE / 5;
const RGBA = defineBundle({ rgba: "unorm8x4" });

                                                    

// The engine's 3D view window inside the frame (pixels)
                           
            
            
                
                 
 

// ST_doPaletteStuff
const NUMREDPALS = 8;
const STARTREDPALS = 1;
const NUMBONUSPALS = 4;
const STARTBONUSPALS = 9;
const RADIATIONPAL = 13;
const PW_STRENGTH = 1;
const PW_INVISIBILITY = 2;
const PW_IRONFEET = 3;

// The software frame as splats: pixel (col, row) at (col + 0.5, height - row
// - 0.5) in pixel units, colored by the frame's RGBA (uploaded per frame)
class FrameSplats {
           generator                                     ;
           rgba           ;
                   data = new ArrayData({ count: SCREEN_WIDTH * SCREEN_HEIGHT }).addBundle("rgba", RGBA);
          made = new Map                               ();
          mask = 0;

  constructor(renderer                ) {
    this.rgba = new GpuArrays({ renderer, bundles: { rgba: RGBA }, capacity: SCREEN_WIDTH * SCREEN_HEIGHT });
    const reader = new GpuArrayReader(RGBA);
    const width = uniform(SCREEN_WIDTH, "uint");
    this.generator = {
      generateSplat: (i) => {
        const color = reader.load("rgba", i).toVar();
        const col = float(i.mod(width)).add(0.5);
        const row = float(SCREEN_HEIGHT).sub(float(i.div(width))).sub(0.5);
        return GpuSplats.Splat(vec3(col, row, 0), vec3(PIXEL_RADIUS, PIXEL_RADIUS, PIXEL_RADIUS * 0.1), vec4(0, 0, 0, 1), color.xyz, color.w, uint(i));
      },
      bind: ({ rgba }) => reader.bind(rgba, "rgba"),
    };
  }

  // A new frame; whether its overlay mask changed (which splats are drawn)
  update(frame           )          {
    const dst = this.data.bundles.rgba.channels.rgba.data;
    dst.set(frame.data);
    let mask = 0;
    for (let i = 3; i < dst.length; i += 4) {
      mask = (Math.imul(mask, 31) + dst[i]) | 0;
    }
    this.rgba.upload(this.data);
    const changed = mask !== this.mask;
    this.mask = mask;
    return changed;
  }

  // The frame's object at `matrixWorld` (one per matrix)
  object(matrixWorld               ) {
    let object = this.made.get(matrixWorld);
    if (!object) {
      object = SplatCollection.object({ generator: this.generator, data: { rgba: this.rgba }, count: SCREEN_WIDTH * SCREEN_HEIGHT, matrixWorld });
      this.made.set(matrixWorld, object);
    }
    return object;
  }
}

export class DoomHud {
           scene = new THREE.Scene();
           camera = new THREE.PerspectiveCamera();
           splatRenderer               ;
  frameMode            = "splats";
  showWeapon = true;
  // Bumped when the objects the world draws for the HUD change
  version = 0;
                   game          ;
                   renderer                ;
                   frameSplats             ;
                   weapon                ;
  // Local poses (view space) and world poses (frozen view x local)
                   frameLocal = new THREE.Matrix4();
                   frameWorld = new THREE.Matrix4();
                   weaponWorld = [new THREE.Matrix4(), new THREE.Matrix4()];
          following = true;
          shown                   = [];
          drawnVersion = -1;
          vanillaFrame = false;
                   root                ;
                   frameCanvas                   ;
                   overlay                   ;
                   tint                ;
                   hint                ;
          hintText         ;

  constructor(game          , renderer                , lighting              , atlas             , sortMode               ) {
    this.game = game;
    this.renderer = renderer;
    this.frameSplats = new FrameSplats(renderer);
    this.weapon = [new SpriteObject(lighting, atlas), new SpriteObject(lighting, atlas)];
    this.splatRenderer = new SplatRenderer({ renderer, sortMode, autoSort: false, viewKey: () => "hud" });
    // Made now: with autoSort off a view made at its first render never sorts
    // unless asked, and requestSort() only reaches views that exist
    this.splatRenderer.viewFor("hud");
    this.scene.add(this.splatRenderer);

    this.root = document.createElement("div");
    this.root.style.cssText = "position:fixed;inset:0;pointer-events:none;";
    document.body.appendChild(this.root);
    this.frameCanvas = document.createElement("canvas");
    this.frameCanvas.width = SCREEN_WIDTH;
    this.frameCanvas.height = SCREEN_HEIGHT;
    this.tint = document.createElement("div");
    this.tint.style.cssText = "position:absolute;inset:0;background:transparent;";
    this.overlay = document.createElement("canvas");
    this.overlay.style.cssText = "position:absolute;left:0;top:0;width:100%;height:100%;image-rendering:pixelated;";
    this.hint = document.createElement("div");
    this.hint.style.cssText = "position:absolute;left:50%;bottom:22%;transform:translateX(-50%);padding:6px 12px;"
      + "background:rgba(0,0,0,0.6);border-radius:3px;color:white;font:15px monospace;text-shadow:0 1px 2px black;white-space:pre;";
    this.root.append(this.tint, this.overlay, this.hint);
    addEventListener("resize", () => this.resize());
    this.resize();
  }

  // Debug: the whole software frame opaque (the vanilla view) for comparison
  get vanilla() {
    return this.vanillaFrame;
  }

  set vanilla(on         ) {
    this.vanillaFrame = on;
    this.game.setOpaqueFrame(on);
  }

  // Per frame, after the game update: `alpha` interpolates the weapon bob,
  // `view` is the frozen view in free fly (undefined while following),
  // `projection` the main camera (copied for the overlay camera)
  update(alpha        , view                           , rect          , projection                         ) {
    const { game } = this;
    if (game.frame && game.frameVersion !== this.drawnVersion) {
      this.drawnVersion = game.frameVersion;
      if (this.frameSplats.update(game.frame)) {
        this.splatRenderer.requestSort();
      }
      this.blit(game.frame);
    }
    this.camera.copy(projection);
    this.camera.position.set(0, 0, 0);
    this.camera.quaternion.identity();
    this.camera.updateMatrixWorld();

    this.following = !view;
    const distance = view ? FRAME_DISTANCE_WORLD : FRAME_DISTANCE_OVERLAY;
    const pixel = (2 * distance * TAN_HALF_FOV) / rect.width;
    this.frameLocal.makeTranslation(0, 0, -distance)
      .multiply(scratch.makeScale(pixel, pixel, pixel))
      .multiply(scratch2.makeTranslation(-(rect.x + rect.width / 2), -(SCREEN_HEIGHT - (rect.y + rect.height / 2)), 0));
    this.updateWeapon(alpha);
    if (view) {
      this.frameWorld.multiplyMatrices(view, this.frameLocal);
      this.weapon.forEach((sprite, i) => this.weaponWorld[i].multiplyMatrices(view, sprite.matrix));
    }
    this.updateTint();
    this.updateHint();
    this.updateCollection();
  }

  // The HUD objects the world renderer draws (free fly)
  worldObjects()                   {
    return this.following ? [] : this.objects();
  }

  // Drawn over the world while following
  render() {
    if (!this.following || this.splatRenderer.collection.count === 0) {
      return;
    }
    const { renderer } = this;
    renderer.autoClear = false;
    renderer.clearDepth();
    renderer.render(this.scene, this.camera);
    renderer.autoClear = true;
  }

          objects()                   {
    const out                   = [];
    if (this.frameMode === "splats" && this.game.frame) {
      out.push(this.frameSplats.object(this.following ? this.frameLocal : this.frameWorld));
    }
    this.weapon.forEach((sprite, i) => {
      const object = sprite.object(this.following ? sprite.matrix : this.weaponWorld[i]);
      if (object) {
        out.push(object);
      }
    });
    return out;
  }

  // A new collection (and a sort) only when the objects change
          updateCollection() {
    const objects = this.objects();
    if (objects.length === this.shown.length && objects.every((object, i) => object === this.shown[i])) {
      return;
    }
    this.shown = objects;
    this.version += 1;
    this.splatRenderer.collection = this.following ? new SplatCollection(objects) : SplatCollection.EMPTY;
    this.splatRenderer.requestSort();
  }

  // R_DrawPSprite: the sprite point (leftOffset, topOffset) sits at screen
  // (sx, sy) in 320x200 pixels; a baked view's origin is that point moved
  // down by its floor-clip lift. One pixel of the 90 degree view is
  // WEAPON_DISTANCE / 160 at the weapon's plane; sx / sy carry vanilla's bob
  // and raise / lower ramps per tic, interpolated between snapshots.
          updateWeapon(alpha        ) {
    const { game } = this;
    const show = this.showWeapon && game.inLevel && !this.vanillaFrame;
    const p = game.curr.player;
    const q = game.prev.player;
    const invisibility = p[PLAYER.POWERS + PW_INVISIBILITY];
    const fuzz = invisibility > 4 * 32 || (invisibility & 8) !== 0;
    this.weapon.forEach((sprite, slot) => {
      const base = PLAYER.PSPRITES + slot * 4;
      const index = p[base];
      const rawFrame = p[base + 1];
      const atlas = sprite.atlas;
      const name = atlas.spriteNames[index];
      const view = show && index >= 0 && rawFrame >= 0 && name ? atlas.view(name, rawFrame & FF_FRAMEMASK, 0) : undefined;
      sprite.view = view;
      if (!view) {
        return;
      }
      sprite.light.light = sprite.lighting.lightOf(p[PLAYER.SECTOR]);
      sprite.light.depth = 0;
      sprite.light.fullbright = (rawFrame & FF_FULLBRIGHT) !== 0;
      sprite.light.fuzz = fuzz;
      let sx = p[base + 2] / 65536;
      let sy = p[base + 3] / 65536;
      if (game.prev.hasPlayer && q[base] === index && q[base + 1] === rawFrame) {
        sx = q[base + 2] / 65536 + (sx - q[base + 2] / 65536) * alpha;
        sy = q[base + 3] / 65536 + (sy - q[base + 3] / 65536) * alpha;
      }
      sy += view.lift;
      const pixel = WEAPON_DISTANCE / 160;
      sprite.matrix.compose(
        position.set((sx - SCREEN_WIDTH / 2) * pixel, (SCREEN_HEIGHT / 2 - sy) * pixel, -WEAPON_DISTANCE),
        identity,
        scale.setScalar(WEAPON_SCALE),
      );
    });
  }

          resize() {
    this.overlay.width = innerWidth;
    this.overlay.height = innerHeight;
    this.drawnVersion = -1;
  }

          blit(frame           ) {
    const ctx = this.overlay.getContext("2d") ;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, this.overlay.width, this.overlay.height);
    if (this.frameMode !== "canvas") {
      return;
    }
    this.frameCanvas.getContext("2d") .putImageData(frame, 0, 0);
    let width = this.overlay.width;
    let height = width / DISPLAY_ASPECT;
    if (height > this.overlay.height) {
      height = this.overlay.height;
      width = height * DISPLAY_ASPECT;
    }
    ctx.drawImage(this.frameCanvas, 0, 0, SCREEN_WIDTH, SCREEN_HEIGHT, (this.overlay.width - width) / 2, (this.overlay.height - height) / 2, width, height);
  }

  // Redraw the current frame (after a frame mode switch)
  redraw() {
    this.drawnVersion = -1;
  }

          updateTint() {
    const { game } = this;
    let css = "transparent";
    if (game.inLevel && !this.vanillaFrame) {
      const p = game.curr.player;
      let cnt = p[PLAYER.DAMAGECOUNT];
      const strength = p[PLAYER.POWERS + PW_STRENGTH];
      if (strength) {
        cnt = Math.max(cnt, 12 - (strength >> 6));
      }
      const ironfeet = p[PLAYER.POWERS + PW_IRONFEET];
      if (cnt) {
        const pal = Math.min((cnt + 7) >> 3, NUMREDPALS - 1) + STARTREDPALS;
        css = `rgba(255, 0, 0, ${((pal - STARTREDPALS + 1) / (NUMREDPALS + 1)).toFixed(3)})`;
      } else if (p[PLAYER.BONUSCOUNT]) {
        const pal = Math.min((p[PLAYER.BONUSCOUNT] + 7) >> 3, NUMBONUSPALS - 1) + STARTBONUSPALS;
        css = `rgba(215, 186, 69, ${((pal - STARTBONUSPALS + 1) / (NUMBONUSPALS + 4)).toFixed(3)})`;
      } else if (ironfeet > 4 * 32 || (ironfeet & 8)) {
        css = `rgba(0, 255, 0, ${RADIATIONPAL / 100})`;
      }
    }
    if (this.tint.style.background !== css) {
      this.tint.style.background = css;
    }
  }

          updateHint() {
    const { game } = this;
    let text = "";
    if (game.holdPaused) {
      text = "";
    } else if (!game.started) {
      text = "Click to capture the mouse (enables sound)   \\: pause / free fly";
    } else if (!game.mouseCaptured) {
      text = game.captureRetry
        ? "the browser needs a moment after Esc; click again to capture the mouse"
        : game.userPaused
          ? "PAUSED  -  free fly: WASD, shift run, ctrl slow   \\: play   click to capture the mouse"
          : game.menuActive
            ? "Doom menu: arrows/Enter/Backspace, Esc closes  -  click to capture the mouse"
            : "click to capture the mouse   \\: pause / free fly";
    } else if (game.userPaused) {
      text = "PAUSED  -  free fly: WASD + mouse, shift run, ctrl slow   \\: play   Esc: release the mouse";
    }
    if (text !== this.hintText) {
      this.hintText = text;
      this.hint.textContent = text;
      this.hint.style.display = text ? "block" : "none";
    }
  }
}

const scratch = new THREE.Matrix4();
const scratch2 = new THREE.Matrix4();
const position = new THREE.Vector3();
const scale = new THREE.Vector3();
const identity = new THREE.Quaternion();

// Centered progress panel for the phases where nothing (or only part of the
// world) can be shown yet
export class LoadingPanel {
  visible = false;
                   root                ;
                   title                ;
                   detail                ;
                   bar                ;
                   fill                ;

  constructor() {
    this.root = document.createElement("div");
    this.root.style.cssText = "position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);min-width:340px;"
      + "padding:14px 18px;background:rgba(0,0,0,0.75);border:1px solid rgba(255,255,255,0.25);border-radius:4px;"
      + "color:white;font:14px monospace;text-shadow:0 1px 2px black;pointer-events:none;display:none;z-index:10;";
    this.title = document.createElement("div");
    this.title.style.cssText = "font-size:16px;margin-bottom:8px;";
    this.detail = document.createElement("div");
    this.detail.style.cssText = "opacity:0.85;margin-bottom:8px;white-space:pre-wrap;";
    this.bar = document.createElement("div");
    this.bar.style.cssText = "height:8px;background:rgba(255,255,255,0.15);border-radius:2px;overflow:hidden;";
    this.fill = document.createElement("div");
    this.fill.style.cssText = "height:100%;width:0%;background:#c33;transition:width 0.15s linear;";
    this.bar.appendChild(this.fill);
    this.root.append(this.title, this.detail, this.bar);
    document.body.appendChild(this.root);
  }

  show(title        ) {
    this.title.textContent = title;
    this.detail.textContent = "";
    this.detail.style.color = "";
    this.bar.style.display = "block";
    this.fill.style.width = "0%";
    this.root.style.display = "block";
    this.visible = true;
  }

  // `fraction` 0..1 fills the bar; omitted keeps the current fill
  step(detail        , fraction         ) {
    if (!this.visible) {
      return;
    }
    this.detail.textContent = detail;
    if (fraction !== undefined) {
      this.fill.style.width = `${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%`;
    }
  }

  // Stays up with an error instead of a progress bar
  fail(message        ) {
    this.root.style.display = "block";
    this.visible = true;
    this.detail.textContent = message;
    this.detail.style.color = "#f66";
    this.bar.style.display = "none";
  }

  hide() {
    this.root.style.display = "none";
    this.visible = false;
  }
}


//# sourceURL=examples/doom/hud.ts