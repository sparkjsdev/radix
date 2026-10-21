// The page around a Spark port; scripts/check-examples.mjs reads window.example
import type * as THREE from "three";
import type { WebGPURenderer } from "three/webgpu";
import { createRenderer, getGpuCaps } from "@sparkjsdev/radix";

declare global {
  interface Window {
    example: { ready: boolean; error: string | undefined };
  }
}

window.example = { ready: false, error: undefined };

const statusLine = document.createElement("div");
statusLine.id = "example-status";
document.body.append(statusLine);

function status(text: string) {
  statusLine.textContent = text;
  statusLine.classList.toggle("empty", !text);
}

function fail(error: unknown) {
  const err = error as Error | undefined;
  window.example.error = err?.stack ?? err?.message ?? String(error);
  status(`Error: ${err?.message ?? error}`);
  statusLine.classList.add("error");
  console.error(error);
}

addEventListener("error", (event) => fail(event.error ?? event.message));
addEventListener("unhandledrejection", (event) => fail(event.reason));

// name is the Spark example's folder; note says what the port leaves out
export function examplePage(name: string, { note }: { note?: string } = {}) {
  return {
    status,
    fail,

    legend(html: string) {
      const element = document.createElement("div");
      element.className = "example-legend";
      element.innerHTML = html;
      document.body.append(element);
      return element;
    },

    progress(label: string) {
      return (fraction: number, stage: string) => status(`${label}: ${stage} ${Math.round(fraction * 100)}%`);
    },

    ready(renderer: WebGPURenderer) {
      status("");
      if (document.getElementById("example-footer")) {
        return;
      }
      footer(name, getGpuCaps(renderer).backend === "webgpu", note);
      let frames = 5;
      const tick = () => (--frames > 0 ? requestAnimationFrame(tick) : (window.example.ready = true));
      requestAnimationFrame(tick);
    },
  };
}

function footer(name: string, webgpu: boolean, note?: string) {
  const params = new URLSearchParams(location.search);
  params.set("gpu", webgpu ? "webgpu-gl" : "webgpu");

  const element = document.createElement("div");
  element.id = "example-footer";
  element.innerHTML = [
    `<b>${webgpu ? "WebGPU" : "WebGL2"}</b>`,
    `<a href="?${params}">${webgpu ? "WebGL2" : "WebGPU"}</a>`,
    `<a href="https://sparkjs.dev/examples/#${name}" target="_blank">Spark original</a>`,
    "<a href=\"../index.html\">all ports</a>",
    note ? `<span>${note}</span>` : "",
  ].join(" ");
  document.body.append(element);
}

type RendererOptions = NonNullable<Parameters<typeof createRenderer>[0]>;

// ?gpu=webgpu or webgpu-gl picks the backend, default auto. Pass pixelRatio
// only where the Spark example sets one.
export async function windowRenderer(camera: THREE.PerspectiveCamera, { pixelRatio, ...options }: RendererOptions & { pixelRatio?: number } = {}) {
  const gpu = new URLSearchParams(location.search).get("gpu");
  const renderer = (await createRenderer({ backend: gpu === "webgpu" || gpu === "webgpu-gl" ? gpu : "auto", ...options })) as WebGPURenderer;
  if (pixelRatio !== undefined) {
    renderer.setPixelRatio(pixelRatio);
  }
  renderer.setSize(innerWidth, innerHeight);
  document.body.append(renderer.domElement);

  addEventListener("resize", () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });
  return renderer;
}
