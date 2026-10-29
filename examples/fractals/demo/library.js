// A demo's fractals, baked just in time. Every cue shows a preset; a preset
// is resident in one table of a pool (sized to the device's memory) once
// its bake starts, with the orders its transitions pair by (morph.ts's
// TableSorter, on a pool of workers). Bakes run in the order the video
// needs them, a chunk at a time between frames (before the start as fast
// as the GPU goes, then within each frame's slack). A table is freed for
// a new bake from the preset needed furthest ahead (never one drawn or
// needed sooner), so a preset shown twice may bake twice, with the same
// seed and the same samples. `fits` says whether what is left can bake
// during playback before each preset's cue.
//
// With `stash` (phones, whose GPU memory is tight: a small pool, and the
// whole demo baked before it starts): once the pool is full, the bakes
// before the start go to one spare table (released at the start) and are
// read back into CPU memory, which is plentiful and not capped; a table
// freed during playback is read back too when its preset comes again; a
// preset kept on the CPU is uploaded into a table when its turn comes
// (milliseconds) instead of baked again (seconds).
import * as THREE from "three";
                                                   
import { GpuArrays,                } from "@sparkjsdev/radix";
                                                     
import { TRANSITIONS, TableSorter,                            } from "../morph.js";
import { PRESETS,             } from "../presets.js";
import { SAMPLES } from "../sample.js";
import { LOOK_DEFAULTS, STYLES,           } from "../shade.js";
                                     

// What the video needs of a preset besides its samples
                          
                 
             
                                                                         
             
 

                    
                 
                    
               
                                
                        
                       
                
 

const lightDirection = (azimuth        , elevation        ) => {
  const az = THREE.MathUtils.degToRad(azimuth);
  const el = THREE.MathUtils.degToRad(elevation);
  return new THREE.Vector3(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az));
};

export class Library {
           fractals = new Map                 ();
           count        ;
           sorter             ;
  // Seconds each cue's transition starts and ends
           starts          ;
           ends          ;
                   renderer                ;
                   cues       ;
                   bakeU              ;
                   maxTables        ;
                   seeds = new Map                ();
                   residents = new Map                  ();
          free              = [];
          tables = 0;
          scratch            ;
  // Presets kept in CPU memory, the spare table bakes before the start go to
  // once the pool is full, and whether it is being read back
                   stash = new Map                   ();
          spare           ;
          spareReading = false;
  // A spare released while it was read back
          spareDispose            ;
                   stashing         ;
          disposed = false;

