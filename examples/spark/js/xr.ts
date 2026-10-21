// WebXR for the ports, as in examples/xr/main.ts
import type { WebGPURenderer } from "three/webgpu";
import { getGpuCaps, type CameraControls, type GpuBackend, type SplatRenderer } from "@sparkjsdev/radix";

export function xrBackend(): GpuBackend {
  const param = new URLSearchParams(location.search).get("gpu");
  if (param === "webgpu" || param === "webgpu-gl") {
    return param;
  }
  return "XRGPUBinding" in globalThis && navigator.gpu ? "webgpu" : "webgpu-gl";
}

// An emulated XRWebGLLayer (IWER) has a null framebuffer; three's WebGL
// state keys draw buffers by framebuffer in a WeakMap, which takes no null
function patchNullXrFramebuffer(renderer: WebGPURenderer) {
  type State = { currentDrawbuffers: WeakMap<object, number[]> | { get(key: object | null): number[] | undefined; set(key: object | null, value: number[]): unknown } };
  const state = (renderer.backend as unknown as { state?: State }).state;
  if (!state?.currentDrawbuffers) {
    return;
  }
  const map = state.currentDrawbuffers as WeakMap<object, number[]>;
  const nullKey = {};
  state.currentDrawbuffers = {
    get: (key: object | null) => map.get(key ?? nullKey),
    set(key: object | null, value: number[]) {
      map.set(key ?? nullKey, value);
      return this;
    },
  };
}

export function setupXr(renderer: WebGPURenderer, splatRenderers: SplatRenderer[], controls: CameraControls, { optionalFeatures = [], framebufferScale = 1, onSession, onEnd }: {
  optionalFeatures?: string[];
  framebufferScale?: number;
  onSession?: (session: XRSession) => void;
  onEnd?: () => void;
} = {}) {
  const webgpu = getGpuCaps(renderer).backend === "webgpu";
  renderer.xr.setReferenceSpaceType("local-floor");
  patchNullXrFramebuffer(renderer);
  controls.xr = renderer.xr;
  for (const splatRenderer of splatRenderers) {
    // The desktop camera and the XR cameras are one viewpoint
    splatRenderer.view = splatRenderer.viewFor("head");
  }

  const init = () => ({ requiredFeatures: webgpu ? ["webgpu", "local-floor"] : ["local-floor"], optionalFeatures });
  let session: XRSession | undefined;
  const button = document.createElement("button");
  button.textContent = "Enter VR";
  button.style.cssText = "position:fixed;bottom:40px;left:50%;transform:translateX(-50%);padding:10px 24px;font-size:16px;border-radius:6px;border:1px solid #888;background:#222;color:#fff;cursor:pointer";
  button.hidden = !navigator.xr;
  document.body.append(button);

  async function start(next: XRSession) {
    renderer.xr.setFramebufferScaleFactor(framebufferScale);
    next.addEventListener("end", () => {
      session = undefined;
      button.hidden = false;
      onEnd?.();
      offer();
    });
    await renderer.xr.setSession(next);
    session = next;
    button.hidden = true;
    onSession?.(next);
  }

  function offer() {
    const xr = navigator.xr as (XRSystem & { offerSession?: (mode: XRSessionMode, init: XRSessionInit) => Promise<XRSession> }) | undefined;
    xr?.offerSession?.("immersive-vr", init()).then(start).catch((error) => console.warn("offerSession", error));
  }

  button.addEventListener("click", async () => {
    try {
      await start(await navigator.xr!.requestSession("immersive-vr", init()));
    } catch (error) {
      button.textContent = `No VR session: ${(error as Error).message}`;
    }
  });
  offer();
  return { button, session: () => session };
}
