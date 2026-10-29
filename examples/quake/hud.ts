// The 2D layer over the splat view, all from the sim: the software frame as
// a transparent overlay (the worker gives it alpha from the overlay mask, so
// the console, menus, status bar, messages and intermission pages show while
// the 3D view area is see-through) drawn as one splat per pixel
// (FrameSplats) or, for comparison, blitted to a canvas; the palette blend
// (damage, powerups, underwater) as a tint, the control hint, and the
// LoadingPanel shown while a level's splats are not on screen yet.
import * as THREE from "three";
import type { WebGPURenderer } from "three/webgpu";
import { ArrayData, GpuArrayReader, GpuArrays, GpuSplats, SplatCollection, SplatRenderer, TSL, defineBundle, type SplatGenerator, type SplatObject } from "@sparkjsdev/radix";
import type { QuakeGame } from "./game.js";
import { readBlend } from "./sim/QuakeSim.js";

const { float, uint, uniform, vec3, vec4 } = TSL;

// Vanilla 4:3 display of the 320x240 frame
const DISPLAY_ASPECT = 4 / 3;
// Frame splat radius in pixels (the bake's texel splat scale)
const PIXEL_RADIUS = 0.7;
// The frame screen's distance ahead of its view (meters)
const FRAME_DISTANCE = 1;

export type FrameMode = "splats" | "canvas" | "off";

// The engine's 3D view inside the frame (pixels) and its horizontal fov
export interface ViewRect {
  x: number;
  y: number;
  width: number;
  height: number;
  fovX: number;
}

export class QuakeHud {
  readonly root: HTMLDivElement;
  readonly frameSplats: FrameSplats;
  // Show the view model
  showWeapon = true;
  private readonly game: QuakeGame;
  private readonly frame: HTMLCanvasElement;
  private readonly frameContext: CanvasRenderingContext2D;
  private readonly overlay: HTMLCanvasElement;
  private readonly overlayContext: CanvasRenderingContext2D;
  private readonly tint: HTMLDivElement;
  private readonly hint: HTMLDivElement;
  private hintText?: string;
  private drawnVersion = -1;
  private mode: FrameMode = "splats";
  private vanillaFrame = false;

  constructor(game: QuakeGame, renderer: WebGPURenderer, sortMode: "gpu" | "cpu") {
    this.game = game;
    this.frameSplats = new FrameSplats(renderer, sortMode);
    this.root = document.createElement("div");
    this.root.style.cssText = "position:fixed;inset:0;pointer-events:none;";
    document.body.appendChild(this.root);

    this.frame = document.createElement("canvas");
    this.frame.width = game.width;
    this.frame.height = game.height;
    this.frameContext = this.frame.getContext("2d")!;

    this.tint = document.createElement("div");
    this.tint.style.cssText = "position:absolute;inset:0;background:transparent;";
    this.root.appendChild(this.tint);

    this.overlay = document.createElement("canvas");
    this.overlay.style.cssText = "position:absolute;left:0;top:0;width:100%;height:100%;image-rendering:pixelated;";
    this.overlayContext = this.overlay.getContext("2d")!;
    this.root.appendChild(this.overlay);

    this.hint = document.createElement("div");
    this.hint.style.cssText = "position:absolute;left:50%;bottom:22%;transform:translateX(-50%);padding:6px 12px;"
      + "background:rgba(0,0,0,0.6);border-radius:3px;color:white;font:15px monospace;text-shadow:0 1px 2px black;white-space:pre;";
    this.root.appendChild(this.hint);

    addEventListener("resize", () => this.resize());
    this.resize();
  }

  // How the software overlay is shown: as splats, blitted to a canvas, or not
  get frameMode() {
    return this.mode;
  }

  // Redraws the current frame right away, so the switch shows while paused
  set frameMode(mode: FrameMode) {
    this.mode = mode;
    this.drawnVersion = -1;
  }

  // Debug: the whole software frame opaque (the vanilla view) for comparison
  get vanilla() {
    return this.vanillaFrame;
  }

  set vanilla(on: boolean) {
    this.vanillaFrame = on;
    this.game.setOpaqueFrame(on);
  }

