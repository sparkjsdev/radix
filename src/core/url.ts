// A URL's file name, as errors show it: a signed URL's token is in its query
// or, on some CDNs, its path, and would otherwise reach the app's logs
export function fileName(url: string) {
  return url.replace(/[?#].*$/, "").replace(/\/+$/, "").split("/").pop()!;
}
