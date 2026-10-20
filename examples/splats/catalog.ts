// Sample splats: single-file RDX of ext splats, hosted on Google Cloud
// Storage: the butterfly and the ceramic without spherical harmonics (in
// rdx/; ?splats= reads the same names elsewhere), the scans with SH3 (extSh,
// in rdx-sh/; ?splatsSh= reads them elsewhere). Every sample is stored
// y-down, so it is flipped upright.
import * as THREE from "three";

export interface Scan {
  label: string;
  url: string;
  // Camera mode it starts in (default orbit)
  mode?: "orbit" | "fly";
  // Trained with the 3DGS screen-space dilation: pre-blur (keeps thin
  // structures) instead of blur
  preBlur?: boolean;
  // Outdoors: a sky behind the splats
  sky?: boolean;
  // Measured up direction after the flip (ground normal), turned to +y
  up?: [number, number, number];
  // Where the camera starts, in the scan's upright frame (else framed from outside)
  view?: { position: [number, number, number]; target: [number, number, number]; fov: number };
}

export const SPLATS = new URLSearchParams(location.search).get("splats") ?? "https://storage.googleapis.com/forge-dev-public/asundqui/radix/261009/rdx";
export const SPLATS_SH = new URLSearchParams(location.search).get("splatsSh") ?? "https://storage.googleapis.com/forge-dev-public/asundqui/radix/261015/rdx-sh";

export const SCANS: Record<string, Scan> = {
  butterfly: { label: "Butterfly", url: `${SPLATS}/butterfly-ai.rdx` },
  // Inside the cave, clear of the floaters around it
  ceramic: {
    label: "Ceramic", url: `${SPLATS}/ceramic.rdx`, mode: "fly",
    view: { position: [-0.23, 1.83, -4.12], target: [0, 0, 0], fov: 50 },
  },
  // Spark's SOGS example view: at the tower's foot, looking at it
  sutro: {
    label: "Sutro (2M, SH3)", url: `${SPLATS_SH}/sutro-2m.rdx`, sky: true,
    view: { position: [0, 1.5, -1.2], target: [0, 1.5, 0], fov: 60 },
  },
  // In the middle of the nave, about 2.5 above the floor, looking along it
  grace: {
    label: "Grace interior (10M, SH3)", url: `${SPLATS_SH}/grace-interior-10m.rdx`, mode: "fly",
    view: { position: [-14, 8, -3], target: [-4, 8, -3], fov: 60 },
  },
  // Up: the ground within 3.5 of the origin; the view: side on, the bike by the bench
  bicycle: {
    label: "Bicycle (SH3)", url: `${SPLATS_SH}/bicycle.rdx`, mode: "fly", preBlur: true, sky: true,
    up: [-0.015, 0.97, 0.244], view: { position: [-3.5, 0.9, 0], target: [0, -0.7, 0], fov: 55 },
  },
  // Mip-NeRF 360's garden. Up: the ground and the table top (parallel within
  // 0.3 degrees); the view: GaussianSplats3D's garden demo (cameraUp
  // [0, -1, -0.54], within a degree of this up), looking down across the table
  garden: {
    label: "Garden (5.8M, SH3)", url: `${SPLATS_SH}/garden.rdx`, mode: "fly", preBlur: true, sky: true,
    up: [-0.01, 0.877, 0.48], view: { position: [-3.15, 0.43, 0.36], target: [1.5, -2.81, -0.36], fov: 50 },
  },
};

// Upright: the flip, then the up correction
export function scanRotation({ up }: Scan) {
  const flip = new THREE.Quaternion(1, 0, 0, 0);
  return up ? new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(...up).normalize(), new THREE.Vector3(0, 1, 0)).multiply(flip) : flip;
}

// Outdoor scans: a sky gradient around the view (zenith blue to a pale
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
