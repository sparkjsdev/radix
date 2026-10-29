import { Node, type NodeBuilder } from "three/webgpu";
import { TSL, type TslNode } from "../gpu/tsl";

// Index of the view a draw's vertex belongs to, chosen when the material is
// built for a camera: with multiview both eyes run one draw and the builtin
// tells them apart (gl_ViewID_OVR on WebGL2; @builtin(view_index) on WebGPU,
// which three's WebGPU XR does not use yet), otherwise three draws each
// sub-camera of an ArrayCamera separately and sets cameraIndex.
class ViewIndexNode extends Node {
  constructor() {
    super("uint");
  }

  generate(builder: NodeBuilder): string {
    const b = builder as unknown as {
      camera?: { isMultiViewCamera?: boolean };
      renderer: { backend: { isWebGPUBackend?: boolean } };
      getBuiltin(name: string, property: string, type: string, stage: string): string;
    };
    if (b.camera?.isMultiViewCamera) {
      return b.renderer.backend.isWebGPUBackend ? b.getBuiltin("view_index", "viewIndex", "u32", "attribute") : "gl_ViewID_OVR";
    }
    return (TSL.cameraIndex as TslNode).build(builder, "uint");
  }
}

export const splatViewIndex: TslNode = TSL.nodeObject(new ViewIndexNode());
