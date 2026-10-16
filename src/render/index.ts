// Splat projection and drawing, TSL for both backends: collections of
// splat objects, the renderer that draws them (its settings, the sort) and
// its views (per-viewpoint settings and CPU orders); the projector's
// program cache
export type { ProjectionMethod } from "./projections.tsl";
export { SplatCollection, type AnySplatObject, type MappedObject, type SplatObject } from "./SplatCollection";
export type { SplatObjectParams, SplatViewParams } from "./splatParams";
export { SplatProjector } from "./SplatProjector";
export { SplatRenderer, type SplatRendererOptions } from "./SplatRenderer";
export type { ModifierSpace } from "./splatTransform.tsl";
export { SplatView, type AutoSort, type SplatOrder, type SplatViewOptions } from "./SplatView";
