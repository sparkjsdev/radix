// The viewer's sample scenes, on Google Cloud Storage: LCC v1 in lcc/ and
// LCC2 in lcc2/, in the dated folders scripts/data.mjs names (LCC_URL,
// LCC2_URL follow it). ?lcc= reads the v1 samples elsewhere, and the LCC2
// ones beside them (its lcc2/ sibling) unless ?lcc2= says otherwise. LCC scenes
// are Z-up and turned upright by rotateX(-90 degrees); the scenes converted
// from the repo's splats/ PLY files were turned Z-up by the converter, so
// the same rotation stands them upright. Scenes with collision (XGRIDS'
// collision.lci or LCC2 meshes) can be walked (walk.ts).
import type { WalkSettings } from "./walk.js";

export interface LccSample {
  label: string;
  // "lcc" (default) or "lcc2"
  format?: "lcc" | "lcc2";
  folder: string;
  // The meta file's name in the folder
  meta: string;
  mode?: "orbit" | "fly";
  // The scene's rotation as a quaternion (x, y, z, w); default Z-up to Y-up
  rotation?: [number, number, number, number];
  // Distance up to which cells draw level 0 (default half a cell, or half a leaf)
  lodDistance?: number;
  // Trained with the 3DGS screen-space dilation: pre-blur (keeps thin
  // structures such as spokes) instead of blur, as the splat viewer does
  preBlur?: boolean;
  // Where the camera starts, in the upright frame (else the spawn point of
  // attrs.lcp, else framed from outside)
  view?: { position: [number, number, number]; target: [number, number, number]; fov?: number };
  // Degrees the spawn point's view turns about the up axis
  spawnYaw?: number;
  // Walk mode's settings in the scene's units (walk.ts DEFAULT_WALK: meters),
  // or false where walking makes no sense (?camera=walk is ignored there)
  walk?: Partial<WalkSettings> | false;
}

// The dated folders on GCS (scripts/data.mjs RADIX_FOLDER_VERSIONS)
const GCS = "https://storage.googleapis.com/forge-dev-public/asundqui/radix";
export const LCC_URL = `${GCS}/261012/lcc`;
export const LCC2_URL = `${GCS}/261012/lcc2`;

const query = new URLSearchParams(location.search);
const folderUrl = (root: string) => new URL(`${root.replace(/\/+$/, "")}/`, location.href).href;
export const LCC_ROOT = folderUrl(query.get("lcc") ?? LCC_URL);
export const LCC2_ROOT = folderUrl(query.get("lcc2") ?? (query.get("lcc") ? new URL("../lcc2/", LCC_ROOT).href : LCC2_URL));

export const SAMPLES: Record<string, LccSample> = {
  // From the spawn point, turned to face into the room
  showroom2: { label: "LCC v1: Showroom (11.6M, 1 cell)", folder: "showroom2", meta: "showroom2.lcc", mode: "fly", spawnYaw: 180 },
  // Under the front porch, looking through the hall's doors at the portrait
  // (its spawn point is inside, in the dark)
  unreal: {
    label: "LCC v1: Unreal sample (3.4M, 3 cells)", folder: "unreal", meta: "meta.lcc", mode: "fly",
    view: { position: [2.81, -3.4, 13.33], target: [-0.08, -4.9, 4.84] },
  },
  // The splat viewer's view of the bike by the bench; orbiting Sutro Tower
  // (it stands at x, z = 0, about 1.75 units tall)
  bicycle: {
    label: "LCC v1: Bicycle, SH 3, 35 cells (converted)", folder: "bicycle", meta: "meta.lcc", mode: "orbit", preBlur: true,
    view: { position: [-3.5, 0.9, -0.06], target: [0, -0.7, 0], fov: 55 },
  },
  // Seen from the air: no collision, no walking
  sutro: {
    label: "LCC v1: Sutro Tower, SH 3 (converted)", folder: "sutro", meta: "meta.lcc", mode: "orbit",
    view: { position: [0, 1.5, -3.3], target: [0, 0.9, 0] }, walk: false,
  },
  // XGRIDS' own LCC2 scenes from the Unreal example: a street of houses
  // (75 m, from its spawn point by the fountain), and four statues on a
  // plaza (8 m; its floor is at the top of the box, floaters fill the rest)
  street: { label: "LCC2: Unreal street (2.8M, 6 levels)", format: "lcc2", folder: "street", meta: "LCC2.lcc2", mode: "fly" },
  "lcc2-1": {
    label: "LCC2: Unreal statues (1.5M, 7 levels)", format: "lcc2", folder: "lcc2-1", meta: "LCC2.lcc2", mode: "orbit",
    view: { position: [0.6, 3.2, 7.5], target: [0, 1.4, 0] },
  },
  // The v1 samples converted to LCC2, one chunk
  // format each, several nodes per chunk file, with their environments and
  // collision (cut per node at depth totalLevels - 2)
  "showroom2-spz": {
    label: "LCC2: Showroom, .spz (converted)", format: "lcc2", folder: "showroom2-spz", meta: "showroom2-spz.lcc2", mode: "fly", spawnYaw: 180,
  },
  "unreal-ply": {
    label: "LCC2: Unreal sample, .ply (converted)", format: "lcc2", folder: "unreal-ply", meta: "unreal-ply.lcc2", mode: "fly",
    view: { position: [2.81, -3.4, 13.33], target: [-0.08, -4.9, 4.84] },
  },
  "bicycle-sog": {
    label: "LCC2: Bicycle, .sog, SH 3 (converted)", format: "lcc2", folder: "bicycle-sog", meta: "bicycle-sog.lcc2", mode: "orbit", preBlur: true,
    view: { position: [-3.5, 0.9, -0.06], target: [0, -0.7, 0], fov: 55 },
  },
  "sutro-spz": {
    label: "LCC2: Sutro Tower, .spz, SH 3 (converted)", format: "lcc2", folder: "sutro-spz", meta: "sutro-spz.lcc2", mode: "orbit",
    view: { position: [0, 1.5, -3.3], target: [0, 0.9, 0] }, walk: false,
  },
};

export const sampleUrl = (sample: LccSample) => new URL(`${sample.folder}/${sample.meta}`, sample.format === "lcc2" ? LCC2_ROOT : LCC_ROOT).href;
