import * as THREE from "three";
import { ArrayFormats, type ArrayFormat, type ScalarType } from "../core/formats";

// How a GPU format (1, 2 or 4 components) becomes a texture on each backend.
// Three derives the sampled type (f32 / u32 / i32) only from texture.type
// being UnsignedIntType or IntType, so all integer formats use those types,
// and the real storage format goes in texture.internalFormat per backend.
export interface GpuFormatInfo {
  format: ArrayFormat;
  components: number;
  scalar: ScalarType;
  kind: "uint" | "sint" | "float";
  webgpu: GPUTextureFormat;
  // WebGL2 internal format and texSubImage format / type (gl constant names)
  gl: string;
  glFormat: string;
  glType: string;
  threeFormat: THREE.PixelFormat;
  threeType: THREE.TextureDataType;
  // TSL type of one element
  node: string;
  // snorm8 is not renderable on either backend (WebGL2 EXT_render_snorm: 80%)
  renderable: boolean;
  // Compute shaders can write it as a storage texture. Three declares the
  // WGSL storage format from format / type, not internalFormat, so 8 and
  // 16-bit integers (typed UnsignedIntType / IntType) would be declared
  // 32-bit; that leaves 32-bit formats, rgba8unorm, rgba8snorm, rgba16float.
  storable: boolean;
}

const SCALAR_GPU: Record<ScalarType, { kind: GpuFormatInfo["kind"]; webgpu: string; gl: string; glType: string; threeType: THREE.TextureDataType }> = {
  uint8: { kind: "uint", webgpu: "8uint", gl: "8UI", glType: "UNSIGNED_BYTE", threeType: THREE.UnsignedIntType },
  sint8: { kind: "sint", webgpu: "8sint", gl: "8I", glType: "BYTE", threeType: THREE.IntType },
  unorm8: { kind: "float", webgpu: "8unorm", gl: "8", glType: "UNSIGNED_BYTE", threeType: THREE.UnsignedByteType },
  snorm8: { kind: "float", webgpu: "8snorm", gl: "8_SNORM", glType: "BYTE", threeType: THREE.ByteType },
  uint16: { kind: "uint", webgpu: "16uint", gl: "16UI", glType: "UNSIGNED_SHORT", threeType: THREE.UnsignedIntType },
  sint16: { kind: "sint", webgpu: "16sint", gl: "16I", glType: "SHORT", threeType: THREE.IntType },
  float16: { kind: "float", webgpu: "16float", gl: "16F", glType: "HALF_FLOAT", threeType: THREE.HalfFloatType },
  uint32: { kind: "uint", webgpu: "32uint", gl: "32UI", glType: "UNSIGNED_INT", threeType: THREE.UnsignedIntType },
  sint32: { kind: "sint", webgpu: "32sint", gl: "32I", glType: "INT", threeType: THREE.IntType },
  float32: { kind: "float", webgpu: "32float", gl: "32F", glType: "FLOAT", threeType: THREE.FloatType },
};

const CHANNELS: Record<number, { webgpu: string; gl: string; glFormat: string; three: THREE.PixelFormat; threeInteger: THREE.PixelFormat }> = {
  1: { webgpu: "r", gl: "R", glFormat: "RED", three: THREE.RedFormat, threeInteger: THREE.RedIntegerFormat },
  2: { webgpu: "rg", gl: "RG", glFormat: "RG", three: THREE.RGFormat, threeInteger: THREE.RGIntegerFormat },
  4: { webgpu: "rgba", gl: "RGBA", glFormat: "RGBA", three: THREE.RGBAFormat, threeInteger: THREE.RGBAIntegerFormat },
};

const cache = new Map<string, GpuFormatInfo>();

export function gpuFormatInfo(format: ArrayFormat): GpuFormatInfo {
  const cached = cache.get(format);
  if (cached) {
    return cached;
  }

  const { scalar, components, gpu } = ArrayFormats.info(format);
  if (!gpu) {
    throw new Error(`Format ${format} is CPU-only (GPU formats have 1, 2 or 4 components)`);
  }

  const s = SCALAR_GPU[scalar];
  const channels = CHANNELS[components];
  const integer = s.kind !== "float";
  const vectorPrefix = { uint: "u", sint: "i", float: "" }[s.kind];
  const scalarNode = { uint: "uint", sint: "int", float: "float" }[s.kind];

  const info: GpuFormatInfo = {
    format,
    components,
    scalar,
    kind: s.kind,
    webgpu: `${channels.webgpu}${s.webgpu}` as GPUTextureFormat,
    gl: `${channels.gl}${s.gl}`,
    glFormat: `${channels.glFormat}${integer ? "_INTEGER" : ""}`,
    glType: s.glType,
    threeFormat: integer ? channels.threeInteger : channels.three,
    threeType: s.threeType,
    node: components === 1 ? scalarNode : `${vectorPrefix}vec${components}`,
    renderable: scalar !== "snorm8",
    storable: ArrayFormats.info(format).scalarBytes === 4 || (components === 4 && (scalar === "unorm8" || scalar === "snorm8" || scalar === "float16")),
  };

  cache.set(format, info);
  return info;
}
