import type * as THREE from "three";
import type { WebGPURenderer } from "three/webgpu";
import { ArrayFormats, type ArrayFormat, type TypedArray } from "../core/formats";
import type { CopySpan, TexelSpan } from "../core/layout";
import { backendOf, glTextureOf, gpuTextureOf } from "./backend";
import { gpuFormatInfo } from "./gpuFormats";

// values and dest hold whole texels from span offset 0

export function uploadTexels(renderer: WebGPURenderer, texture: THREE.Texture, format: ArrayFormat, spans: TexelSpan[], values: TypedArray) {
  const { bytes, components } = ArrayFormats.info(format);
  const backend = backendOf(renderer);

  if (backend.isWebGPUBackend) {
    const gpuTexture = gpuTextureOf(renderer, texture);
    for (const { x, y, layer, width, rows, offset } of spans) {
      backend.device!.queue.writeTexture(
        { texture: gpuTexture, origin: { x, y, z: layer } },
        values,
        { offset: offset * bytes, bytesPerRow: width * bytes, rowsPerImage: rows },
        { width, height: rows, depthOrArrayLayers: 1 },
      );
    }
    return;
  }

  const gl = backend.gl!;
  const info = gpuFormatInfo(format);
  withGlState(gl, () => {
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, glTextureOf(renderer, texture));
    for (const { x, y, layer, width, rows, offset } of spans) {
      gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, x, y, layer, width, rows, 1, glEnum(gl, info.glFormat), glEnum(gl, info.glType), values, offset * components);
    }
  });
}

// Drops texels past dest's length
export async function readTexels(renderer: WebGPURenderer, texture: THREE.Texture, format: ArrayFormat, spans: TexelSpan[], dest: TypedArray) {
  const backend = backendOf(renderer);
  if (backend.isWebGPUBackend) {
    await readWebGPU(backend.device!, gpuTextureOf(renderer, texture), format, spans, dest);
  } else {
    await readWebGL(backend.gl!, glTextureOf(renderer, texture), format, spans, dest);
  }
}

export function copyTexels(renderer: WebGPURenderer, src: THREE.Texture, dst: THREE.Texture, spans: CopySpan[]) {
  const backend = backendOf(renderer);

  if (backend.isWebGPUBackend) {
    const device = backend.device!;
    const encoder = device.createCommandEncoder({ label: "radix_copyTexels" });
    for (const span of spans) {
      encoder.copyTextureToTexture(
        { texture: gpuTextureOf(renderer, src), origin: { x: span.src.x, y: span.src.y, z: span.src.layer } },
        { texture: gpuTextureOf(renderer, dst), origin: { x: span.dst.x, y: span.dst.y, z: span.dst.layer } },
        { width: span.width, height: span.rows, depthOrArrayLayers: 1 },
      );
    }
    device.queue.submit([encoder.finish()]);
    return;
  }

  const gl = backend.gl!;
  withGlState(gl, () => {
    const framebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, framebuffer);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, glTextureOf(renderer, dst));

    for (const span of spans) {
      gl.framebufferTextureLayer(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, glTextureOf(renderer, src), 0, span.src.layer);
      gl.copyTexSubImage3D(gl.TEXTURE_2D_ARRAY, 0, span.dst.x, span.dst.y, span.dst.layer, span.src.x, span.src.y, span.width, span.rows);
    }

    gl.deleteFramebuffer(framebuffer);
  });
}

