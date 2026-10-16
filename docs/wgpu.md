# WebGPU compute

The `Wgpu*` classes provide the features only WebGPU has: compute kernels, storage buffers, compute writers and scattered stores into tables, and the GPU radix sort and compaction that `SplatRenderer` sorts with. Everything here needs the WebGPU backend and throws on WebGL2 (check `getGpuCaps(renderer).compute`).

Code: `src/wgpu/`. Kernels are TSL functions, like everything in `gpu/`, which three compiles to WGSL compute shaders ([shaders.md](shaders.md)).

```ts
const { If, uint } = TSL;

const counts = new WgpuBuffer({ renderer, format: "uint32", count: n });
const double = new WgpuCompute({
  body: ({ index }) => {
    If(index.lessThan(uint(n)), () => {
      counts.element(index).assign(index.mul(2));
    });
  },
});

// n threads, in workgroups of 64
double.dispatch(renderer, n);

// A Uint32Array
const values = await counts.read();
```

## Storage arrays

`GpuArrays` made with `storage: true` can be written from compute. They also support everything other arrays do: uploads, readbacks, copies, swaps, readers, and fragment writers.

```ts
// Both are typed GpuArrays<S, true>
const arrays = new GpuArrays({
  renderer,
  bundles: { extSplats: Splats.EXT },
  capacity,
  storage: true,
});
const copy = GpuArrays.fromData(renderer, data, { storage: true });
```

- The type records the setting: `WgpuArrayWriter` and `WgpuArrayStore.bind` accept only `GpuArrays<S, true>`, so passing other arrays is a compile error. `arrays.hasStorage()` narrows arrays made with a `boolean`.
- Only some formats can be written this way (`channel.storage` tells which): 32-bit formats with 1, 2, or 4 components, and `rgba8unorm`, `rgba8snorm`, and `rgba16float` texels. That covers every splat bundle. Other channels stay read-only from compute.
- `swap` requires both arrays to have the same storage setting.

## WgpuArrayWriter

`WgpuArrayWriter` is the compute version of `GpuArrayWriter`. It takes the same constructor arguments, runs through the same `arrays.write` / `writeBatch`, and gives the same texels for the same indices. Both kinds can be mixed in one batch.

```ts
const writer = new WgpuArrayWriter({
  outputs: { extSplats: Splats.EXT },
  write: (index, out) => {
    const splat = reader.loadSplat(index);
    const pbr = reader.loadPbr(index);
    GpuSplats.storeExt(out.extSplats, splat, pbr);
  },
});

arrays.write(writer, { at: 0, count: n, first: 0 });

// A compute and a fragment writer in one batch
arrays.writeBatch([
  { writer, at: 0, count: 1000 },
  { writer: fragmentWriter, at: 4096, count: 500 },
]);
```

| Option | Default | What it does |
|---|---|---|
| `outputs` | | the bundles written (names to definitions) |
| `write(index, out)` | | assigns one texel per output channel |
| `workgroupSize` | 64 | threads per workgroup |
| `label` | from the channels | the kernel's name in GPU profilers |

- Each range runs as one dispatch with one thread per texel, across every layer.
- Limits: at most 4 output channels (`WgpuArrayWriter.MAX_CHANNELS`, from `maxStorageTexturesPerShaderStage`), one packing, storable formats only, and storage arrays only. There is no limit on bytes per texel.
- `write` must not read the arrays it writes: a texture cannot be sampled and written in the same dispatch. Read from other arrays, then `swap`.
- `writer.kernel` is its `WgpuCompute`.

## WgpuArrayStore

`WgpuArrayStore` writes elements at any index from a kernel. It is the writing counterpart of `GpuArrayReader`.

```ts
const store = new WgpuArrayStore(Splats.EXT).bind(arrays, "extSplats");
const scatter = new WgpuCompute({
  body: ({ index }) => {
    If(index.lessThan(n), () => {
      // One element at any index (packing 1)
      store.store("extA", target(index), value(index));
    });
  },
});

scatter.dispatch(renderer, count);
arrays.count = count;
```

