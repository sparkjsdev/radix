// The edited graph: edit operations that keep it well-formed where they can
// (one link per input, no cycles, labelled params only on unlinked inputs),
// an undo history of snapshots and change events. A "value" change is a
// param write (no rebuild), "structure" needs a new GraphModifier, "layout"
// only moved nodes.
//
// Edits apply to the current level: the top of the graph, or the inside of
// a group reached through `path` (instance ids from the top). Groups are
// shared, so an edit inside one shows in every instance.
import {
  boundaryNode, canLink, GROUP_INPUT, GROUP_OUTPUT, GROUP_PREFIX, groupOf, groupsInside, instancePaths, linkSources, splitPort, validate,
  valueFits, withGroups, zeroValue, type Graph, type GraphGroup, type GraphLevel, type GraphNode, type NodeDef, type NodeLookup,
  type PortType, type Value,
} from "./fx/index.js";

export interface EditorRegistry extends NodeLookup {
  list(): NodeDef[];
}

export type ChangeKind = "structure" | "value" | "layout";

export interface Change {
  kind: ChangeKind;
  // A new graph, a step through the history, or into / out of a group (else an edit)
  reason?: "load" | "history" | "enter" | "exit";
  // For "value": the param "node.input" at the level, its names in the
  // flat graph (one per instance of the group) and its new value
  param?: string;
  params?: string[];
  value?: Value;
}

const HISTORY = 200;
// A group's input ports on its boundary node: drop a wire on it to add one
export const NEW_PORT = "+";

const sanitize = (text: string) => text.replace(/[^A-Za-z0-9_-]/g, "").replace(/^[^A-Za-z_]+/, "") || "port";
// "Noise scale" -> "noiseScale"
const camel = (text: string) => sanitize(text.trim().split(/\s+/).map((word, i) => (i === 0 ? word.charAt(0).toLowerCase() + word.slice(1) : word.charAt(0).toUpperCase() + word.slice(1))).join(""));

export class GraphDoc {
  graph: Graph;
  path: string[] = [];
  readonly registry: EditorRegistry;
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  // Edits with the same gesture key share one undo step (a slider drag)
  private gesture?: string;
  private listeners = new Set<(change: Change) => void>();
  private cachedLookup?: NodeLookup;

  constructor(registry: EditorRegistry, graph: Graph) {
    this.registry = registry;
    this.graph = structuredClone(graph);
  }