  constructor(renderer                , kinds        , bakeU              , cues       , times                                      , count        , maxTables        , { stash = false } = {}) {
    this.stashing = stash;
    this.renderer = renderer;
    this.cues = cues;
    this.bakeU = bakeU;
    this.count = count;
    this.starts = times.starts;
    this.ends = times.ends;
    const names = [...new Set(cues.map((cue) => cue.preset))];
    this.maxTables = Math.max(3, Math.min(maxTables, names.length));
    const kindById = new Map(kinds.map((kind) => [kind.id, kind]));
    names.forEach((name, n) => {
      const preset = PRESETS.find((each) => each.name === name);
      if (!preset) {
        throw new Error(`no preset ${name}`);
      }
      const kind = kindById.get(preset.kind) ;
      this.fractals.set(name, { preset, kind, look: { ...LOOK_DEFAULTS, ...kind.look, ...STYLES[preset.style], ...preset.look } });
      // The seeds the teaser videos were rendered with
      this.seeds.set(name, 101 + n * 7);
    });
    this.sorter = new TableSorter(renderer, count, Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 1)));
  }

  get presets() {
    return [...this.fractals.keys()];
  }

  pairing(cue        ) {
    return TRANSITIONS[this.cues[cue].style].pairing;
  }

  // The cue under film time t (its transition included)
  cueAt(t        ) {
    let i = 0;
    while (i + 1 < this.cues.length && t >= this.starts[i + 1]) {
      i += 1;
    }
    return i;
  }

          baked(name        ) {
    const r = this.residents.get(name);
    return r && r.done >= this.count ? r : undefined;
  }

  // Whether cue i can be drawn: its transition (from the last cue's
  // preset, both ordered by its pairing), or the preset at rest
  ready(i        , moving         ) {
    const to = this.baked(this.cues[i].preset);
    if (!to) {
      return false;
    }
    if (!moving) {
      return true;
    }
    const p = this.pairing(i);
    if (!to.orders.has(p)) {
      return false;
    }
    if (i === 0) {
      return true;
    }
    return Boolean(this.baked(this.cues[i - 1].preset)?.orders.has(p));
  }

  // Whether film time t can be drawn
  canShow(t        ) {
    const i = this.cueAt(t);
    return this.ready(i, t < this.ends[i]);
  }

  // Whether every moment of [from, to] can be drawn
  canShowThrough(from        , to        ) {
    for (let i = this.cueAt(from); i < this.cues.length && this.starts[i] <= to; i += 1) {
      if (!this.ready(i, this.ends[i] > from)) {
        return false;
      }
    }
    return true;
  }

  // Rows a second the next bake needs to be ready a second before its cue
  // (0 when nothing is left)
  needed(t        ) {
    for (let i = this.cueAt(t); i < this.cues.length; i += 1) {
      const name = this.cues[i].preset;
      if (!this.baked(name)) {
        return (this.count - (this.residents.get(name)?.done ?? 0)) / Math.max(this.starts[i] - t - 1, 0.25);
      }
    }
    return 0;
  }

  // Hands a baked preset's samples over (to the gallery, as the demo
  // leaves); the library forgets them and bakes them again if needed
  take(name        ) {
    const r = this.baked(name);
    if (!r) {
      return undefined;
    }
    this.residents.delete(name);
    r.orders.forEach((ordered) => ordered.order.dispose());
    return r.arrays;
  }

  arrays(name        ) {
    return this.baked(name) .arrays;
  }

  order(name        , pairing         ) {
    return this.baked(name) .orders.get(pairing) ;
  }

  // Marks presets drawn until the returned release is called
  use(...names          ) {
    const used = names.map((name) => this.residents.get(name) );
    used.forEach((r) => (r.users += 1));
    return () => used.forEach((r) => (r.users -= 1));
  }

  // When a preset is next needed after t (its cue's transition starts), or
  // Infinity; one still drawn at t is needed now
          nextUse(name        , t        ) {
    for (let i = 0; i < this.cues.length; i += 1) {
      const leaves = this.ends[i + 1] ?? Infinity;
      if (this.cues[i].preset === name && leaves > t) {
        return this.starts[i];
      }
    }
    return Infinity;
  }

  // A table for a bake needed at `needAt`: a free one, a new one, or the one
  // of the preset needed furthest after it
          claim(needAt        , t        ) {
    const reused = this.free.pop();
    if (reused) {
      return reused;
    }
    if (this.tables < this.maxTables) {
      this.tables += 1;
      return new GpuArrays({ renderer: this.renderer, bundles: { samples: SAMPLES }, capacity: this.count });
    }
    let victim                      ;
    let latest = needAt;
    for (const r of this.residents.values()) {
      const next = this.nextUse(r.preset, t);
      if (r.users === 0 && r.sorting.size === 0 && r.done >= this.count && next > latest) {
        victim = r;
        latest = next;
      }
    }
    if (!victim) {
      return undefined;
    }
    this.evict(victim, t);
    return this.free.pop();
  }

  // A resident's table freed: read back first when it is stashing and the
  // preset comes again (the table is free once the readback is done)
          evict(r          , t        ) {
    this.residents.delete(r.preset);
    r.orders.forEach((ordered) => ordered.order.dispose());
    if (this.stashing && !this.stash.has(r.preset) && this.nextUse(r.preset, t) < Infinity) {
      void r.arrays.read({ start: 0, count: this.count }).then((data) => {
        if (!this.disposed) {
          this.stash.set(r.preset, data);
        }
      }).finally(() => (this.disposed ? r.arrays.dispose() : this.free.push(r.arrays)));
      return;
    }
    this.free.push(r.arrays);
  }

  // The resident the next bake goes to: the first preset from cue `from`
  // on that is not baked
  // (`ahead`: before the start, when a full pool bakes into the spare table
  // for the CPU). A stashed preset that gets a table is uploaded, not baked
          job(t        , ahead         ) {
    for (let i = this.cueAt(t); i < this.cues.length; i += 1) {
      const name = this.cues[i].preset;
      const r = this.residents.get(name);
      if (r && r.done >= this.count) {
        continue;
      }
      if (r) {
        return r;
      }
      const stashed = this.stash.get(name);
      if (ahead && stashed) {
        continue;
      }
      const arrays = this.claim(this.starts[i], t);
      if (arrays) {
        const resident           = { preset: name, arrays, done: 0, orders: new Map(), sorting: new Set(), users: 0 };
        this.residents.set(name, resident);
        if (!stashed) {
          return resident;
        }
        arrays.upload(stashed, { srcStart: 0, dstStart: 0, count: this.count });
        resident.done = this.count;
        continue;
      }
      if (!ahead || !this.stashing || this.spareReading) {
        return undefined;
      }
      if (this.spare?.preset !== name) {
        this.spare ??= { preset: name, arrays: new GpuArrays({ renderer: this.renderer, bundles: { samples: SAMPLES }, capacity: this.count }), done: 0, orders: new Map(), sorting: new Set(), users: 0 };
        this.spare.preset = name;
        this.spare.done = 0;
      }
      return this.spare;
    }
    return undefined;
  }

  // Every preset baked or on the CPU (what a phone waits for before it
  // starts)
  stocked() {
    return this.presets.every((name) => this.baked(name) || this.stash.has(name));
  }

  // The start: the spare table goes (once its readback is done)
  endPrep() {
    const spare = this.spare;
    this.spare = undefined;
    if (spare && !this.spareReading) {
      spare.arrays.dispose();
    } else if (spare) {
      this.spareDispose = spare.arrays;
    }
  }

  // Baked or stashed rows over all presets, 0..1
  stockProgress() {
    const names = this.presets;
    const rows = (name        ) => (this.stash.has(name) ? this.count : Math.min(this.count, this.residents.get(name)?.done ?? (this.spare?.preset === name ? this.spare.done : 0)));
    return names.reduce((sum, name) => sum + rows(name), 0) / (names.length * this.count);
  }

  // Whether a bake is waiting for a table or anything is left to bake
  pending(t        ) {
    for (let i = this.cueAt(t); i < this.cues.length; i += 1) {
      if (!this.baked(this.cues[i].preset)) {
        return true;
      }
    }
    return false;
  }

  // Bakes up to `rows` rows of the next bake; the rows baked (0: nothing to
  // do, or no table free yet)
  bake(rows        , t        , ahead = false) {
    const r = this.job(t, ahead);
    if (!r) {
      return 0;
    }
    const f = this.fractals.get(r.preset) ;
    const { kind, preset } = f;
    const values = { ...Object.fromEntries(Object.entries(kind.params).map(([key, param]) => [key, param.value])), ...preset.params };
    for (const [key, uniform] of Object.entries(kind.uniforms)) {
      uniform.value = values[key];
    }
    kind.prepare?.(values);
    const u = this.bakeU;
    u.seed.value = this.seeds.get(r.preset) ;
    u.count.value = this.count;
    u.coverage.value = 1;
    u.fromCamera.value = 0;
    u.lightDir.value.copy(lightDirection(preset.light?.azimuth ?? 35, preset.light?.elevation ?? 45));
    const n = Math.min(Math.floor(rows), this.count - r.done);
    r.arrays.write(kind.writer(), { at: r.done, count: n, first: r.done });
    r.done += n;
    if (r === this.spare && r.done >= this.count) {
      // Done: to the CPU, then the spare takes the next
      this.spareReading = true;
      const name = r.preset;
      void r.arrays.read({ start: 0, count: this.count }).then((data) => {
        if (!this.disposed) {
          this.stash.set(name, data);
        }
      }).finally(() => {
        this.spareReading = false;
        r.preset = "";
        this.spareDispose?.dispose();
        this.spareDispose = undefined;
      });
    }
    return n;
  }

  // The kinds the cues use, in the order they are first needed
  kinds() {
    return [...new Set(this.cues.map((cue) => this.fractals.get(cue.preset) .kind))];
  }

  // Compiles a kind's bake program (a few rows into a scratch table), so no
  // bake during playback stalls a frame on a compile
  warmKind(kind      ) {
    this.scratch ??= new GpuArrays({ renderer: this.renderer, bundles: { samples: SAMPLES }, capacity: 4096 });
    this.scratch.write(kind.writer(), { at: 0, count: 4 });
  }

  warm() {
    this.kinds().forEach((kind) => this.warmKind(kind));
  }

  // How far the bakes are toward a start that leaves the rest to playback
  // at `rate` rows a second (with `margin` seconds to spare): 0..1, 1 just
  // when `fits` turns true (0 before a rate is known)
  startProgress(rate        , margin        ) {
    if (rate <= 0) {
      return 0;
    }
    let total = 0;
    let done = 0;
    let need = this.count;
    const seen = new Set        ();
    for (let i = 0; i < this.cues.length; i += 1) {
      const name = this.cues[i].preset;
      if (seen.has(name)) {
        continue;
      }
      seen.add(name);
      total += this.count;
      done += Math.min(this.count, this.residents.get(name)?.done ?? 0);
      need = Math.max(need, total - rate * Math.max(0, this.starts[i] - margin - 0.3 * seen.size));
    }
    return Math.min(1, done / need);
  }

  // Starts the sorts the cues from t on need (both sides of every
  // transition), a few at a time
  sort(t        ) {
    for (let i = this.cueAt(t); i < this.cues.length && this.sorter.busy < 6; i += 1) {
      const p = this.pairing(i);
      for (const name of i > 0 ? [this.cues[i - 1].preset, this.cues[i].preset] : [this.cues[i].preset]) {
        const r = this.baked(name);
        if (r && !r.orders.has(p) && !r.sorting.has(p)) {
          r.sorting.add(p);
          void this.sorter.sort(r.arrays, this.count, p).then((ordered) => {
            r.sorting.delete(p);
            if (this.disposed || this.residents.get(name) !== r) {
              ordered.order.dispose();
            } else {
              r.orders.set(p, ordered);
            }
          });
        }
      }
    }
  }

  // Whether everything left from cue 0 bakes before it is needed, at
  // `rate` rows a second from the start, with `margin` seconds to spare
  // (each sort counted as a fixed cost)
  fits(rate        , margin        ) {
    let clock = 0;
    const seen = new Set        ();
    for (let i = 0; i < this.cues.length; i += 1) {
      const name = this.cues[i].preset;
      if (seen.has(name)) {
        continue;
      }
      seen.add(name);
      const done = this.residents.get(name)?.done ?? 0;
      if (done >= this.count) {
        continue;
      }
      clock += (this.count - done) / Math.max(rate, 1) + 0.3;
      if (clock > this.starts[i] - margin) {
        return false;
      }
    }
    return true;
  }

  // Baked rows over all presets, 0..1
  progress() {
    const names = this.presets;
    return names.reduce((sum, name) => sum + Math.min(this.count, this.residents.get(name)?.done ?? 0), 0) / (names.length * this.count);
  }

  // Every preset baked and every order sorted
  complete() {
    return this.cues.every((_, i) => this.ready(i, true));
  }

  dispose() {
    this.disposed = true;
    for (const r of this.residents.values()) {
      r.orders.forEach((ordered) => ordered.order.dispose());
      r.arrays.dispose();
    }
    this.free.forEach((arrays) => arrays.dispose());
    this.scratch?.dispose();
    this.spare?.arrays.dispose();
    this.stash.clear();
    this.residents.clear();
    this.free = [];
    this.sorter.dispose();
  }
}


//# sourceURL=examples/fractals/demo/library.ts