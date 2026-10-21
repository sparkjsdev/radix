import esbuild from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Inlines ?worker&inline and ?module&inline imports, so pages need no worker files
export function inlineWorkerPlugin({ minify = false, define = {} } = {}) {
  return {
    name: "inline-worker",
    setup(build) {
      // esbuild writes paths outside the file namespace as given, so this one is repo-relative
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
