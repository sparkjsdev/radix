# Params

Params are plain values that tune the projection and the draw: how far each Gaussian is drawn, blur, culling, depth of field, and the CPU sort's guard band. They are copied into uniforms before each dispatch and draw, so changing one compiles nothing and can happen every frame.

Code: `src/render/splatParams.ts`.

```ts
// Every splat this renderer draws
splatRenderer.params.maxStdDev = 3;
// The default for every object
splatRenderer.objectParams.blurAmount = 0.1;
// One viewpoint
splatRenderer.viewFor(thumbCamera, { objectParams: { minPixelRadius: 1 } });
// One object
const crisp = SplatCollection.arrays(splats, { params: { blurAmount: 0 } });
```

## Two groups

- **View params** (`SplatViewParams`: `maxStdDev`, `minAlpha`, `falloff`) are read by the draw too, so all splats in one render share them. They are set on the renderer (`params`), and a view can override them.
- **Object params** (`SplatObjectParams`: everything else) are read only by the projection, so they can differ per object. They resolve per object, field by field: `object.params`, then the view's `objectParams`, then the renderer's `objectParams`.

The renderer's `params` and `objectParams` are complete objects, changed in place. A view's `params` and `objectParams` and an object's `params` are partial: the fields they set override the next level, and unset fields fall back to it.

## All params

| Param | Group | Default | What it does |
|---|---|---|---|
| `maxStdDev` | view | √8 ≈ 2.83 | how far each Gaussian is drawn, in standard deviations: the quad's extent |
| `minAlpha` | view | 0.5 / 255 | fragments, and whole splats, below this alpha are dropped |
| `falloff` | view | 1 | 1: Gaussian falloff; 0: flat discs |
| `lodInflate` | object | `true` | LoD opacities above 1 (merged LoD splats) grow the splat instead of its opacity |
| `blurAmount` | object | 0.3 | anti-aliasing blur, in pixel area units, with opacity compensation (a splat blurred wider gets fainter) |
| `preBlurAmount` | object | 0 | blur in pixel area units, without opacity compensation |
| `clipXY` | object | 1.4 | splats whose center is farther outside the frustum than this (in NDC) are culled |
| `minPixelRadius` | object | 0 | splats smaller than this on screen (in pixels, along both axes) are culled |
| `maxPixelRadius` | object | 512 | the largest on-screen radius, in pixels |
| `minContribution` | object | 0 | `ewa` only: splats whose drawn weight (opacity × the 2D Gaussian's area in pixels, 2π √det) is below this are culled; 0 keeps them all |
| `focalDistance` | object | 0 | depth of field: the distance to the focal plane |
| `apertureTan` | object | 0 | depth of field: the tangent of half the aperture angle. Depth of field is off while either is 0 |
| `sortGuard` | object | 0 | CPU sort only: splats farther outside the head's view than this (in NDC, plus each splat's extent) get the invalid sort key, so the sort and the draw skip them; 0 keeps them all ([sorting.md](sorting.md#sortguard)) |
| `maxShDegree` | object | 4 | the highest spherical-harmonics band drawn (0 to 4), up to the generator's degree; 0 draws base colors only ([sh.md](sh.md#drawing)) |

## Notes on each

- **`maxStdDev`**: √8 draws each Gaussian out to where it falls to e^-4 (about 1.8%) of its peak. Smaller values draw smaller quads (faster, slightly harder edges); larger values change little.
- **`minAlpha`**: also culls whole splats whose peak alpha is below it, before they are sorted or drawn.
- **`blurAmount`** and **`preBlurAmount`**: both add to each splat's 2D covariance, in pixel area units. `blurAmount` (the classic 3DGS anti-aliasing filter, 0.3) also scales opacity by the ratio of the areas, so thin splats do not get brighter when they are widened to a pixel; `preBlurAmount` keeps the opacity. Lower `blurAmount` gives sharper results on captures trained with a smaller filter.
- **`lodInflate`**: merged LoD nodes store opacities above 1 to stand for several overlapping splats. With `lodInflate`, the projection grows such a splat to match and stores opacity 1; without it, the draw treats any stored opacity above 1 as a stretch.
- **`clipXY`** and **`minPixelRadius`**: cheap culls before the sort. `clipXY` above 1 keeps splats whose center is just off screen but whose extent reaches into it.
- **`minContribution`**: drops splats that would add almost nothing to the image (faint, tiny ones), which saves draw time on large scenes. The benchmarks used 0.75 with `minPixelRadius: 1` ([performance.md](performance.md#settings-that-change-it)).
- **`focalDistance`** and **`apertureTan`**: each splat in front of the camera is blurred by a circle of confusion `|depth − focalDistance| × apertureTan` (in world units), seen at its depth.
- **`maxShDegree`**: bands above it are skipped in a uniform branch, texture reads included, so changing it recompiles nothing. Objects without SH ignore it.
- **`sortGuard`**: for the CPU sort only, whose order lags the camera. With it set, re-sort when the view turns, not only when it moves (`autoSort` does). 0.5 is a good value: it reduced the WebGL2 draw by 24-68% on full turns in the benchmarks.

## Gotchas

- View params cannot differ per object: one draw reads them for every splat. Put objects that need different `maxStdDev`, `minAlpha`, or `falloff` in different renderers.
- Each render projects again, so a changed param takes effect at the next render on both sort paths. The exception is `sortGuard`: it shapes the CPU sort's keys, so it takes effect with the next order.
- `SplatRenderer` copies the options' `params` and `objectParams` over the defaults when it is made. After that, change the renderer's `params` and `objectParams` objects in place.
