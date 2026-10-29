// Time in the film: seconds, and the bars of the score (100 BPM, 4/4), so
// cuts, captions and music line up. A shot is a span of bars with its own
// scene and camera; the film draws the one under the playhead. The other
// films (film2/, film3/) take their own tempo from tempo().
                                    

// Beats and 4/4 bars at `bpm`, in seconds
export function tempo(bpm        ) {
  const BEAT = 60 / bpm;
  const BAR = BEAT * 4;
  return { BPM: bpm, BEAT, BAR, bars: (n        ) => n * BAR, beats: (n        ) => n * BEAT };
}

export const { BPM, BEAT, BAR, bars, beats } = tempo(100);

export const clamp01 = (x        ) => Math.min(1, Math.max(0, x));
export const lerp = (a        , b        , t        ) => a + (b - a) * t;
export const smooth = (t        ) => {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
};
export const easeInOut = (t        ) => {
  const x = clamp01(t);
  return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2;
};
export const easeOut = (t        ) => 1 - (1 - clamp01(t)) ** 3;
export const easeIn = (t        ) => clamp01(t) ** 3;
export const expoOut = (t        ) => (t >= 1 ? 1 : 1 - 2 ** (-10 * clamp01(t)));
// 0 -> 1 over [a, b]
export const span = (t        , a        , b        ) => clamp01((t - a) / (b - a));
// Rises over [a, a + fade], holds, falls over [b - fade, b]
export const window = (t        , a        , b        , fade        ) => Math.min(smooth((t - a) / fade), smooth((b - t) / fade));

// Deterministic randomness: one stream per seed
export function random(seed        ) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

                       
               
                               
               
             
                                                                           
                                    
                 
                
                                                                        
                                                           
                                                                     
                      
                                   
                  
 


//# sourceURL=examples/film/timeline.ts