import * as THREE from "three";

export interface Scan {
  label: string;
  url: string;
  scene?: boolean;
  // Trained with the 3DGS screen-space dilation: pre-blur, which keeps thin structures, not blur
  preBlur?: boolean;
  sky?: boolean;
  // The ground normal after the flip, turned to +y
  up?: [number, number, number];
  // Where the camera starts, in the scan's upright frame before scaling
  view?: { position: [number, number, number]; target: [number, number, number]; fov: number };
}

export const SPLATS = new URLSearchParams(location.search).get("splats") ?? "https://storage.googleapis.com/forge-dev-public/asundqui/radix/261009/rdx";
export const SPLATS_SH = new URLSearchParams(location.search).get("splatsSh") ?? "https://storage.googleapis.com/forge-dev-public/asundqui/radix/261015/rdx-sh";

export const SCANS: Record<string, Scan> = {
  butterfly: { label: "Butterfly", url: `${SPLATS}/butterfly-ai.rdx` },
  // Inside the cave, clear of the floaters around it
  ceramic: {
    label: "Ceramic", url: `${SPLATS}/ceramic.rdx`,
    view: { position: [-0.23, 1.83, -4.12], target: [0, 0, 0], fov: 50 },
  },
  // Spark's SOGS example view: at the tower's foot, looking at it
  sutro: {
    label: "Sutro (2M, SH3)", url: `${SPLATS_SH}/sutro-2m.rdx`, scene: true, preBlur: true, sky: true,
    view: { position: [0, 1.5, -1.2], target: [0, 1.5, 0], fov: 60 },
  },
};

// Stored y-down: the flip, then the up correction
export function scanRotation({ up }: Scan) {
  const flip = new THREE.Quaternion(1, 0, 0, 0);
  return up ? new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(...up).normalize(), new THREE.Vector3(0, 1, 0)).multiply(flip) : flip;
}

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
