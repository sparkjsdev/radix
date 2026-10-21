// The flow preview's depths and probe graphs, which show a port's value as color
import {
  boundaryNode, GROUP_OUTPUT, groupOf, splitPort, withGroups, type Graph, type GraphLevel, type NodeLookup,
} from "./fx/index.js";

// Nodes feeding ids, themselves included
export function upstreamOf(level: GraphLevel, ids: string[]) {
  const into = new Map<string, string[]>();
  for (const link of level.links) {
    const to = splitPort(link.to)[0];
    into.set(to, [...(into.get(to) ?? []), splitPort(link.from)[0]]);
  }
  const seen = new Set<string>();
  const stack = [...ids];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (!seen.has(id) && level.nodes[id]) {
      seen.add(id);
      stack.push(...(into.get(id) ?? []));
    }
  }
  return seen;
}

// Longest chain of links into each node, 0 for sources. A cycle stops where it closes.
export function depths(level: GraphLevel) {
  const into = new Map<string, string[]>();
  for (const link of level.links) {
    const to = splitPort(link.to)[0];
    into.set(to, [...(into.get(to) ?? []), splitPort(link.from)[0]]);
  }
  const depth = new Map<string, number>();
  const visiting = new Set<string>();
  const visit = (id: string): number => {
    const known = depth.get(id);
    if (known !== undefined) {
      return known;
    }
    if (visiting.has(id)) {
      return 0;
    }
    visiting.add(id);
    const d = Math.max(-1, ...(into.get(id) ?? []).filter((from) => level.nodes[from]).map(visit)) + 1;
    visiting.delete(id);
    depth.set(id, d);
    return d;
  };
  Object.keys(level.nodes).forEach(visit);
  return depth;
}

export function outputNodes(level: GraphLevel, registry: NodeLookup) {
  return Object.keys(level.nodes).filter((id) => registry.get(level.nodes[id].type)?.output);
}

// Where values end up at a level: the output node, or a group's outputs
export function flowRoots(level: GraphLevel, registry: NodeLookup) {
  return Object.keys(level.nodes).filter((id) => level.nodes[id].type === GROUP_OUTPUT || registry.get(level.nodes[id].type)?.output);
}

// A copy of the graph with a port inside a group (path: instance ids from the
// top) wired out through every group as a new output, so a probe can read it
export function exposePort(graph: Graph, registry: NodeLookup, path: string[], port: string): { graph: Graph; port: string } | undefined {
  if (path.length === 0) {
    return { graph, port };
  }
  const copy = structuredClone(graph);
  const names: string[] = [];
  let level: GraphLevel = copy;
  for (const id of path) {
    const name = groupOf(level.nodes[id]?.type ?? "");
    const group = name !== undefined ? copy.groups?.[name] : undefined;
    if (!group || name === undefined) {
      return undefined;
    }
    names.push(name);
    level = group;
  }
  const [node, output] = splitPort(port);
  const type = withGroups(registry, copy.groups, names[names.length - 1]).get(level.nodes[node]?.type ?? "")?.outputs[output];
  if (!type) {
    return undefined;
  }
  let current = port;
  for (let i = path.length - 1; i >= 0; i -= 1) {
    const group = copy.groups![names[i]];
    let name = "__probe";
    for (let n = 2; group.outputs[name]; n += 1) {
      name = `__probe${n}`;
    }
    group.outputs[name] = type;
    group.links.push({ from: current, to: `${boundaryNode(group, GROUP_OUTPUT)}.${name}` });
    current = `${path[i]}.${name}`;
  }
  return { graph: copy, port: current };
}

// The float probe's ramp, of period 2 so -1 and 1 match
const RAMP = { a: [0.5, 0.5, 0.5], b: [0.5, 0.5, 0.5], c: [0.5, 0.5, 0.5], d: [0.5, 0.25, 0] };

// graph with port ("node.output" at the top) as the output's rgb. A probed bool
// also shows every splat.
export function probeGraph(graph: Graph, registry: NodeLookup, port: string): Graph | undefined {
  const lookup = withGroups(registry, graph.groups);
  const [node, output] = splitPort(port);
  const type = graph.nodes[node] && lookup.get(graph.nodes[node].type)?.outputs[output];
  const outs = outputNodes(graph, lookup);
  if (!type || outs.length !== 1) {
    return undefined;
  }
  const out = outs[0];
  const probe = structuredClone(graph);
  probe.name = `${graph.name ?? "graph"} probe ${port}`;
  delete probe.params;
  probe.links = probe.links.filter((link) => link.to !== `${out}.rgb` && !(type === "bool" && link.to === `${out}.keep`));
  const link = (from: string, to: string) => probe.links.push({ from, to });
  switch (type) {
    case "float":
      probe.nodes.__probe = { type: "color.cosinePalette", inputs: structuredClone(RAMP) };
      link(port, "__probe.t");
      break;
    case "bool":
      probe.nodes.__probePick = { type: "math.select", inputs: { a: 0, b: 1 } };
      probe.nodes.__probe = { type: "color.tint", inputs: { rgb: [1, 0.12, 0.18], color: [0.2, 1, 0.4], intensity: 1 } };
      link(port, "__probePick.condition");
      link("__probePick.value", "__probe.amount");
      break;
    case "vec3":
      probe.nodes.__probeHalf = { type: "math.vec3Scale", inputs: { s: 0.5 } };
      probe.nodes.__probe = { type: "math.vec3Add", inputs: { b: [0.5, 0.5, 0.5] } };
      link(port, "__probeHalf.v");
      link("__probeHalf.value", "__probe.a");
      break;
    case "color":
      link(port, `${out}.rgb`);
      return probe;
    default:
      return undefined;
  }
  link("__probe.value", `${out}.rgb`);
  return probe;
}
