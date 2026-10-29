// Every Spark 2.3.1 example (sparkjsdev/spark examples/ at tag v2.3.1) and
// what became of it here. The index page lists these; the smoke check
// (scripts/check-examples.mjs) loads every page of a ported or
// partial entry. status: "ported" | "partial" | "blocked" | "removed".
//   pages   the port's pages (default [`${name}/index.html`]); listed: on sparkjs.dev
//   uses    what in Radix (or the shared js/) it exercises
//   gaps    what Radix lacks for it (partial and blocked entries)
//   xr      needs an XR session to show everything (checked on desktop only)
//   smoke   query string the smoke check loads the pages with
//   smokeWait  ms the smoke check waits before its screenshot (default 1500)
export interface Example {
  name: string;
  title: string;
  status: "ported" | "partial" | "blocked" | "removed";
  listed?: boolean;
  pages?: string[];
  uses?: string;
  gaps?: string;
  xr?: boolean;
  smoke?: string;
  smokeWait?: number;
}

export const EXAMPLES: Example[] = [
  { name: "hello-world", title: "Hello World", status: "ported", listed: true, pages: ["hello-world/index.html", "hello-world/carousel.html"], uses: "loadSplats, SplatCollection.arrays, per-object opacity through the generator's bind (carousel)" },
  { name: "envmap", title: "Environment Map", status: "ported", listed: true, uses: "a CubeCamera rendering the splats (one GPU sort per face) into the duck's envMap" },
  { name: "interactivity", title: "Interactivity", status: "ported", listed: true, uses: "per-object opacity fades, splats depth-tested against a lit GLB table with shadows, the scans' degree-3 spherical harmonics (Radix's, seen from each view)" },
  { name: "multiple-splats", title: "Multiple Splats", status: "ported", listed: true, uses: "one GpuArrays drawn as six objects with their own matrices" },
  { name: "multiple-viewpoints", title: "Multiple Viewpoints", status: "ported", listed: true, uses: "one SplatRenderer rendered from three cameras into render targets" },
  { name: "procedural-splats", title: "Procedural Splats", status: "ported", listed: true, uses: "splats built on the CPU (Splats.make / encoder): a 500k Sierpinski pyramid, stars, text and image splats" },
  { name: "raycasting", title: "Raycasting", status: "ported", listed: true, uses: "THREE.Raycaster against splats (a CPU ellipsoid test, js/raycast.js), per-object tint" },
  { name: "dynamic-lighting", title: "Dynamic Lighting", status: "ported", listed: true, uses: "Spark's SDF edits as a world-space modifier (js/sdf.js)" },
  { name: "particle-animation", title: "Particle Animation", status: "ported", listed: true, uses: "CPU-built splats re-uploaded every frame (GpuArrays.upload)" },
  { name: "particle-simulation", title: "Particle Simulation", status: "ported", listed: true, uses: "Spark's snowBox as a TSL generator (js/snow.js), sorted with a scan" },
  { name: "splat-painter", title: "Splat Painter", status: "ported", listed: true, uses: "a GpuArrayWriter brush rewriting stored splats, restore by copyFrom, readback and SPZ export" },
  { name: "splat-reveal-effects", title: "Splat Reveal Effects", status: "ported", listed: true, smokeWait: 8000, uses: "object-space TSL modifiers driven by uniforms", gaps: "Sutro (SOGS zip) is left out" },
  { name: "splat-shader-effects", title: "Splat Shader Effects", status: "ported", listed: true, uses: "object-space TSL modifiers driven by uniforms" },
  { name: "splat-dissolve-effects", title: "Splat Dissolve Effects", status: "ported", listed: true, uses: "an object-space TSL modifier driven by time" },
  { name: "splat-transitions", title: "Splat Transitions", status: "ported", listed: true, uses: "four effect demos: world-space modifiers over several objects, text splats, GLB environments" },
  { name: "stochastic", title: "Stochastic", status: "removed", listed: true, gaps: "listed on sparkjs.dev but no longer in Spark's examples" },
  { name: "sogs", title: "SOGS Compression", status: "blocked", listed: true, gaps: "Radix reads PLY, SPZ, RAD and RDX only: no SOG / SOGS (.sog, .zip) decoder" },
  { name: "webxr", title: "WebXR", status: "ported", listed: true, xr: true, uses: "WebXR on either backend, hand joints as a generator, fingertip SDF edits" },
  { name: "glsl", title: "GLSL Shaders", status: "ported", listed: true, uses: "an object modifier (fromSplats modifiers) plus a world modifier (the renderer's)" },
  { name: "debug-color", title: "Debug Coloring", status: "ported", listed: true, uses: "GpuSplats.normalOf and view-space depth in per-object modifiers" },
  { name: "depth-of-field", title: "Depth of Field", status: "ported", listed: true, uses: "the focalDistance and apertureTan params" },
  { name: "splat-texture", title: "Splat Texture", status: "removed", listed: true, gaps: "listed on sparkjs.dev but no longer in Spark's examples" },
  { name: "editor", title: "Editor", status: "partial", listed: true, smoke: "?url=https://sparkjs.dev/assets/splats/butterfly.spz", uses: "several files, per-file transforms and opacity, text and grid splats, bounds, normal color and clip box, render params, layouts, the four methods", gaps: "no LoD (build, traverse, foveation), no .splat / .ksplat / .zip / .sog" },
  { name: "viewer", title: "Viewer", status: "ported", listed: true, smoke: "?url=https://sparkjs.dev/assets/splats/butterfly.spz", uses: "drag and drop, URLs, PLY / SPZ / RAD / RDX, SPZ export (writeSplats)", gaps: "no .splat / .ksplat / .zip / .sog" },
  { name: "basic-xr", title: "Basic XR", status: "ported", listed: true, xr: true, uses: "WebXR on either backend with CameraControls' XR rig; the LoD file's leaves through an index list", gaps: "draws every leaf where Spark draws a LoD budget (no LoD selection)" },
  { name: "interactive-holes", title: "Interactive Holes", status: "ported", listed: true, uses: "a uniform array of 128 click spheres over the stored centers, raycasts through the holes (centers edited in the picker's CPU copy, as Spark edits only its CPU array)" },
  { name: "lofi", title: "Lofi Worlds", status: "partial", listed: true, uses: "a cache of worlds as GpuArrays freed in release, a generator blending two worlds by splat index, world modifiers, snow and rain, audio", gaps: "WebXR hands and spotlights checked in the emulator only" },
  { name: "mobile-joystick", title: "Mobile On-Screen Joystick", status: "ported", listed: true, uses: "CameraControls plus a touch joystick" },
  { name: "render-cube-depth", title: "Render Cube Depthmap", status: "ported", listed: true, uses: "cube renders read back, depth as color from a view-space modifier, falloff 0" },
  { name: "lod-on-demand", title: "LoD-on-demand", status: "blocked", listed: true, gaps: "Radix does not build LoD trees" },
  { name: "nonlod", title: "Simultaneous Non-LoD + LoD", status: "blocked", listed: true, gaps: "Radix neither builds LoD trees nor selects LoD subsets" },
  { name: "extsplats", title: "Extended Splats encoding", status: "ported", listed: true, uses: "packedSplats (half-float centers) against extSplats (float32) 1000 units out" },
  { name: "streaming-lod", title: "Streaming LoDs", status: "blocked", listed: true, gaps: "no paged RAD loading over range requests, no LoD selection" },
  { name: "multi-lod", title: "Multiple Streaming LoDs", status: "blocked", listed: true, gaps: "no paged RAD loading, no LoD selection or page budget across objects" },
  { name: "on-demand", title: "On-demand Rendering", status: "blocked", listed: true, gaps: "its scene is a 40M-splat paged RAD (no paged loading or LoD selection); rendering on demand itself maps to SplatRenderer.onInvalidate" },
  { name: "interactive-deform", title: "Interactive Deform", status: "ported", uses: "a raycast hit and drag driving a world-space deformation" },
  { name: "interactive-ripples", title: "Interactive Ripples", status: "ported", uses: "a raycast hit starting an object-space shockwave" },
  { name: "splat-flow", title: "Splat Flow", status: "ported", uses: "a world modifier over three objects keyed on splat index, CPU bounds, a GLB environment" },
  { name: "splat-portal", title: "Splat Portal", status: "ported", uses: "two scenes with their own SplatRenderers rendered into targets shown through portal meshes", gaps: "Sutro (SOGS zip) swapped for another scan" },
  { name: "lod", title: "LoD", status: "blocked", gaps: "Radix neither builds LoD trees nor selects LoD subsets (foveation)" },
  { name: "portal", title: "Portal", status: "blocked", gaps: "needs a custom splat fragment shader (disk clip) and SplatSkinning" },
  { name: "newportal", title: "Multi-Portal", status: "blocked", gaps: "needs SparkPortals (linked portal passes) and paged loading" },
];

// The pages of an entry that has a port
export function pagesOf(example: Example) {
  return example.pages ?? [`${example.name}/index.html`];
}
