// What flows where: depths for the flow preview, the nodes an output depends
// on, and probe graphs, which show one port's value as the splats' color.
import {
  boundaryNode, GROUP_OUTPUT, groupOf, splitPort, withGroups,                                              
} from "./fx/index.js";

// Nodes feeding `ids`, themselves included
export function upstreamOf(level            , ids          ) {
  const into = new Map                  ();
  for (const link of level.links) {
    const to = splitPort(link.to)[0];
    into.set(to, [...(into.get(to) ?? []), splitPort(link.from)[0]]);
  }
  const seen = new Set        ();
  const stack = [...ids];
  while (stack.length > 0) {
    const id = stack.pop() ;
    if (!seen.has(id) && level.nodes[id]) {
      seen.add(id);
      stack.push(...(into.get(id) ?? []));
    }
  }
  return seen;
}

// Longest chain of links from a source to each node (0 for nodes nothing
// feeds); a cycle stops counting where it closes
export function depths(level            ) {
  const into = new Map                  ();
  for (const link of level.links) {
    const to = splitPort(link.to)[0];
    into.set(to, [...(into.get(to) ?? []), splitPort(link.from)[0]]);
  }
  const depth = new Map                ();
  const visiting = new Set        ();
  const visit = (id        )         => {
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

export function outputNodes(level            , registry            ) {
  return Object.keys(level.nodes).filter((id) => registry.get(level.nodes[id].type)?.output);
}

// Where values end up at a level: the output node, or a group's outputs
export function flowRoots(level            , registry            ) {
  return Object.keys(level.nodes).filter((id) => level.nodes[id].type === GROUP_OUTPUT || registry.get(level.nodes[id].type)?.output);
}

// A port inside a group (reached through `path`, instance ids from the top)
// wired out through every group on the way as a new output, so a probe can
// read it at the top. The copy of the graph and the port there.
export function exposePort(graph       , registry            , path          , port        )                                             {
  if (path.length === 0) {
    return { graph, port };
  }
  const copy = structuredClone(graph);
  const names           = [];
  let level             = copy;
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
    const group = copy.groups [names[i]];
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

// Probe viewer: floats through a blue-purple-orange ramp (period 2, so
// -1 and 1 match), vectors from [-1, 1] to [0, 1], bools green (true) or
// red, colors as they are
const RAMP = { a: [0.5, 0.5, 0.5], b: [0.5, 0.5, 0.5], c: [0.5, 0.5, 0.5], d: [0.5, 0.25, 0] };

// `graph` with `port` ("node.output" at the top) driving the output's rgb
// instead; offset, scale and keep stay (a probed bool shows every splat)
export function probeGraph(graph       , registry            , port        )                    {
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
  const link = (from        , to        ) => probe.links.push({ from, to });
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


//# sourceURL=examples/fxedit/preview.ts