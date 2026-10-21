// Node definitions: a TSL building block plus the metadata an editor needs
import type { SplatNode, TslNode } from "@sparkjsdev/radix";

// color is a vec3 shown with a color picker, and a bool param a float uniform, true above 0.5
export type PortType = "float" | "vec2" | "vec3" | "vec4" | "color" | "bool";

export type Value = number | number[] | boolean;

export interface InputDef {
  type: PortType;
  default: Value;
  // Absent (build sees undefined) unless linked or given a value. Other unlinked inputs are params.
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

// effect: a whole effect as one node, group: group instances and boundary nodes
export type NodeCategory = "input" | "field" | "math" | "color" | "effect" | "group" | "splat";

export interface NodeSource {
  name: string;
  url: string;
  license: string;
}

export interface BuildContext {
  // The splat as it entered the graph
  source: SplatNode;
  // The splat var the output node writes
  splat: SplatNode;
  // The stored splat's index (uint)
  index: TslNode;
  // Seconds, for nodes whose time flag is set
  time: TslNode;
  // The last click's point in the modifier's space and seconds since it, for
  // nodes whose click flag is set
  click: { point: TslNode; age: TslNode };
  // The camera for nodes whose camera flag is set, pixelSize a pixel's world size at unit depth
  camera: { position: TslNode; forward: TslNode; pixelSize: TslNode };
  option(name: string): string | number;
}

export interface NodeDef {
  // Stable, namespaced: "field.noise"
  id: string;
  label: string;
  // One line for the palette and tooltips
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
  // The graph's one output node, which writes the splat
  output?: boolean;
  source?: NodeSource;
  build(inputs: Record<string, TslNode>, ctx: BuildContext): Record<string, TslNode>;
}

// Components of a port type's values (bool is one)
export const PORT_COMPONENTS: Record<PortType, number> = { float: 1, bool: 1, vec2: 2, vec3: 3, color: 3, vec4: 4 };
