# Concepts

Definitions of the terms the other pages use, in the order they come up. Each entry links to the page that covers it.

## Data

- **Table** (`ArrayData`): the structure Radix keeps its data in. Rows are **elements** (one splat, one sort key, one index), and columns are **channels**: typed arrays whose **format** says what each element holds (`"uint32x4"`, `"float16x2"`, `"unorm8x4"`). The first `count` rows are valid, and `capacity` rows are allocated, always a multiple of 4096. [arraydata.md](arraydata.md)
- **Bundle**: a named set of channels used together, such as the two channels `extA` and `extB` of a splat. Its definition (`defineBundle`) is plain data, so it can be sent to workers and written into file headers unchanged. All bundles of a table have the same rows. [arraydata.md](arraydata.md#bundles)
- **Packing**: how many elements share one GPU texel (1, 2, or 4). Index lists pack 4 indices per `uint32x4` texel.
- **GPU table** (`GpuArrays`): the same table in textures, one 2D array texture per channel, so row `i` on the CPU is row `i` on the GPU. [gpu-arrays.md](gpu-arrays.md)
- **Texture layout** (`TextureLayout`): where element `t` sits in its texture: 1024 texels per row, a power-of-two height, and up to 512 layers. [gpu-arrays.md](gpu-arrays.md#texture-layout)
- **Twins**: a `core/` class and its `gpu/` shader version with the same method names and the same bit layouts (`Splats` and `GpuSplats`, `Encoding` and `GpuEncoding`, `SortKeys` and `GpuSortKeys`). Data encoded on one side decodes on the other. [encoding.md](encoding.md)
- **Transfer**: sending a table's arrays to a worker without copying them. The sender's arrays are detached until they come back. [workers.md](workers.md)

## Splats

- **Splat**: one 3D Gaussian, with a center, three scales, a rotation (quaternion), a color, and an opacity. Ext splats add a normal, roughness, and metallic (PBR).
- **Layout**: how a table stores splats. `extSplats` (32 bytes, the default), `covSplats` (32 bytes, a covariance instead of scales and rotation), and `packedSplats` (16 bytes, 8-bit codes). A layout's name is also its bundle's name: `data.bundles.extSplats`. [splats.md](splats.md)
- **Covariance form** and **splat form**: the two ways to give a splat's shape. Splat form is scales plus a rotation (`SplatNode`); covariance form is the 3x3 covariance matrix (`CovSplatNode`). Converting splat to covariance is cheap; the reverse needs an eigendecomposition. [generators.md](generators.md#forms)
- **LoD tree**: a level-of-detail tree stored next to the splats in a `lodTree` bundle, one node per splat. Radix loads and saves it; the app chooses which nodes to draw.
- **LoD subset**: the splats of a LoD tree an app chose for the current camera, drawn through an index list.
- **Index list**: a table of element indices (`ArrayData.INDICES`, bundle `indices`), used for draw orders and for subsets. [generators.md](generators.md#index-lists)
- **Splat atlas**: several objects stored together in one set of arrays, like a texture atlas, each drawn through an index list or a remap.

## Drawing

- **Generator** (`SplatGenerator`): TSL code that makes splat `i` in a shader, in splat form, covariance form, or both. A reader of stored splats is one kind (`SplatGenerator.fromSplats`); a function that computes splats from `i` is another. A generator is a program; its data is bound per object with `bind(data)`. [generators.md](generators.md)
- **Object** (`SplatObject`): one thing to draw: a generator, its data, a splat count, and a world transform (`matrixWorld`). [rendering.md](rendering.md#splatobject)
- **Collection** (`SplatCollection`): an immutable, ordered list of objects. The collection object serves as the version: a different set of objects or counts needs a new collection. [rendering.md](rendering.md#splatcollection)
- **Renderer** (`SplatRenderer`): the `THREE.Mesh` that draws a collection, and the settings every viewpoint shares. Add it to a scene and render from any camera. [rendering.md](rendering.md#splatrenderer)
- **Viewpoint** and **view** (`SplatView`): one place a renderer is drawn from, usually one camera. A view holds the settings that differ for that viewpoint and, with the CPU sort, that viewpoint's order. [views.md](views.md)
- **View key**: the key a renderer stores a view under: the camera by default, or any value from `viewKey(camera)`. [views.md](views.md#view-keys)
- **Head** and **eyes**: the head is the camera in mono, or the XR rig's pose in stereo; each eye is one image drawn. Splats are projected once from the head, with a small part per eye. [xr.md](xr.md)
- **Method** (`ProjectionMethod`): one of four ways to rasterize a splat: `ewa`, `3dgut`, `htgs`, and `raygs`. [projection.md](projection.md#methods)
- **Projection**: the pass that turns each splat into a few 32-bit **words** (what the draw needs to place and shade its quad) plus a sort key. It runs in compute on WebGPU and as a fragment pass on WebGL2. [projection.md](projection.md)
- **Params**: plain values that tune the projection and the draw (`blurAmount`, `maxStdDev`, ...). View params are shared by everything one render draws; object params can differ per object. [params.md](params.md)
- **Modifier**: a TSL function applied to every splat a renderer draws, in view, world, or object space, or in the frame of a matrix. [generators.md](generators.md#modifiers)
- **Program cache**: compiled projection programs, one per generator, modifier, method, eye count, and backend, shared by every renderer. [generators.md](generators.md#the-program-cache)

## Sorting

- **Sort key**: a 16-, 24-, or 32-bit integer per splat that orders splats back to front. It encodes the splat's distance from the head. [sorting.md](sorting.md#sort-keys)
- **Invalid key**: the all-ones key of a splat that is not drawn; it sorts last and is dropped.
- **GPU sort**: compaction and a radix sort on the GPU in the same frame as the projection (`sortMode: "gpu"`, WebGPU only). [sorting.md](sorting.md#the-gpu-sort)
- **CPU sort**: the keys are computed on the GPU, read back, and sorted on a worker; the order arrives a few frames late (`sortMode: "cpu"`, the WebGL2 path). [sorting.md](sorting.md#the-cpu-sort)
- **Order** (`SplatOrder`): the result of one CPU sort: splat indices back to front, for one collection, from one viewpoint, with a `version`. [views.md](views.md#orders)
- **autoSort**: the loop that re-sorts a view when its camera or collection changed and applies each order as it arrives. [views.md](views.md#autosort)
- **Sort guard** (`sortGuard`): a band around the view outside which the CPU sort drops splats, so it sorts and draws fewer splats. [sorting.md](sorting.md#sortguard)

## Lifetimes

- **Live collection**: a collection that a renderer may still draw or sort. These are the renderer's collection, its views' collections and, with the CPU sort, the collections of their orders and of sorts in flight. [lifetimes.md](lifetimes.md#object-releases)
- **Release**: an object's callback, run once that object is in no live collection of any renderer. The app frees what the object owns there. [lifetimes.md](lifetimes.md#object-releases)
- **onInvalidate**: the renderer's callback for when there is something new to show: an order landed or a sort was requested. For apps that render only when needed. [lifetimes.md](lifetimes.md#on-demand-rendering)
