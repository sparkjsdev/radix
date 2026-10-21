// CC0 samples from github.com/raymondyfei/SharedTestModels, all stored y-up (RUB)
export interface Sample {
  label: string;
  file: string;
  note: string;
}

export const SPZ_ROOT = new URLSearchParams(location.search).get("spz") ?? "https://storage.googleapis.com/forge-dev-public/asundqui/radix/261015/spz";

export const SAMPLES: Record<string, Sample> = {
  "backpack-v2": {
    label: "Backpack · v2", file: "adobe_backpack.spz",
    note: "gzip, version 2: rotations as 3 bytes of x, y, z; Adobe's safe-orbit record after the SH",
  },
  "scarf-v3": {
    label: "Scarf · v3 (SH 4)", file: "scarf_v3.spz",
    note: "gzip, version 3: smallest-three rotations; SH degree 4 (written by nianticlabs/spz)",
  },
  "seashell-v4": {
    label: "Seashell · SPZ 4", file: "seashell_v4.spz",
    note: "SPZ 4: a plaintext NGSP header, a safe-orbit record, then one zstd stream per column",
  },
  "backpack-v4": {
    label: "Backpack · SPZ 4", file: "adobe_backpack_v4.spz",
    note: "SPZ 4 (NGSP / zstd) of the v2 backpack's splats",
  },
  "sparkling-v4": {
    label: "Sparkling water · SPZ 4 (SH 4)", file: "sparkling_water_v4.spz",
    note: "SPZ 4 with SH degree 4: compare SH 3 and 4 on its reflections (written by nianticlabs/spz)",
  },
};
