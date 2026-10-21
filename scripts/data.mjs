// Where the examples' hosted files live on Google Cloud Storage: one dated
// folder (YYMMDD) per upload, each kind of data in its own subfolder:
//   rdx/     the sample scans (single-file RDX)
//   rdx-sh/  the splats viewer's SH3 versions of them (extSh)
//   spz/     the SPZ example's samples, v2 to SPZ 4
//   sogs/    the SOG viewer's samples
// Files in a dated folder are never replaced, so these addresses stay valid.
// Data folders changed or added since the data's version name their own
// (RADIX_FOLDER_VERSIONS).
export const RADIX_DATA_VERSION = "261009";

export const RADIX_DATA_URL = `https://storage.googleapis.com/forge-dev-public/asundqui/radix/${RADIX_DATA_VERSION}/`;

export const RADIX_FOLDER_VERSIONS = { "rdx-sh": "261015", spz: "261015" };

// A data folder's address on the web
export const radixUrl = (name) => `https://storage.googleapis.com/forge-dev-public/asundqui/radix/${RADIX_FOLDER_VERSIONS[name] ?? RADIX_DATA_VERSION}/${name}/`;
