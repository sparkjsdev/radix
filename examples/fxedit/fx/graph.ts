// Graphs of fx nodes as plain JSON, and what can be known about them without
// a GPU: validation, evaluation order, the params, the structure key. No
// three.js here (types only), so an editor or a worker can use it.
//
//   { version: 1, name?, description?,
//     nodes: { id: { type, inputs?: { name: value }, options?: { name: value }, position?, note? } },
//     links: [{ from: "node.output", to: "node.input" }],
//     params?: { "Label": "node.input" },
//     groups?: { name: { label?, description?, inputs: { port: InputDef }, outputs: { port: type },
//                        nodes, links } } }
//
// Node ids are letters, digits, _ and -. Every input that is not linked is a
// param (writable without rebuilding), except optional inputs without a value,
// which are absent. `params` names the knobs a UI should show.
//
// Groups are nodes made of nodes. A node of type "group.<name>" is an
// instance of groups[name]: its ports are the group's inputs and outputs.
// Inside, one "group.input" node gives the instance's inputs as outputs and
// one "group.output" node takes its outputs. Groups may use other groups (not
// themselves). Instances share their group; per-instance values are the
// instance's inputs. flattenGraph() expands every instance into plain nodes
// named "instance/inner", keeping the instance's id for a pass-through of
// its inputs, so the params of the top level keep their names.
import { PORT_COMPONENTS, type InputDef, type NodeDef, type NodeSource, type PortType, type Value } from "./types.js";

export interface GraphNode {
  type: string;
  inputs?: Record<string, Value>;
  options?: Record<string, string | number>;
  // Editor layout and caption, ignored here
  position?: [number, number];
  note?: string;
}

export interface GraphLink {
  from: string;
  to: string;
}

// Nodes and links: the top of a graph or the inside of a group
export interface GraphLevel {
  nodes: Record<string, GraphNode>;
  links: GraphLink[];
  params?: Record<string, string>;
}

export interface GraphGroup extends GraphLevel {
  label?: string;
  description?: string;
  inputs: Record<string, InputDef>;
  outputs: Record<string, PortType>;
}

export interface Graph extends GraphLevel {
  version: 1;
  name?: string;
  // What the graph does and where it comes from, for editors
  description?: string;
  source?: NodeSource;
  groups?: Record<string, GraphGroup>;
}

export interface NodeLookup {
  get(id: string): NodeDef | undefined;
}

// An unlinked, present input of a reachable node: a param named "node.input"
export interface GraphParam {
  node: string;
  input: string;
  name: string;
  type: PortType;
  value: Value;
  // The input's definition (ranges for a UI)
  def: InputDef;
}

export const GROUP_PREFIX = "group.";
export const GROUP_INPUT = "group.input";
export const GROUP_OUTPUT = "group.output";

const NODE_ID = /^[A-Za-z_][A-Za-z0-9_-]*$/;

// "node.port" -> [node, port]
export function splitPort(port: string): [string, string] {
  const dot = port.indexOf(".");
  return dot < 0 ? [port, ""] : [port.slice(0, dot), port.slice(dot + 1)];
}

// float broadcasts to vectors; color and vec3 are the same data
export function canLink(from: PortType, to: PortType) {
  if (from === to) {
    return true;
  }
  if (from === "float") {
    return to === "vec2" || to === "vec3" || to === "vec4" || to === "color";
  }
  return (from === "color" || from === "vec3") && (to === "color" || to === "vec3");
}

export function valueFits(type: PortType, value: Value) {
  if (type === "bool") {
    return typeof value === "boolean" || typeof value === "number";
  }
  if (type === "float") {
    return typeof value === "number" && Number.isFinite(value);
  }
  return Array.isArray(value) && value.length === PORT_COMPONENTS[type] && value.every((v) => Number.isFinite(v));
}

export function zeroValue(type: PortType): Value {
  return type === "bool" ? false : type === "float" ? 0 : new Array<number>(PORT_COMPONENTS[type]).fill(0);
}

// --- Groups ---

// The group an instance type names ("group.ripple" -> "ripple")
export function groupOf(type: string): string | undefined {
  return type.startsWith(GROUP_PREFIX) && type !== GROUP_INPUT && type !== GROUP_OUTPUT ? type.slice(GROUP_PREFIX.length).split(":")[0] : undefined;
}

