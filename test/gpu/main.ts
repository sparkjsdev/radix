// Test page for src (/build/test/gpu/index.html, ?gpu=webgpu | webgpu-gl). Runs
// the checks on load (not with ?run=0); `await radixTest.run()` in the
// console runs them again.
import * as THREE from "three";
import * as radix from "@sparkjsdev/radix";
import { createRenderer, getGpuCaps } from "@sparkjsdev/radix";
import { runTests } from "./tests";

const output = document.getElementById("output")!;
const print = (line: string) => {
  output.textContent += `${line}\n`;
  console.log(line);
};

const renderer = await createRenderer();
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
