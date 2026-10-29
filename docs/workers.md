# Workers

`WorkerPool` runs `core/` functions on up to `size` workers. A worker is made only when a call needs one, so a pool that is never used starts no workers. Most apps don't use the pool directly: `loadSplats`, `writeSplats`, and the CPU sort use the shared pool (`WorkerPool.default`) or the shared sort pool (`SplatRenderer.sortPool`).

Code: `src/worker/` (imports `core/` only): `WorkerPool.ts`, `coreWorker.ts` (the worker's handlers), `coreModule.ts` (what workers import), `splatFiles.ts`, and `splatSort.ts`.

```ts
const pool = new WorkerPool({ size: 2 });

// Runs on the next free worker; callers queue in order
const { splats } = await pool.call("loadSplats", { url }, { onProgress });
// splats is a TransferableArrayData; ArrayData.fromTransferable(splats) rebuilds the table

// One worker, held until released
const lease = await pool.acquire();
await lease.call("writeSplats", { data: splats, format: "ply" });
lease.release();

// Terminates the workers
pool.dispose();
```

## WorkerPool and WorkerLease

| Member | What it does |
|---|---|
| `new WorkerPool({ size? })` | a pool of up to `size` workers (default 4), none made yet |
| `WorkerPool.default` | the shared pool, made on first use (still without workers) |
| `WorkerPool.available` | whether this context can make workers: a page can; Node and workers cannot |
| `WorkerPool.coreUrl` | a blob URL of `core/` as one ES module, the one the pool's workers run, for an app's own workers to `import()` ([below](#your-own-workers-and-the-core-module)) |
| `call(name, args, { onProgress?, signal? })` | runs a handler on the next free worker (making one if the pool has room), and returns its result |
| `acquire({ signal? })` | a `WorkerLease`: one worker, held until `release()`; an abort while waiting for one rejects |
| `workerCount` | workers made so far, and alive |
| `dispose()` | terminates the workers (their pending calls reject) and rejects queued callers |
| `lease.call(name, args, options?)`, `lease.release()` | runs a handler on the leased worker; gives the worker back. A released lease throws on `call` |

Types: `WorkerCall` (the handler names), `WorkerArgs<N>` and `WorkerResult<N>` (a handler's argument and result), and `CallOptions` (`{ onProgress?, signal? }`).

## Handlers

| Handler | Arguments | Result |
|---|---|---|
| `loadSplats` | `{ url \| bytes, name?, layout?, encoding?, sh?, coordinateSystem?, palette?, request? }` (`request`: `fetch` options, plain data) | `{ splats, shPalette? }`: the table (`TransferableArrayData`), its SH bundle included, and the palette's table for RAD's clustered SH; `palette: false` expands it per splat instead |
| `writeSplats` | `{ data, shPalette?, format, options? }` | `{ bytes, error, data, shPalette }`: the data's (and palette's) arrays come back even when encoding fails |
| `sortKeys` | `{ keys, count, bits, ordering? }` | `{ ordering, visible, keys }`: the order, the visible count, and the keys, back for reuse |

Pages call the wrappers instead: `loadSplats` / `loadSplatFile` / `writeSplats` ([files.md](files.md)) and `sortSplatKeys` (below).

## sortSplatKeys

`sortSplatKeys(keys, { bits, ordering?, worker? })` sorts splat sort keys back to front (`SortKeys.sort`) on a worker or on the current thread, with the same `worker` choices as `loadSplats`. It returns `SortedSplats`: `ordering` (splat indices back to front; its first `visible` have valid keys), `visible`, and `keys`. The keys and the order are transferred to the worker and back, so pass the previous `ordering` to reuse its array. `SplatView.sort` calls it ([sorting.md](sorting.md#the-cpu-sort)).

## Transfers and progress

- Arrays in arguments and results are transferred, not copied (`ArrayData.transferables` finds every `ArrayBuffer` in a value). The sender's arrays are detached until they come back, and `ArrayData.setFromTransferable` puts them back in place ([arraydata.md](arraydata.md#sending-to-workers)).
- A handler reports progress as `(fraction, stage)`. The worker posts it at most every 50 ms (and whenever the stage changes or it finishes), and never reports a lower fraction than before.

## Cancelling

A call's `signal` (`CallOptions`) rejects the call with `signal.reason` as soon as it aborts. The pool then posts `{ id, cancel: true }`, and the worker aborts that call's own `AbortController`: `fetch` stops, and the handler's `progress` throws at its next report, so a decode stops there too. The worker stays, so a lease keeps working. A call aborted while it waits for a worker leaves the queue. A result that arrives after the abort is dropped.

## Failures

- A handler that throws rejects its call with the error's message; the worker stays.
- When a worker fails outside a handler (an uncaught error, or a message that cannot be read), its pending calls reject and the worker is replaced, so a waiting caller gets a new worker.
- `dispose()` rejects pending and queued calls.

## Bundling

The workers' code is one ES module in the bundle: `worker/coreModule.ts` (`core/` plus `serveWorker` from `coreWorker.ts`), imported as a string (`import coreModule from "./coreModule?module&inline"`, built by `scripts/inline-worker-plugin.mjs`, minified in the library build, since an app's minifier cannot shrink a string). `WorkerPool.coreUrl` is a blob URL of it, made on first use, and each pool worker starts from a one-line blob that imports `serveWorker` from that URL and calls it. Pages therefore need no separate worker file, and every worker loads the same code. A bundler other than this repo's esbuild setup needs the same `?module&inline` import support. Pages need `worker-src blob:` if they set a Content Security Policy.

## Your own workers and the core module

A page's own module worker gets no import map, so it cannot `import "@sparkjsdev/radix"`. It imports `core/` from `WorkerPool.coreUrl` instead: the module Radix's own workers run, already in the bundle, so no second file is loaded. The page hands the URL to the worker:

```ts
// Page
const worker = new Worker(new URL("./myWorker.js", import.meta.url), { type: "module" });
worker.postMessage({ coreUrl: WorkerPool.coreUrl });

// myWorker.ts
let core: Promise<typeof import("@sparkjsdev/radix/core")> | undefined;
self.onmessage = async (event) => {
  core ??= import(event.data.coreUrl);
  const { SplatFiles, Encoding } = await core;
  // ...
};
```

The LCC example's decoders work this way (`examples/lcc/LccDecoders.ts`, `lccWorker.ts`). The module also exports `serveWorker`, which an app's worker does not call.

`npm run build` also writes `dist/radix-core.module.js`: `core/` alone (formats, tables, codecs, the CPU encoder), with no imports at all, for Node and for pages that load workers without the library. Such a page maps it in its import map (`"@sparkjsdev/radix/core": "/dist/radix-core.module.js"`) and hands `import.meta.resolve("@sparkjsdev/radix/core")` to its workers. The build fails if `core/` gains an import.

## Adding a handler

To add a handler, add a function to `handlers` in `coreWorker.ts`. It receives its arguments and `{ progress, signal }` (`progress` throws once the call is cancelled), and its return value is transferred back. `WorkerCall`, `WorkerArgs`, and `WorkerResult` are derived from the handlers' types, so they include the new one.