| Member | What it does |
|---|---|
| `new WgpuArrayStore(def)` | a store of one bundle definition; the shader code is built from it alone |
| `bind(arrays, name)` | write bundle `name` of storage arrays from now on; bind again after the arrays are resized or swapped |
| `store(channel, index, value)` | writes one element of an unpacked bundle |
| `storeTexel(channel, texel, value)` | writes a whole texel (of a packed bundle) |

The kernel must set `arrays.count` itself.

## WgpuCompute and WgpuComputeBatch

```ts
const kernel = new WgpuCompute({
  workgroupSize: [64],
  label: "myKernel",
  body: ({ index, globalId, localId, workgroupId, numWorkgroups }) => {
    // ...
  },
});

// A thread count, [x, y, z] workgroups, or an indirect buffer
kernel.dispatch(renderer, threads);

// Two kernels in one compute pass
const batch = new WgpuComputeBatch(renderer);
batch.add(a, n);
batch.add(b, n);
batch.submit();
```

| Member | What it does |
|---|---|
| `new WgpuCompute({ body, workgroupSize?, label? })` | a kernel built once from a TSL body. `workgroupSize` is 1 to 3 numbers (default `[64]`) |
| `dispatch(renderer, size)` | runs it now. `size` (`DispatchSize`): a thread count (rounded up to whole workgroups), workgroups per dimension, or an `IndirectStorageBufferAttribute` the GPU wrote (3 x uint32) |
| `dispose()` | frees the kernel |
| `ComputeIds` | the body's argument: `globalId`, `localId`, `workgroupId`, `numWorkgroups`, and `index` (the linear thread index) |
| `new WgpuComputeBatch(renderer)`, `add(kernel, size)`, `submit({ split? })` | dispatches recorded into as few compute passes as possible; `split: true` dispatches one by one, so profilers time each kernel |

- A body must check its own bounds: a thread count is rounded up to whole workgroups. When a dispatch needs more than 65535 workgroups, three splits it into a 2D grid, and `index` stays linear.
- In a batch, each dispatch sees the storage writes of the dispatches before it. A kernel queued again with a different size starts a new pass.
- A uniform holds one value for a whole pass: set uniforms before `add`, and leave them until `submit`.

