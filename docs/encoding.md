# Encodings

The splat layouts store their fields with the codecs below. `Encoding` and `SplatMath` (CPU) and their twins `GpuEncoding` and `GpuSplatMath` (TSL) are public, so other formats and shaders can reuse them and get the same bits.

Code: `src/core/encoding.ts` and `math.ts`; `src/gpu/encoding.tsl.ts` and `math.tsl.ts`. The word maps of each layout are in [splats.md](splats.md#layouts).

```ts
// A direction in 24 bits
const code = Encoding.encodeOct24({ x: 0, y: 0, z: 1 });

// Decodes within 0.06 degrees
const back = Encoding.decodeOct24(code, { x: 0, y: 0, z: 0 });

// The same bits in a shader
const dir = GpuEncoding.decodeOct24(word.bitAnd(0xffffff));
```

## The fields

| Field | Layouts | Stored as | Precision |
|---|---|---|---|
| center | ext, cov | float32 x 3 | exact |
| center | packed | half float x 3 | 11 significant bits (about 0.05% of the distance from the origin) |
| scales | ext | half(ln s) x 3 | ln s within about 2^-11 of itself, so s within about 2^-11 x \|ln s\| of itself (0.25% at s = e^-5) |
| scales | packed | 8-bit ln s over `[lnScaleMin, lnScaleMax]` (0 = a zero scale) | a step of 21 / 255 ≈ 0.08 in ln s by default: about 8% of the scale per step |
| rotation | ext | `QuatOct32`: a 10 + 10 bit octahedral axis and a 12-bit angle | rotations under 2 degrees within 0.03 degrees |
| rotation | packed | `QuatOct24`: an 8 + 8 bit axis and an 8-bit angle | an angle step of 0.7 degrees |
| covariance | cov | half(ln) of the diagonal; half(sign x ln of the abs correlation) for the rest | relative, about 2^-11 |
| color | ext, cov | three 8-bit magnitudes, three sign bits, and a shared 5-bit exponent | 1 / 255 of the largest channel's power of two; values above 1 and below 0 are kept |
| color | packed | unorm8 over `[rgbMin, rgbMax]` | 1 / 255 of the range |
| opacity | ext, cov | one byte, 128 = 1.0 | 1 / 128; up to 255 / 128 for merged LoD nodes |
| opacity | packed | unorm8 | 1 / 255; at most 1 |
| normal | ext, cov | `Oct24`: 12 + 12 bits; code 0 = none | within 0.06 degrees |
| roughness, metallic | ext | unorm8 each | 1 / 255 |

A fresh row (all zero bits) decodes as roughness 0, metallic 0, and no normal until `Splats.storePbr` writes it.

## Octahedral directions

A direction is divided by its L1 norm, which maps it onto an octahedron. The lower half of the octahedron is folded over the upper half, giving a point in a square. Each of the point's two coordinates is rounded to `bits` bits, and the code is `u | v << bits`. Code 0 means no vector. A direction that rounds to 0 gets the all-ones code instead, which decodes to the same direction.

The error is nearly uniform over the sphere. `Oct24` (12 bits per axis) is within about 0.06 degrees. The encoder rounds each coordinate and does not search neighboring codes.

## Quaternions as an axis and an angle

`QuatOct` codes store the rotation's axis as an octahedral direction in the low `2 x axisBits` bits and its angle (0 to pi, for the quaternion with w >= 0) in the `angleBits` bits above. A zero quaternion encodes as the identity (code 0).

The angle gets the most bits because many splats are rotated only slightly from the identity. For a small rotation, the axis error is scaled by sin(angle / 2), so the angle's step sets the precision: with 12 bits (a step of pi / 4095), rotations under 2 degrees decode within about 0.03 degrees. A splat aligned with a coordinate axis can also be stored as a small rotation from the identity, with its scales permuted.

## Shared-exponent color

`encodeExtRgb` finds the largest absolute channel, rounds its log2 up to an exponent `e` (stored as `e + 15`, 0 to 31), and stores each channel as an 8-bit magnitude in units of `2^e / 255`, with its sign in one of three bits. This keeps colors from about 2^-15 to 2^16, including the negative and above-1 values that merged LoD nodes and lighting produce. The `ext` spherical-harmonics codec stores each SH coefficient (an RGB triple) in one such word; [sh.md](sh.md#codecs) has its layout and the other SH codecs.

## Encoding: the CPU codecs

| Member | What it does |
|---|---|
| `encodeHalf(f)`, `decodeHalf(h)` | half-float bits, rounded to nearest even like the GPU's `packHalf2x16` |
| `encodeUnorm8(v)` | `round(v * 255)`, clamped to 0..255 |
| `encodeLodOpacity(o)`, `decodeLodOpacity(byte)` | 128 = 1.0, up to 255 |
| `encodeExtRgb(rgb)`, `decodeExtRgb(code, out)` | the shared-exponent color word |
| `encodeOct(v, bits)`, `decodeOct(code, bits, out)` | an octahedral direction, `bits` per axis (1 to 16) |
| `encodeQuatOct(q, axisBits, angleBits)`, `decodeQuatOct(code, axisBits, angleBits, out)` | a quaternion as an axis and an angle (at most 32 bits in all) |
| `encodeOct24` / `decodeOct24`, `encodeQuatOct32` / `decodeQuatOct32`, `encodeQuatOct24` / `decodeQuatOct24` | the fixed-size codecs, each built once with its constants |
| `floatView(u32)` | a `Float32Array` over the same memory (cached per array); ext centers are read through it |

The generic and fixed-size codecs give the same codes (the checks compare them).

## SplatMath: quaternions and covariances

| `SplatMath` member | What it does |
|---|---|
| `normalizeQuat(q, out)` | a unit quaternion (the identity for a zero one) |
| `covFromScaleQuat(scales, q, out)` | Σ = M Mᵀ with M = R(q) diag(scales) |
| `symEigens(cov)` | eigenvalues (descending) and eigenvectors (`basis`, columns, right-handed) of a symmetric 3x3 matrix, by Jacobi rotations with a relative tolerance |
| `basisToQuat(m, out)` | the quaternion (w >= 0) of an orthonormal basis given as columns |

Types: `Vec3`, `Quat`, `Rgb`, and `Cov` (`{ xx, yy, zz, xy, xz, yz }`).

## The shader twins

`GpuEncoding` has the same codecs on TSL nodes: `encodeHalf` / `decodeHalf`, `encodeHalf2` / `decodeHalf2` (two halves in one word), `encodeUnorm8`, `encodeLodOpacity` / `decodeLodOpacity`, `encodeExtRgb` / `decodeExtRgb`, `encodeOct` / `decodeOct`, `encodeQuatOct` / `decodeQuatOct`, and the fixed-size `encodeOct24`, `encodeQuatOct32`, and `encodeQuatOct24` with their decoders. Half floats use the GPU's `packHalf2x16` / `unpackHalf2x16`.

`GpuSplatMath` has `quatRotate(q, v)`, `quatMul(a, b)`, `quatConj(q)`, `mat3FromMat4(m)`, `scaleQuatMatrix(scales, q)`, `covFromScaleQuat(scales, q)`, `covMatrix(xxyyzz, xyxzyz)`, `symEigens(xxyyzz, xyxzyz)`, and `basisToQuat(basis)`.

## CPU and GPU

The CPU and TSL codecs produce the same bits for the same inputs, except where float32 math on the GPU lands on the other side of a rounding step from the CPU's float64 math. In that case the code is one step off: under 2% of ext and packed splats, and about 7% of cov splats (those with correlations near 1). The checks require every such code to still decode within the field's budget ([checks.md](checks.md)).
