import * as THREE from "three";
import { NodeMaterial, type WebGPURenderer } from "three/webgpu";
import type { GpuArrayReader } from "../gpu/GpuArrayReader";
import { hdrToneMappingActive } from "../gpu/hdr";
import { TSL, type TslNode } from "../gpu/tsl";
import { fragmentAlpha, type SplatVaryings } from "./projection.tsl";
import { SplatCamera } from "./splatCamera";
import { SplatParams } from "./splatParams";
import type { SplatProjection } from "./SplatProjection";
import { splatViewIndex } from "./viewIndex";

const { Discard, Fn, If, instanceIndex, log, max, min, select, sqrt, sRGBTransferEOTF, struct, uint, varyingProperty, vec2, vec3, vec4, vertexIndex } = TSL;

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

// x and y in {-1, 1} from bits 0 and 1. An indexed draw passes the index value
// as vertexIndex, so the 2 shared corners shade once.
export const quadCorner = (v: TslNode) => vec2(v.bitAnd(uint(1)), v.shiftRight(uint(1)).bitAnd(uint(1))).mul(2.0).sub(1.0);

// One instance draws every quad, since GPUs run an instance's vertices together
export function quadIndices(quads: number) {
  const indices = new Uint16Array(quads * 6);
  for (let q = 0; q < quads; q += 1) {
    indices.set([0, 1, 2, 2, 1, 3].map((corner) => q * 4 + corner), q * 6);
  }
  return indices;
}

export interface DrawOptions {
  projection: SplatProjection;
  eyes: number;
  // Its count bounds the indices drawn
  projected: GpuArrayReader;
  // The splat index of draw i
  order: (i: TslNode) => TslNode;
  count: TslNode;
  quads: number;
  // 1 when the output stores linear color
  encodeLinear: TslNode;
}

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

// three rebuilds the pipeline on the next draw. The key tells old and new shaders apart.
export function setDrawNodes(material: NodeMaterial, options: DrawOptions) {
  const { vertexNode, fragmentNode } = drawNodes(options);
  material.vertexNode = vertexNode;
  material.fragmentNode = fragmentNode;
  const key = `splatDraw:${nextDrawKey++}`;
  material.customProgramCacheKey = () => key;
  material.needsUpdate = true;
}

let nextDrawKey = 0;

function drawNodes({ projection, eyes, projected, order, count, quads, encodeLinear }: DrawOptions) {
  const params = SplatParams.nodes;
  const v = eyes === 1 ? uint(0) : splatViewIndex;

  const types = { uv: "vec2", localDir: "vec3", localCross: "vec3", c2: "float" } as const;
  const varyings = Object.fromEntries(projection.varyings.map((name) => [name, varyingProperty(types[name], `vSplat_${name}`)])) as Partial<SplatVaryings>;
  const rgb = varyingProperty("vec3", "vSplatRgb");
  const opacity = varyingProperty("float", "vSplatOpacity");
  const cutoff = varyingProperty("float", "vSplatCutoff");

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
      // In stereo the view index picks the eye's words
      const words = projection.loadWords(projected, eyes, index);
      const head = words.slice(0, projection.headWords);
      const eyeWords = words.slice(head.length, head.length + projection.eyeWords).map((word, k) =>
        eyes === 1 ? word : select(v.equal(uint(0)), word, words[head.length + projection.eyeWords + k]).toVar());
      const look = projection.look(head, eyeWords);

      If(look.visible, () => {
        // Opacities above 1 are LoD stretches the projection kept. With
        // lodInflate it grew the splat and stored 1.
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
        // LoD merges and SH leave negative colors, which give NaN in the sRGB
        // decode and darken float targets
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
    return vec4(color.mul(alpha), alpha);
  });

  return { vertexNode: vertex(), fragmentNode: fragment() };
}

// Splats are sRGB, drawn as is where the output keeps sRGB: the canvas without
// three's linear framebuffer target, that target under Hdr.useToneMapping, and
// 8-bit targets
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
