// The core module workers import (WorkerPool.coreUrl): core/, plus
// serveWorker, which the pool's workers call to serve their handlers
export * from "../core/index";
export { serveWorker } from "./coreWorker";
