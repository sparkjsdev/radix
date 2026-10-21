// Runs the checks of src on one backend and prints a line per check
//   ?gpu=     webgpu | webgpu-gl (default: webgpu when available, else webgpu-gl)
//   ?run=0    no run on load (default: a run on load)
//   radixTest.run()     runs the checks again, resolving to their results
//   radixTest.renderer  the renderer the checks use
//   radix, THREE        the library and three.js
import * as THREE from "three";
import * as radix from "@sparkjsdev/radix";
import { createRenderer, getGpuCaps } from "@sparkjsdev/radix";
import { runTests } from "./tests";

const output = document.getElementById("output")!;
const print = (line: string) => {
  output.textContent += `${line}\n`;
  console.log(line);
};

const gpu = new URLSearchParams(location.search).get("gpu");
const renderer = await createRenderer({ backend: gpu === "webgpu" || gpu === "webgpu-gl" ? gpu : "auto" });
print(`backend ${getGpuCaps(renderer).backend}  ${JSON.stringify(getGpuCaps(renderer))}`);

async function run() {
  const results = await runTests(renderer, (result) => {
    print(`${result.skipped ? "SKIP" : result.ok ? "ok  " : "FAIL"}  ${result.name}${result.detail ? `  (${result.detail})` : ""}`);
  });
  const failed = results.filter((result) => !result.ok);
  print(`${results.length - failed.length}/${results.length} passed`);
  return results;
}

Object.assign(window, { radixTest: { renderer, run }, radix, THREE });
if (new URLSearchParams(location.search).get("run") !== "0") {
  await run();
}
