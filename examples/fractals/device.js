// What this device can take: samples per bake, the pixel ratio and the GPU
// memory the page's tables may use, by platform and backend (desktop,
// iOS / iPadOS, Android; WebGPU or WebGL2), and a resolution that follows
// the frame rate. HiDPI (the screen's own pixel ratio, at most 2) is on by
// default on desktops and off (one canvas pixel per CSS pixel) on phones and
// tablets; a choice is kept per device, and ?hidpi=0 | 1 overrides it.
// Samples come in two qualities per platform (standard by default, high for
// newer devices), kept per device too, ?quality=standard | high overriding. Phones and tablets get fewer samples and fewer pixels:
// a splat costs its sort and its fill, and their GPUs share memory with
// everything else.
                                                   

                                                     
                                          

// Samples per bake on WebGPU, standard and high (WebGL2 takes half)
const SPLATS                                     = {
  desktop: [2_000_000, 4_000_000],
  ios: [1_000_000, 2_000_000],
  android: [500_000, 1_000_000],
};

export const splatsOf = (p          , webgpu         , quality         ) => SPLATS[p][quality === "high" ? 1 : 0] / (webgpu ? 1 : 2);

                       
                     
                                                                    
                   
                 
                                                                           
                 
                     
                                      
                 
 

export function platform()           {
  const agent = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(agent) || (/Macintosh/.test(agent) && navigator.maxTouchPoints > 1)) {
    return "ios";
  }
  return /Android/.test(agent) ? "android" : "desktop";
}

const HIDPI_KEY = "radix-fractals:hidpi";
const QUALITY_KEY = "radix-fractals:quality";

function load(key        ) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function save(key        , value        ) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage off: the choice lasts the visit
  }
}

export const saveQuality = (quality         ) => save(QUALITY_KEY, quality);

export const pixelRatioOf = (hiDpi         ) => (hiDpi ? Math.min(devicePixelRatio || 1, 2) : 1);

export const saveHiDpi = (on         ) => save(HIDPI_KEY, on ? "1" : "0");

function hiDpiFor(p          ) {
  const choice = new URLSearchParams(location.search).get("hidpi") ?? load(HIDPI_KEY);
  return choice === null ? p === "desktop" : choice === "1";
}

function qualityFor()          {
  return (new URLSearchParams(location.search).get("quality") ?? load(QUALITY_KEY)) === "high" ? "high" : "standard";
}

export function deviceTier(webgpu         )       {
  const p = platform();
  const hiDpi = hiDpiFor(p);
  const quality = qualityFor();
  // iOS reloads a tab past roughly 300 MB of GPU memory
  const memory = p === "ios" ? 200e6 : p === "android" ? 260e6 : webgpu ? 900e6 : 360e6;
  return { platform: p, quality, splats: splatsOf(p, webgpu, quality), hiDpi, pixelRatio: pixelRatioOf(hiDpi), memory };
}

// Bytes a table of `splats` samples takes (sample.ts: 40 per sample) with
// the orders kept for its transitions
export const tableBytes = (splats        ) => splats * 52;

// This device's own frame time (ms, up to a 20 fps frame), measured on
// frames that bake nothing: every eighth frame is left free for it. Bakes
// size their chunks against it (Budget), so a 60 fps desktop and a 40 fps
// phone both bake in what their frames leave.
export class FramePace {
  base = 16.7;
          frame = 0;

  // Whether this frame may bake
  bakes() {
    this.frame += 1;
    return this.frame % 8 !== 0;
  }

  // A frame that baked nothing
  update(dt        ) {
    if (dt > 0 && dt < 250) {
      this.base = Math.min(50, this.base + (dt - this.base) * 0.25);
    }
  }
}

// Rows to bake per frame for one kind of bake: grows while frames stay
// within `slack` ms of the device's frame time, halves after a late frame
// and holds a few frames
export class Budget {
  chunk        ;
          hold = 0;
                   pace           ;
                   min        ;
                   max        ;

  constructor(pace           , min        , max        , start = min) {
    this.pace = pace;
    this.min = min;
    this.max = max;
    this.chunk = start;
  }

  next(dt        , slack        ) {
    const over = dt - this.pace.base;
    if (dt < 300 && over > slack * 2 + 2) {
      this.chunk = Math.max(this.min, this.chunk / 2);
      this.hold = 6;
    } else if (this.hold > 0) {
      this.hold -= 1;
    } else if (over < slack) {
      this.chunk = Math.min(this.max, this.chunk * 1.15);
    }
    return Math.floor(this.chunk);
  }
}

// Lowers the pixel ratio while frames run slow (under ~42 fps) and raises
// it again after a few good seconds, once a second at most. Frames that
// bake are left out of the average.
export class Resolution {
  scale = 1;
          ema = 16.7;
          timer = 0;
          good = 0;
                   renderer                ;
          base        ;
                   min        ;

  constructor(renderer                , base        , min = 0.55) {
    this.renderer = renderer;
    this.base = base;
    this.min = min;
    renderer.setPixelRatio(base);
  }

  // A new pixel ratio to scale (HiDPI on or off)
  setBase(base        ) {
    this.base = base;
    this.renderer.setPixelRatio(base * this.scale);
  }

  update(dt        , busy = false) {
    if (dt <= 0 || dt > 250) {
      return;
    }
    if (!busy) {
      this.ema += (dt - this.ema) * 0.05;
    }
    this.timer += dt;
    if (this.timer < 1000) {
      return;
    }
    this.timer = 0;
    let next = this.scale;
    if (this.ema > 24) {
      next = Math.max(this.min, this.scale * 0.85);
      this.good = 0;
    } else if (this.ema < 18 && this.scale < 1) {
      this.good += 1;
      if (this.good >= 3) {
        next = Math.min(1, this.scale * 1.1);
        this.good = 0;
      }
    } else {
      this.good = 0;
    }
    if (Math.abs(next - this.scale) > 0.01) {
      this.scale = next;
      this.renderer.setPixelRatio(this.base * next);
    }
  }
}


//# sourceURL=examples/fractals/device.ts