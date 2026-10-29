// Sample SOG files, all on Google Cloud Storage under SOGS (?sogs= reads
// the same names elsewhere, such as /splats/sogs for local copies; every
// host needs CORS headers): mirrors of PlayCanvas's bundled .sog files,
// Spark's SOGS .zip, an unbundled SOGS meta.json and PlayCanvas's SOG LoD
// scenes (lod-meta.json), with their original addresses in `source`; and
// our splat-transform conversions of sutro_2m.ply (see main.ts). Rotations
// and start views are in the viewer's world (y up).
import * as THREE from "three";

export interface Sample {
  label: string;
  url: string;
  credit?: string;
  // Where the mirrored file came from
  source?: string;
  // Turned upright (default a half turn about x: files are usually y-down)
  rotation?: [number, number, number];
  mode?: "orbit" | "fly";
  sky?: boolean;
  // Where the camera starts (else framed from outside)
  view?: { position: [number, number, number]; target: [number, number, number]; fov: number };
}

export const SOGS = new URL(`${new URLSearchParams(location.search).get("sogs") ?? "https://storage.googleapis.com/forge-dev-public/asundqui/radix/261009/sogs"}/`, location.href).href;

const PC = "https://raw.githubusercontent.com/playcanvas/engine/main/examples/assets/splats";
const PC_DATA = "https://code.playcanvas.com/examples_data";

// Half turns about z, as PlayCanvas's examples place some of these
const Z_TURN: [number, number, number] = [0, 0, Math.PI];
const SUTRO_VIEW = { position: [0, 1.5, -1.2], target: [0, 1.5, 0], fov: 60 } satisfies Sample["view"];

export const SAMPLES: Record<string, Sample> = {
  "toy-cat": {
    label: "Toy cat (v2 .sog)", url: `${SOGS}toy-cat.sog`, credit: "PlayCanvas", source: "https://developer.playcanvas.com/assets/toy-cat.sog", rotation: Z_TURN,
  },
  skull: { label: "Skull (v2 .sog)", url: `${SOGS}skull.sog`, credit: "PlayCanvas engine examples", source: `${PC}/skull.sog` },
  bicycle: {
    label: "Bicycle (v2 .sog, 1M)", url: `${SOGS}bicycle.sog`, credit: "Mip-NeRF 360, PlayCanvas engine examples", source: `${PC}/bicycle.sog`, rotation: Z_TURN,
    view: { position: [1.6, 1.2, 2.2], target: [0, 0.575, 0], fov: 60 },
  },
  apartment: {
    label: "Apartment (v2 .sog, no SH)", url: `${SOGS}apartment.sog`, credit: "Stephane Agullo (sa3d.fr), CC-BY-4.0", source: `${PC}/apartment.sog`, mode: "fly",
    view: { position: [-3.8, 0.4, 7.2], target: [0, 0.4, 0], fov: 60 },
  },
  // Orbiting the hall itself (its densest splats), not the whole plot
  hall: {
    label: "Knock Community Hall (v2 .sog)", url: `${SOGS}knock-community-hall.sog`, credit: "scbenoit, CC-BY-4.0", source: `${PC}/knock-community-hall.sog`,
    view: { position: [1, 4.5, 11], target: [-1.5, 2, 0.5], fov: 60 },
  },
  sunnyvale: {
    label: "Sunnyvale (v2 .sog, 58 MB)", url: `${SOGS}sunnyvale.sog`, credit: "PlayCanvas examples", source: `${PC_DATA}/example_sunnyvale/sunnyvale.sog`,
    rotation: Z_TURN, mode: "fly", sky: true, view: { position: [0, 1.15, 0], target: [0, 1.15, -1], fov: 75 },
  },
  sutro: {
    label: "Sutro (SOGS .zip, 2M)", url: `${SOGS}sutro.zip`, credit: "Spark examples", source: "https://sparkjs.dev/assets/splats/sutro.zip", sky: true, view: SUTRO_VIEW,
  },
  logo: {
    label: "PlayCanvas logo (SOGS meta.json)", url: `${SOGS}playcanvas-logo/meta.json`, credit: "PlayCanvas engine examples", source: `${PC}/playcanvas-logo/meta.json`, rotation: Z_TURN,
  },
  playbot: { label: "Playbot (LoD)", url: `${SOGS}playbot/lod-meta.json`, credit: "PlayCanvas engine examples", source: `${PC}/playbot/lod-meta.json` },
  skatepark: {
    label: "Skatepark (LoD, 16M)", url: `${SOGS}skatepark/lod-meta.json`, credit: "PlayCanvas examples", source: `${PC_DATA}/example_skatepark_03/lod-meta.json`,
    rotation: [-Math.PI / 2, 0, 0], mode: "fly", sky: true, view: { position: [32, 2, 2], target: [0, 0.6, 0], fov: 75 },
  },
  "roman-parish": {
    label: "Roman parish (LoD, 69M)", url: `${SOGS}roman-parish/lod-meta.json`, credit: "PlayCanvas examples", source: `${PC_DATA}/example_roman_parish_03/lod-meta.json`,
    rotation: [-Math.PI / 2, 0, 0], mode: "fly", view: { position: [10.3, 2, -10], target: [12, 3, 0], fov: 75 },
  },
  "sutro-2m": { label: "Sutro 2M (v2 .sog, converted)", url: `${SOGS}sutro-2m.sog`, credit: "sutro_2m.ply through splat-transform", sky: true, view: SUTRO_VIEW },
  "sutro-2m-dir": { label: "Sutro 2M (v2 meta.json, converted)", url: `${SOGS}sutro-2m/meta.json`, credit: "sutro_2m.ply through splat-transform", sky: true, view: SUTRO_VIEW },
  "sutro-v1": { label: "Sutro (SOGS v1 meta.json)", url: `${SOGS}sutro-v1/meta.json`, credit: "Spark examples (sutro.zip unbundled)", sky: true, view: SUTRO_VIEW },
  "sutro-lod": { label: "Sutro 2M (LoD, 5 levels, converted)", url: `${SOGS}sutro-lod/lod-meta.json`, credit: "sutro_2m.ply through splat-transform", sky: true, view: SUTRO_VIEW },
};

export function sampleRotation(sample?: Sample) {
  return sample?.rotation ? new THREE.Quaternion().setFromEuler(new THREE.Euler(...sample.rotation)) : new THREE.Quaternion(1, 0, 0, 0);
}

// Outdoor scenes: a sky gradient around the view (zenith blue to a pale
// horizon, hazy below), as an equirectangular background
let sky: THREE.CanvasTexture | undefined;
export function skyTexture() {
  if (!sky) {
    const canvas = Object.assign(document.createElement("canvas"), { width: 4, height: 512 });
    const g = canvas.getContext("2d")!;
    const gradient = g.createLinearGradient(0, 0, 0, 512);
    gradient.addColorStop(0, "#2f6fb8");
    gradient.addColorStop(0.3, "#6fa6dc");
    gradient.addColorStop(0.49, "#d6e7f5");
    gradient.addColorStop(0.52, "#c9cfd4");
    gradient.addColorStop(1, "#5d6166");
    g.fillStyle = gradient;
    g.fillRect(0, 0, 4, 512);
    sky = new THREE.CanvasTexture(canvas);
    sky.mapping = THREE.EquirectangularReflectionMapping;
    sky.colorSpace = THREE.SRGBColorSpace;
  }
  return sky;
}
