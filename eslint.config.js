import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

// The library's layers import downwards only. core/ runs anywhere (no three,
// no other layer); gpu/ and worker/ sit on core/ side by side, worker/
// without three; wgpu/ (WebGPU only) sits on gpu/; render/ puts core/, gpu/,
// wgpu/ and worker/ together, and nothing imports it; controls/ needs three only
const layer = (files, group, message) => ({
  files,
  rules: {
    "no-restricted-imports": ["error", { patterns: [{ group, message }] }],
  },
});

export default [
  {
    ignores: ["node_modules/", "dist/", "build/", "recordings/"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    rules: {
      "no-undef": "off",
    },
  },
  layer(["src/gpu/**/*.ts"], ["../worker/*", "../wgpu/*", "../render/*", "../controls/*"], "gpu/ imports neither worker/, wgpu/, render/ nor controls/"),
  layer(["src/wgpu/**/*.ts"], ["../worker/*", "../render/*", "../controls/*"], "wgpu/ imports neither worker/, render/ nor controls/"),
  layer(["src/render/**/*.ts"], ["../controls/*"], "render/ does not import controls/"),
  layer(["src/core/**/*.ts"], ["three", "three/*", "../gpu/*", "../wgpu/*", "../worker/*", "../render/*", "../controls/*"], "core/ imports neither three nor the other layers"),
  layer(["src/worker/**/*.ts"], ["three", "three/*", "../gpu/*", "../wgpu/*", "../render/*", "../controls/*"], "worker/ imports core/ only"),
  layer(["src/controls/**/*.ts"], ["../core/*", "../gpu/*", "../wgpu/*", "../worker/*", "../render/*"], "controls/ imports three only"),
  {
    files: ["scripts/**/*.mjs", "eslint.config.js"],
    languageOptions: {
      globals: globals.node,
    },
  },
];
