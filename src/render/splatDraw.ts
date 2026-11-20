// The splat draw: a quad per splat, 4 vertices indexed by 2 triangles, no
// vertex attributes, `quads` quads per instance (see quadIndices). The
// vertex shader takes the splat index of quad i from `order`, decodes the
// projected words of the eye being drawn and places a quad corner; the
// fragment shader evaluates the method's density and blends premultiplied
// color "over" the target.
import * as THREE from "three";
import { NodeMaterial, type MRTNode, type WebGPURenderer } from "three/webgpu";
import type { GpuArrayReader } from "../gpu/GpuArrayReader";
import { hdrToneMappingActive } from "../gpu/hdr";
import { TSL, type TslNode } from "../gpu/tsl";
import { fragmentAlpha, type SplatVaryings } from "./projection.tsl";
import { SplatCamera } from "./splatCamera";
import { SplatParams } from "./splatParams";
import type { SplatProjection } from "./SplatProjection";
import { splatViewIndex } from "./viewIndex";

const { Discard, Fn, If, instanceIndex, log, max, min, mrt, property, select, sqrt, sRGBTransferEOTF, struct, uint, varyingProperty, vec2, vec3, vec4, vertexIndex } = TSL;

// What a method's vertex step fills, plus what the fragment needs
export const DrawVertex = struct({
  position: "vec4",
  uv: "vec2",
  localDir: "vec3",
  localCross: "vec3",
  c2: "float",
  rgb: "vec3",
  opacity: "float",
  cutoff: "float",
}, "SplatDrawVertex");

// Corner of quad vertex 0..3, x and y in {-1, 1}: bit 0 and bit 1 of v.
// An indexed draw passes the index value as vertexIndex, so the GPU's
// vertex cache shades the 2 shared corners once: 4 invocations, not 6.
export const quadCorner = (v: TslNode) => vec2(v.bitAnd(uint(1)), v.shiftRight(uint(1)).bitAnd(uint(1))).mul(2.0).sub(1.0);

// The index buffer of `quads` quads: 2 triangles over vertices 4q..4q+3.
// One instance draws them all, `quads` splats: GPUs run an instance's
// vertices together, so instances of 4 leave most of that work idle.
export function quadIndices(quads: number) {
  const indices = new Uint16Array(quads * 6);
  for (let q = 0; q < quads; q += 1) {
    indices.set([0, 1, 2, 2, 1, 3].map((corner) => q * 4 + corner), q * 6);
  }
  return indices;
}

// What a fragment modifier reads: the draw's fragment, after the density
// cut and minAlpha
export interface SplatFragment {
  // The premultiplied color the draw blends "over" the target (vec4)
  color: TslNode;
  // The fragment's point on its splat's quad in the eye's view space (vec3):
  // the camera at the origin, looking down -z
  position: TslNode;
}

// What it gives back, each optional
export interface SplatFragmentOutput {
  // Drops the fragment where true (bool)
  discard?: TslNode;
  // The color drawn instead (premultiplied vec4)
  color?: TslNode;
  // Outputs into the render target's other textures, by texture name, with
  // their blend modes (three's mrt(); the draw's color goes to "output",
  // which must be the first texture)
  mrt?: MRTNode;
}

// Builds the draw's fragment stage on top of Radix's: called once each
// time the material is built, with property nodes the stage fills
export type SplatFragmentModifier = (fragment: SplatFragment) => SplatFragmentOutput;

export interface DrawOptions {
  projection: SplatProjection;
  eyes: number;
  // Reader of the projected bundle (its count bounds the indices drawn)
  projected: GpuArrayReader;
  // The splat index of the i-th splat drawn, and how many are drawn
  order: (i: TslNode) => TslNode;
  count: TslNode;
  // Quads per instance (quadIndices)
  quads: number;
  // 1 when the output stores linear color (see outputIsLinear)
  encodeLinear: TslNode;
  fragment?: SplatFragmentModifier;
}