// Whether a group uses a flag (time, click, camera) somewhere inside
function groupUses(registry: NodeLookup, groups: Record<string, GraphGroup>, name: string, flag: "time" | "click" | "camera", seen = new Set<string>()): boolean {
  if (seen.has(name) || !groups[name]) {
    return false;
  }
  seen.add(name);
  return Object.values(groups[name].nodes).some((node) => {
    const inner = groupOf(node.type);
    return inner ? groupUses(registry, groups, inner, flag, seen) : Boolean(registry.get(node.type)?.[flag]);
  });
}

const passThrough = (inputs: Record<string, unknown>) => ({ ...inputs }) as Record<string, never>;

// `registry` plus the node types groups make: instances ("group.<name>"),
// and inside group `scope` its boundary nodes. flattenGraph() adds the
// pass-throughs "group.<name>:in" and ":out".
export function withGroups<T extends NodeLookup>(registry: T, groups: Record<string, GraphGroup> | undefined, scope?: string): NodeLookup & { base: T } {
  const cache = new Map<string, NodeDef | undefined>();
  const make = (type: string): NodeDef | undefined => {
    const all = groups ?? {};
    const scoped = scope !== undefined ? all[scope] : undefined;
    if (type === GROUP_INPUT || type === GROUP_OUTPUT) {
      if (!scoped) {
        return undefined;
      }
      const input = type === GROUP_INPUT;
      return {
        id: type,
        label: input ? "Group inputs" : "Group outputs",
        description: input ? "What the group is given: its inputs, as outputs to wire inside" : "What the group gives back: wire results into its outputs",
        category: "group",
        inputs: input ? {} : Object.fromEntries(Object.entries(scoped.outputs).map(([name, portType]) => [name, { type: portType, default: zeroValue(portType) }])),
        outputs: input ? Object.fromEntries(Object.entries(scoped.inputs).map(([name, def]) => [name, def.type])) : {},
        build: () => ({}),
      };
    }
    const name = groupOf(type);
    if (name === undefined) {
      return registry.get(type);
    }
    const group = all[name];
    if (!group) {
      return undefined;
    }
    const suffix = type.slice(GROUP_PREFIX.length + name.length);
    const outputInputs = Object.fromEntries(Object.entries(group.outputs).map(([port, portType]) => [port, { type: portType, default: zeroValue(portType) }]));
    const flags = {
      time: groupUses(registry, all, name, "time"),
      click: groupUses(registry, all, name, "click"),
      camera: groupUses(registry, all, name, "camera"),
    };
    if (suffix === ":in" || suffix === ":out") {
      const inputs = suffix === ":in" ? group.inputs : outputInputs;
      return {
        id: type, label: group.label ?? name, category: "group", inputs,
        outputs: Object.fromEntries(Object.entries(inputs).map(([port, def]) => [port, def.type])),
        build: passThrough,
      };
    }
    if (suffix !== "") {
      return undefined;
    }
    return {
      id: type,
      label: group.label ?? name,
      description: group.description,
      category: "group",
      inputs: group.inputs,
      outputs: group.outputs,
      ...flags,
      build: () => {
        throw new Error(`fx group ${name}: flatten the graph before building it`);
      },
    };
  };
  return {
    base: registry,
    get(type: string) {
      if (!cache.has(type)) {
        cache.set(type, make(type));
      }
      return cache.get(type);
    },
  };
}

// The id of a group's boundary node of `type` (group.input or group.output)
export function boundaryNode(group: GraphGroup, type: string): string | undefined {
  return Object.keys(group.nodes).find((id) => group.nodes[id].type === type);
}

// Group `name` uses these groups, directly or deeper (itself only in a cycle)
export function groupsInside(groups: Record<string, GraphGroup>, name: string, found = new Set<string>()): Set<string> {
  for (const node of Object.values(groups[name]?.nodes ?? {})) {
    const inner = groupOf(node.type);
    if (inner !== undefined && !found.has(inner)) {
      found.add(inner);
      groupsInside(groups, inner, found);
    }
  }
  return found;
}

