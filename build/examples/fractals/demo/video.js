// A demo's picture at film time t: the cue under the playhead morphing from
// the last fractal in its morph.ts style (or at rest), the look blended
// between the two (palette, lights, sky, 4D turn), the camera blended
// between the two cues' moves, and the music's marks (airScore.ts) in the
// light: bloom and lens on the kicks, rim light and glow on every melodic
// hit, a palette offset per chord, a lean into risers, a flash on impacts.
// The viewer's own turn and zoom (Steer) go on top of the camera, and a
// tall screen backs the camera off so the fractal fits across. Its own
// scene, SplatRenderer and RenderPipeline (bloom, tone mapping), as the
// gallery's.
import * as THREE from "three";
import { RenderPipeline,                     } from "three/webgpu";
import { bloom } from "three/examples/jsm/tsl/display/BloomNode.js";
import { GpuArrays, SplatCollection, SplatGenerator, SplatRenderer, TSL } from "@sparkjsdev/radix";
import { Captions } from "../../film/text.js";
import { clamp01, easeInOut, lerp, smooth, tempo } from "../../film/timeline.js";
import { TRANSITIONS, makeMorphUniforms, morphGenerator, setStyle,              } from "../morph.js";
import { PALETTES } from "../palettes.js";
import { SAMPLES } from "../sample.js";
import { makeLookUniforms, setPaletteSlot, setSky, shadeGenerator, skyNode, skyOf,           } from "../shade.js";
                                                    
                                            
                                           

const { pass } = TSL;
const DEG = Math.PI / 180;
// The palette's offset on each chord of a four-bar progression
const DRIFT = [0, 0.06, 0.12, 0.06];

// The viewer's turn and zoom over the video's camera
                          
              
                
               
 

                         
               
                
              
 

// The marks of one kind, by time, as a sum of decaying pulses
function pulses(marks        , kind          ) {
  const list = marks.filter((mark) => mark.kind === kind).sort((a, b) => a.at - b.at);
  return {
    at(t        , decay        ) {
      let sum = 0;
      for (let i = list.length - 1; i >= 0 && list[i].at > t - decay * 6; i -= 1) {
        if (list[i].at <= t) {
          sum += list[i].weight * Math.exp(-(t - list[i].at) / decay);
        }
      }
      return sum;
    },
    // How many have passed, and seconds since the last
    count(t        ) {
      let n = 0;
      while (n < list.length && list[n].at <= t) {
        n += 1;
      }
      return { n, since: n > 0 ? t - list[n - 1].at : Infinity };
    },
  };
}

// The seconds each cue's transition starts and ends
export function cueTimes(tune      ) {
  const { bars, beats } = tempo(tune.bpm);
  return { starts: tune.cues.map((cue) => bars(cue.bar)), ends: tune.cues.map((cue) => bars(cue.bar) + beats(cue.beats)) };
}

export class Video {
           duration        ;
           camera = new THREE.PerspectiveCamera(40, 1, 0.01, 100);
                   scene = new THREE.Scene();
                   pipeline                ;
                   glow                          ;
                   splats               ;
                   u = makeLookUniforms();
                   m = makeMorphUniforms();
                   steady = shadeGenerator(this.u);
                   morph = morphGenerator(this.u, this.m);
                   empty                                       ;
                   captions          ;
                   look = {}        ;
                   target = new THREE.Vector3();
                   lights = new Map                       ();
          shown = "";
                   renderer                ;
                   library         ;
                   tune      ;
                   bars                       ;
                   beats                       ;
                   kicks                           ;
                   hits                           ;
                   impacts                           ;
                   chords                           ;
                   rises        ;

  constructor(renderer                , library         , tune      , marks        , overlay             ) {
    this.renderer = renderer;
    this.library = library;
    this.tune = tune;
    const { bars, beats } = tempo(tune.bpm);
    this.bars = bars;
    this.beats = beats;
    this.duration = bars(tune.end);
    this.m.count.value = library.count;
    this.scene.backgroundNode = skyNode(this.u);
    this.splats = new SplatRenderer({ renderer, params: { maxStdDev: 2.6 } });
    this.scene.add(this.splats);
    this.pipeline = new RenderPipeline(renderer);
    const color = pass(this.scene, this.camera).getTextureNode("output");
    this.glow = bloom(color, 0.5, 0.45, 0.7);
    this.pipeline.outputNode = color.add(this.glow);
    // What the first transition grows from: no samples
    this.empty = { arrays: new GpuArrays({ renderer, bundles: { samples: SAMPLES }, capacity: 4096 }), order: { order: SplatGenerator.indices(renderer, [0]), visible: 0 } };

    this.kicks = pulses(marks, "kick");
    this.hits = pulses(marks, "hit");
    this.impacts = pulses(marks, "impact");
    this.chords = pulses(marks, "chord");
    this.rises = marks.filter((mark) => mark.kind === "rise");

    for (const [name, f] of library.fractals) {
      const az = (f.preset.light?.azimuth ?? 35) * DEG;
      const el = (f.preset.light?.elevation ?? 45) * DEG;
      this.lights.set(name, new THREE.Vector3(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az)));
    }

