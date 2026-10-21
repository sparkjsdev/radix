import { IndirectStorageBufferAttribute, StorageBufferAttribute, type WebGPURenderer } from "three/webgpu";
import { ArrayFormats, type ArrayFormat, type ArrayOf } from "../core/formats";
import { backendOf } from "../gpu/backend";
import { gpuFormatInfo } from "../gpu/gpuFormats";
import { TSL, type TslNode } from "../gpu/tsl";
import { requireWebGPU } from "./WgpuCompute";

const { storage } = TSL;

/**
 * A resizable storage buffer of a 32-bit format, on the WebGPU backend only.
 * Growing or swapping keeps its TSL node, so shaders built on it keep working.
 */
export class WgpuBuffer<F extends ArrayFormat = ArrayFormat> {
  readonly renderer: WebGPURenderer;
  readonly format: F;
  readonly atomic: boolean;
  /** Whether the buffer holds indirect dispatch arguments. */
  readonly indirect: boolean;
  /** three's attribute for the buffer, replaced when it grows or swaps. */
  attribute: StorageBufferAttribute;
  node: TslNode;
  /** The size in elements. */
  capacity: number;

  /**
   * Makes the buffer.
   *
   * @param options.renderer The renderer to make it on, with the WebGPU
   *   backend.
   * @param options.format A 32-bit format with 1, 2 or 4 components.
   * @param options.count The size in elements.
   * @param [options.atomic=false] Makes the elements atomic<u32> or
   *   atomic<i32>.
   * @param [options.indirect=false] Holds dispatch arguments, 3 uint32 each.
   * @param [options.label=""] The GPU buffer's name in WebGPU errors and
   *   debuggers.
   */
  constructor({ renderer, format, count, atomic = false, indirect = false, label = "" }: {
    renderer: WebGPURenderer;
    format: F;
    count: number;
    atomic?: boolean;
    indirect?: boolean;
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

  /** The GPU buffer, made if three has not made it yet. */
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

  /**
   * Resizes the buffer.
   *
   * @param count The size in elements.
   * @param [options.keep=false] Copies the old contents over.
   * @return Whether the size changed.
   */
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

  /**
   * Grows the buffer to fit count, doubling up to the binding limit.
   *
   * @param count The size needed, in elements.
   * @param [options.keep=false] Copies the old contents over.
   * @return Whether the size changed.
   */
  ensureCapacity(count: number, options?: { keep?: boolean }) {
    if (count <= this.capacity) {
      return false;
    }
    const limit = Math.floor(this.backend().device.limits.maxStorageBufferBindingSize / ArrayFormats.info(this.format).bytes);
    return this.setCapacity(Math.max(count, Math.min(this.capacity * 2, limit)), options);
  }

  /** Trades GPU buffers and capacities with a buffer of the same format and kind. */
  swap(other: WgpuBuffer<F>) {
    if (other.format !== this.format || other.atomic !== this.atomic || other.indirect !== this.indirect) {
      throw new Error("WgpuBuffer.swap: the buffers differ in format or kind");
    }
    [this.attribute, other.attribute] = [other.attribute, this.attribute];
    [this.capacity, other.capacity] = [other.capacity, this.capacity];
    this.node.value = this.attribute;
    other.node.value = other.attribute;
  }

  /**
   * Writes elements from the CPU.
   *
   * @param [offset=0] The first element to write.
   */
  upload(data: ArrayOf<F>, offset = 0) {
    const bytes = ArrayFormats.info(this.format).bytes;
    this.backend().device.queue.writeBuffer(this.gpuBuffer(), offset * bytes, data.buffer, data.byteOffset, data.byteLength);
  }

  /**
   * Zeroes elements.
   *
   * @param [offset=0] The first element.
   * @param [count=capacity-offset] The elements to zero.
   */
  clear(offset = 0, count = this.capacity - offset) {
    const bytes = ArrayFormats.info(this.format).bytes;
    const device = this.backend().device;
    const encoder = device.createCommandEncoder({ label: "radix_clearBuffer" });
    encoder.clearBuffer(this.gpuBuffer(), offset * bytes, count * bytes);
    device.queue.submit([encoder.finish()]);
  }

  /**
   * Copies elements on the GPU from a buffer of the same format.
   *
   * @param [options.srcStart=0] The first element to read.
   * @param [options.dstStart=0] The first element to write.
   * @param [options.count=src.capacity-srcStart] The elements to copy.
   */
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

  /**
   * Reads elements back from the GPU.
   *
   * @param [offset=0] The first element.
   * @param [count=capacity-offset] The elements to read.
   */
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
