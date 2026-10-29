// Spark's SplatEdit / SplatEditSdf (sphere shapes) as a world-space TSL
// modifier (Radix has no SDF edits). Each SdfEdit is a layer with a blend
// mode and up to maxSdfs sphere slots (uniforms: moving, recoloring, showing
// or hiding a sphere compiles nothing); its spheres are its SdfSphere
// children, placed in the world. The field math follows Spark's
// evaluateSdfArray / modulateSdfArray / applyRgbaDisplaceEdit.
//
//   const edit = new SdfEdit({ rgbaBlendMode: "add_rgba", sdfSmooth: 0.1, softEdge: 0.8 });
//   edit.add(new SdfSphere({ radius: 1, color, opacity: 0 }));
//   scene.add(edit);
//   splatRenderer.modifier = sdfModifier([edit]);
//   splatRenderer.modifierSpace = "world";
//   // every frame: edit.update()
import * as THREE from "three";
import { TSL,                                                  } from "@sparkjsdev/radix";

const { clamp, exp, float, length, log, max, mix, select, uniform, vec3, vec4 } = TSL;

// Spark's SplatEditRgbaBlendMode; DARKEN is not one of Spark's modes (its
// examples' DARKEN falls back to the MULTIPLY default)
export const SdfBlend = { MULTIPLY: "multiply", SET_RGB: "set_rgb", ADD_RGBA: "add_rgba", DARKEN: "multiply" }         ;
                                                                    

const FAR = 1e9;

export class SdfSphere extends THREE.Object3D {
           isSdfSphere = true;
  radius        ;
  color             ;
  opacity        ;
  displace               ;
  invert         ;

  constructor({ radius = 1, color = new THREE.Color(1, 1, 1), opacity = 1, displace = new THREE.Vector3(), invert = false } = {}) {
    super();
    this.radius = radius;
    this.color = color.clone();
    this.opacity = opacity;
    this.displace = displace.clone();
    this.invert = invert;
  }
}

const position = new THREE.Vector3();
const scale = new THREE.Vector3();

// Whether an object and its ancestors are visible
function visible(object                ) {
  for (let node                        = object; node; node = node.parent) {
    if (!node.visible) {
      return false;
    }
  }
  return true;
}

export class SdfEdit extends THREE.Object3D {
  rgbaBlendMode              ;
  smooth         ;
  uniforms                                                            ;
  slots                                                                                                           ;

  constructor({ rgbaBlendMode = SdfBlend.MULTIPLY                , sdfSmooth = 0, softEdge = 0, invert = false, maxSdfs = 4 } = {}) {
    super();
    this.rgbaBlendMode = rgbaBlendMode;
    // Smooth union or plain minimum, chosen when the shader is built
    this.smooth = sdfSmooth > 0;
    this.uniforms = {
      sdfSmooth: uniform(Math.max(sdfSmooth, 1e-6)),
      softEdge: uniform(softEdge),
      invert: uniform(invert ? 1 : 0),
    };
    this.slots = Array.from({ length: maxSdfs }, () => ({
      center: uniform(new THREE.Vector3()),
      radius: uniform(0),
      rgba: uniform(new THREE.Vector4()),
      displace: uniform(new THREE.Vector3()),
      sign: uniform(1),
      enabled: uniform(0),
    }));
  }

  get sdfSmooth()         {
    return this.uniforms.sdfSmooth.value;
  }

  set sdfSmooth(value        ) {
    this.uniforms.sdfSmooth.value = Math.max(value, 1e-6);
  }

  get softEdge()         {
    return this.uniforms.softEdge.value;
  }

  set softEdge(value        ) {
    this.uniforms.softEdge.value = value;
  }

  // Copies the spheres' world positions, sizes and colors into the slots
  update() {
    this.updateMatrixWorld();
    const spheres = this.children.filter((child)                     => (child             ).isSdfSphere && visible(child));
    this.slots.forEach((slot, i) => {
      const sphere = spheres[i];
      slot.enabled.value = sphere && visible(this) ? 1 : 0;
      if (!sphere) {
        return;
      }
      sphere.matrixWorld.decompose(position, new THREE.Quaternion(), scale);
      slot.center.value.copy(position);
      slot.radius.value = sphere.radius * scale.x;
      slot.rgba.value.set(sphere.color.r, sphere.color.g, sphere.color.b, sphere.opacity);
      slot.displace.value.copy(sphere.displace);
      slot.sign.value = sphere.invert ? -1 : 1;
    });
  }

  // Applies the edit to `out` (a splat var, world space) in place
  apply(out           ) {
    const pos = out.get("center").toVar();
    const rgba = vec4(out.get("rgb"), out.get("opacity")).toVar();
    const distances = this.slots.map((slot) => select(slot.enabled.greaterThan(0.5), length(pos.sub(slot.center)).sub(slot.radius).mul(slot.sign), float(FAR)));

    let distance         ;
    let sdfRgba         ;
    let sdfDisplace         ;
    if (this.smooth) {
      // A weighted soft minimum, the weights relative to the largest one
      const k = this.uniforms.sdfSmooth;
      const scaled = distances.map((d         ) => d.negate().div(k).toVar());
      const top = scaled.reduce((a         , b         ) => max(a, b)).toVar();
      const weights = scaled.map((s         ) => exp(s.sub(top)).toVar());
      const total = weights.reduce((a         , b         ) => a.add(b)).toVar();
      sdfRgba = weights.reduce((sum         , w         , i        ) => sum.add(this.slots[i].rgba.mul(w)), vec4(0)).div(total);
      sdfDisplace = weights.reduce((sum         , w         , i        ) => sum.add(this.slots[i].displace.mul(w)), vec3(0)).div(total);
      distance = log(total).negate().sub(top).mul(k);
    } else {
      distance = distances[0].toVar();
      sdfRgba = vec4(this.slots[0].rgba).toVar();
      sdfDisplace = vec3(this.slots[0].displace).toVar();
      for (let i = 1; i < this.slots.length; i += 1) {
        const nearer = distances[i].lessThan(distance);
        sdfRgba.assign(select(nearer, this.slots[i].rgba, sdfRgba));
        sdfDisplace.assign(select(nearer, this.slots[i].displace, sdfDisplace));
        distance.assign(select(nearer, distances[i], distance));
      }
    }
    distance = select(this.uniforms.invert.greaterThan(0.5), distance.negate(), distance).toVar();

    const soft = this.uniforms.softEdge;
    const modulate = select(soft.equal(0), select(distance.lessThan(0), float(1), float(0)), clamp(distance.negate().div(soft).add(0.5), 0, 1)).toVar();

    const target = this.rgbaBlendMode === SdfBlend.ADD_RGBA
      ? rgba.add(sdfRgba)
      : this.rgbaBlendMode === SdfBlend.SET_RGB
        ? vec4(sdfRgba.xyz, rgba.w.mul(sdfRgba.w))
        : rgba.mul(sdfRgba);
    const blended = mix(rgba, target, modulate).toVar();
    out.get("rgb").assign(blended.xyz);
    // Above 1 would read as a merged LoD splat and grow it (lodInflate)
    out.get("opacity").assign(clamp(blended.w, 0, 1));
    out.get("center").assign(pos.add(sdfDisplace.mul(modulate)));
  }
}

// A world-space SplatModifier applying `edits` in order
export function sdfModifier(edits           )                {
  return (splat) => {
    const out = splat.toVar();
    edits.forEach((edit) => edit.apply(out));
    return out;
  };
}


//# sourceURL=examples/spark/js/sdf.ts