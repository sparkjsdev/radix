// Springs for everything that moves in the editor, and the one animation
// loop, which sleeps once everything has settled.

export class Spring {
  value        ;
  target        ;
  velocity = 0;
  // Settled when this close to the target and this slow (units of value)
           epsilon        ;

  constructor(value        , epsilon = 0.05) {
    this.value = value;
    this.target = value;
    this.epsilon = epsilon;
  }

  // Semi-implicit Euler in fixed substeps, stable for stiff springs; true
  // while still moving
  step(dt        , stiffness        , damping        )          {
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

// Calls every ticker each animation frame while any of them reports it is
// still moving; wake() after changing a target
export class Animator {
          tickers                              = [];
          frame = 0;
          last = 0;

  add(ticker                         ) {
    this.tickers.push(ticker);
    this.wake();
  }

  wake() {
    if (this.frame === 0) {
      this.last = performance.now();
      this.frame = requestAnimationFrame((now) => this.loop(now));
    }
  }

          loop(now        ) {
    const dt = Math.min(0.05, Math.max(0, (now - this.last) / 1000));
    this.last = now;
    let active = false;
    for (const ticker of this.tickers) {
      active = ticker(dt) || active;
    }
    this.frame = active ? requestAnimationFrame((time) => this.loop(time)) : 0;
  }
}


//# sourceURL=examples/fxedit/springs.ts