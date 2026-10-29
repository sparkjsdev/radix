// WebXR for the ports, after /build/examples/xr/index.html (../../xr/main.ts):
// WebGPU XR where the browser has the WebXR / WebGPU binding (GPU sort every
// frame), else the WebGL2 backend's XR (CPU sort through one view for the
// head). An "Enter VR" button, and the emulator's offered
// session. three swaps in the XR camera while presenting.
                                                   
import { getGpuCaps,                                                          } from "@sparkjsdev/radix";

// The backend for an XR page: ?gpu= when given
export function xrBackend()             {
  const param = new URLSearchParams(location.search).get("gpu");
  if (param === "webgpu" || param === "webgpu-gl") {
    return param;
  }
  return "XRGPUBinding" in globalThis && navigator.gpu ? "webgpu" : "webgpu-gl";
}

// An emulated XRWebGLLayer (IWER) has a null framebuffer; three's WebGL
// state keys draw buffers by framebuffer in a WeakMap, which takes no null
function patchNullXrFramebuffer(renderer                ) {
                                                                                                                                                                        
  const state = (renderer.backend                                ).state;
  if (!state?.currentDrawbuffers) {
    return;
  }
  const map = state.currentDrawbuffers                             ;
  const nullKey = {};
  state.currentDrawbuffers = {
    get: (key               ) => map.get(key ?? nullKey),
    set(key               , value          ) {
      map.set(key ?? nullKey, value);
      return this;
    },
  };
}

// Sets up sessions for `splatRenderers`; optionalFeatures are added to the
// backend's required ones. The controls' XR sticks move the rig: the
// controlled object's parent unless controls.rig is set. Returns
// { button, session() }.
export function setupXr(renderer                , splatRenderers                 , controls                , { optionalFeatures = [], framebufferScale = 1, onSession, onEnd }   
                              
                            
                                           
                     
  = {}) {
  const webgpu = getGpuCaps(renderer).backend === "webgpu";
  renderer.xr.setReferenceSpaceType("local-floor");
  patchNullXrFramebuffer(renderer);
  controls.xr = renderer.xr;
  for (const splatRenderer of splatRenderers) {
    // The desktop camera and the XR cameras are one viewpoint
    splatRenderer.view = splatRenderer.viewFor("head");
  }

  const init = () => ({ requiredFeatures: webgpu ? ["webgpu", "local-floor"] : ["local-floor"], optionalFeatures });
  let session                       ;
  const button = document.createElement("button");
  button.textContent = "Enter VR";
  button.style.cssText = "position:fixed;bottom:40px;left:50%;transform:translateX(-50%);padding:10px 24px;font-size:16px;border-radius:6px;border:1px solid #888;background:#222;color:#fff;cursor:pointer";
  button.hidden = !navigator.xr;
  document.body.append(button);

  async function start(next           ) {
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
    const xr = navigator.xr                                                                                                                ;
    xr?.offerSession?.("immersive-vr", init()).then(start).catch((error) => console.warn("offerSession", error));
  }

  button.addEventListener("click", async () => {
    try {
      await start(await navigator.xr .requestSession("immersive-vr", init()));
    } catch (error) {
      button.textContent = `No VR session: ${(error         ).message}`;
    }
  });
  offer();
  return { button, session: () => session };
}


//# sourceURL=examples/spark/js/xr.ts