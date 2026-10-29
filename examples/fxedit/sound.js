// Tiny synthesized UI sounds (WebAudio, nothing to download); muted by default.
                                                                                                                         

export class Sound {
  muted = true;
  volume = 0.5;
          context               ;
          lastTick = 0;

  play(name           ) {
    if (this.muted || this.volume <= 0) {
      return;
    }
    this.context ??= new AudioContext();
    const t = this.context.currentTime;
    switch (name) {
      case "connect":
        this.tone(660, t, 0.07, "triangle", 0.25);
        this.tone(990, t + 0.05, 0.1, "triangle", 0.2);
        break;
      case "disconnect":
        this.tone(620, t, 0.12, "triangle", 0.2, 310);
        break;
      case "pick":
        this.tone(520, t, 0.05, "sine", 0.15);
        break;
      case "drop":
        this.tone(190, t, 0.1, "sine", 0.35, 120);
        break;
      case "add":
        this.tone(440, t, 0.06, "sine", 0.2, 880);
        break;
      case "ok":
        [523, 659, 784].forEach((f, i) => this.tone(f, t + i * 0.06, 0.14, "sine", 0.18));
        break;
      case "error":
        this.tone(150, t, 0.16, "square", 0.08);
        this.tone(112, t + 0.08, 0.2, "square", 0.08);
        break;
      case "delete":
        this.tone(320, t, 0.14, "sawtooth", 0.08, 70);
        break;
      case "open":
        this.tone(880, t, 0.04, "sine", 0.1);
        break;
      case "tick": {
        const now = performance.now();
        if (now - this.lastTick > 45) {
          this.lastTick = now;
          this.tone(1500, t, 0.015, "sine", 0.04);
        }
        break;
      }
    }
  }

          tone(frequency        , start        , duration        , type                , gain        , slideTo         ) {
    const context = this.context ;
    const oscillator = context.createOscillator();
    const envelope = context.createGain();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, start);
    if (slideTo) {
      oscillator.frequency.exponentialRampToValueAtTime(slideTo, start + duration);
    }
    envelope.gain.setValueAtTime(0.0001, start);
    envelope.gain.exponentialRampToValueAtTime(gain * this.volume, start + 0.005);
    envelope.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    oscillator.connect(envelope).connect(context.destination);
    oscillator.start(start);
    oscillator.stop(start + duration + 0.02);
  }
}


//# sourceURL=examples/fxedit/sound.ts