// A splat material: premultiplied "over" blending, depth tested, not written
export function makeDrawMaterial(options: DrawOptions): NodeMaterial {
  const material = new NodeMaterial();
  material.name = "radix_splatDraw";
  material.transparent = true;
  material.blending = THREE.CustomBlending;
  material.blendSrc = THREE.OneFactor;
  material.blendDst = THREE.OneMinusSrcAlphaFactor;
  material.blendSrcAlpha = THREE.OneFactor;
  material.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;
  material.depthTest = true;
  material.depthWrite = false;

  // Transparent DoubleSide is otherwise drawn as back then front faces,
  // which reorders the sorted splats
  material.side = THREE.DoubleSide;
  material.forceSinglePass = true;
  material.fog = false;

  setDrawNodes(material, options);
  return material;
}

// Build the material's shaders for `options`, in place: three rebuilds its
// pipeline on the next draw (the key tells the old and new shaders apart)
export function setDrawNodes(material: NodeMaterial, options: DrawOptions) {
  const { vertexNode, fragmentNode } = drawNodes(options);
  material.vertexNode = vertexNode;
  material.fragmentNode = fragmentNode;
  const key = `splatDraw:${nextDrawKey++}`;
  material.customProgramCacheKey = () => key;
  material.needsUpdate = true;
}

let nextDrawKey = 0;

