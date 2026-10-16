// `import code from "./file?module&inline"` (scripts/inline-worker-plugin.mjs)
// bundles file.ts into one ES module and gives its code as a string
declare module "*/coreModule?module&inline" {
  const code: string;
  export default code;
}