async function readWebGPU(device: GPUDevice, texture: GPUTexture, format: ArrayFormat, spans: TexelSpan[], dest: TypedArray) {
  const { bytes } = ArrayFormats.info(format);

  // copyTextureToBuffer needs bytesPerRow aligned to 256
  const align = (n: number) => Math.ceil(n / 256) * 256;
  const offsets: number[] = [];
  let size = 0;
  for (const span of spans) {
    offsets.push(size);
    size += align(span.width * bytes) * span.rows;
  }

  const buffer = device.createBuffer({ label: "radix_readTexels", size: Math.max(size, 4), usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const encoder = device.createCommandEncoder({ label: "radix_readTexels" });
  spans.forEach((span, i) => {
    encoder.copyTextureToBuffer(
      { texture, origin: { x: span.x, y: span.y, z: span.layer } },
      { buffer, offset: offsets[i], bytesPerRow: align(span.width * bytes), rowsPerImage: span.rows },
      { width: span.width, height: span.rows, depthOrArrayLayers: 1 },
    );
  });
  device.queue.submit([encoder.finish()]);

  await buffer.mapAsync(GPUMapMode.READ);
  const mapped = new Uint8Array(buffer.getMappedRange());
  const out = new Uint8Array(dest.buffer, dest.byteOffset, dest.byteLength);

  // Rows are 256-byte aligned in the buffer, packed in dest
  spans.forEach((span, i) => {
    for (let row = 0; row < span.rows; row += 1) {
      const at = (span.offset + row * span.width) * bytes;
      const length = Math.min(span.width * bytes, out.length - at);
      if (length > 0) {
        const from = offsets[i] + row * align(span.width * bytes);
        out.set(mapped.subarray(from, from + length), at);
      }
    }
  });

  buffer.unmap();
  buffer.destroy();
}

// WebGL2 only guarantees RGBA readPixels of the widest type, so narrow into dest
async function readWebGL(gl: WebGL2RenderingContext, texture: WebGLTexture, format: ArrayFormat, spans: TexelSpan[], dest: TypedArray) {
  const info = gpuFormatInfo(format);
  if (info.scalar === "snorm8") {
    throw new Error("snorm8 cannot be read back on WebGL2 (not renderable)");
  }

  const read = info.kind === "uint" ? { format: gl.RGBA_INTEGER, type: gl.UNSIGNED_INT, array: Uint32Array }
    : info.kind === "sint" ? { format: gl.RGBA_INTEGER, type: gl.INT, array: Int32Array }
    : info.scalar === "unorm8" ? { format: gl.RGBA, type: gl.UNSIGNED_BYTE, array: Uint8Array }
    : { format: gl.RGBA, type: gl.FLOAT, array: Float32Array };
  const texelBytes = 4 * read.array.BYTES_PER_ELEMENT;
  const total = spans.reduce((sum, span) => sum + span.width * span.rows, 0);

  const pack = gl.createBuffer();
  withGlState(gl, () => {
    const framebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, framebuffer);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pack);
    gl.bufferData(gl.PIXEL_PACK_BUFFER, Math.max(total * texelBytes, 4), gl.STREAM_READ);

    let at = 0;
    for (const span of spans) {
      gl.framebufferTextureLayer(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, texture, 0, span.layer);
      gl.readPixels(span.x, span.y, span.width, span.rows, read.format, read.type, at * texelBytes);
      at += span.width * span.rows;
    }

    gl.deleteFramebuffer(framebuffer);
  });

  await glFence(gl);
  const components = info.components;
  const half = info.scalar === "float16";

  if (components === 4 && !half && dest instanceof read.array) {
    withGlState(gl, () => {
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pack);
      let at = 0;
      for (const span of spans) {
        const length = Math.min(span.width * span.rows * 4, dest.length - span.offset * 4);
        if (length > 0) {
          gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, at * texelBytes, dest, span.offset * 4, length);
        }
        at += span.width * span.rows;
      }
    });
    gl.deleteBuffer(pack);
    return;
  }

  const texels = new read.array(total * 4);
  withGlState(gl, () => {
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pack);
    gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, texels);
  });
  gl.deleteBuffer(pack);

  let at = 0;
  for (const span of spans) {
    for (let i = 0; i < span.width * span.rows; i += 1, at += 1) {
      const base = (span.offset + i) * components;
      for (let c = 0; c < components && base + c < dest.length; c += 1) {
        const value = texels[at * 4 + c];
        dest[base + c] = half ? toHalfBits(value) : value;
      }
    }
  }
}

async function glFence(gl: WebGL2RenderingContext) {
  const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0)!;
  gl.flush();

  try {
    while (true) {
      const status = gl.clientWaitSync(sync, 0, 0);
      if (status === gl.WAIT_FAILED) {
        throw new Error("clientWaitSync failed");
      }
      if (status !== gl.TIMEOUT_EXPIRED) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  } finally {
    gl.deleteSync(sync);
  }
}

// three caches GL bindings, so restore every binding and parameter touched
function withGlState(gl: WebGL2RenderingContext, fn: () => void) {
  const bindings = {
    readFramebuffer: gl.getParameter(gl.READ_FRAMEBUFFER_BINDING),
    packBuffer: gl.getParameter(gl.PIXEL_PACK_BUFFER_BINDING),
    unpackBuffer: gl.getParameter(gl.PIXEL_UNPACK_BUFFER_BINDING),
    texture: gl.getParameter(gl.TEXTURE_BINDING_2D_ARRAY),
  };
  const unpack = [
    gl.UNPACK_ALIGNMENT, gl.UNPACK_FLIP_Y_WEBGL, gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, gl.UNPACK_ROW_LENGTH,
    gl.UNPACK_IMAGE_HEIGHT, gl.UNPACK_SKIP_PIXELS, gl.UNPACK_SKIP_ROWS, gl.UNPACK_SKIP_IMAGES,
  ];
  const saved = unpack.map((name) => gl.getParameter(name));

  gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, null);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  for (const name of unpack.slice(1)) {
    gl.pixelStorei(name, 0);
  }

  try {
    fn();
  } finally {
    unpack.forEach((name, i) => gl.pixelStorei(name, saved[i]));
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, bindings.readFramebuffer);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, bindings.packBuffer);
    gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, bindings.unpackBuffer);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, bindings.texture);
  }
}

function glEnum(gl: WebGL2RenderingContext, name: string): number {
  return (gl as unknown as Record<string, number>)[name];
}

const floatView = new Float32Array(1);
const bitsView = new Uint32Array(floatView.buffer);

// Exact for values read from half-float textures
function toHalfBits(value: number) {
  floatView[0] = value;
  const bits = bitsView[0];
  const sign = (bits >>> 16) & 0x8000;
  const exponent = ((bits >>> 23) & 0xff) - 127 + 15;
  const mantissa = bits & 0x7fffff;

  if (exponent >= 0x1f) {
    return sign | 0x7c00 | (((bits >>> 23) & 0xff) === 0xff && mantissa ? 0x200 : 0);
  }
  if (exponent <= 0) {
    return exponent < -10 ? sign : sign | ((mantissa | 0x800000) >> (14 - exponent));
  }
  return sign | (exponent << 10) | (mantissa >> 13);
}