  on(listener: (change: Change) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(change: Change) {
    this.cachedLookup = undefined;
    this.listeners.forEach((listener) => listener(change));
  }

  load(graph: Graph) {
    this.graph = structuredClone(graph);
    this.graph.links ??= [];
    this.path = [];
    this.undoStack = [];
    this.redoStack = [];
    this.gesture = undefined;
    this.emit({ kind: "structure", reason: "load" });
  }

  // --- Levels ---

  // The group whose inside is shown (undefined: the top)
  get groupName(): string | undefined {
    let name: string | undefined;
    let level: GraphLevel = this.graph;
    for (const id of this.path) {
      name = groupOf(level.nodes[id]?.type ?? "");
      const group = name !== undefined ? this.graph.groups?.[name] : undefined;
      if (!group) {
        return undefined;
      }
      level = group;
    }
    return name;
  }

  get group(): GraphGroup | undefined {
    const name = this.groupName;
    return name !== undefined ? this.graph.groups?.[name] : undefined;
  }

  // The nodes and links being edited
  get level(): GraphLevel {
    return this.group ?? this.graph;
  }

  // Node types at this level (groups and, inside one, its boundary nodes)
  get lookup(): NodeLookup {
    this.cachedLookup ??= withGroups(this.registry, this.graph.groups, this.groupName);
    return this.cachedLookup;
  }

  // Groups that can be placed here (not this group or one that contains it)
  placeableGroups(): string[] {
    const here = this.groupName;
    const groups = this.graph.groups ?? {};
    return Object.keys(groups).filter((name) => here === undefined || (name !== here && !groupsInside(groups, name).has(here)));
  }

  // What the palette offers here
  paletteDefs(): NodeDef[] {
    const groups = this.placeableGroups().map((name) => this.lookup.get(`${GROUP_PREFIX}${name}`)!).filter(Boolean);
    return [...this.registry.list(), ...groups];
  }

  isGroupNode(id: string) {
    const name = groupOf(this.level.nodes[id]?.type ?? "");
    return name !== undefined && Boolean(this.graph.groups?.[name]);
  }

  enter(id: string) {
    if (!this.isGroupNode(id)) {
      return false;
    }
    this.path = [...this.path, id];
    this.gesture = undefined;
    this.emit({ kind: "structure", reason: "enter" });
    return true;
  }

  // Up to `depth` levels from the top (default: one level up)
  exit(depth = this.path.length - 1) {
    if (depth < 0 || depth >= this.path.length) {
      return false;
    }
    this.path = this.path.slice(0, depth);
    this.gesture = undefined;
    this.emit({ kind: "structure", reason: "exit" });
    return true;
  }

  // A param at this level as flat names, one per instance of the group
  flatParams(param: string): string[] {
    const name = this.groupName;
    return name === undefined ? [param] : instancePaths(this.graph, name).map((prefix) => `${prefix}/${param}`);
  }

  get canUndo() {
    return this.undoStack.length > 0;
  }

  get canRedo() {
    return this.redoStack.length > 0;
  }

  errors() {
    return validate(this.graph, this.registry);
  }

  def(id: string): NodeDef | undefined {
    const node = this.level.nodes[id];
    return node && this.lookup.get(node.type);
  }

  // Linked inputs: "node.input" -> "node.output"
  sources() {
    return linkSources(this.level);
  }

  // The output "node.port" feeding an input, if linked
  sourceOf(input: string) {
    return this.level.links.find((link) => link.to === input)?.from;
  }

  // Optional, unlinked and without a value: build sees nothing
  isAbsent(node: string, input: string) {
    const def = this.def(node)?.inputs[input];
    return def?.optional === true && !this.sourceOf(`${node}.${input}`) && this.level.nodes[node].inputs?.[input] === undefined;
  }

  // Undo snapshot, unless this edit continues the gesture `key`
  private record(key?: string) {
    if (key !== undefined && key === this.gesture) {
      return;
    }
    this.gesture = key;
    this.undoStack.push(JSON.stringify({ graph: this.graph, path: this.path }));
    if (this.undoStack.length > HISTORY) {
      this.undoStack.shift();
    }
    this.redoStack = [];
  }

  endGesture() {
    this.gesture = undefined;
  }

  undo() {
    return this.travel(this.undoStack, this.redoStack);
  }

  redo() {
    return this.travel(this.redoStack, this.undoStack);
  }

  private travel(from: string[], to: string[]) {
    const snapshot = from.pop();
    if (!snapshot) {
      return false;
    }
    to.push(JSON.stringify({ graph: this.graph, path: this.path }));
    const state = JSON.parse(snapshot) as { graph: Graph; path: string[] };
    this.graph = state.graph;
    this.path = state.path;
    this.gesture = undefined;
    this.emit({ kind: "structure", reason: "history" });
    return true;
  }

  newId(type: string, taken: Record<string, unknown> = this.level.nodes) {
    const base = sanitize(type.split(".").pop() ?? "node") || "node";
    if (!taken[base]) {
      return base;
    }
    for (let i = 2; ; i += 1) {
      if (!taken[`${base}${i}`]) {
        return `${base}${i}`;
      }
    }
  }

  addNode(type: string, position: [number, number]) {
    this.record();
    const id = this.newId(type);
    this.level.nodes[id] = { type, position: [Math.round(position[0]), Math.round(position[1])] };
    this.emit({ kind: "structure" });
    return id;
  }

  removeNodes(ids: Iterable<string>) {
    const level = this.level;
    // A group keeps its boundary nodes
    const gone = new Set([...ids].filter((id) => level.nodes[id] && level.nodes[id].type !== GROUP_INPUT && level.nodes[id].type !== GROUP_OUTPUT));
    if (gone.size === 0) {
      return;
    }
    this.record();
    gone.forEach((id) => delete level.nodes[id]);
    level.links = level.links.filter((link) => !gone.has(splitPort(link.from)[0]) && !gone.has(splitPort(link.to)[0]));
    if (level.params) {
      level.params = Object.fromEntries(Object.entries(level.params).filter(([, port]) => !gone.has(splitPort(port)[0])));
    }
    this.emit({ kind: "structure" });
  }

  // Why output `from` cannot feed input `to` (undefined: it can). The new
  // port of a group's boundary node takes any type.
  canConnect(from: string, to: string): string | undefined {
    const [fromNode, fromPort] = splitPort(from);
    const [toNode, toPort] = splitPort(to);
    const newIn = fromPort === NEW_PORT && this.level.nodes[fromNode]?.type === GROUP_INPUT;
    const newOut = toPort === NEW_PORT && this.level.nodes[toNode]?.type === GROUP_OUTPUT;
    const fromType = newIn ? undefined : this.def(fromNode)?.outputs[fromPort];
    const toType = newOut ? undefined : this.def(toNode)?.inputs[toPort]?.type;
    if ((!fromType && !newIn) || (!toType && !newOut) || (newIn && newOut)) {
      return "No such port";
    }
    if (fromNode === toNode) {
      return "A node cannot feed itself";
    }
    if (fromType && toType && !canLink(fromType, toType)) {
      return `${fromType} does not fit ${toType}`;
    }
    if (this.upstream(fromNode).has(toNode)) {
      return "That would make a loop";
    }
    return undefined;
  }

  // Nodes `id` depends on, itself included
  upstream(id: string) {
    const seen = new Set<string>();
    const visit = (node: string) => {
      if (seen.has(node)) {
        return;
      }
      seen.add(node);
      for (const link of this.level.links) {
        if (splitPort(link.to)[0] === node) {
          visit(splitPort(link.from)[0]);
        }
      }
    };
    visit(id);
    return seen;
  }

  // Link output `from` to input `to`, replacing what fed it; the error if
  // not. A wire to a boundary node's new port first adds that group port.
  link(from: string, to: string): string | undefined {
    const error = this.canConnect(from, to);
    if (error) {
      return error;
    }
    if (this.sourceOf(to) === from) {
      return undefined;
    }
    this.record();
    const [fromNode, fromPort] = splitPort(from);
    const [toNode, toPort] = splitPort(to);
    const group = this.group;
    if (group && fromPort === NEW_PORT) {
      const def = this.def(toNode)!.inputs[toPort];
      const value = this.level.nodes[toNode].inputs?.[toPort] ?? def.default;
      from = `${fromNode}.${this.addPort(group, "in", toPort, def.type, value, def)}`;
    }
    if (group && toPort === NEW_PORT) {
      const type = this.def(fromNode)!.outputs[fromPort];
      to = `${toNode}.${this.addPort(group, "out", fromPort, type)}`;
    }
    const level = this.level;
    level.links = level.links.filter((link) => link.to !== to);
    level.links.push({ from, to });
    if (level.params) {
      level.params = Object.fromEntries(Object.entries(level.params).filter(([, port]) => port !== to));
    }
    this.emit({ kind: "structure" });
    return undefined;
  }

  // Add a port to a group's interface (no record or emit); its name
  private addPort(group: GraphGroup, dir: "in" | "out", name: string, type: PortType, value?: Value, like?: { min?: number; max?: number; step?: number }) {
    const ports = dir === "in" ? group.inputs : group.outputs;
    const port = this.newId(sanitize(name), ports);
    if (dir === "in") {
      group.inputs[port] = { type, default: structuredClone(value ?? zeroValue(type)), min: like?.min, max: like?.max, step: like?.step };
    } else {
      group.outputs[port] = type;
    }
    return port;
  }

  // Take a port off the current group's interface, with every wire and
  // value that used it, here and on every instance
  removeGroupPort(dir: "in" | "out", port: string) {
    const name = this.groupName;
    const group = this.group;
    if (name === undefined || !group || !(dir === "in" ? group.inputs[port] : group.outputs[port])) {
      return;
    }
    this.record();
    if (dir === "in") {
      delete group.inputs[port];
    } else {
      delete group.outputs[port];
    }
    const boundary = boundaryNode(group, dir === "in" ? GROUP_INPUT : GROUP_OUTPUT)!;
    const inside = `${boundary}.${port}`;
    group.links = group.links.filter((link) => link.from !== inside && link.to !== inside);
    if (dir === "out") {
      const node = group.nodes[boundary];
      if (node.inputs) {
        delete node.inputs[port];
      }
    }
    for (const level of [this.graph, ...Object.values(this.graph.groups ?? {})]) {
      for (const [id, node] of Object.entries(level.nodes)) {
        if (node.type !== `${GROUP_PREFIX}${name}`) {
          continue;
        }
        const outside = `${id}.${port}`;
        level.links = level.links.filter((link) => (dir === "in" ? link.to !== outside : link.from !== outside));
        if (dir === "in" && node.inputs) {
          delete node.inputs[port];
        }
        if (level.params) {
          level.params = Object.fromEntries(Object.entries(level.params).filter(([, target]) => target !== outside));
        }
      }
    }
    this.emit({ kind: "structure" });
  }

  renameGroup(label: string) {
    const group = this.group;
    const text = label.trim();
    if (!group || !text || group.label === text) {
      return;
    }
    this.record();
    group.label = text;
    this.emit({ kind: "structure" });
  }

  unlink(to: string) {
    const from = this.sourceOf(to);
    if (from) {
      this.record();
      this.level.links = this.level.links.filter((link) => link.to !== to);
      this.emit({ kind: "structure" });
    }
    return from;
  }

  // Write an input's value. A param only needs a param write; giving an
  // absent optional input a value changes the structure.
  setValue(node: string, input: string, value: Value, gesture?: string) {
    const target = this.level.nodes[node];
    if (!target) {
      return;
    }
    const absent = this.isAbsent(node, input);
    this.record(gesture);
    target.inputs = { ...target.inputs, [input]: structuredClone(value) };
    const param = `${node}.${input}`;
    this.emit(absent ? { kind: "structure" } : this.sourceOf(param) ? { kind: "layout" } : { kind: "value", param, params: this.flatParams(param), value });
  }

  // Make an optional input absent again
  clearValue(node: string, input: string) {
    const level = this.level;
    const target = level.nodes[node];
    if (target?.inputs?.[input] === undefined || !this.def(node)?.inputs[input]?.optional) {
      return;
    }
    this.record();
    const inputs = { ...target.inputs };
    delete inputs[input];
    target.inputs = inputs;
    if (level.params) {
      level.params = Object.fromEntries(Object.entries(level.params).filter(([, port]) => port !== `${node}.${input}`));
    }
    this.emit({ kind: "structure" });
  }

  setOption(node: string, name: string, value: string | number) {
    const target = this.level.nodes[node];
    if (!target || target.options?.[name] === value) {
      return;
    }
    this.record();
    target.options = { ...target.options, [name]: value };
    this.emit({ kind: "structure" });
  }

  // Place nodes (one undo step)
  moveNodes(positions: Map<string, [number, number]>) {
    const nodes = this.level.nodes;
    const moved = [...positions].filter(([id, [x, y]]) => {
      const position = nodes[id]?.position;
      return nodes[id] && (!position || Math.round(x) !== position[0] || Math.round(y) !== position[1]);
    });
    if (moved.length === 0) {
      return;
    }
    this.record();
    for (const [id, [x, y]] of moved) {
      nodes[id].position = [Math.round(x), Math.round(y)];
    }
    this.emit({ kind: "layout" });
  }

  // --- Grouping ---

  // Why these nodes cannot fold into one group (undefined: they can): a
  // wire may not leave them and come back through another node, which
  // would make the group feed itself
  groupProblem(ids: Iterable<string>): string | undefined {
    const chosen = new Set(ids);
    const downstream = new Set<string>();
    const stack = [...chosen];
    while (stack.length > 0) {
      const id = stack.pop()!;
      for (const link of this.level.links) {
        const to = splitPort(link.to)[0];
        if (splitPort(link.from)[0] === id && !downstream.has(to)) {
          downstream.add(to);
          stack.push(to);
        }
      }
    }
    const upstream = new Set([...chosen].flatMap((id) => [...this.upstream(id)]));
    const between = [...downstream].find((id) => !chosen.has(id) && upstream.has(id));
    return between ? `a wire leaves the selection and comes back through ${between}: add it to the selection` : undefined;
  }

  // Fold nodes of this level into a new group and put an instance in their
  // place. Wires crossing the selection become the group's ports; knobs on
  // the folded nodes become group inputs, so they keep working. The id of
  // the instance, if anything was grouped.
  groupNodes(ids: Iterable<string>, label = "Group"): string | undefined {
    const level = this.level;
    const chosen = new Set([...ids].filter((id) => {
      const def = this.def(id);
      return def && !def.output && level.nodes[id].type !== GROUP_INPUT && level.nodes[id].type !== GROUP_OUTPUT;
    }));
    if (chosen.size === 0 || this.groupProblem(chosen)) {
      return undefined;
    }
    this.record();
    this.graph.groups ??= {};
    const name = this.newId(sanitize(label.toLowerCase()), this.graph.groups);
    const inputId = this.newId("inputs", Object.fromEntries([...chosen].map((id) => [id, true])));
    const outputId = this.newId("outputs", Object.fromEntries([...chosen, inputId].map((id) => [id, true])));
    const group: GraphGroup = { label, inputs: {}, outputs: {}, nodes: {}, links: [] };

    const boxes = [...chosen].map((id) => level.nodes[id].position ?? [0, 0]);
    const x0 = Math.min(...boxes.map(([x]) => x));
    const x1 = Math.max(...boxes.map(([x]) => x));
    const y0 = Math.min(...boxes.map(([, y]) => y));
    const y1 = Math.max(...boxes.map(([, y]) => y));
    for (const id of chosen) {
      const node: GraphNode = structuredClone(level.nodes[id]);
      if (node.position) {
        node.position = [node.position[0] - x0 + 260, node.position[1] - y0];
      }
      group.nodes[id] = node;
    }
    group.nodes[inputId] = { type: GROUP_INPUT, position: [0, Math.round((y1 - y0) / 2)] };
    group.nodes[outputId] = { type: GROUP_OUTPUT, position: [x1 - x0 + 520, Math.round((y1 - y0) / 2)] };

    // The folded nodes leave, so the card may take one of their ids
    const instance = this.newId(name, Object.fromEntries(Object.keys(level.nodes).filter((id) => !chosen.has(id)).map((id) => [id, true])));
    const outer: GraphLevel["links"] = [];
    const inputFor = new Map<string, string>();
    const outputFor = new Map<string, string>();
    for (const link of level.links) {
      const fromIn = chosen.has(splitPort(link.from)[0]);
      const toIn = chosen.has(splitPort(link.to)[0]);
      if (fromIn && toIn) {
        group.links.push(structuredClone(link));
      } else if (toIn) {
        let port = inputFor.get(link.from);
        if (!port) {
          const [fromNode, fromPort] = splitPort(link.from);
          const [toNode, toPort] = splitPort(link.to);
          const type = this.def(fromNode)!.outputs[fromPort];
          const target = this.def(toNode)!.inputs[toPort];
          port = this.addPort(group, "in", toPort, type, target.type === type ? target.default : undefined, target);
          inputFor.set(link.from, port);
          outer.push({ from: link.from, to: `${instance}.${port}` });
        }
        group.links.push({ from: `${inputId}.${port}`, to: link.to });
      } else if (fromIn) {
        let port = outputFor.get(link.from);
        if (!port) {
          const [fromNode, fromPort] = splitPort(link.from);
          port = this.addPort(group, "out", fromPort, this.def(fromNode)!.outputs[fromPort]);
          outputFor.set(link.from, port);
          group.links.push({ from: link.from, to: `${outputId}.${port}` });
        }
        outer.push({ from: `${instance}.${port}`, to: link.to });
      } else {
        outer.push(link);
      }
    }

    const instanceInputs: Record<string, Value> = {};
    if (level.params) {
      for (const [labelName, target] of Object.entries(level.params)) {
        const [node, input] = splitPort(target);
        if (!chosen.has(node)) {
          continue;
        }
        const def = this.def(node)!.inputs[input];
        const value = level.nodes[node].inputs?.[input] ?? def.default;
        const port = this.addPort(group, "in", camel(labelName), def.type, value, def);
        group.links.push({ from: `${inputId}.${port}`, to: target });
        instanceInputs[port] = structuredClone(value);
        level.params[labelName] = `${instance}.${port}`;
      }
    }

    for (const id of chosen) {
      delete level.nodes[id];
    }
    level.nodes[instance] = {
      type: `${GROUP_PREFIX}${name}`,
      position: [Math.round((x0 + x1) / 2), Math.round((y0 + y1) / 2)],
      ...(Object.keys(instanceInputs).length ? { inputs: instanceInputs } : {}),
    };
    level.links = outer;
    this.graph.groups[name] = group;
    this.emit({ kind: "structure" });
    return instance;
  }

  // Put a group instance's nodes back in its place; the group goes too when
  // nothing else uses it. The ids of the placed nodes.
  ungroup(id: string): string[] {
    const level = this.level;
    const name = groupOf(level.nodes[id]?.type ?? "");
    const group = name !== undefined ? this.graph.groups?.[name] : undefined;
    if (!group || name === undefined) {
      return [];
    }
    this.record();
    const instance = level.nodes[id];
    const inputId = boundaryNode(group, GROUP_INPUT);
    const outputId = boundaryNode(group, GROUP_OUTPUT);
    const lookup = withGroups(this.registry, this.graph.groups, name);
    const rename = new Map<string, string>();
    const taken: Record<string, unknown> = { ...level.nodes };
    delete taken[id];
    const inner = Object.entries(group.nodes).filter(([innerId]) => innerId !== inputId && innerId !== outputId);
    const positions = inner.map(([, node]) => node.position ?? [0, 0]);
    const cx = positions.reduce((sum, [x]) => sum + x, 0) / Math.max(1, positions.length);
    const cy = positions.reduce((sum, [, y]) => sum + y, 0) / Math.max(1, positions.length);
    const [ix, iy] = instance.position ?? [0, 0];
    // The card goes first: its contents may take its id
    delete level.nodes[id];
    for (const [innerId, node] of inner) {
      const newId = taken[innerId] ? this.newId(innerId, taken) : innerId;
      taken[newId] = true;
      rename.set(innerId, newId);
      const copy = structuredClone(node);
      if (copy.position) {
        copy.position = [Math.round(ix + copy.position[0] - cx), Math.round(iy + copy.position[1] - cy)];
      }
      level.nodes[newId] = copy;
    }
    const at = (port: string) => {
      const [node, name2] = splitPort(port);
      return `${rename.get(node) ?? node}.${name2}`;
    };
    const outerSource = new Map(level.links.filter((link) => splitPort(link.to)[0] === id).map((link) => [splitPort(link.to)[1], link.from]));
    const outerTargets = level.links.filter((link) => splitPort(link.from)[0] === id);
    const links = level.links.filter((link) => splitPort(link.to)[0] !== id && splitPort(link.from)[0] !== id);
    const relabel = new Map<string, string>();
    for (const link of group.links) {
      const [fromNode, fromPort] = splitPort(link.from);
      const [toNode, toPort] = splitPort(link.to);
      // Where the value comes from outside: a wire, or the instance's value
      const source = fromNode === inputId ? outerSource.get(fromPort) : at(link.from);
      const targets = toNode === outputId ? outerTargets.filter((outerLink) => splitPort(outerLink.from)[1] === toPort).map((outerLink) => outerLink.to) : [at(link.to)];
      for (const target of targets) {
        if (source) {
          links.push({ from: source, to: target });
        } else if (fromNode === inputId) {
          const [targetNode, targetInput] = splitPort(target);
          const type = lookup.get(level.nodes[targetNode]?.type ?? "")?.inputs[targetInput]?.type
            ?? this.lookup.get(level.nodes[targetNode]?.type ?? "")?.inputs[targetInput]?.type;
          let value = instance.inputs?.[fromPort] ?? group.inputs[fromPort]?.default;
          if (type && value !== undefined && !valueFits(type, value) && typeof value === "number") {
            value = zeroValue(type) === 0 ? value : (zeroValue(type) as number[]).map(() => value as number);
          }
          if (type && value !== undefined && valueFits(type, value) && level.nodes[targetNode]) {
            level.nodes[targetNode].inputs = { ...level.nodes[targetNode].inputs, [targetInput]: structuredClone(value) };
            if (!relabel.has(`${id}.${fromPort}`)) {
              relabel.set(`${id}.${fromPort}`, target);
            }
          }
        }
      }
    }
    level.links = links;
    if (level.params) {
      level.params = Object.fromEntries(Object.entries(level.params).flatMap(([labelName, target]) => {
        if (splitPort(target)[0] !== id) {
          return [[labelName, target]];
        }
        const next = relabel.get(target);
        return next ? [[labelName, next]] : [];
      }));
    }
    if (instancePaths(this.graph, name).length === 0 && !Object.values(this.graph.groups ?? {}).some((g) => Object.values(g.nodes).some((node) => node.type === `${GROUP_PREFIX}${name}`))) {
      delete this.graph.groups![name];
    }
    this.emit({ kind: "structure" });
    return [...rename.values()];
  }
}