// Every instance of group `name` as its flat id ("a/b"), through nested groups
export function instancePaths(graph: Graph, name: string): string[] {
  const paths: string[] = [];
  const visit = (level: GraphLevel, prefix: string, depth: number) => {
    if (depth > 32) {
      return;
    }
    for (const [id, node] of Object.entries(level.nodes)) {
      const inner = groupOf(node.type);
      if (inner === undefined || !graph.groups?.[inner]) {
        continue;
      }
      if (inner === name) {
        paths.push(prefix + id);
      }
      visit(graph.groups[inner], `${prefix}${id}/`, depth + 1);
    }
  };
  visit(graph, "", 0);
  return paths;
}

// The graph with every group instance expanded (the graph must be valid).
// Instance m of group G becomes node m (type "group.G:in", m's inputs passed
// through), G's inner nodes as "m/inner" and G's output node as
// "m/<its id>" (type "group.G:out"); links into and out of m follow.
export function flattenGraph(graph: Graph): Graph {
  const groups = graph.groups ?? {};
  if (!Object.values(graph.nodes).some((node) => groupOf(node.type) !== undefined)) {
    return graph;
  }
  const nodes: Record<string, GraphNode> = {};
  const links: GraphLink[] = [];
  const expand = (level: GraphLevel, prefix: string, instance: string | undefined, groupName: string | undefined) => {
    for (const [id, node] of Object.entries(level.nodes)) {
      if (node.type === GROUP_INPUT) {
        continue;
      }
      const inner = groupOf(node.type);
      const flatId = prefix + id;
      if (node.type === GROUP_OUTPUT) {
        nodes[flatId] = { ...structuredClone(node), type: `${GROUP_PREFIX}${groupName}:out` };
      } else if (inner !== undefined) {
        nodes[flatId] = { ...structuredClone(node), type: `${GROUP_PREFIX}${inner}:in` };
        expand(groups[inner], `${flatId}/`, flatId, inner);
      } else {
        nodes[flatId] = structuredClone(node);
      }
    }
    for (const link of level.links) {
      const [fromNode, fromPort] = splitPort(link.from);
      const fromType = level.nodes[fromNode]?.type;
      const fromGroup = fromType && groupOf(fromType);
      let from: string;
      if (fromType === GROUP_INPUT) {
        from = `${instance}.${fromPort}`;
      } else if (fromGroup !== undefined && fromGroup !== "") {
        from = `${prefix}${fromNode}/${boundaryNode(groups[fromGroup], GROUP_OUTPUT)}.${fromPort}`;
      } else {
        from = prefix + link.from;
      }
      links.push({ from, to: prefix + link.to });
    }
  };
  expand(graph, "", undefined, undefined);
  return { ...graph, nodes, links };
}

// "node.port" at the level reached through `path` (instance ids from the
// top) as a port of the flat graph: prefixed, and an instance's output read
// from its group's output node
export function flatPort(graph: Graph, path: string[], port: string): string {
  let level: GraphLevel = graph;
  for (const id of path) {
    level = graph.groups?.[groupOf(level.nodes[id]?.type ?? "") ?? ""] ?? level;
  }
  const prefix = path.length ? `${path.join("/")}/` : "";
  const [node, name] = splitPort(port);
  const inner = groupOf(level.nodes[node]?.type ?? "");
  const group = inner !== undefined ? graph.groups?.[inner] : undefined;
  if (group) {
    return `${prefix}${node}/${boundaryNode(group, GROUP_OUTPUT)}.${name}`;
  }
  return prefix + port;
}

// --- Validation ---

// Every problem with the graph, as messages (empty: valid). Messages about
// a group's inside start with "Group <name>: ".
export function validate(graph: Graph, registry: NodeLookup): string[] {
  const errors: string[] = [];
  if (graph.version !== 1) {
    errors.push(`Unsupported graph version ${String(graph.version)}`);
  }
  const groups = graph.groups ?? {};
  for (const [name, group] of Object.entries(groups)) {
    const say = (message: string) => errors.push(`Group ${name}: ${message}`);
    if (!NODE_ID.test(name) || name === "input" || name === "output") {
      say("use letters, digits, _ and - (not input or output) for group names");
    }
    if (groupsInside(groups, name).has(name)) {
      say("contains itself");
      continue;
    }
    for (const [port, def] of Object.entries(group.inputs ?? {})) {
      if (!NODE_ID.test(port) || !(def.type in PORT_COMPONENTS) || !valueFits(def.type, def.default)) {
        say(`bad input ${port}`);
      }
    }
    for (const [port, type] of Object.entries(group.outputs ?? {})) {
      if (!NODE_ID.test(port) || !(type in PORT_COMPONENTS)) {
        say(`bad output ${port}`);
      }
    }
    for (const type of [GROUP_INPUT, GROUP_OUTPUT]) {
      const count = Object.values(group.nodes ?? {}).filter((node) => node.type === type).length;
      if (count !== 1) {
        say(`needs one ${type} node (found ${count})`);
      }
    }
    validateLevel(group, withGroups(registry, groups, name), false).forEach(say);
  }
  errors.push(...validateLevel(graph, withGroups(registry, groups), true));
  return errors;
}