  private updateHint() {
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
            ? "Quake menu: arrows/Enter, Esc closes  -  click to capture the mouse"
            : game.consoleActive
              ? "Quake console: ` closes  -  click to capture the mouse"
              : "click to capture the mouse   `: console   \\: pause / free fly";
    } else if (game.userPaused) {
      text = "PAUSED  -  free fly: WASD + mouse, shift run, ctrl slow   \\: play   Esc: release the mouse";
    }
    if (text !== this.hintText) {
      this.hintText = text;
      this.hint.textContent = text;
      this.hint.style.display = text ? "block" : "none";
    }
  }

  private resize() {
    this.overlay.width = innerWidth;
    this.overlay.height = innerHeight;
    this.drawnVersion = -1;
  }

  // Per frame, after the game update. `frozen` is the camera pose following
  // ended at (free fly: the screen stays there, in the world), else the
  // screen is drawn over the world from the camera
  update(camera: THREE.PerspectiveCamera, frozen: THREE.Matrix4 | undefined, rect: ViewRect) {
    const { game } = this;
    if (game.frame && game.frameVersion !== this.drawnVersion) {
      this.drawnVersion = game.frameVersion;
      if (this.frameMode === "splats") {
        this.frameSplats.update(game.frame);
      }
      this.blit(game.frame);
    }
    this.frameSplats.place(camera, frozen, rect, this.frameMode === "splats" && !!game.frame);
    this.updateTint();
    this.updateHint();
  }

  private blit(frame: ImageData) {
    const { overlayContext: context, overlay } = this;
    context.imageSmoothingEnabled = false;
    context.clearRect(0, 0, overlay.width, overlay.height);
    if (this.frameMode !== "canvas") {
      return;
    }
    this.frameContext.putImageData(frame, 0, 0);
    let width = overlay.width;
    let height = width / DISPLAY_ASPECT;
    if (height > overlay.height) {
      height = overlay.height;
      width = height * DISPLAY_ASPECT;
    }
    context.drawImage(this.frame, 0, 0, frame.width, frame.height, (overlay.width - width) / 2, (overlay.height - height) / 2, width, height);
  }

  // V_UpdatePalette's color shifts as one tint over the 3D view (the 2D
  // overlay pixels already come palette-shifted from the software renderer)
  private updateTint() {
    let css = "transparent";
    if (this.game.inLevel && !this.vanillaFrame) {
      const [r, g, b, a] = readBlend(this.game.curr);
      if (a > 0.002) {
        css = `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${a.toFixed(3)})`;
      }
    }
    if (this.tint.style.background !== css) {
      this.tint.style.background = css;
    }
  }

  dispose() {
    this.frameSplats.dispose();
    this.root.remove();
  }
}

const PIXELS = defineBundle({ rgba: "uint8x4" });

interface FrameData {
  pixels: GpuArrays;
  width: number;
  height: number;
}

// Pixel i of a width x height grid at (col + 0.5, height - row - 0.5, 0) in
// pixel units, colored by the frame (alpha 0 where the 3D view shows)
function frameGenerator(): SplatGenerator<FrameData> {
  const reader = new GpuArrayReader(PIXELS);
  const width = uniform(320, "uint");
  const height = uniform(240, "uint");
  return {
    generateSplat: (i) => {
      const index = uint(i);
      const col = float(index.mod(width));
      const row = float(index.div(width));
      const rgba = vec4(reader.load("rgba", index)).div(255.0).toVar();
      const center = vec3(col.add(0.5), float(height).sub(row).sub(0.5), 0.0);
      return GpuSplats.Splat(center, vec3(PIXEL_RADIUS, PIXEL_RADIUS, PIXEL_RADIUS * 0.1), vec4(0, 0, 0, 1), rgba.rgb, rgba.a, index);
    },
    bind: (data) => {
      reader.bind(data.pixels, "pixels");
      width.value = data.width;
      height.value = data.height;
    },
  };
}

// The software frame as splats: one per pixel on a fixed grid, placed as a
// screen FRAME_DISTANCE ahead of a view and sized so that pixel columns span
// the engine's fov across the view rect, centered on its optical axis. Seen
// through the matching camera projection (main.ts) it covers exactly the
// letterboxed 4:3 frame at any window size. While following it is drawn by
// its own renderer (`splats`) from `camera`, a camera at the origin with
// the main camera's projection, over the world; in free fly `worldObject`
// is the same screen where the player was, for the world's renderer to draw
// (sorted and occluded with the world). A new frame only uploads its pixels.
export class FrameSplats {
  readonly splats: SplatRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera();
  // The screen in the world (free fly), else undefined
  worldObject?: SplatObject<FrameData>;
  private readonly generator = frameGenerator();
  private readonly data = new ArrayData({ count: 320 * 240 }).addBundle("pixels", PIXELS);
  private readonly pixels: GpuArrays;
  private readonly matrixWorld = new THREE.Matrix4();
  private object?: SplatObject<FrameData>;
  private width = 0;
  private height = 0;

  constructor(renderer: WebGPURenderer, sortMode: "gpu" | "cpu") {
    this.pixels = GpuArrays.fromData(renderer, this.data);
    // One fixed viewpoint: on the CPU sort, sorted once and kept
    this.splats = new SplatRenderer({ renderer, sortMode, viewKey: () => "hud" });
    this.scene.add(this.splats);
    this.camera.matrixAutoUpdate = false;
  }

