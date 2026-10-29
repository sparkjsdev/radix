// The assets of the Spark examples (Spark's examples/assets.json). Every
// host sends access-control-allow-origin: *, so pages load them directly.
// ?assets=<base> loads them from a local copy instead: <base>/<name>.
import * as THREE from "three";

const SPARK = "https://sparkjs.dev/assets";
const FORGE = "https://storage.googleapis.com/forge-dev-public";

const ASSETS                         = {
  "arrow.glb": `${SPARK}/models/arrow.glb`,
  "dali-env.glb": `${SPARK}/models/dali-env.glb`,
  "dali-table.glb": `${SPARK}/models/dali-table.glb`,
  "rubberduck.glb": `${SPARK}/models/rubberduck.glb`,
  "table.glb": `${SPARK}/models/table.glb`,

  "butterfly.png": `${SPARK}/images/butterfly.png`,
  "heart.png": `${SPARK}/images/heart.png`,
  "sky.jpeg": `${SPARK}/images/sky.jpeg`,
  "star.png": `${SPARK}/images/star.png`,

  "butterfly.spz": `${SPARK}/splats/butterfly.spz`,
  "butterfly-ai.spz": `${SPARK}/splats/butterfly-ai.spz`,
  "butterfly-wings-closed.spz": `${SPARK}/splats/butterfly-wings-closed.spz`,
  "cat.spz": `${SPARK}/splats/cat.spz`,
  "dessert.spz": `${SPARK}/splats/dessert.spz`,
  "distant-igloo.spz": `${SPARK}/splats/distant-igloo.spz`,
  "fireplace.spz": `${SPARK}/splats/fireplace.spz`,
  "fly.spz": `${SPARK}/splats/fly.spz`,
  "forge.spz": `${SPARK}/splats/forge.spz`,
  "furry-logo-pedestal.spz": `${SPARK}/splats/furry-logo-pedestal.spz`,
  "penguin.spz": `${SPARK}/splats/penguin.spz`,
  "robot-head.spz": `${SPARK}/splats/robot-head.spz`,
  "snow-street.spz": `${SPARK}/splats/snow-street.spz`,
  "valley.spz": `${SPARK}/splats/valley.spz`,
  "woobles.spz": `${SPARK}/splats/woobles.spz`,

  "branzino-amarin.spz": `${SPARK}/splats/food/branzino-amarin.spz`,
  "burger-from-amboy.spz": `${SPARK}/splats/food/burger-from-amboy.spz`,
  "clams-and-caviar-by-ikoyi.spz": `${SPARK}/splats/food/clams-and-caviar-by-ikoyi.spz`,
  "coral-caviar.spz": `${SPARK}/splats/food/coral-caviar.spz`,
  "double-double-from-InNOut.spz": `${SPARK}/splats/food/double-Double-from-InNOut.spz`,
  "gyro.spz": `${SPARK}/splats/food/gyro.spz`,
  "iberico-sandwich-by-reserve.spz": `${SPARK}/splats/food/iberico-sandwich-by-reserve.spz`,
  "pad-thai.spz": `${SPARK}/splats/food/pad-thai.spz`,
  "primerib-tamos.spz": `${SPARK}/splats/food/primerib-tamos.spz`,
  "steaksandwich-mels.spz": `${SPARK}/splats/food/steaksandwich-mels.spz`,
  "tomahawk-niku.spz": `${SPARK}/splats/food/tomahawk-niku.spz`,

  "greyscale-bedroom.spz": `${FORGE}/marble-scenes/greyscale-room.spz`,
  "painted-bedroom.spz": `${FORGE}/painted_bedroom.spz`,
  "cozy-cottage-lod.spz": `${FORGE}/asundqui/cozy-xr/cozy_cottage-lod.spz`,
};

const localBase = new URLSearchParams(location.search).get("assets");

// The URL of one of the examples' assets
export function asset(name        ) {
  if (!ASSETS[name]) {
    throw new Error(`Unknown asset ${name}`);
  }
  return localBase ? `${localBase.replace(/\/$/, "")}/${name}` : ASSETS[name];
}

                                                                                        

// A GLB asset's scene. `unlit` swaps its materials for unlit ones (Spark's
// loadDelitGLB); "env" also turns them inside out with a linear texture, for
// environment spheres.
export async function loadGlb(name        , { unlit }                              = {}) {
  const { GLTFLoader } = await import("three/addons/loaders/GLTFLoader.js");
  const { scene } = await new GLTFLoader().loadAsync(asset(name));
  if (!unlit) {
    return scene;
  }

  scene.traverse((object) => {
    const mesh = object                                                 ;
    if (!mesh.isMesh) {
      return;
    }
    const material = new THREE.MeshBasicMaterial({ map: mesh.material.map ?? null });
    if (mesh.material.color) {
      material.color.copy(mesh.material.color);
    }
    if (unlit === "env") {
      material.side = THREE.BackSide;
      if (material.map) {
        material.map.colorSpace = THREE.LinearSRGBColorSpace;
        material.map.needsUpdate = true;
      }
    }
    mesh.material = material;
  });
  return scene;
}


//# sourceURL=examples/spark/js/assets.ts