import * as THREE from "three";
import { Line2NodeMaterial } from "three/webgpu";
import { LineSegments2 } from "three/examples/jsm/lines/webgpu/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import { TSL } from "@sparkjsdev/radix";

const { abs, clamp, float, length, materialLineWidth, max, uniform, uv, vec2 } = TSL;

const EDGES = 12;

// A transparent Line2NodeMaterial composites over a copy of the opaque pass,
// which has no splats: build it as opaque, keep it transparent for the render list
class BlendedLineMaterial extends Line2NodeMaterial {
  setupDiffuseColor(builder: Parameters<Line2NodeMaterial["setupDiffuseColor"]>[0]) {
    this.transparent = false;
    super.setupDiffuseColor(builder);
    this.transparent = true;
  }
}

function unitBoxSegments() {
  const edges: number[] = [];
  const midlines: number[] = [];
  for (let a = 0; a < 3; a++) {
    const b = (a + 1) % 3;
    const c = (a + 2) % 3;
    const segment = (list: number[], pb: number, pc: number) => {
      const start = [0, 0, 0];
      start[b] = pb;
      start[c] = pc;
      const end = [...start];
      end[a] = 1;
      list.push(...start, ...end);
    };
    for (const [pb, pc] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
      segment(edges, pb, pc);
    }
    for (const [pb, pc] of [[0.5, 0], [0.5, 1], [0, 0.5], [1, 0.5]]) {
      segment(midlines, pb, pc);
    }
  }
  return [...edges, ...midlines];
}

export class BoxLines extends LineSegments2 {
  // width in pixels, hold and fade in seconds
  readonly settings = { width: 2, idle: 0.15, hold: 0.3, fade: 1.0, midlines: true };
  readonly opacity = uniform(1);
  private lastActive = -Infinity;
  private readonly size = new THREE.Vector3();

  constructor(color: THREE.ColorRepresentation = 0xffffff) {
    const geometry = new LineSegmentsGeometry().setPositions(unitBoxSegments());
    // Normal blending spelled out as custom: the shader build would force
    // alpha to 1 for NormalBlending while transparent is off
    const material = new BlendedLineMaterial({
      color,
      transparent: true,
      blending: THREE.CustomBlending,
      blendSrc: THREE.SrcAlphaFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      depthWrite: false,
    });
    super(geometry, material);
    this.renderOrder = 1;
    // Without MSAA the material only cuts the round caps: fade the outer
    // pixel of the line (drawn one pixel wider) by the distance from its axis
    const { x, y } = uv();
    const r = length(vec2(x, max(abs(y).sub(1), 0)));
    material.opacityNode = this.opacity.mul(clamp(float(1).sub(r).mul(materialLineWidth).mul(0.5), 0, 1));
  }

  // Show the lines at full opacity
  touch(now = performance.now()) {
    this.lastActive = now;
  }

  update(walls: THREE.Box3, now = performance.now()) {
    const { settings } = this;
    walls.getSize(this.size);
    if (!walls.min.equals(this.position) || !this.size.equals(this.scale)) {
      this.touch(now);
    }
    this.position.copy(walls.min);
    this.scale.copy(this.size);
    this.material.linewidth = settings.width + 1;
    this.geometry.instanceCount = settings.midlines ? 2 * EDGES : EDGES;
    const idle = (now - this.lastActive) / 1000 - settings.hold;
    const t = settings.fade > 0 ? THREE.MathUtils.smoothstep(idle, 0, settings.fade) : idle > 0 ? 1 : 0;
    this.opacity.value = settings.idle + (1 - settings.idle) * (1 - t);
  }
}
