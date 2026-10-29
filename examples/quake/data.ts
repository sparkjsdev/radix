// Where the page fetches its data: dataBase(name) is the folder of one
// export, relative to which the page fetches every file (doom/data.ts is a
// copy).

// The hosted exports: the dated GCS folder of scripts/data.mjs
// (scripts/build-site.mjs rewrites this line for its --data). A copy
// elsewhere is read with ?data=<url>.
export const DATA_ROOT = "https://storage.googleapis.com/forge-dev-public/asundqui/radix/261009/";

export function dataBase(name: string): string {
  return new URLSearchParams(location.search).get("data") ?? `${DATA_ROOT}${name}/`;
}

// fetch(url), throwing an Error that names the address when it fails
export async function fetchData(url: string): Promise<Response> {
  const response = await fetch(url);
  if (response.status === 404) {
    throw new Error(`No data at ${url}`);
  }
  if (!response.ok) {
    throw new Error(`Failed to load ${url}: ${response.status}`);
  }
  return response;
}
