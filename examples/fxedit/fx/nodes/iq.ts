/*!
 * The sphere and box distances and the cosine palette follow Inigo Quilez's shaders
 * (https://www.shadertoy.com/view/Xds3zN, https://www.shadertoy.com/view/ll2GD3):
 *
 * The MIT License
 *
 * Copyright © 2013-2015 Inigo Quilez
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
 * documentation files (the "Software"), to deal in the Software without restriction, including without limitation
 * the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to
 * permit persons to whom the Software is furnished to do so, subject to the following conditions: The above copyright
 * notice and this permission notice shall be included in all copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE
 * WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
 * COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
 * OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 */
// TSL ports of https://iquilezles.org/articles/distfunctions/ and
// https://iquilezles.org/articles/palettes/
import { TSL, type TslNode } from "@sparkjsdev/radix";
import type { NodeSource } from "../types.js";

const { abs, cos, dot, length, max, min } = TSL;

export const IQ_DISTANCE: NodeSource = { name: "Inigo Quilez, distance functions", url: "https://iquilezles.org/articles/distfunctions/", license: "MIT" };
export const IQ_PALETTE: NodeSource = { name: "Inigo Quilez, palettes", url: "https://iquilezles.org/articles/palettes/", license: "MIT" };

export const sdSphere = (p: TslNode, radius: TslNode) => length(p).sub(radius);

export const sdBox = (p: TslNode, halfSize: TslNode) => {
  const q = abs(p).sub(halfSize).toVar();
  return length(max(q, 0.0)).add(min(max(q.x, max(q.y, q.z)), 0.0));
};

// Plane through the origin with unit normal n
export const sdPlane = (p: TslNode, n: TslNode) => dot(p, n);

// a + b cos(2 pi (c t + d))
export const cosinePalette = (t: TslNode, a: TslNode, b: TslNode, c: TslNode, d: TslNode) =>
  a.add(b.mul(cos(c.mul(t).add(d).mul(2 * Math.PI))));
