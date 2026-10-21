import * as THREE from "three";
import { GpuSplats, TSL, type SplatModifier, type TslNode } from "@sparkjsdev/radix";
import {
  evaluationOrder, flattenGraph, graphKey, graphParams, isAbsent, linkSources, splitPort, validate, valueFits, withGroups, type Graph,
  type GraphParam, type NodeLookup,
} from "./graph.js";
import { fxNodes } from "./nodes/index.js";
import type { BuildContext, PortType, Value } from "./types.js";

const { float, uniform, vec2, vec3, vec4 } = TSL;

// Written by the page: seconds, and the click and the camera in the modifier's
// space (pixelSize: one drawing-buffer pixel's world size at unit depth)
export const FxInputs = {
  time: uniform(0),
  click: { point: uniform(new THREE.Vector3()), time: uniform(-1e4) },
  camera: { position: uniform(new THREE.Vector3(0, 0, 3)), forward: uniform(new THREE.Vector3(0, 0, -1)), pixelSize: uniform(0.0015) },
};

export interface GraphModifier {
  // "fx:" + graphKey: the structure, never values
  readonly key: string;
  readonly modifier: SplatModifier;
  // One uniform per param ("node.input"); a bool's is a float (0 or 1)
  readonly uniforms: Map<string, TslNode>;
  readonly usesTime: boolean;
  readonly usesClick: boolean;
  readonly usesCamera: boolean;
  // The last built graph's knobs: label -> "node.input"
  labels: Record<string, string>;
  readonly params: Map<string, GraphParam>;
}

const cache = new Map<string, GraphModifier>();

// The modifier of graph's structure, built once since modifiers are program keys,
// with its uniforms set to graph's values
export function buildGraphModifier(graph: Graph, registry: NodeLookup = fxNodes): GraphModifier {
  const errors = validate(graph, registry);
  if (errors.length > 0) {
    throw new Error(`Invalid fx graph${graph.name ? ` ${graph.name}` : ""}:\n${errors.join("\n")}`);
  }
  const key = `fx:${graphKey(graph, registry)}`;
  const built = cache.get(key) ?? compile(structuredClone(graph), registry, key);
  cache.set(key, built);
  built.labels = structuredClone(graph.params ?? {});
  for (const param of graphParams(graph, registry)) {
    setParam(built, param.name, param.value);
  }
  return built;
}

// A param by label or "node.input"
export function setParam(target: GraphModifier, name: string, value: Value) {
  const param = paramOf(target, name);
  if (!valueFits(param.type, value)) {
    throw new Error(`fx param ${name}: ${JSON.stringify(value)} does not fit ${param.type}`);
  }
  param.value = structuredClone(value);
  const u = target.uniforms.get(param.name)!;
  if (typeof u.value === "number") {
    u.value = Number(value);
  } else {
    u.value.fromArray(value as number[]);
  }
}

export function getParam(target: GraphModifier, name: string): Value {
  return paramOf(target, name).value;
}

function paramOf(target: GraphModifier, name: string) {
  const param = target.params.get(target.labels[name] ?? name);
  if (!param) {
    throw new Error(`fx graph has no param ${name}`);
  }
  return param;
}

function compile(source: Graph, registry: NodeLookup, key: string): GraphModifier {
  const graph = flattenGraph(source);
  const lookup = withGroups(registry, source.groups);
  const order = evaluationOrder(source, registry);
  const def = (id: string) => lookup.get(graph.nodes[id].type)!;
  const usesClick = order.some((id) => def(id).click);
  const usesCamera = order.some((id) => def(id).camera);
  const usesTime = usesClick || order.some((id) => def(id).time);

  const params = new Map(graphParams(source, registry).map((param) => [param.name, param]));
  const uniforms = new Map([...params.values()].map((param) => [param.name, makeUniform(param.type, param.value)]));
  const sources = linkSources(graph);

  const modifier: SplatModifier = (s) => {
    // Reads see the splat as it entered: .toVar() declares lazily, where
    // first used, so both vars are declared here by explicit assignments
    const entered = GpuSplats.Splat().toVar();
    entered.assign(s);
    const splat = GpuSplats.Splat().toVar();
    splat.assign(s);
    const time = usesTime ? FxInputs.time : float(0);
    const click = usesClick
      ? { point: FxInputs.click.point, age: time.sub(FxInputs.click.time) }
      : { point: vec3(0), age: float(1e4) };
    const camera = usesCamera
      ? FxInputs.camera
      : { position: vec3(0, 0, 3), forward: vec3(0, 0, -1), pixelSize: float(0.0015) };

    const outputs = new Map<string, Record<string, TslNode>>();
    for (const id of order) {
      const node = graph.nodes[id];
      const nodeDef = def(id);
      const inputs: Record<string, TslNode> = {};
      for (const [name, input] of Object.entries(nodeDef.inputs)) {
        const from = sources.get(`${id}.${name}`);
        if (from) {
          const [fromNode, port] = splitPort(from);
          inputs[name] = convert(outputs.get(fromNode)![port], def(fromNode).outputs[port], input.type);
        } else if (!isAbsent(graph, nodeDef, id, name, sources)) {
          const u = uniforms.get(`${id}.${name}`)!;
          inputs[name] = input.type === "bool" ? u.greaterThan(0.5) : u;
        }
      }
      const build: BuildContext = {
        source: entered,
        splat,
        index: entered.get("index"),
        time,
        click,
        camera,
        option: (name) => node.options?.[name] ?? nodeDef.options![name].default,
      };
      outputs.set(id, nodeDef.build(inputs, build));
    }
    return splat;
  };

  return { key, modifier, uniforms, usesTime, usesClick, usesCamera, labels: {}, params };
}

function makeUniform(type: PortType, value: Value): TslNode {
  const v = Array.isArray(value) ? value : [Number(value)];
  switch (type) {
    case "float":
    case "bool": return uniform(v[0]);
    case "vec2": return uniform(new THREE.Vector2().fromArray(v));
    case "vec3":
    case "color": return uniform(new THREE.Vector3().fromArray(v));
    case "vec4": return uniform(new THREE.Vector4().fromArray(v));
  }
}

// A linked float feeds vectors by broadcast (validate allows nothing else)
function convert(value: TslNode, from: PortType, to: PortType): TslNode {
  if (from !== "float" || to === "float") {
    return value;
  }
  return to === "vec2" ? vec2(value) : to === "vec4" ? vec4(value) : vec3(value);
}