  // New software frame: its RGBA
  update(frame: ImageData) {
    if (frame.width !== this.width || frame.height !== this.height) {
      this.width = frame.width;
      this.height = frame.height;
      this.data.setCapacity(frame.width * frame.height);
      this.object = SplatCollection.object({
        generator: this.generator, data: { pixels: this.pixels, width: frame.width, height: frame.height }, count: frame.width * frame.height, matrixWorld: this.matrixWorld,
      });
    }
    this.data.count = frame.width * frame.height;
    this.data.bundles.pixels.channels.rgba.data.set(frame.data);
    this.pixels.upload(this.data);
  }

  // Places the screen ahead of the camera, or of `frozen` in the world;
  // hidden unless `show`
  place(camera: THREE.PerspectiveCamera, frozen: THREE.Matrix4 | undefined, rect: ViewRect, show: boolean) {
    const object = show ? this.object : undefined;
    const pixel = (2 * FRAME_DISTANCE * Math.tan(THREE.MathUtils.degToRad(rect.fovX / 2))) / rect.width;
    const cx = rect.x + rect.width / 2;
    const cy = this.height - (rect.y + rect.height / 2);
    this.matrixWorld.copy(frozen ?? IDENTITY)
      .multiply(offset.makeTranslation(0, 0, -FRAME_DISTANCE))
      .multiply(scale.makeScale(pixel, pixel, pixel))
      .multiply(center.makeTranslation(-cx, -cy, 0));
    this.worldObject = frozen ? object : undefined;
    const collection = !frozen && object ? [object] : [];
    if (collection[0] !== this.splats.collection.objects[0]?.object || collection.length !== this.splats.collection.objects.length) {
      this.splats.collection = new SplatCollection(collection);
    }
    this.camera.projectionMatrix.copy(camera.projectionMatrix);
    this.camera.projectionMatrixInverse.copy(camera.projectionMatrixInverse);
  }

  // Over the world (following only): color kept
  render(renderer: WebGPURenderer) {
    if (this.splats.collection.count === 0) {
      return;
    }
    const clear = renderer.autoClearColor;
    renderer.autoClearColor = false;
    renderer.render(this.scene, this.camera);
    renderer.autoClearColor = clear;
  }

  dispose() {
    this.splats.dispose();
    this.pixels.dispose();
  }
}

const IDENTITY = new THREE.Matrix4();
const offset = new THREE.Matrix4();
const scale = new THREE.Matrix4();
const center = new THREE.Matrix4();

// Centered progress panel for the phases where nothing (or only part of the
// world) can be shown yet: boot, model atlas, scene loading, the first LoD
// selection
export class LoadingPanel {
  readonly root: HTMLDivElement;
  private readonly title: HTMLDivElement;
  private readonly detail: HTMLDivElement;
  private readonly bar: HTMLDivElement;
  private readonly fill: HTMLDivElement;
  visible = false;

  constructor() {
    this.root = document.createElement("div");
    this.root.style.cssText = "position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);min-width:340px;max-width:80vw;"
      + "padding:14px 18px;background:rgba(0,0,0,0.75);border:1px solid rgba(255,255,255,0.25);border-radius:4px;"
      + "color:white;font:14px monospace;text-shadow:0 1px 2px black;pointer-events:none;display:none;z-index:10;";
    this.title = document.createElement("div");
    this.title.style.cssText = "font-size:16px;margin-bottom:8px;";
    this.detail = document.createElement("div");
    this.detail.style.cssText = "opacity:0.85;margin-bottom:8px;white-space:pre-wrap;";
    this.bar = document.createElement("div");
    this.bar.style.cssText = "height:8px;background:rgba(255,255,255,0.15);border-radius:2px;overflow:hidden;";
    this.fill = document.createElement("div");
    this.fill.style.cssText = "height:100%;width:0%;background:#a63;transition:width 0.15s linear;";
    this.bar.appendChild(this.fill);
    this.root.append(this.title, this.detail, this.bar);
    document.body.appendChild(this.root);
  }

  show(title: string) {
    this.title.textContent = title;
    this.detail.textContent = "";
    this.detail.style.color = "";
    this.bar.style.display = "block";
    this.fill.style.width = "0%";
    this.root.style.display = "block";
    this.visible = true;
  }

  step(detail: string, fraction?: number) {
    if (!this.visible) {
      return;
    }
    this.detail.textContent = detail;
    if (fraction !== undefined) {
      this.fill.style.width = `${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%`;
    }
  }

  fail(message: string) {
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
