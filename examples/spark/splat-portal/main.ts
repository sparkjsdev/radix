// Spark's splat-portal: two separate worlds, each with a circular portal
// showing the other; walk through to switch worlds. Each world is its own
// scene with its own SplatRenderer; each frame renders the other world from
// the linked camera into a render target, which the portal's TSL material
// samples. Spark's world B is Sutro, a SOGS zip Radix cannot read: here it
// is the fireplace scan.
import * as THREE from "three";
import { MeshBasicNodeMaterial } from "three/webgpu";
import { CameraControls, SplatCollection, SplatRenderer, TSL } from "@sparkjsdev/radix";
import { asset } from "../js/assets.js";
import { examplePage, windowRenderer } from "../js/page.js";
import { fileObject, loadSplatFile } from "../js/files.js";

const { Discard, Fn, clamp, float, length, max, normalize, positionLocal, positionWorld, sin, smoothstep, texture, uniform, vec2, vec4 } = TSL;

const page = examplePage("splat-portal");
page.legend("WASD + mouse to move, go through the portal to switch worlds");

const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.01, 2000);
camera.position.set(0, 1, 3);

// createRenderer, sized to the window and added to the page; it follows
// window resizes, the camera's aspect too (js/page.ts)
const renderer = await windowRenderer(camera, { antialias: true, pixelRatio: devicePixelRatio });
const controls = new CameraControls({ canvas: renderer.domElement, object: camera });
controls.lookAt(new THREE.Vector3(0, 1, 0));

// A world: a scene with its own splat renderer drawing one scan, placed by
// the Object3D `holder`
async function world(name: string, holder: THREE.Object3D) {
  const file = await loadSplatFile(renderer, asset(name), { onProgress: page.progress(name) });
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);
  const splats = new SplatRenderer({ renderer });
  splats.collection = new SplatCollection([fileObject(file, { matrixWorld: holder.matrixWorld })]);
  scene.add(splats, holder);
  return scene;
}

const valley = new THREE.Object3D();
valley.rotateX(Math.PI);
const sceneA = await world("valley.spz", valley);

const fireplace = new THREE.Object3D();
fireplace.rotateX(Math.PI);
fireplace.position.set(0, -0.5, -11);
const sceneB = await world("fireplace.spz", fireplace);

const RADIUS = 0.6;
const time = uniform(0);
const size = (): [number, number] => [Math.max(1, Math.floor(innerWidth * renderer.getPixelRatio())), Math.max(1, Math.floor(innerHeight * renderer.getPixelRatio()))];

// A portal in `world` showing its target: the other world seen by its
// camera. `toOther` maps this world's points through the portal into the
// other's; `clip` is the camera's world to clip transform.
function portal(world: THREE.Scene, position: THREE.Vector3, turn: number) {
  const target = new THREE.RenderTarget(...size(), { depthBuffer: true });
  const toOther = uniform(new THREE.Matrix4());
  const clip = uniform(new THREE.Matrix4());

  const material = new MeshBasicNodeMaterial({ side: THREE.DoubleSide });
  material.colorNode = Fn(() => {
    const local = positionLocal.xy;
    const r = length(local).toVar();
    Discard(r.greaterThan(RADIUS));
    const offset = normalize(local).mul(sin(r.mul(50).sub(time.mul(10))).mul(0.001)).toVar();
    const projected = clip.mul(toOther.mul(vec4(positionWorld, 1))).toVar();
    const ndc = projected.xy.div(max(projected.w, 1e-6)).toVar();
    // TSL samples render targets with v down on both backends (Spark's GLSL: up)
    const uv = clamp(vec2(ndc.x, ndc.y.negate()).mul(0.5).add(0.5).add(offset), 0, 1);
    const color = texture(target.texture, uv).add(offset.x.mul(50)).toVar();
    const edgeFade = float(1).sub(smoothstep(RADIUS * 0.8, RADIUS, r));
    return vec4(color.xyz.mul(edgeFade.add(0.1)), 1);
  })();

  const mesh = new THREE.Mesh(new THREE.CircleGeometry(RADIUS, 64), material);
  mesh.renderOrder = 1000;
  mesh.position.copy(position);
  mesh.rotation.y = turn;
  mesh.updateMatrixWorld(true);
  world.add(mesh);
  return { mesh, world, target, toOther: toOther.value as THREE.Matrix4, clip: clip.value as THREE.Matrix4, camera: new THREE.PerspectiveCamera() };
}

type Portal = ReturnType<typeof portal>;
const portalA = portal(sceneA, new THREE.Vector3(0, 1, -2), 0);
const portalB = portal(sceneB, new THREE.Vector3(-1, 1, -5), Math.PI);
const pairs = [[portalA, portalB], [portalB, portalA]] as const;
addEventListener("resize", () => [portalA, portalB].forEach(({ target }) => target.setSize(...size())));

// Through a portal: other * Ry(PI) * this^-1 (the portals do not move)
const rotY180 = new THREE.Matrix4().makeRotationY(Math.PI);
for (const [from, to] of pairs) {
  from.toOther.copy(from.mesh.matrixWorld).invert().premultiply(rotY180).premultiply(to.mesh.matrixWorld);
}

// The main camera carried through `from`, kept within 3 of the other portal
function linkCamera(from: Portal, to: Portal) {
  const linked = from.camera;
  linked.matrixWorld.copy(camera.matrixWorld).premultiply(from.toOther);
  linked.matrixWorld.decompose(linked.position, linked.quaternion, linked.scale);
  linked.position.sub(to.mesh.position).clampLength(0, 3).add(to.mesh.position);
  linked.projectionMatrix.copy(camera.projectionMatrix);
  linked.projectionMatrixInverse.copy(camera.projectionMatrixInverse);
  linked.updateMatrixWorld(true);
  from.clip.multiplyMatrices(linked.projectionMatrix, linked.matrixWorldInverse);
}

let here = portalA;
let lastSide = -1;
let cooldown = 0;
page.ready(renderer);

// Crossing this world's portal (from one side to the other, or into its
// middle) moves the camera into the other world
function crossPortal(delta: number) {
  cooldown -= delta;
  if (cooldown > 0) {
    return;
  }
  const local = here.mesh.worldToLocal(camera.position.clone());
  const side = Math.sign(local.z);
  const close = Math.abs(local.z) < 0.3 && Math.hypot(local.x, local.y) <= RADIUS * 1.2;
  if (close && ((lastSide !== 0 && side !== lastSide) || Math.abs(local.z) < 0.1)) {
    camera.matrixWorld.premultiply(here.toOther);
    camera.matrixWorld.decompose(camera.position, camera.quaternion, camera.scale);
    camera.position.add(new THREE.Vector3(0, 0, -0.2).applyQuaternion(camera.quaternion));
    camera.updateMatrixWorld(true);
    here = here === portalA ? portalB : portalA;
    cooldown = 0.5;
  }
  lastSide = side;
}

let last: number | undefined;
renderer.setAnimationLoop((now) => {
  const delta = last === undefined ? 0 : Math.min((now - last) / 1000, 0.1);
  last = now;
  controls.update();
  time.value = now / 1000;
  camera.updateMatrixWorld(true);

  // The other worlds into the targets, portals hidden
  portalA.mesh.visible = portalB.mesh.visible = false;
  for (const [from, to] of pairs) {
    linkCamera(from, to);
    renderer.setRenderTarget(from.target);
    renderer.render(to.world, from.camera);
  }
  renderer.setRenderTarget(null);
  portalA.mesh.visible = portalB.mesh.visible = true;

  crossPortal(delta);
  renderer.render(here.world, camera);
});
