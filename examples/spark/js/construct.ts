// Splats made on the CPU, after Spark's splatConstructors.ts
import * as THREE from "three";
import { Splats, type SplatBundle, type SplatTarget } from "@sparkjsdev/radix";

const FLOATS = 14;

interface Xyz {
  x: number;
  y: number;
  z: number;
}

interface Rgb {
  r: number;
  g: number;
  b: number;
}

export class SplatBuilder {
  values: Float32Array;
  count: number;

  constructor(capacity = 1024) {
    this.values = new Float32Array(capacity * FLOATS);
    this.count = 0;
  }

  // Spark's PackedSplats.pushSplat argument order
  pushSplat(center: Xyz, scales: Xyz, quaternion: Xyz & { w: number }, opacity: number, color: Rgb) {
    if ((this.count + 1) * FLOATS > this.values.length) {
      const grown = new Float32Array(this.values.length * 2);
      grown.set(this.values);
      this.values = grown;
    }
    this.values.set([center.x, center.y, center.z, scales.x, scales.y, scales.z, quaternion.x, quaternion.y, quaternion.z, quaternion.w, color.r, color.g, color.b, opacity], this.count * FLOATS);
    this.count += 1;
  }

  build({ layout = "extSplats", encoding }: SplatTarget = {}) {
    const data = Splats.make(this.count, { layout, encoding });
    writeSplats(Splats.get(data).bundle, this.values, 0, this.count);
    return data;
  }
}

// values in SplatBuilder's layout
export function writeSplats(bundle: SplatBundle, values: Float32Array, first: number, count: number) {
  const encode = Splats.encoder(bundle);
  const s = Splats.makeExtSplat();
  for (let i = first; i < first + count; i += 1) {
    const o = i * FLOATS;
    [s.center.x, s.center.y, s.center.z] = [values[o], values[o + 1], values[o + 2]];
    [s.scales.x, s.scales.y, s.scales.z] = [values[o + 3], values[o + 4], values[o + 5]];
    [s.quaternion.x, s.quaternion.y, s.quaternion.z, s.quaternion.w] = [values[o + 6], values[o + 7], values[o + 8], values[o + 9]];
    [s.rgb.r, s.rgb.g, s.rgb.b] = [values[o + 10], values[o + 11], values[o + 12]];
    s.opacity = values[o + 13];
    encode(i, s);
  }
}

// One splat per pixel of text on a canvas; the returned color is for Spark's recolor
export function textSplats({
  text, font = "Arial", fontSize = 32, color = new THREE.Color(1, 1, 1), rgb = new THREE.Color(1, 1, 1),
  dotRadius = 0.8, textAlign = "start", lineHeight = 1, objectScale = 1,
}: {
  text: string;
  font?: string;
  fontSize?: number;
  color?: THREE.Color;
  rgb?: THREE.Color;
  dotRadius?: number;
  textAlign?: CanvasTextAlign;
  lineHeight?: number;
  objectScale?: number;
}) {
  const lines = text.split("\n");
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d")!;
  ctx.font = `${fontSize}px ${font}`;
  ctx.textAlign = textAlign;
  const empty = ctx.measureText("");
  const fontHeight = empty.fontBoundingBoxAscent + empty.fontBoundingBoxDescent;

  let [minLeft, maxRight, minTop, maxBottom] = [Infinity, -Infinity, Infinity, -Infinity];
  lines.forEach((line, i) => {
    const metrics = ctx.measureText(line);
    const y = fontHeight * lineHeight * i;
    minLeft = Math.min(minLeft, -metrics.actualBoundingBoxLeft);
    maxRight = Math.max(maxRight, metrics.actualBoundingBoxRight);
    minTop = Math.min(minTop, y - metrics.actualBoundingBoxAscent);
    maxBottom = Math.max(maxBottom, y + metrics.actualBoundingBoxDescent);
  });
  const originLeft = Math.floor(minLeft);
  const originTop = Math.floor(minTop);
  const width = Math.max(1, Math.ceil(maxRight) - originLeft);
  const height = Math.max(1, Math.ceil(maxBottom) - originTop);
  canvas.width = width;
  canvas.height = height;

  ctx.font = `${fontSize}px ${font}`;
  ctx.textAlign = textAlign;
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "#FFFFFF";
  lines.forEach((line, i) => ctx.fillText(line, -originLeft, fontHeight * lineHeight * i - originTop));

  const rgba = ctx.getImageData(0, 0, width, height).data;
  const builder = new SplatBuilder(width * height / 4);
  const center = new THREE.Vector3();
  const scales = new THREE.Vector3().setScalar(dotRadius * objectScale);
  const quaternion = new THREE.Quaternion();
  for (let y = 0, offset = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1, offset += 4) {
      const a = rgba[offset + 3];
      if (a > 0) {
        center.set(x - 0.5 * (width - 1), 0.5 * (height - 1) - y, 0).multiplyScalar(objectScale);
        builder.pushSplat(center, scales, quaternion, a / 255, rgb);
      }
    }
  }
  return { data: builder.build(), color };
}

