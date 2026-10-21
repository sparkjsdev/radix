// Frees GPU arrays once the owner drops them and every object holding them is released
export class Resident {
  private holds = 0;
  private dropped = false;
  private freed = false;
  private readonly free: () => void;

  constructor(free: () => void) {
    this.free = free;
  }

  // A release callback for one object that draws these arrays
  hold(): () => void {
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

  private check() {
    if (this.dropped && this.holds === 0 && !this.freed) {
      this.freed = true;
      this.free();
    }
  }
}
