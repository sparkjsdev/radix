import { IndirectStorageBufferAttribute, StorageBufferAttribute, type WebGPURenderer } from "three/webgpu";
import { ArrayFormats, type ArrayFormat, type ArrayOf } from "../core/formats";
import { backendOf } from "../gpu/backend";
import { gpuFormatInfo } from "../gpu/gpuFormats";
import { TSL, type TslNode } from "../gpu/tsl";
import { requireWebGPU } from "./WgpuCompute";

const { storage } = TSL;

// Typed, resizable storage buffer (WebGPU backend only) of a 32-bit format
// with 1, 2 or 4 components ("uint32", "float32x4", ...). Kernels and
// shaders access it through element(i); with `atomic` the elements are
// atomic<u32|i32>. Growing swaps the attribute under the same node, so
// shaders built on it keep working.
export class WgpuBuffer<F extends ArrayFormat = ArrayFormat> {
  readonly renderer: WebGPURenderer;
  readonly format: F;
  readonly atomic: boolean;
  readonly indirect: boolean;
  attribute: StorageBufferAttribute;
  node: TslNode;
  capacity: number;

  constructor({ renderer, format, count, atomic = false, indirect = false, label = "" }: {
    renderer: WebGPURenderer;
    format: F;
    count: number;
    atomic?: boolean;
    // Indirect dispatch arguments (uint32, 3 per dispatch)
    indirect?: boolean;
    // The GPU buffer's name in WebGPU errors and debuggers
    label?: string;
  }) {
    requireWebGPU(renderer, "WgpuBuffer");
    if (ArrayFormats.info(format).scalarBytes !== 4 || !ArrayFormats.info(format).gpu) {
      throw new Error(`WgpuBuffer needs a 32-bit format with 1, 2 or 4 components, not ${format}`);
    }

    this.renderer = renderer;
    this.format = format;
    this.atomic = atomic;
    this.indirect = indirect;

    this.capacity = Math.max(1, count);
    this.checkSize(this.capacity);
    this.attribute = this.makeAttribute(this.capacity, label);
    this.node = storage(this.attribute, gpuFormatInfo(format).node, this.capacity);
    if (atomic) {
      this.node = this.node.toAtomic();
    }
  }

  get components() {
    return ArrayFormats.info(this.format).components;
  }

  get byteLength() {
    return this.capacity * ArrayFormats.info(this.format).bytes;
  }

  element(index: TslNode): TslNode {
    return this.node.element(index);
  }

  // The GPU buffer, created if three has not yet
  gpuBuffer(): GPUBuffer {
    const backend = this.backend();
    if (!backend.get(this.attribute).buffer) {
      if (this.indirect) {
        backend.createIndirectStorageAttribute(this.attribute);
      } else {
        backend.createStorageAttribute(this.attribute);
      }
    }
    return backend.get(this.attribute).buffer!;
  }

  // Resize to `count` elements; with `keep` the old contents are copied over
  setCapacity(count: number, { keep = false }: { keep?: boolean } = {}) {
    const capacity = Math.max(1, count);
    if (capacity === this.capacity) {
      return false;
    }
    this.checkSize(capacity);

    const previous = this.attribute;
    const previousBuffer = this.backend().get(previous).buffer;
    this.attribute = this.makeAttribute(capacity, previous.name);
    this.capacity = capacity;
    this.node.value = this.attribute;

    if (keep && previousBuffer) {
      this.copyBuffer(previousBuffer, 0, this.gpuBuffer(), 0, Math.min(previousBuffer.size, this.byteLength));
    }
    if (previousBuffer) {
      this.backend().destroyAttribute(previous);
    }
    return true;
  }

  // Grows by doubling, at most to the binding limit (count itself must fit)
  ensureCapacity(count: number, options?: { keep?: boolean }) {
    if (count <= this.capacity) {
      return false;
    }
    const limit = Math.floor(this.backend().device.limits.maxStorageBufferBindingSize / ArrayFormats.info(this.format).bytes);
    return this.setCapacity(Math.max(count, Math.min(this.capacity * 2, limit)), options);
  }

