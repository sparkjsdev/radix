// Splats rendered into a cube map, after Spark's renderEnvMap / renderCubeMap
import * as THREE from "three";
import { CubeRenderTarget, type WebGPURenderer } from "three/webgpu";
import type { SplatRenderer } from "@sparkjsdev/radix";

export async function renderCubeMap({ renderer, scene, splatRenderer, worldCenter, size = 256, hideObjects = [], near = 0.1, far = 1000, target }: {
  renderer: WebGPURenderer;
  scene: THREE.Scene;
  splatRenderer: SplatRenderer;
  worldCenter: THREE.Vector3;
  size?: number;
  hideObjects?: THREE.Object3D[];
  near?: number;
  far?: number;
  target?: CubeRenderTarget;
}) {
  target ??= new CubeRenderTarget(size, { generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter });
  const cubeCamera = new THREE.CubeCamera(near, far, target);
  cubeCamera.position.copy(worldCenter);
  cubeCamera.coordinateSystem = renderer.coordinateSystem;
  cubeCamera.updateCoordinateSystem();
  cubeCamera.updateMatrixWorld(true);

  if (splatRenderer.sortMode === "cpu") {
    await Promise.all(cubeCamera.children.map(async (camera) => {
      const view = splatRenderer.viewFor(camera as THREE.Camera);
      view.apply(await view.sort(camera as THREE.Camera));
    }));
  }

  const hidden = hideObjects.filter((object) => object.visible);
  hidden.forEach((object) => (object.visible = false));
  cubeCamera.update(renderer, scene);
  hidden.forEach((object) => (object.visible = true));
  cubeCamera.children.forEach((camera) => splatRenderer.views.get(camera)?.dispose());
  return target;
}

export async function readCubeTargets(renderer: WebGPURenderer, target: CubeRenderTarget) {
  const { width, height } = target;
  const faces = [];
  for (let face = 0; face < 6; face += 1) {
    faces.push(await renderer.readRenderTargetPixelsAsync(target, 0, 0, width, height, 0, face));
  }
  return faces;
}
