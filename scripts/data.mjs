// The hosted data's GCS addresses: one folder per upload, dated YYMMDD and never replaced
export const RADIX_DATA_VERSION = "261009";

export const RADIX_DATA_URL = `https://storage.googleapis.com/forge-dev-public/asundqui/radix/${RADIX_DATA_VERSION}/`;

export const RADIX_FOLDER_VERSIONS = { "rdx-sh": "261015", spz: "261015" };

export const radixUrl = (name) => `https://storage.googleapis.com/forge-dev-public/asundqui/radix/${RADIX_FOLDER_VERSIONS[name] ?? RADIX_DATA_VERSION}/${name}/`;
