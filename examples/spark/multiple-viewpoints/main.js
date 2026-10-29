// Spark's multiple-viewpoints: a turning butterfly seen from the main camera
// and from two more cameras, each rendered into a texture shown on a screen
// near the main camera. One SplatRenderer draws all three (on the CPU sort,
// each camera gets its own view and order). The sliders move the two cameras
// sideways without turning them; only their arrows turn.
import * as THREE from "three";
import { asset, loadGlb } from "../js/assets.js";
import { SplatSet } from "../js/objects.js";
import { examplePage, windowRenderer } from "../js/page.js";

const page = examplePage("multiple-viewpoints");

const scene = new THREE.Scene();
const background = new THREE.Color();
scene.background = background;
const camera = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.1, 1000);

// createRenderer, sized to the window and added to the page; it follows
// window resizes, the camera's aspect too (js/page.ts)
const renderer = await windowRenderer(camera);

const splats = new SplatSet({ renderer, scene });
const butterfly = await splats.load(asset("butterfly.spz"), { onProgress: page.progress("butterfly") });
butterfly.rotation.x = Math.PI;
butterfly.position.set(0, 0, -3);

const arrow = (await loadGlb("arrow.glb")).children[0]              ;
const MATCAPS = "https://raw.githubusercontent.com/nidorx/matcaps/master/128/";

// A camera at `origin` with its arrow and slider, drawn on a screen at
// `screenAt` (in units of the near distance) over `color`. Its screen is in
// the scene it renders, so it renders into two targets in turn (Spark's
// doubleBuffer).
function viewpoint(origin               , screenAt                  , slider        , matcap        , color        ) {
  const width = 320;
  const height = 240;
  const targets = [0, 1].map(() => new THREE.RenderTarget(width, height));
  const screen = new THREE.Mesh(
    new THREE.PlaneGeometry(0.5 * camera.near, (0.5 * camera.near * height) / width),
    new THREE.MeshBasicMaterial({ map: targets[0].texture }),
  );
  screen.position.set(...screenAt, -1).multiplyScalar(camera.near);
  scene.add(screen);

  const view = new THREE.PerspectiveCamera(75, width / height, 0.1, 1000);
  view.position.copy(origin);
  view.lookAt(butterfly.position);

  const pointer = arrow.clone();
  pointer.material = new THREE.MeshMatcapMaterial({ matcap: new THREE.TextureLoader().load(MATCAPS + matcap) });
  scene.add(pointer);
  const aim = () => {
    pointer.position.copy(view.position);
    pointer.lookAt(butterfly.position);
  };
  aim();
  document.getElementById(slider) .addEventListener("input", (event) => {
    view.position.x = Number((event.target                    ).value) / 100;
    aim();
  });

  let back = 1;
  return () => {
    background.set(color);
    renderer.setRenderTarget(targets[back]);
    renderer.render(scene, view);
    renderer.setRenderTarget(null);
    screen.material.map = targets[back].texture;
    back = 1 - back;
  };
}

const viewpoints = [
  viewpoint(new THREE.Vector3(0, 1.5, -3), [-0.5, 0.5], "camera1", "1A2461_3D70DB_2C3C8F_2C6CAC-128px.png", 0x202040),
  viewpoint(new THREE.Vector3(0.5, -1, -3), [0.5, -0.5], "camera2", "9D282A_38191D_DFC6CD_D6495A-128px.png", 0x302020),
];
page.ready(renderer);

let last                    ;
renderer.setAnimationLoop((time) => {
  const delta = last === undefined ? 0 : Math.min((time - last) / 1000, 0.1);
  last = time;
  butterfly.rotation.y += delta * 0.4;

  background.set(0x000000);
  renderer.render(scene, camera);
  viewpoints.forEach((render) => render());
});


//# sourceURL=examples/spark/multiple-viewpoints/main.ts