function drawNodes({ projection, eyes, projected, order, count, quads, encodeLinear, fragment: modifier }: DrawOptions) {
  const params = SplatParams.nodes;
  const v = eyes === 1 ? uint(0) : splatViewIndex;

  // Written by the vertex stage, read by the fragment stage; only the
  // method's own varyings are declared
  const types = { uv: "vec2", localDir: "vec3", localCross: "vec3", c2: "float" } as const;
  const varyings = Object.fromEntries(projection.varyings.map((name) => [name, varyingProperty(types[name], `vSplat_${name}`)])) as Partial<SplatVaryings>;
  const rgb = varyingProperty("vec3", "vSplatRgb");
  const opacity = varyingProperty("float", "vSplatOpacity");
  const cutoff = varyingProperty("float", "vSplatCutoff");

  // Only with a fragment modifier: the quad corner in view space, as a
  // homogeneous point (linear in clip space, so it interpolates exactly)
  const viewPoint = modifier ? varyingProperty("vec4", "vSplatViewPoint") : undefined;
  const input = modifier ? { color: property("vec4", "SplatColor"), position: property("vec3", "SplatPosition") } : undefined;
  const output = modifier?.(input!);

  const vertex = Fn(() => {
    const out = DrawVertex().toVar();
    out.get("position").assign(vec4(0.0, 0.0, 2.0, 1.0));
    out.get("uv").assign(vec2(0.0));
    out.get("localDir").assign(vec3(0.0));
    out.get("localCross").assign(vec3(0.0));
    out.get("c2").assign(0.0);
    out.get("rgb").assign(vec3(0.0));
    out.get("opacity").assign(0.0);
    out.get("cutoff").assign(0.0);

    const i = instanceIndex.mul(uint(quads)).add(vertexIndex.shiftRight(uint(2))).toVar();
    const index = select(i.lessThan(count), order(i), projected.count).toVar();
    If(index.lessThan(projected.count), () => {
      // The head words, then the eye's (chosen by the view index in stereo)
      const words = projection.loadWords(projected, eyes, index);
      const head = words.slice(0, projection.headWords);
      const eyeWords = words.slice(head.length, head.length + projection.eyeWords).map((word, k) =>
        eyes === 1 ? word : select(v.equal(uint(0)), word, words[head.length + projection.eyeWords + k]).toVar());
      const look = projection.look(head, eyeWords);

      If(look.visible, () => {
        // The std devs the projection sized the bound with, and where to
        // cut. Opacities above 1 are LoD stretches the projection kept
        // (with lodInflate it grew the splat and stored 1 instead).
        const alpha = look.opacity.toVar();
        const bound = params.maxStdDev.toVar();
        const cut = params.maxStdDev.toVar();
        If(alpha.greaterThan(1.0), () => {
          alpha.assign(min(alpha.mul(4.0).sub(3.0), 5.0));
          bound.assign(params.maxStdDev.add(alpha.sub(1.0).mul(0.7)));
          cut.assign(bound);
        }).ElseIf(params.falloff.greaterThanEqual(1.0), () => {
          // Beyond this radius opacity * exp(-D/2) < minAlpha
          cut.assign(min(cut, sqrt(log(max(alpha, params.minAlpha).div(params.minAlpha)).mul(2.0))));
        });

        projection.vertex(head, eyeWords, SplatCamera.eye(v), quadCorner(vertexIndex), bound, cut, out);
        // Storage keeps signed colors (LoD merges, SH); a negative one would
        // give NaN in the sRGB decode and darken float targets
        out.get("rgb").assign(max(look.rgb, vec3(0.0)));
        out.get("opacity").assign(alpha);
        out.get("cutoff").assign(cut);
      });
    });

    for (const name of projection.varyings) {
      varyings[name]!.assign(out.get(name));
    }
    rgb.assign(out.get("rgb"));
    opacity.assign(out.get("opacity"));
    cutoff.assign(out.get("cutoff"));
    viewPoint?.assign(SplatCamera.eye(v).projectionInverse.mul(out.get("position")));
    return out.get("position");
  });

  const fragment = Fn(() => {
    const z2 = projection.density(varyings as SplatVaryings).toVar();
    If(z2.greaterThan(cutoff.mul(cutoff)), () => {
      Discard();
    });

    const alpha = fragmentAlpha(z2, opacity, params.falloff).toVar();
    If(alpha.lessThan(params.minAlpha), () => {
      Discard();
    });

    const color = select(encodeLinear.greaterThan(0.5), sRGBTransferEOTF(rgb), rgb);
    if (!input || !viewPoint) {
      return vec4(color.mul(alpha), alpha);
    }
    input.color.assign(vec4(color.mul(alpha), alpha));
    input.position.assign(viewPoint.xyz.div(viewPoint.w));
    if (output?.discard) {
      If(output.discard, () => {
        Discard();
      });
    }
    return output?.color ?? input.color;
  });

  // Three takes a custom fragment node's other outputs only as an output
  // struct, so the color becomes the mrt's "output". Three builds the outputs
  // in texture order and the others read what the color's stage assigns, so
  // "output" must be the target's first texture.
  const color = fragment();
  return { vertexNode: vertex(), fragmentNode: output?.mrt ? output.mrt.merge(mrt({ output: color })) : color };
}

// Whether the output encodes linear color: splats are sRGB, drawn as they
// are where the output keeps them (the canvas without three's linear
// framebuffer target, that target under Hdr.useToneMapping, which decodes
// it, plain 8-bit targets)
export function outputIsLinear(renderer: WebGPURenderer) {
  const target = renderer.getRenderTarget();
  if (target === null) {
    if (renderer.xr.isPresenting && (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend) {
      const binding = (renderer.xr as unknown as { getWebGPUBinding?: () => { getPreferredColorFormat(): string } | null }).getWebGPUBinding?.();
      return binding?.getPreferredColorFormat().endsWith("-srgb") === true;
    }
    return (renderer as unknown as { needsFrameBufferTarget?: boolean }).needsFrameBufferTarget === true && !hdrToneMappingActive(renderer);
  }
  // Inside a render, three's framebuffer target is the current one
  if ((target as { isPostProcessingRenderTarget?: boolean }).isPostProcessingRenderTarget && hdrToneMappingActive(renderer)) {
    return false;
  }
  const texture = target.texture;
  return texture.colorSpace === THREE.SRGBColorSpace || texture.type !== THREE.UnsignedByteType;
}
