export class Spring {
  value: number;
  target: number;
  velocity = 0;
  // Settling distance, in the value's units
  readonly epsilon: number;

  constructor(value: number, epsilon = 0.05) {
    this.value = value;
    this.target = value;
    this.epsilon = epsilon;
  }

  // True while moving. Semi-implicit Euler in fixed substeps keeps stiff springs stable.
  step(dt: number, stiffness: number, damping: number): boolean {
    if (this.value === this.target && this.velocity === 0) {
      return false;
    }
    const c = 2 * Math.sqrt(stiffness) * damping;
    for (let t = dt; t > 0; t -= 1 / 240) {
      const h = Math.min(t, 1 / 240);
      this.velocity += (stiffness * (this.target - this.value) - c * this.velocity) * h;
      this.value += this.velocity * h;
    }
    if (Math.abs(this.target - this.value) < this.epsilon && Math.abs(this.velocity) < this.epsilon * 10) {
      this.snap();
      return false;
    }
    return true;
  }

  snap(value = this.target) {
    this.value = value;
    this.target = value;
    this.velocity = 0;
  }
}

// Ticks every ticker each frame while any is moving; wake() after changing a target
export class Animator {
  private tickers: ((dt: number) => boolean)[] = [];
  private frame = 0;
  private last = 0;

  add(ticker: (dt: number) => boolean) {
    this.tickers.push(ticker);
    this.wake();
  }

  wake() {
    if (this.frame === 0) {
      this.last = performance.now();
      this.frame = requestAnimationFrame((now) => this.loop(now));
    }
  }

  private loop(now: number) {
    const dt = Math.min(0.05, Math.max(0, (now - this.last) / 1000));
    this.last = now;
    let active = false;
    for (const ticker of this.tickers) {
      active = ticker(dt) || active;
    }
    this.frame = active ? requestAnimationFrame((time) => this.loop(time)) : 0;
  }
}
