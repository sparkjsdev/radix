import * as THREE from "three";
import type { WebGPURenderer } from "three/webgpu";
import { TSL, type TslNode } from "../gpu/tsl";
import { splatViewIndex } from "./viewIndex";

const { uint, uniform, uniformArray } = TSL;

const MAX_EYES = 2;

// fromHead is the identity for an eye that is the head
export interface EyeNodes {
  fromHead: TslNode;
  fromHeadQuat: TslNode;
  projection: TslNode;
  isOrtho: TslNode;
  renderSize: TslNode;
  ndcZMin: TslNode;
}

export interface EyeSetting {
  // World to eye
  view: THREE.Matrix4;
  projection: THREE.Matrix4;
  ortho?: boolean;
}

const nodes = {
  fromHeads: uniformArray(Array.from({ length: MAX_EYES }, () => new THREE.Matrix4())),
  fromHeadQuats: uniformArray(Array.from({ length: MAX_EYES }, () => new THREE.Vector4(0, 0, 0, 1))),
  projections: uniformArray(Array.from({ length: MAX_EYES }, () => new THREE.Matrix4())),
  orthos: uniformArray(new Array<number>(MAX_EYES).fill(0), "uint"),
  renderSize: uniform(new THREE.Vector2(1, 1)),
  // Near plane NDC depth: -1 in WebGL's clip convention, 0 in WebGPU's
  ndcZMin: uniform(0),
};

// Clip z from WebGL's -w..w to WebGPU's 0..w, and back
const TO_WEBGPU = new THREE.Matrix4().set(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
const TO_WEBGL = TO_WEBGPU.clone().invert();

// The render's camera as uniforms shared by every program and draw
export class SplatCamera {
  // The eye being drawn, in a draw's shaders
  static readonly viewIndex: TslNode = splatViewIndex;

  // Eyes of the latest set()
  static eyes = 1;
  // World to head of the latest set()
  static readonly head = new THREE.Matrix4();

  static eye(v: number | TslNode): EyeNodes {
    const at = typeof v === "number" ? uint(v) : v;
    return {
      fromHead: nodes.fromHeads.element(at),
      fromHeadQuat: nodes.fromHeadQuats.element(at),
      projection: nodes.projections.element(at),
      isOrtho: nodes.orthos.element(at).notEqual(uint(0)),
      renderSize: nodes.renderSize,
      ndcZMin: nodes.ndcZMin,
    };
  }

  // An eye in the renderer's other clip convention is converted in the uniforms only
  static set(renderer: WebGPURenderer, camera: THREE.Camera) {
    const array = camera as THREE.ArrayCamera;
    const cameras = array.isArrayCamera && array.cameras.length > 0 ? array.cameras : [camera];
    const count = Math.min(cameras.length, MAX_EYES);
    camera.updateMatrixWorld();

    // Eyes share one size: an ArrayCamera's first viewport, else the render
    // target, else the canvas viewport
    const size = scratch.size;
    const viewport = (cameras[0] as { viewport?: THREE.Vector4 }).viewport;
    const target = renderer.getRenderTarget();
    if (viewport && array.isArrayCamera) {
      size.set(viewport.z, viewport.w);
    } else if (target) {
      size.set(target.width, target.height);
    } else {
      renderer.getDrawingBufferSize(size);
      const canvas = renderer.getViewport(scratch.viewport);
      const full = renderer.getSize(scratch.canvas);
      if (canvas.z !== full.x || canvas.w !== full.y) {
        const ratio = renderer.getPixelRatio();
        size.set(Math.floor(canvas.z * ratio), Math.floor(canvas.w * ratio));
      }
    }

    const webgpu = renderer.coordinateSystem === THREE.WebGPUCoordinateSystem;
    scratch.eyes.length = count;
    for (let v = 0; v < count; v += 1) {
      const eye = cameras[v];
      eye.updateMatrixWorld();
      scratch.eyes[v] ??= { view: new THREE.Matrix4(), projection: new THREE.Matrix4() };
      const setting = scratch.eyes[v];
      setting.view.copy(eye.matrixWorld).invert();
      // XR eyes carry the headset's projections, in the renderer's convention
      const converted = !renderer.xr.isPresenting && eye.coordinateSystem !== renderer.coordinateSystem;
      setting.projection.copy(eye.projectionMatrix);
      if (converted) {
        setting.projection.premultiply(webgpu ? TO_WEBGPU : TO_WEBGL);
      }
      setting.ortho = (eye as THREE.OrthographicCamera).isOrthographicCamera === true;
    }
    SplatCamera.setViews({ head: scratch.head.copy(camera.matrixWorld).invert(), eyes: scratch.eyes, size, ndcZMin: webgpu ? 0 : -1 });
  }

  // head and each eye's view map world to view
  static setViews({ head, eyes, size, ndcZMin }: { head: THREE.Matrix4; eyes: EyeSetting[]; size: THREE.Vector2; ndcZMin: number }) {
    if (eyes.length < 1 || eyes.length > MAX_EYES) {
      throw new Error(`SplatCamera: 1 or ${MAX_EYES} eyes, not ${eyes.length}`);
    }
    SplatCamera.eyes = eyes.length;
    SplatCamera.head.copy(head);
    const headWorld = scratch.headWorld.copy(head).invert();
    eyes.forEach(({ view, projection, ortho = false }, v) => {
      // Exactly the identity for an eye that is the head
      const fromHead = view.equals(head) ? scratch.fromHead.identity() : scratch.fromHead.multiplyMatrices(view, headWorld);
      (nodes.fromHeads.array[v] as THREE.Matrix4).copy(fromHead);
      fromHead.decompose(scratch.position, scratch.quaternion, scratch.scale);
      const q = scratch.quaternion;
      (nodes.fromHeadQuats.array[v] as THREE.Vector4).set(q.x, q.y, q.z, q.w);
      (nodes.projections.array[v] as THREE.Matrix4).copy(projection);
      nodes.orthos.array[v] = ortho ? 1 : 0;
    });
    (nodes.renderSize.value as THREE.Vector2).copy(size);
    nodes.ndcZMin.value = ndcZMin;
  }
}

const scratch = {
  head: new THREE.Matrix4(),
  headWorld: new THREE.Matrix4(),
  size: new THREE.Vector2(),
  viewport: new THREE.Vector4(),
  canvas: new THREE.Vector2(),
  eyes: [] as EyeSetting[],
  fromHead: new THREE.Matrix4(),
  position: new THREE.Vector3(),
  quaternion: new THREE.Quaternion(),
  scale: new THREE.Vector3(),
};