// One level: the top (one output node, params) or a group's inside (no
// output node; its boundary nodes resolve through `lookup`)
function validateLevel(level: GraphLevel, lookup: NodeLookup, top: boolean): string[] {
  const errors: string[] = [];
  const defs = new Map<string, NodeDef>();
  for (const [id, node] of Object.entries(level.nodes ?? {})) {
    if (!NODE_ID.test(id)) {
      errors.push(`Node id "${id}": use letters, digits, _ and -`);
    }
    const def = lookup.get(node.type);
    if (!def) {
      errors.push(`Node ${id}: unknown type ${node.type}`);
      continue;
    }
    defs.set(id, def);
    for (const [name, value] of Object.entries(node.options ?? {})) {
      const option = def.options?.[name];
      if (!option) {
        errors.push(`Node ${id}: unknown option ${name}`);
      } else if (typeof value !== typeof option.default || (option.choices && !option.choices.includes(String(value)))) {
        errors.push(`Node ${id}: bad value ${String(value)} for option ${name}`);
      }
    }
    for (const [name, value] of Object.entries(node.inputs ?? {})) {
      const input = def.inputs[name];
      if (!input) {
        errors.push(`Node ${id}: unknown input ${name}`);
      } else if (!valueFits(input.type, value)) {
        errors.push(`Node ${id}: value ${JSON.stringify(value)} does not fit input ${name} (${input.type})`);
      }
    }
  }

  const outputs = [...defs].filter(([, def]) => def.output).map(([id]) => id);
  if (top && outputs.length !== 1) {
    errors.push(`A graph needs exactly one output node (found ${outputs.length})`);
  } else if (!top && outputs.length > 0) {
    errors.push(`Node ${outputs[0]}: the output node belongs at the top, not in a group`);
  }

  const linked = new Set<string>();
  for (const link of level.links ?? []) {
    const [fromNode, fromPort] = splitPort(link.from);
    const [toNode, toPort] = splitPort(link.to);
    const fromType = defs.get(fromNode)?.outputs[fromPort];
    const toType = defs.get(toNode)?.inputs[toPort]?.type;
    if (!fromType) {
      errors.push(`Link ${link.from} -> ${link.to}: no output ${link.from}`);
    } else if (!toType) {
      errors.push(`Link ${link.from} -> ${link.to}: no input ${link.to}`);
    } else if (!canLink(fromType, toType)) {
      errors.push(`Link ${link.from} -> ${link.to}: ${fromType} does not connect to ${toType}`);
    }
    if (linked.has(link.to)) {
      errors.push(`Input ${link.to} has more than one link`);
    }
    linked.add(link.to);
  }

  const cycle = findCycle(level);
  if (cycle) {
    errors.push(`Cycle through ${cycle.join(" -> ")}`);
  }

  for (const [label, port] of Object.entries(level.params ?? {})) {
    const [node, input] = splitPort(port);
    const def = defs.get(node)?.inputs[input];
    if (!top) {
      errors.push(`Param "${label}": groups advertise knobs as their inputs`);
    } else if (!def) {
      errors.push(`Param "${label}": no input ${port}`);
    } else if (linked.has(port)) {
      errors.push(`Param "${label}": ${port} is linked`);
    } else if (def.optional && level.nodes[node].inputs?.[input] === undefined) {
      errors.push(`Param "${label}": optional input ${port} needs a value in the graph`);
    }
  }
  return errors;
}

