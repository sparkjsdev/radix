// A graph built into a Radix SplatModifier. Modifiers are program cache
// keys, so each graph structure (graphKey) is built once and kept: every
// unlinked input reads its own uniform, and FxInputs holds the uniforms of
// time, the click and the camera, so changing values, time, the click or
// the camera writes uniforms and compiles nothing. A new structure (links,
// options, absent inputs) is a new modifier, compiled at its first render.
import * as THREE from "three";
import { GpuSplats, TSL,                                  } from "@sparkjsdev/radix";
import {
  evaluationOrder, flattenGraph, graphKey, graphParams, isAbsent, linkSources, splitPort, validate, valueFits, withGroups,            
                                   
} from "./graph.js";
import { fxNodes } from "./nodes/index.js";
                                                                

const { float, uniform, vec2, vec3, vec4 } = TSL;

// Written by the page: seconds, the last click (a point in the modifier's
// space and its time) and the viewing camera in the modifier's space
// (pixelSize: world size of one drawing-buffer pixel at unit depth)
export const FxInputs = {
  time: uniform(0),
  click: { point: uniform(new THREE.Vector3()), time: uniform(-1e4) },
  camera: { position: uniform(new THREE.Vector3(0, 0, 3)), forward: uniform(new THREE.Vector3(0, 0, -1)), pixelSize: uniform(0.0015) },
};

                                
                                                  
                       
                                   
                                                                       
                                          
                             
                              
                               
                                                        
                                 
                                                
                                           
 

const cache = new Map                       ();

// The modifier of `graph`'s structure, its uniforms set to the graph's values
export function buildGraphModifier(graph       , registry             = fxNodes)                {
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
export function setParam(target               , name        , value       ) {
  const param = paramOf(target, name);
  if (!valueFits(param.type, value)) {
    throw new Error(`fx param ${name}: ${JSON.stringify(value)} does not fit ${param.type}`);
  }
  param.value = structuredClone(value);
  const u = target.uniforms.get(param.name) ;
  if (typeof u.value === "number") {
    u.value = Number(value);
  } else {
    u.value.fromArray(value            );
  }
}

export function getParam(target               , name        )        {
  return paramOf(target, name).value;
}

function paramOf(target               , name        ) {
  const param = target.params.get(target.labels[name] ?? name);
  if (!param) {
    throw new Error(`fx graph has no param ${name}`);
  }
  return param;
}

function compile(source       , registry            , key        )                {
  const graph = flattenGraph(source);
  const lookup = withGroups(registry, source.groups);
  const order = evaluationOrder(source, registry);
  const def = (id        ) => lookup.get(graph.nodes[id].type) ;
  const usesClick = order.some((id) => def(id).click);
  const usesCamera = order.some((id) => def(id).camera);
  const usesTime = usesClick || order.some((id) => def(id).time);

  const params = new Map(graphParams(source, registry).map((param) => [param.name, param]));
  const uniforms = new Map([...params.values()].map((param) => [param.name, makeUniform(param.type, param.value)]));
  const sources = linkSources(graph);

  const modifier                = (s) => {
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

    const outputs = new Map                                 ();
    for (const id of order) {
      const node = graph.nodes[id];
      const nodeDef = def(id);
      const inputs                          = {};
      for (const [name, input] of Object.entries(nodeDef.inputs)) {
        const from = sources.get(`${id}.${name}`);
        if (from) {
          const [fromNode, port] = splitPort(from);
          inputs[name] = convert(outputs.get(fromNode) [port], def(fromNode).outputs[port], input.type);
        } else if (!isAbsent(graph, nodeDef, id, name, sources)) {
          const u = uniforms.get(`${id}.${name}`) ;
          inputs[name] = input.type === "bool" ? u.greaterThan(0.5) : u;
        }
      }
      const build               = {
        source: entered,
        splat,
        index: entered.get("index"),
        time,
        click,
        camera,
        option: (name) => node.options?.[name] ?? nodeDef.options [name].default,
      };
      outputs.set(id, nodeDef.build(inputs, build));
    }
    return splat;
  };

  return { key, modifier, uniforms, usesTime, usesClick, usesCamera, labels: {}, params };
}

function makeUniform(type          , value       )          {
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
function convert(value         , from          , to          )          {
  if (from !== "float" || to === "float") {
    return value;
  }
  return to === "vec2" ? vec2(value) : to === "vec4" ? vec4(value) : vec3(value);
}


//# sourceURL=examples/fxedit/fx/graphModifier.ts