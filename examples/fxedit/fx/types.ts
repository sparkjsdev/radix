// Node definitions: a TSL building block plus the metadata an editor needs
// (typed ports with defaults and UI ranges, options, attribution). A graph
// (graph.ts) wires nodes by id; buildGraphModifier (graphModifier.ts)
// builds it into a Radix SplatModifier.
import type { SplatNode, TslNode } from "@sparkjsdev/radix";

// Port types. color is a vec3 shown with a color picker; a bool param is a
// float uniform (above 0.5: true).
export type PortType = "float" | "vec2" | "vec3" | "vec4" | "color" | "bool";

export type Value = number | number[] | boolean;

export interface InputDef {
  type: PortType;
  default: Value;
  // Optional inputs are absent (build sees undefined) unless linked or given
  // a value in the graph; others become a param when unlinked
  optional?: boolean;
  // UI hints only
  min?: number;
  max?: number;
  step?: number;
  label?: string;
}

// Choices that change the program (enums, loop counts); part of the key
export interface OptionDef {
  default: string | number;
  choices?: string[];
  min?: number;
  max?: number;
}

// effect: whole effects ported as one node (macro nodes); group: instances
// of a graph's groups and their boundary nodes (graph.ts)
export type NodeCategory = "input" | "field" | "math" | "color" | "effect" | "group" | "splat";

export interface NodeSource {
  name: string;
  url: string;
  license: string;
}

export interface BuildContext {
  // Copy of the splat as it entered the graph (read it through input nodes)
  source: SplatNode;
  // The splat var the output node writes
  splat: SplatNode;
  // The stored splat's index (uint)
  index: TslNode;
  // Seconds (FxInputs.time), for nodes with `time: true`
  time: TslNode;
  // The last click (FxInputs.click) for nodes with `click: true`: its point
  // in the modifier's space and seconds since it
  click: { point: TslNode; age: TslNode };
  // The viewing camera (FxInputs.camera) for nodes with `camera: true`;
  // pixelSize: world size of one pixel at unit depth
  camera: { position: TslNode; forward: TslNode; pixelSize: TslNode };
  option(name: string): string | number;
}

export interface NodeDef {
  // Stable, namespaced: "field.noise"
  id: string;
  label: string;
  // One line for editors (palette, tooltips)
  description?: string;
  category: NodeCategory;
  inputs: Record<string, InputDef>;
  outputs: Record<string, PortType>;
  options?: Record<string, OptionDef>;
  // Reads ctx.time
  time?: boolean;
  // Reads ctx.click
  click?: boolean;
  // Reads ctx.camera (view-dependent: exact for one view per frame)
  camera?: boolean;
  // The graph's one output node (writes the splat; may return `keep`)
  output?: boolean;
  source?: NodeSource;
  build(inputs: Record<string, TslNode>, ctx: BuildContext): Record<string, TslNode>;
}

// Components of a port type's values (bool is one)
export const PORT_COMPONENTS: Record<PortType, number> = { float: 1, bool: 1, vec2: 2, vec3: 3, color: 3, vec4: 4 };
