// A modifier run in a fromSplats generator in a page frame, faster on WebGL2 than the renderer's
import * as THREE from "three";
import { GpuSplatMath, GpuSplats, TSL, type SplatModifier } from "@sparkjsdev/radix";

const { uniform } = TSL;

// Frame from file coordinates: p' = scale R p + translate
export const Frame = {
  quaternion: uniform(new THREE.Vector4(0, 0, 0, 1)),
  scale: uniform(1),
  translate: uniform(new THREE.Vector3()),
};

const position = new THREE.Vector3();
const quaternion = new THREE.Quaternion();
const scale = new THREE.Vector3();

// The frame of a similarity matrix (its scale's x stands for all three)
export function setFrame(matrix: THREE.Matrix4) {
  matrix.decompose(position, quaternion, scale);
  Frame.quaternion.value.set(quaternion.x, quaternion.y, quaternion.z, quaternion.w);
  Frame.scale.value = scale.x;
  Frame.translate.value.copy(position);
}

export function inFrame(modifier: SplatModifier): SplatModifier {
  return (s) => {
    const { quaternion: q, scale: k, translate: t } = Frame;
    const inside = GpuSplats.Splat(
      GpuSplatMath.quatRotate(q, s.get("center")).mul(k).add(t),
      s.get("scales").mul(k),
      GpuSplatMath.quatMul(q, s.get("quaternion")),
      s.get("rgb"),
      s.get("opacity"),
      s.get("index"),
    );
    const out = modifier(inside);
    const back = GpuSplatMath.quatConj(q);
    return GpuSplats.Splat(
      GpuSplatMath.quatRotate(back, out.get("center").sub(t)).div(k),
      out.get("scales").div(k),
      GpuSplatMath.quatMul(back, out.get("quaternion")),
      out.get("rgb"),
      out.get("opacity"),
      out.get("index"),
    );
  };
}