function findCycle(level: GraphLevel): string[] | undefined {
  const upstream = new Map<string, string[]>();
  for (const link of level.links ?? []) {
    const to = splitPort(link.to)[0];
    upstream.set(to, [...(upstream.get(to) ?? []), splitPort(link.from)[0]]);
  }

  const state = new Map<string, "visiting" | "done">();
  const path: string[] = [];
  const visit = (id: string): string[] | undefined => {
    if (state.get(id) === "done") {
      return undefined;
    }
    if (state.get(id) === "visiting") {
      return [...path.slice(path.indexOf(id)), id];
    }
    state.set(id, "visiting");
    path.push(id);
    for (const from of upstream.get(id) ?? []) {
      const cycle = visit(from);
      if (cycle) {
        return cycle;
      }
    }
    path.pop();
    state.set(id, "done");
    return undefined;
  };
  for (const id of Object.keys(level.nodes ?? {})) {
    const cycle = visit(id);
    if (cycle) {
      return cycle;
    }
  }
  return undefined;
}

// --- The built program (valid graphs; groups are flattened first) ---

// Link feeding each linked input: "node.input" -> "node.output"
export function linkSources(level: GraphLevel): Map<string, string> {
  return new Map(level.links.map((link) => [link.to, link.from]));
}

// Nodes the output depends on, each after its inputs, in the flat graph
export function evaluationOrder(graph: Graph, registry: NodeLookup): string[] {
  const flat = flattenGraph(graph);
  const lookup = withGroups(registry, graph.groups);
  const sources = linkSources(flat);
  const order: string[] = [];
  const seen = new Set<string>();
  const visit = (id: string) => {
    if (seen.has(id)) {
      return;
    }
    seen.add(id);
    for (const input of Object.keys(lookup.get(flat.nodes[id].type)!.inputs)) {
      const from = sources.get(`${id}.${input}`);
      if (from) {
        visit(splitPort(from)[0]);
      }
    }
    order.push(id);
  };
  visit(outputNode(flat, lookup));
  return order;
}

export function outputNode(graph: GraphLevel, registry: NodeLookup): string {
  return Object.keys(graph.nodes).find((id) => registry.get(graph.nodes[id].type)?.output)!;
}

// Whether an input of a reachable node is absent: optional, unlinked, no value
export function isAbsent(graph: GraphLevel, def: NodeDef, node: string, input: string, sources = linkSources(graph)) {
  return def.inputs[input].optional === true && !sources.has(`${node}.${input}`) && graph.nodes[node].inputs?.[input] === undefined;
}

// The params of a valid graph (flat names), in evaluation order
export function graphParams(graph: Graph, registry: NodeLookup): GraphParam[] {
  const flat = flattenGraph(graph);
  const lookup = withGroups(registry, graph.groups);
  const sources = linkSources(flat);
  const params: GraphParam[] = [];
  for (const node of evaluationOrder(graph, registry)) {
    const def = lookup.get(flat.nodes[node].type)!;
    for (const [input, inputDef] of Object.entries(def.inputs)) {
      if (sources.has(`${node}.${input}`) || isAbsent(flat, def, node, input, sources)) {
        continue;
      }
      const value = flat.nodes[node].inputs?.[input] ?? inputDef.default;
      params.push({ node, input, name: `${node}.${input}`, type: inputDef.type, value: structuredClone(value), def: inputDef });
    }
  }
  return params;
}

// Structure of a valid graph as a short string: reachable nodes, their types
// and options, links and which inputs are absent (of the flat graph). Values
// are left out, so every instance of a graph shares one program; node ids
// are in, because the params are named after them.
export function graphKey(graph: Graph, registry: NodeLookup): string {
  const flat = flattenGraph(graph);
  const lookup = withGroups(registry, graph.groups);
  const sources = linkSources(flat);
  const parts = evaluationOrder(graph, registry).map((node) => {
    const def = lookup.get(flat.nodes[node].type)!;
    const options = Object.keys(def.options ?? {}).sort().map((name) => `${name}=${flat.nodes[node].options?.[name] ?? def.options![name].default}`);
    const inputs = Object.keys(def.inputs).map((input) => {
      const from = sources.get(`${node}.${input}`);
      return from ? `${input}<${from}` : isAbsent(flat, def, node, input, sources) ? `${input}-` : input;
    });
    const ports = def.category === "group" ? `{${Object.entries(def.inputs).map(([p, d]) => `${p}:${d.type}`).join(",")}}` : "";
    return `${node}:${def.id}${ports}(${options.join(",")})[${inputs.join(",")}]`;
  });
  return hash53(parts.join(";"));
}

// cyrb53 (public domain): 53-bit string hash as hex
function hash53(text: string) {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
}
