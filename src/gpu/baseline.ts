// Device baselines: what createRenderer asks for and what the module designs
// against, each met by about 95% of devices (share in parentheses,
// web3dsurvey.com, Sep 2026).

// WebGPU limits requested above the defaults. Adapters below a value get
// their own limit instead. Kept at the default because the next common tier
// is under 95%: maxStorageTexturesPerShaderStage 4 (8: 93%),
// maxComputeInvocationsPerWorkgroup and maxComputeWorkgroupSizeX/Y 256
// (768/1024: 92%), maxSampledTexturesPerShaderStage 16 (44: 89%),
// maxInterStageShaderVariables 16 (27: 89%), maxVertexAttributes 16 (29: 92%),
// maxBindGroups 4 (7: 18%), maxUniformBufferBindingSize 64 KiB,
// maxDynamic*BuffersPerPipelineLayout (89%), maxColorAttachments 8 and
// maxComputeWorkgroupsPerDimension 65535 (never higher).
// Optional features (three requests every one the adapter has): at or above
// 95% are depth32float-stencil8, indirect-first-instance,
// rg11b10ufloat-renderable, timestamp-query, depth-clip-control and
// bgra8unorm-storage; shader-f16 (94%), float32-filterable (92%),
// float32-blendable (89%), texture-formats-tier1 (92%) / tier2 (81%),
// subgroups (70%), dual-source-blending, clip-distances, primitive-index and
// texture compression (BC 88%, ETC2/ASTC 46%) need a fallback.
export const WEBGPU_BASELINE_LIMITS: Record<string, number> = {
  maxTextureDimension1D: 16384, // 99%
  maxTextureDimension2D: 16384, // 100%
  maxTextureArrayLayers: 2048, // 99%
  maxBufferSize: 1 << 30, // 97%
  maxStorageBufferBindingSize: 256 << 20, // 98% (1 GiB: 92%)
  maxComputeWorkgroupStorageSize: 32768, // 98%; 99% report at least 32767
  maxColorAttachmentBytesPerSample: 64, // 98% (128: 83%, not Apple GPUs)
  maxStorageBuffersPerShaderStage: 10, // 99%
  maxStorageBuffersInVertexStage: 10, // 99%
  maxStorageBuffersInFragmentStage: 10, // 99%
};

// WebGPU's defaults for the limits above: a device gets these unrequested
export const WEBGPU_DEFAULT_LIMITS: Record<string, number> = {
  maxTextureDimension1D: 8192,
  maxTextureDimension2D: 8192,
  maxTextureArrayLayers: 256,
  maxBufferSize: 256 << 20,
  maxStorageBufferBindingSize: 128 << 20,
  maxComputeWorkgroupStorageSize: 16384,
  maxColorAttachmentBytesPerSample: 32,
  maxStorageBuffersPerShaderStage: 8,
  maxStorageBuffersInVertexStage: 8,
  maxStorageBuffersInFragmentStage: 8,
};

// WebGL2 parameters (gl.getParameter names) to design against, 100% unless noted.
// Not baseline: EXT_render_snorm (80%, so snorm8 is not renderable),
// EXT_texture_norm16 (85%), EXT_disjoint_timer_query_webgl2 (66%),
// KHR_parallel_shader_compile (75%), OVR_multiview2 (56%).
// Three enables when present: OES_draw_buffers_indexed (98%),
// WEBGL_multi_draw (93%), OES_texture_float_linear (91%), EXT_clip_control (88%).
export const WEBGL2_BASELINE: Record<string, number> = {
  MAX_TEXTURE_SIZE: 8192, // 98%
  MAX_ARRAY_TEXTURE_LAYERS: 512,
  MAX_DRAW_BUFFERS: 4, // 6 and up: 98%
  MAX_COLOR_ATTACHMENTS: 4,
  MAX_TEXTURE_IMAGE_UNITS: 16,
  MAX_VERTEX_TEXTURE_IMAGE_UNITS: 16,
  MAX_UNIFORM_BLOCK_SIZE: 16384, // 32 KiB: 73%
  MAX_VARYING_VECTORS: 15, // 16: 99%
  MAX_VERTEX_ATTRIBS: 16,
  MAX_SAMPLES: 4,
};

// Float16 and float32 color targets, float16 blending (99.9%, three enables it)
export const WEBGL2_REQUIRED_EXTENSIONS = ["EXT_color_buffer_float"];
// Float32 blending (94%); three does not enable it
export const WEBGL2_OPTIONAL_EXTENSIONS = ["EXT_float_blend"];
