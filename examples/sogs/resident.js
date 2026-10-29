// GPU arrays shared by splat objects: freed once the owner drops them and
// every object holding them has been released (Radix releases an object
// when no live collection, including a CPU sort's in-flight orders, holds it)
export class Resident {
          holds = 0;
          dropped = false;
          freed = false;
                   free            ;

  constructor(free            ) {
    this.free = free;
  }

  // A release callback for one object that draws these arrays
  hold()             {
    this.holds += 1;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.holds -= 1;
        this.check();
      }
    };
  }

  drop() {
    this.dropped = true;
    this.check();
  }

          check() {
    if (this.dropped && this.holds === 0 && !this.freed) {
      this.freed = true;
      this.free();
    }
  }
}


//# sourceURL=examples/sogs/resident.ts