    this.captions = new Captions(overlay);
    for (const line of tune.lines) {
      this.captions.add({
        at: bars(line.at), until: bars(line.until), html: `<div>${line.html}</div>`, className: line.className,
        anim: line.anim ?? "letters", enter: line.enter ?? 0.5, exit: 0.3, stagger: 0.025,
      });
    }
  }

          rising(t        ) {
    return Math.max(0, ...this.rises.map((r) => (t >= r.at && t < r.until  ? ((t - r.at) / (r.until  - r.at)) ** 2 : 0)));
  }

          paletteAt(cue     , t        ) {
    const p = cue.palettes;
    if (!p) {
      return { name: this.library.fractals.get(cue.preset) .preset.palette, before: undefined                      , mix: 1 };
    }
    const into = (t - this.bars(cue.bar + p.from)) / this.beats(1);
    if (into < 0) {
      return { name: p.names[0], before: undefined, mix: 1 };
    }
    const k = Math.min(Math.floor(into), p.names.length - 1);
    return { name: p.names[k], before: k > 0 ? p.names[k - 1] : undefined, mix: smooth((into - Math.floor(into)) / 0.3) };
  }

          poseOf(cue     , t        ) {
    const view = this.library.fractals.get(cue.preset) .preset.view ?? {};
    const local = (t - this.bars(cue.bar)) / this.bars(1);
    const move = cue.move;
    return {
      azimuth: ((move.azimuth ?? view.azimuth ?? 30) + (move.orbit ?? 0) * local) * DEG,
      elevation: ((move.elevation ?? view.elevation ?? 20) + (move.rise ?? 0) * local) * DEG,
      distance: (move.distance ?? view.distance ?? 3.4) * (1 - (move.push ?? 0) * local),
      target: new THREE.Vector3(...(view.target ?? [0, 0, 0])),
      fov: view.fov ?? 40,
    };
  }

  // The splats for cue i: its transition or its preset at rest (a new
  // collection only when that changes)
          collect(i        , moving         ) {
    const key = `${i}|${moving}`;
    if (key === this.shown) {
      return;
    }
    this.shown = key;
    const library = this.library;
    const cues = this.tune.cues;
    const to = cues[i].preset;
    if (!moving) {
      this.splats.collection = new SplatCollection([SplatCollection.object({
        generator: this.steady, data: { samples: library.arrays(to) }, count: library.count, release: library.use(to),
      })]);
      return;
    }
    const pairing = library.pairing(i);
    const from = i > 0 ? cues[i - 1].preset : undefined;
    this.splats.collection = new SplatCollection([SplatCollection.object({
      generator: this.morph,
      data: {
        from: from ? library.arrays(from) : this.empty.arrays,
        to: library.arrays(to),
        fromOrder: from ? library.order(from, pairing) : this.empty.order,
        toOrder: library.order(to, pairing),
      },
      count: library.count,
      release: from ? library.use(from, to) : library.use(to),
    })]);
  }

  // Sets up film time t (which the library must be able to show) and
  // returns the frame's finish
  draw(t        , offsets         , aspect        )         {
    const { library, tune, u, m, look, bars, beats } = this;
    const cues = tune.cues;
    const i = library.cueAt(t);
    const cue = cues[i];
    const prev = cues[i - 1];
    const to = library.fractals.get(cue.preset) ;
    const from = prev ? library.fractals.get(prev.preset)  : to;
    const p = clamp01((t - bars(cue.bar)) / beats(cue.beats));
    const k = smooth(p);
    const moving = p < 1;

    this.collect(i, moving);
    setStyle(m, TRANSITIONS[cue.style]);
    m.t.value = p;

    // The music's pulses
    const kick = Math.min(1.2, this.kicks.at(t, 0.16));
    const hit = Math.min(1, this.hits.at(t, 0.35));
    const flash = Math.min(1, this.impacts.at(t, 0.2));
    const rise = this.rising(t);
    const { n: chordCount, since } = this.chords.count(t);
    const drift = chordCount > 0 ? lerp(DRIFT[(chordCount + 2) % 4], DRIFT[(chordCount + 3) % 4], smooth(since / 0.9)) : 0;

    for (const key of Object.keys(to.look)                  ) {
      look[key] = lerp(from.look[key], to.look[key], k);
    }
    look.shift += drift;
    look.rim += 0.6 * hit;
    look.glow *= 1 + 0.35 * hit;
    for (const [key, value] of Object.entries(look)) {
      (u                                                )[key].value = value;
    }
    u.time.value = t;
    const palette = this.paletteAt(cue, t);
    const left = prev ? this.paletteAt(prev, bars(cue.bar) - 1e-3).name : palette.name;
    if (moving) {
      setPaletteSlot(u.palettes[1], PALETTES[left]);
      setPaletteSlot(u.palettes[0], PALETTES[palette.name]);
      u.paletteMix.value = 1;
      setSky(u, skyOf(PALETTES[left]), skyOf(PALETTES[palette.name]), k);
    } else {
      const before = palette.before ?? palette.name;
      setPaletteSlot(u.palettes[1], PALETTES[before]);
      setPaletteSlot(u.palettes[0], PALETTES[palette.name]);
      u.paletteMix.value = palette.mix;
      setSky(u, skyOf(PALETTES[before]), skyOf(PALETTES[palette.name]), palette.mix);
    }
    u.lightDir.value.lerpVectors(this.lights.get(from.preset.name) , this.lights.get(to.preset.name) , k).normalize();
    const turn = to.preset.turn ?? 0;
    const turnFrom = from.preset.turn ?? 0;
    u.turnXW.value = turn * t;
    u.turnZW.value = turn * 0.61 * t;
    u.turnFromXW.value = turnFrom * t;
    u.turnFromZW.value = turnFrom * 0.61 * t;

    // The camera: the last cue's move to this one's over the transition,
    // leaning into a riser, then the viewer's turn and zoom; a tall frame
    // backs off until the fractal fits across
    const a = this.poseOf(prev ?? cue, t);
    const b = this.poseOf(cue, t);
    const c = prev ? easeInOut(p) : 1;
    const fit = Math.max(1, 1.25 / aspect) ** 0.8;
    const azimuth = lerp(a.azimuth, b.azimuth, c) + offsets.yaw;
    const elevation = THREE.MathUtils.clamp(lerp(a.elevation, b.elevation, c) + offsets.pitch, -80 * DEG, 80 * DEG);
    const distance = lerp(a.distance, b.distance, c) * (1 - 0.07 * rise) * fit * Math.exp(offsets.zoom);
    const camera = this.camera;
    this.target.lerpVectors(a.target, b.target, c);
    camera.position.set(Math.cos(elevation) * Math.sin(azimuth), Math.sin(elevation), Math.cos(elevation) * Math.cos(azimuth)).multiplyScalar(distance).add(this.target);
    camera.lookAt(this.target);
    camera.fov = lerp(a.fov, b.fov, c) * (1 - 0.018 * kick);
    camera.aspect = aspect;
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
    camera.getWorldPosition(u.camera.value);

    this.glow.strength.value = lerp(from.preset.bloom ?? 0.5, to.preset.bloom ?? 0.5, k) * (1 + 0.28 * kick + 0.18 * hit + 0.45 * rise);
    this.renderer.toneMappingExposure = lerp(from.preset.exposure ?? 1, to.preset.exposure ?? 1, k) * (1 + 0.025 * kick + 0.025 * hit + 0.04 * rise);
    this.captions.update(t);

    return {
      fade: Math.max(1 - smooth(t / 1.4), smooth((t - bars(tune.end - 1)) / bars(1))),
      flash: 0.5 * flash,
      dim: 0.4 * smooth((t - bars(tune.outro + 0.2)) / bars(1)),
    };
  }

  // Draws the first cue's transition and its fractal at rest once, so both
  // programs compile before the start (needs only the first cue ready)
  warm(aspect        ) {
    this.draw(0.05, { yaw: 0, pitch: 0, zoom: 0 }, aspect);
    this.render();
    this.collect(0, false);
    this.render();
  }

  // The kick's pulse at t (0..1), for the controls to beat along
  pulse(t        ) {
    return Math.min(1, this.kicks.at(t, 0.16));
  }

  // Where the camera is (the viewer's turn included), and the palette at t
  pose() {
    return { position: this.camera.position.clone(), target: this.target.clone(), fov: this.camera.fov };
  }

  paletteFor(t        ) {
    return this.paletteAt(this.tune.cues[this.library.cueAt(t)], t).name;
  }

  render() {
    this.pipeline.render();
  }

  dispose() {
    this.splats.collection = new SplatCollection([]);
    this.splats.dispose?.();
    this.pipeline.dispose();
    this.empty.arrays.dispose();
    this.empty.order.order.dispose();
    this.captions.update(-1);
  }
}


//# sourceURL=examples/fractals/demo/video.ts