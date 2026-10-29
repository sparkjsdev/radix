// A pool of LCC decode workers (lccWorker.ts): LCC v1 blocks and
// environments, LCC2 .spz / .ply chunks. Each worker gets the URL of
// Radix's core module (WorkerPool.coreUrl, the copy Radix's own
// workers run), since a worker has no import map. Each runs up to two
// requests at once, so one block downloads while another decodes; callers
// look at `free` and pick their most wanted blocks every frame instead of
// queueing requests that may go stale.
import { ArrayData, WorkerPool } from "@sparkjsdev/radix";
                                                                         
                                                                    
                                                           

const PER_WORKER = 2;

               
                 
                               
                             
 

                         
              
                    
                                            
                       
 

export class LccDecoders {
                   workers          ;
                   busy = new Map                ();
                   jobs = new Map             ();
          nextId = 1;
  // Totals since the pool was made
           stats = { decoded: 0, bytes: 0, ms: 0, lastMs: 0 };

  constructor({ workers = Math.max(2, Math.min(4, Math.floor((navigator.hardwareConcurrency || 4) / 2))) }                       = {}) {
    const coreUrl = WorkerPool.coreUrl;
    this.workers = Array.from({ length: workers }, () => {
      const worker = new Worker(new URL("./lccWorker.js", import.meta.url), { type: "module" });
      worker.onmessage = (event                        ) => this.receive(event.data);
      worker.onerror = (event) => console.error("LCC decode worker:", event.message);
      worker.postMessage({ type: "init", coreUrl }                     );
      this.busy.set(worker, 0);
      return worker;
    });
  }

  get size() {
    return this.workers.length;
  }

  // Requests the pool can start now
  get free() {
    return this.workers.length * PER_WORKER - this.jobs.size;
  }

  get running() {
    return this.jobs.size;
  }

  // The block decoded into ext splats (and extSh with `sh`); rejects with an
  // AbortError when `signal` aborts first
  decode(source           , block          , { sh, ranges, normal, signal }               )                     {
    return this.post({ type: "decode", id: 0, source, block, sh, ranges, normal }, signal)                      ;
  }

  // environment.bin decoded likewise (with the scene's env ranges), or
  // undefined when the scene has none
  environment(source           , { sh, ranges, normal, signal }               )                                 {
    return this.post({ type: "environment", id: 0, source, sh, ranges, normal }, signal)                                  ;
  }

  // An LCC2 .spz / .ply chunk file (the first of `paths` the source has) as
  // ext splats, with extSh and meta.lccSh when `sh` and it has SH
  chunk(source           , paths          , { sh, signal }                                       )                     {
    return this.post({ type: "chunk", id: 0, source, paths, sh }, signal)                      ;
  }

  // collision.lci's header, or undefined when the scene has none
  lciHeader(source           )                                 {
    return this.post({ type: "lciHeader", id: 0, source })                                  ;
  }

  // A collision chunk: a mesh of collision.lci, or an LCC2 node's mesh .ply
  // and .btree (the first of each list of paths the source has)
  collision(source           , what                                                                      , signal              )                          {
    const request             = "mesh" in what ? { type: "lciMesh", id: 0, source, mesh: what.mesh } : { type: "lcc2Collision", id: 0, source, ...what };
    return this.post(request, signal)                           ;
  }

          post(request                                                  , signal              ) {
    const worker = this.workers.reduce((best, each) => (this.busy.get(each)  < this.busy.get(best)  ? each : best));
    const id = this.nextId++;
    this.busy.set(worker, this.busy.get(worker)  + 1);
    return new Promise         ((resolve, reject) => {
      this.jobs.set(id, { worker, resolve, reject });
      signal?.addEventListener("abort", () => worker.postMessage({ type: "cancel", id }                     ), { once: true });
      worker.postMessage({ ...request, id }                     );
    });
  }

          receive(reply          ) {
    const job = this.jobs.get(reply.id);
    if (!job) {
      return;
    }
    this.jobs.delete(reply.id);
    this.busy.set(job.worker, this.busy.get(job.worker)  - 1);
    if (reply.type === "decoded") {
      this.stats.decoded += 1;
      this.stats.bytes += reply.bytes;
      this.stats.ms += reply.ms;
      this.stats.lastMs = reply.ms;
      job.resolve(ArrayData.fromTransferable(reply.data));
    } else if (reply.type === "missing") {
      job.resolve(undefined);
    } else if (reply.type === "value") {
      job.resolve(reply.value);
    } else {
      job.reject(reply.message === "AbortError" ? new DOMException("Cancelled", "AbortError") : new Error(reply.message));
    }
  }

  dispose() {
    for (const worker of this.workers) {
      worker.terminate();
    }
    for (const job of this.jobs.values()) {
      job.reject(new DOMException("Cancelled", "AbortError"));
    }
    this.jobs.clear();
  }
}


//# sourceURL=examples/lcc/LccDecoders.ts