**Workgroup scans** for your own kernels are static methods of `WgpuCompute`: `scanTier(renderer, tier?)` (`"subgroup"` where the device has subgroups, else `"portable"`: a `ScanTier`), `threadRank(tier, localId)` (each thread's rank in scan order), and `workgroupExclusiveScan(tier, scratch, rank, value)` (an exclusive prefix sum of one `uint` per thread, plus the total), over `SCAN_WORKGROUP` (256) threads.

## WgpuBuffer

`WgpuBuffer` is a typed, resizable storage buffer of a 32-bit format with 1, 2, or 4 components.

```ts
const buffer = new WgpuBuffer({
  renderer,
  format: "uint32",
  count,
  atomic: false,
  indirect: false,
});

// In TSL
buffer.element(i);

// From JavaScript
buffer.upload(values);
await buffer.read();
buffer.clear();
buffer.copyFrom(other);
buffer.ensureCapacity(n, { keep: true });
```

| Member | What it does |
|---|---|
| `new WgpuBuffer({ renderer, format, count, atomic?, indirect?, label? })` | `atomic`: the elements are `atomic<u32>` or `atomic<i32>`; `indirect`: dispatch or draw arguments; `label`: the GPU buffer's name in WebGPU errors and debuggers |
| `element(i)` | element `i` in TSL |
| `upload(data, offset?)`, `read(offset?, count?)`, `clear(offset?, count?)` | CPU writes, readbacks, and zeroing |
| `copyFrom(src, { srcStart?, dstStart?, count? })` | a GPU copy from a buffer of the same format |
| `setCapacity(n, { keep? })`, `ensureCapacity(n, { keep? })` | resize; `keep` copies the contents. `ensureCapacity` doubles, but never past the binding limit |
| `swap(other)` | trades GPU buffers (and their labels) with a buffer of the same format and kind |
| `node`, `attribute`, `capacity`, `byteLength`, `components`, `gpuBuffer()` | the TSL node, three's attribute, the size, and the `GPUBuffer` |
| `dispose()` | frees the buffer |

- Growing or swapping keeps the same TSL node, so shaders built on the buffer keep working.
- Shaders bind a whole buffer, so a size larger than the device's `maxStorageBufferBindingSize` throws an error naming the limit. Radix requests 256 MiB by default, which 98% of devices support (64M uint32s); `createRenderer({ limits: { maxStorageBufferBindingSize: "adapter" } })` asks for all the adapter has.

## WgpuRadixSort and WgpuCompact

These are general building blocks: the sort takes any uint32 keys and values, and the compaction takes any TSL function that returns a key.

```ts
// keys and values are WgpuBuffer<"uint32">, sorted in place
const sort = new WgpuRadixSort({ renderer, keys, values });

// Or sortIndirect(countBuffer, { bits })
sort.sort(count, { bits: 24 });

const compact = new WgpuCompact({ renderer, key: (i) => keyOf(i) });

// Keys equal to this are dropped
compact.invalid.value = 0xffffff;

// Outputs compact.keys, compact.values (indices) and compact.count (element 0)
compact.compact(n);
```

| Member | What it does |
|---|---|
| `new WgpuRadixSort({ renderer, keys, values, tier?, keysPerThread? })` | a stable LSD sort with 8-bit digits. `tier`: `"auto"` (default), `"portable"`, or `"subgroup"`. `keysPerThread`: 8 (default) or 16 (`RadixKeysPerThread`) |
| `sort(count, { bits? })` | sorts the first `count` keys and their values; `bits` is 16, 24, or 32 (default 32): 2, 3, or 4 passes |
| `sortIndirect(countBuffer, { bits? })` | the count from a buffer the GPU wrote (after compaction); every dispatch is sized on the GPU |
| `new WgpuCompact({ renderer, key, tier? })` | stream compaction of `key(i)` for the first `n` indices |
| `compact(n)`, `invalid`, `keys`, `values`, `count` | run it; the dropped key (a `uint` uniform, default all ones); the outputs |
| `dispose()` | frees the kernels and buffers |

- Each radix pass is a histogram, a block scan, and a scatter (reduce, then scan, with no forward-progress assumptions), one kernel per pass, so a whole sort fits in one `WgpuComputeBatch`. It gives the same order as the CPU's `SortKeys.sort`.
- Scans use subgroup operations where the device has them and workgroup memory otherwise. Both tiers give the same results.
- 16 keys per thread need about 19 KB of workgroup memory and measured 10-25% slower on an Apple M3, so 8 is the default.
- With an odd number of passes (24-bit keys), the sort ends by swapping the buffers with its scratch buffers (`WgpuBuffer.swap`) instead of copying back.
- `WgpuCompact` uses a deterministic block scan, no atomics, and keeps the input order, so a stable sort after compaction gives the same order as sorting every element.

## WgpuSplatSorter

`SplatRenderer` sorts with this class in `sortMode: "gpu"`. Compaction drops the invalid keys of a projection's `sortKeys` bundle, `sortIndirect` orders the rest back to front, and a one-thread kernel writes the `drawIndexedIndirect` arguments. Nothing is read back.

| Member | What it does |
|---|---|
| `new WgpuSplatSorter(renderer)` | the sorter's kernels and buffers |
| `sort(projected, count, bits)` | sorts the first `count` splats of arrays with a `sortKeys` bundle (`SortKeys.KEYS`) |
| `values` | the sorted splat indices: `values.element(i)` is the i-th splat drawn |
| `count` | the visible count, as a TSL node |
| `indirect` | the draw arguments: `[6 x 1024, ceil(visible / 1024), 0, 0, 0]` |
| `readCount()` | the visible count, read back |
| `WgpuSplatSorter.QUADS_PER_INSTANCE` | 1024: splats per instance of the draw |
| `dispose()` | frees it |

More on how the renderer uses it: [sorting.md](sorting.md#the-gpu-sort).