  // Trade GPU buffers (and capacities) with `other`, of the same format:
  // shaders built on either node follow, as when a buffer grows
  swap(other: WgpuBuffer<F>) {
    if (other.format !== this.format || other.atomic !== this.atomic || other.indirect !== this.indirect) {
      throw new Error("WgpuBuffer.swap: the buffers differ in format or kind");
    }
    [this.attribute, other.attribute] = [other.attribute, this.attribute];
    [this.capacity, other.capacity] = [other.capacity, this.capacity];
    this.node.value = this.attribute;
    other.node.value = other.attribute;
  }

  // Write `data` (scalars of this format) starting at element `offset`
  upload(data: ArrayOf<F>, offset = 0) {
    const bytes = ArrayFormats.info(this.format).bytes;
    this.backend().device.queue.writeBuffer(this.gpuBuffer(), offset * bytes, data.buffer, data.byteOffset, data.byteLength);
  }

  // Zero elements [offset, offset + count) (default: all)
  clear(offset = 0, count = this.capacity - offset) {
    const bytes = ArrayFormats.info(this.format).bytes;
    const device = this.backend().device;
    const encoder = device.createCommandEncoder({ label: "radix_clearBuffer" });
    encoder.clearBuffer(this.gpuBuffer(), offset * bytes, count * bytes);
    device.queue.submit([encoder.finish()]);
  }

  // GPU copy of elements from a buffer of the same format
  copyFrom(src: WgpuBuffer<F>, { srcStart = 0, dstStart = 0, count = src.capacity - srcStart }: {
    srcStart?: number;
    dstStart?: number;
    count?: number;
  } = {}) {
    if (src.format !== this.format || srcStart + count > src.capacity || dstStart + count > this.capacity) {
      throw new Error("WgpuBuffer.copyFrom: formats differ or the range is out of bounds");
    }

    const bytes = ArrayFormats.info(this.format).bytes;
    this.copyBuffer(src.gpuBuffer(), srcStart * bytes, this.gpuBuffer(), dstStart * bytes, count * bytes);
  }

  // Read back elements [offset, offset + count)
  async read(offset = 0, count = this.capacity - offset): Promise<ArrayOf<F>> {
    const { bytes, components, array } = ArrayFormats.info(this.format);
    this.gpuBuffer();
    const buffer = await this.renderer.getArrayBufferAsync(this.attribute, null, offset * bytes, count * bytes);
    return new array(buffer, 0, count * components) as ArrayOf<F>;
  }

  dispose() {
    if (this.backend().get(this.attribute).buffer) {
      this.backend().destroyAttribute(this.attribute);
    }
    this.capacity = 0;
  }

  // Shaders bind the whole buffer, so it must fit the device's binding limit
  private checkSize(capacity: number) {
    const bytes = capacity * ArrayFormats.info(this.format).bytes;
    const limit = this.backend().device.limits.maxStorageBufferBindingSize;
    if (bytes > limit) {
      throw new Error(`WgpuBuffer: ${capacity.toLocaleString("en-US")} elements take ${bytes.toLocaleString("en-US")} bytes, past this device's maxStorageBufferBindingSize of ${limit.toLocaleString("en-US")}; createRenderer({ limits: { maxStorageBufferBindingSize: "adapter" } }) asks for all the adapter has`);
    }
  }

  // Three labels the GPU buffer with the attribute's name
  private makeAttribute(capacity: number, name: string) {
    const { components, array } = ArrayFormats.info(this.format);
    const attribute = this.indirect
      ? new IndirectStorageBufferAttribute(new Uint32Array(capacity * components), components)
      : new StorageBufferAttribute(new array(capacity * components), components);
    attribute.name = name;
    return attribute;
  }

  private copyBuffer(src: GPUBuffer, srcOffset: number, dst: GPUBuffer, dstOffset: number, size: number) {
    const device = this.backend().device;
    const encoder = device.createCommandEncoder({ label: "radix_copyBuffer" });
    encoder.copyBufferToBuffer(src, srcOffset, dst, dstOffset, size);
    device.queue.submit([encoder.finish()]);
  }

  private backend() {
    return backendOf(this.renderer) as unknown as {
      device: GPUDevice;
      get(object: unknown): { buffer?: GPUBuffer };
      createStorageAttribute(attribute: StorageBufferAttribute): void;
      createIndirectStorageAttribute(attribute: StorageBufferAttribute): void;
      destroyAttribute(attribute: StorageBufferAttribute): void;
    };
  }
}
