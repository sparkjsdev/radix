// Spark's webxr: the valley in VR with tracked hands drawn as splats, each
// fingertip carrying a colored, wobbling sphere that lights the splats it
// touches. The hands are a TSL generator reading the joints from a uniform
// array (Spark's makeJointSplats), drawn by their own SplatRenderer so the
// edits skip them (Spark's editable = false); the fingertip spheres are an
// SdfEdit (js/sdf.js) in the valley renderer's world modifier. On the
// desktop it shows the valley; hands need a headset or an emulator.
import * as THREE from "three";
import { CameraControls, GpuSplats, SplatCollection, SplatRenderer, TSL, type SplatGenerator } from "@sparkjsdev/radix";
import { asset } from "../js/assets.js";
import { examplePage, windowRenderer } from "../js/page.js";
import { SdfBlend, SdfEdit, SdfSphere, sdfModifier } from "../js/sdf.js";
import { fileObject, loadSplatFile } from "../js/files.js";
import { setupXr, xrBackend } from "../js/xr.js";

const { float, select, uint, uniformArray, vec3, vec4 } = TSL;

const page = examplePage("webxr");

// The controls move the camera, and in XR its parent, the local frame
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 1000);
const localFrame = new THREE.Group();
localFrame.add(camera);
scene.add(localFrame);

// createRenderer, sized to the window and added to the page; it follows
// window resizes, the camera's aspect too (js/page.ts)
const renderer = await windowRenderer(camera, { xr: true, backend: xrBackend() });
const controls = new CameraControls({ canvas: renderer.domElement, object: camera });

const edit = new SdfEdit({ rgbaBlendMode: SdfBlend.ADD_RGBA, sdfSmooth: 0.02, softEdge: 0.02, maxSdfs: 10 });
localFrame.add(edit);

// The valley with the edits, the hands in a renderer of their own; both
// move by uniforms the CPU sort cannot see
const splats = new SplatRenderer({ renderer, params: { maxStdDev: Math.sqrt(5) }, modifier: sdfModifier([edit]), modifierSpace: "world" });
const handSplats = new SplatRenderer({ renderer, params: { maxStdDev: Math.sqrt(5) } });
scene.add(splats, handSplats);
setupXr(renderer, [splats, handSplats], controls, { optionalFeatures: ["hand-tracking"] });

const valley = new THREE.Object3D();
valley.quaternion.set(1, 0, 0, 0);
valley.scale.setScalar(0.5);
scene.add(valley);
const file = await loadSplatFile(renderer, asset("valley.spz"), { onProgress: page.progress("valley") });
splats.collection = new SplatCollection([fileObject(file, { matrixWorld: valley.matrixWorld })]);

// Both hands' 25 joints: position and radius (0: not tracked), in the
// reference space the local frame places
const JOINTS = 25;
const joints = Array.from({ length: JOINTS * 2 }, () => new THREE.Vector4());
const uJoints = uniformArray(joints, "vec4");
const handGenerator: SplatGenerator = {
  generateSplat(index) {
    const joint = uJoints.element(index).toVar();
    const radius = joint.w.mul(0.6);
    return GpuSplats.Splat(joint.xyz, vec3(radius), vec4(0, 0, 0, 1), vec3(0.9, 0.85, 0.8), select(joint.w.greaterThan(0), float(0.9), float(0)), uint(index));
  },
};
const hands = new THREE.Object3D();
localFrame.add(hands);
handSplats.collection = new SplatCollection([{ generator: handGenerator, count: JOINTS * 2, matrixWorld: hands.matrixWorld }]);

// A sphere per fingertip, its color by finger as in Spark's example
const TIPS = ["thumb-tip", "index-finger-tip", "middle-finger-tip", "ring-finger-tip", "pinky-finger-tip"];
const tips = new Map<string, { sdf: SdfSphere; finger: number }>();
for (const hand of ["left", "right"]) {
  TIPS.forEach((tip, finger) => {
    const sdf = new SdfSphere({ radius: 0.03, color: new THREE.Color(finger < 3 ? 1 : 0, finger % 2, finger > 1 ? 1 : 0), opacity: 0 });
    sdf.visible = false;
    edit.add(sdf);
    tips.set(`${hand}-${tip}`, { sdf, finger });
  });
}
page.ready(renderer);

const lastCameraPos = new THREE.Vector3();
renderer.setAnimationLoop((time, xrFrame) => {
  controls.update();

  // A large jump of the head (a new session's origin) moves the frame back
  if (lastCameraPos.distanceTo(camera.position) > 0.5) {
    localFrame.position.copy(camera.position).multiplyScalar(-1);
  }
  lastCameraPos.copy(camera.position);

  joints.forEach((joint) => joint.set(0, 0, 0, 0));
  tips.forEach(({ sdf }) => (sdf.visible = false));
  const referenceSpace = renderer.xr.getReferenceSpace();
  if (xrFrame && referenceSpace) {
    for (const source of xrFrame.session.inputSources) {
      if (!source.hand || (source.handedness !== "left" && source.handedness !== "right")) {
        continue;
      }
      const base = source.handedness === "left" ? 0 : JOINTS;
      [...source.hand.entries()].forEach(([name, space], i) => {
        const pose = xrFrame.getJointPose!(space, referenceSpace);
        if (!pose || i >= JOINTS) {
          return;
        }
        const { x, y, z } = pose.transform.position;
        joints[base + i].set(x, y, z, pose.radius ?? 0.01);
        const tip = tips.get(`${source.handedness}-${name}`);
        if (tip) {
          const { sdf, finger } = tip;
          sdf.position.set(x, y, z);
          sdf.displace.set(0.01 * Math.sin(time * 0.007 + finger), 0.01 * Math.sin(time * 0.002 + finger * 2), 0.01 * Math.sin(time * 0.009 + finger * 3));
          sdf.visible = true;
        }
      });
    }
  }
  edit.update();

  for (const splatRenderer of [splats, handSplats]) {
    if (splatRenderer.sortMode === "cpu") {
      splatRenderer.requestSort();
    }
  }
  renderer.render(scene, camera);
});
