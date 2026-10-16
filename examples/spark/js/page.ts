// The page around a Spark port: error capture, a status line, a legend, the
// footer (backend, links) and window.example, which tells the smoke check
// (scripts/check-examples.mjs) when the page has drawn its content
// ({ ready: true }) or failed ({ error }). windowRenderer makes the
// renderer every port starts with.
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

// Errors anywhere, the animation loop's included
addEventListener("error", (event) => fail(event.error ?? event.message));
addEventListener("unhandledrejection", (event) => fail(event.reason));

// `name` is the Spark example's folder (footer links); `note` a footer
// line saying what the port leaves out
export function examplePage(name: string, { note }: { note?: string } = {}) {
  return {
    status,
    fail,

    // A line of instructions at the top of the page
    legend(html: string) {
      const element = document.createElement("div");
      element.className = "example-legend";
      element.innerHTML = html;
      document.body.append(element);
      return element;
    },

    // An onProgress for loading that shows `label` and the stage
    progress(label: string) {
      return (fraction: number, stage: string) => status(`${label}: ${stage} ${Math.round(fraction * 100)}%`);
    },

    // The page shows what it loaded: the footer, and a few frames later the
    // smoke check's signal (later calls only clear the status)
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

// The backend, a link to the other one, the Spark original and the index
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

// createRenderer (WebGPU, or the WebGL2 backend with ?gpu=webgpu-gl), sized
// to the window and added to the page; it follows window resizes, and so
// does the camera's aspect. pixelRatio: only where the Spark example sets
// one (else three's 1).
export async function windowRenderer(camera: THREE.PerspectiveCamera, { pixelRatio, ...options }: RendererOptions & { pixelRatio?: number } = {}) {
  const renderer = (await createRenderer(options)) as WebGPURenderer;
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
