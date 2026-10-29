// Splats rendered into a cube map (Spark's renderEnvMap / renderCubeMap): a
// CubeCamera renders the scene once per face, and each render projects and
// sorts for that face. On the CPU sort (WebGL2) each face camera has its own
// view: it is sorted and applied first, so one update draws every face.
import * as THREE from "three";
import { CubeRenderTarget,                     } from "three/webgpu";
                                                       

export async function renderCubeMap({ renderer, scene, splatRenderer, worldCenter, size = 256, hideObjects = [], near = 0.1, far = 1000, target }   
                           
                     
                               
                             
                
                                 
                
               
                            
 ) {
  target ??= new CubeRenderTarget(size, { generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter });
  const cubeCamera = new THREE.CubeCamera(near, far, target);
  cubeCamera.position.copy(worldCenter);
  cubeCamera.coordinateSystem = renderer.coordinateSystem;
  cubeCamera.updateCoordinateSystem();
  cubeCamera.updateMatrixWorld(true);

  if (splatRenderer.sortMode === "cpu") {
    await Promise.all(cubeCamera.children.map(async (camera) => {
      const view = splatRenderer.viewFor(camera                );
      view.apply(await view.sort(camera                ));
    }));
  }

  const hidden = hideObjects.filter((object) => object.visible);
  hidden.forEach((object) => (object.visible = false));
  cubeCamera.update(renderer, scene);
  hidden.forEach((object) => (object.visible = true));
  cubeCamera.children.forEach((camera) => splatRenderer.views.get(camera)?.dispose());
  return target;
}

// The six faces' pixels (RGBA8) of a cube target, read back
export async function readCubeTargets(renderer                , target                  ) {
  const { width, height } = target;
  const faces = [];
  for (let face = 0; face < 6; face += 1) {
    faces.push(await renderer.readRenderTargetPixelsAsync(target, 0, 0, width, height, 0, face));
  }
  return faces;
}


//# sourceURL=examples/spark/js/cube.ts