// forEachSplat may change a splat and returns its opacity, or null to skip it
export type ForEachSplat = (
  width: number, height: number, index: number, center: THREE.Vector3, scales: THREE.Vector3, quaternion: THREE.Quaternion, opacity: number, color: THREE.Color,
) => number | null | undefined;

export async function imageSplats({ url, dotRadius = 0.8, subXY = 1, forEachSplat }: { url: string; dotRadius?: number; subXY?: number; forEachSplat?: ForEachSplat }) {
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.src = url;
  await img.decode();
  subXY = Math.max(1, Math.floor(subXY));
  const width = Math.round(img.width / subXY);
  const height = Math.round(img.height / subXY);
  const canvas = Object.assign(document.createElement("canvas"), { width: img.width, height: img.height });
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, 0, 0, width, height);
  const rgba = ctx.getImageData(0, 0, width, height).data;

  const builder = new SplatBuilder(width * height);
  const center = new THREE.Vector3();
  const scales = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const color = new THREE.Color();
  for (let y = 0, index = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1, index += 1) {
      const a = rgba[index * 4 + 3];
      if (a === 0) {
        continue;
      }
      let opacity = a / 255;
      color.setRGB(rgba[index * 4] / 255, rgba[index * 4 + 1] / 255, rgba[index * 4 + 2] / 255);
      center.set(x - 0.5 * (width - 1), 0.5 * (height - 1) - y, 0);
      scales.setScalar(dotRadius);
      quaternion.set(0, 0, 0, 1);
      if (forEachSplat) {
        const result = forEachSplat(width, height, index, center, scales, quaternion, opacity, color);
        if (result === null || result === undefined) {
          continue;
        }
        opacity = result;
      }
      builder.pushSplat(center, scales, quaternion, opacity, color);
    }
  }
  return builder.build();
}

// Spark's constructGrid: each point a colored splat with a larger black one around it
export function constructGrid({ builder = new SplatBuilder(), extents, stepSize = 1, pointRadius = 0.01, pointShadowScale = 2, opacity = 1, color }: {
  builder?: SplatBuilder;
  extents: THREE.Box3;
  stepSize?: number;
  pointRadius?: number;
  pointShadowScale?: number;
  opacity?: number;
  color?: THREE.Color | ((out: THREE.Color, point: THREE.Vector3) => void);
}) {
  const EPSILON = 1e-6;
  color ??= (out, point) => out.set(0.55 + 0.45 * Math.cos(point.x), 0.55 + 0.45 * Math.cos(point.y), 0.55 + 0.45 * Math.cos(point.z));
  const center = new THREE.Vector3();
  const scales = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const pointColor = new THREE.Color();
  for (let z = extents.min.z; z < extents.max.z + EPSILON; z += stepSize) {
    for (let y = extents.min.y; y < extents.max.y + EPSILON; y += stepSize) {
      for (let x = extents.min.x; x < extents.max.x + EPSILON; x += stepSize) {
        center.set(x, y, z);
        for (let layer = 0; layer < 2; layer += 1) {
          scales.setScalar(pointRadius * (layer ? 1 : pointShadowScale));
          if (!layer) {
            pointColor.setScalar(0);
          } else if (typeof color === "function") {
            color(pointColor, center);
          } else {
            pointColor.copy(color);
          }
          builder.pushSplat(center, scales, quaternion, opacity, pointColor);
        }
      }
    }
  }
  return builder;
}
