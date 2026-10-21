// Errors show only the file name, since a signed URL's token may be in its query or path
export function fileName(url: string) {
  return url.replace(/[?#].*$/, "").replace(/\/+$/, "").split("/").pop()!;
}
