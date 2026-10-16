// Where the examples' hosted files live on Google Cloud Storage: one dated
// folder (YYMMDD) per upload, each kind of data in its own subfolder:
//   rdx/     the sample scans (single-file RDX)
//   rdx-sh/  the splats viewer's SH3 versions of them, with garden (extSh)
//   spz/     the SPZ example's samples, v2 to SPZ 4
//   sogs/    the SOG viewer's samples
//   lcc/     the LCC viewer's LCC v1 samples, with their collision.lci, and
//   lcc2/    its LCC2 samples
//   doom/    the Doom port's levels
//   quake/   the Quake port's maps
// Files in a dated folder are never replaced, so these addresses stay valid.
// Data folders changed or added since the data's version name their own
// (RADIX_FOLDER_VERSIONS).
export const RADIX_DATA_VERSION = "261009";

export const RADIX_DATA_URL = `https://storage.googleapis.com/forge-dev-public/asundqui/radix/${RADIX_DATA_VERSION}/`;

export const RADIX_FOLDER_VERSIONS = { lcc: "261012", lcc2: "261012", "rdx-sh": "261015", spz: "261015" };

// A data folder's address on the web
export const radixUrl = (name) => `https://storage.googleapis.com/forge-dev-public/asundqui/radix/${RADIX_FOLDER_VERSIONS[name] ?? RADIX_DATA_VERSION}/${name}/`;
