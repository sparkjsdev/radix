import esbuild from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// `import Worker from "./file?worker&inline"` bundles file.ts as its own ESM
// bundle and exports a Worker subclass that runs it from a blob URL, so the
// page needs no separate worker files. `import code from "./file?module&inline"`
// bundles it the same way and exports its code as a string (for a blob URL
// that workers import). `define` is passed through to the bundle
// (RADIX_STATIC); `minify` for the production build.
export function inlineWorkerPlugin({ minify = false, define = {} } = {}) {
  return {
    name: "inline-worker",
    setup(build) {
      // esbuild prints the path of a module outside the file namespace as
      // given, in the bundle and its source map, so it is repo-relative
      build.onResolve({ filter: /\?(worker|module)&inline$/ }, (args) => {
        const file = path.resolve(args.resolveDir, args.path.replace(/\?(worker|module)&inline$/, ""));
        return {
          path: path.relative(root, file).split(path.sep).join("/"),
          namespace: "inline-worker",
          pluginData: { kind: args.path.match(/\?(worker|module)&inline$/)[1], file },
        };
      });

      build.onLoad({ filter: /.*/, namespace: "inline-worker" }, async (args) => {
        const result = await esbuild.build({
          entryPoints: [args.pluginData.file],
          bundle: true,
          format: "esm",
          platform: "browser",
          minify,
          define,
          write: false,
          metafile: true,
        });
        const code = result.outputFiles[0].text;
        const watchFiles = Object.keys(result.metafile.inputs);
        if (args.pluginData.kind === "module") {
          return { contents: `export default ${JSON.stringify(code)};`, loader: "js", watchFiles };
        }

        return {
          contents: [
            `const workerCode = ${JSON.stringify(code)};`,
            `const workerUrl = URL.createObjectURL(new Blob([workerCode], { type: "text/javascript" }));`,
            "export default class InlineWorker extends Worker {",
            "  constructor(options = {}) {",
            '    super(workerUrl, { ...options, type: "module" });',
            "  }",
            "}",
          ].join("\n"),
          loader: "js",
          watchFiles,
        };
      });
    },
  };
}
