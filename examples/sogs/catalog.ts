import * as THREE from "three";

// Shown in the corner while its sample is open
export interface Credit {
  title: string;
  url: string;
  author: string;
  authorUrl?: string;
  license?: { name: string; url: string };
}

export interface Sample {
  label: string;
  url: string;
  credit?: Credit;
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
const CC_BY = { name: "CC BY 4.0", url: "https://creativecommons.org/licenses/by/4.0/" };
const SUTRO: Credit = { title: "Sutro Tower", url: "https://vincentwoo.com/2025/02/18/sutro-tower-in-3d/", author: "Vincent Woo and Daylen Yang" };

export const SAMPLES: Record<string, Sample> = {
  // Orbiting the hall itself (its densest splats), not the whole plot
  hall: {
    label: "Knock Community Hall (v2 .sog)", url: `${SOGS}knock-community-hall.sog`, source: `${PC}/knock-community-hall.sog`,
    credit: { title: "Knock Community Hall", url: "https://superspl.at/scene/0ff2e6dc", author: "scbenoit", authorUrl: "https://superspl.at/user/scbenoit", license: CC_BY },
    view: { position: [1, 4.5, 11], target: [-1.5, 2, 0.5], fov: 60 },
  },
  sunnyvale: {
    label: "Sunnyvale (v2 .sog, 58 MB)", url: `${SOGS}sunnyvale.sog`, source: `${PC_DATA}/example_sunnyvale/sunnyvale.sog`,
    credit: {
      title: "Sunnyvale Heritage Park Museum", url: "https://superspl.at/scene/d5d397aa",
      author: "zeitgeistarchivescans", authorUrl: "https://superspl.at/user/zeitgeistarchivescans", license: CC_BY,
    },
    rotation: Z_TURN, mode: "fly", sky: true, view: { position: [0, 1.15, 0], target: [0, 1.15, -1], fov: 75 },
  },
  sutro: {
    label: "Sutro (SOGS .zip, 2M)", url: `${SOGS}sutro.zip`, credit: SUTRO, source: "https://sparkjs.dev/assets/splats/sutro.zip", sky: true, view: SUTRO_VIEW,
  },
  "sutro-2m": { label: "Sutro 2M (v2 .sog, converted)", url: `${SOGS}sutro-2m.sog`, credit: SUTRO, sky: true, view: SUTRO_VIEW },
  "sutro-2m-dir": { label: "Sutro 2M (v2 meta.json, converted)", url: `${SOGS}sutro-2m/meta.json`, credit: SUTRO, sky: true, view: SUTRO_VIEW },
  "sutro-v1": { label: "Sutro (SOGS v1 meta.json)", url: `${SOGS}sutro-v1/meta.json`, credit: SUTRO, sky: true, view: SUTRO_VIEW },
  "sutro-lod": { label: "Sutro 2M (LoD, 5 levels, converted)", url: `${SOGS}sutro-lod/lod-meta.json`, credit: SUTRO, sky: true, view: SUTRO_VIEW },
};

export function creditHtml({ title, url, author, authorUrl, license }: Credit) {
  const link = (text: string, href?: string) => (href ? `<a href="${href}" target="_blank" rel="noopener">${text}</a>` : text);
  return `${link(title, url)} by ${link(author, authorUrl)}${license ? `, ${link(license.name, license.url)}` : ""}`;
}

export function sampleRotation(sample?: Sample) {
  return sample?.rotation ? new THREE.Quaternion().setFromEuler(new THREE.Euler(...sample.rotation)) : new THREE.Quaternion(1, 0, 0, 0);
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
