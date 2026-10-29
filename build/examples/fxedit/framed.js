// A modifier run inside a generator (SplatGenerator.fromSplats({ modifiers })),
// in a frame of the page's: fromSplats modifiers see the file's own
// coordinates, so the splat goes into the frame, through the modifier and
// back. The frame is a similarity (rotation, uniform scale, translation)
// held in uniforms, so moving it compiles nothing.
//
// The WebGL2 path: a renderer modifier in a space makes the transform ahead
// of it keep a non-uniform branch with an eigendecomposition in the
// projection, about 6x slower there at millions of splats; inside the
// generator, the object's transform goes straight to covariances.
import * as THREE from "three";
import { GpuSplatMath, GpuSplats, TSL,                    } from "@sparkjsdev/radix";

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
export function setFrame(matrix               ) {
  matrix.decompose(position, quaternion, scale);
  Frame.quaternion.value.set(quaternion.x, quaternion.y, quaternion.z, quaternion.w);
  Frame.scale.value = scale.x;
  Frame.translate.value.copy(position);
}

export function inFrame(modifier               )                {
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


//# sourceURL=examples/fxedit/framed.ts