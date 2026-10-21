// Device limits met by about 95% of devices (web3dsurvey.com, Sep 2026)

export const WEBGPU_BASELINE_LIMITS: Record<string, number> = {
  maxTextureDimension1D: 16384,
  maxTextureDimension2D: 16384,
  maxTextureArrayLayers: 2048,
  maxBufferSize: 1 << 30,
  maxStorageBufferBindingSize: 256 << 20, // 1 GiB is under 95%
  maxComputeWorkgroupStorageSize: 32768,
  maxColorAttachmentBytesPerSample: 64, // 128 is under 95%, and not on Apple GPUs
  maxStorageBuffersPerShaderStage: 10,
  maxStorageBuffersInVertexStage: 10,
  maxStorageBuffersInFragmentStage: 10,
};

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

export const WEBGL2_BASELINE: Record<string, number> = {
  MAX_TEXTURE_SIZE: 8192,
  MAX_ARRAY_TEXTURE_LAYERS: 512,
  MAX_DRAW_BUFFERS: 4,
  MAX_COLOR_ATTACHMENTS: 4,
  MAX_TEXTURE_IMAGE_UNITS: 16,
  MAX_VERTEX_TEXTURE_IMAGE_UNITS: 16,
  MAX_UNIFORM_BLOCK_SIZE: 16384, // 32 KiB is under 95%
  MAX_VARYING_VECTORS: 15,
  MAX_VERTEX_ATTRIBS: 16,
  MAX_SAMPLES: 4,
};

// Float16 and float32 color targets
export const WEBGL2_REQUIRED_EXTENSIONS = ["EXT_color_buffer_float"];
// Float32 blending, which three does not enable
export const WEBGL2_OPTIONAL_EXTENSIONS = ["EXT_float_blend"];
