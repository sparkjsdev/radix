// Auto-layout with ELK's layered algorithm (elkjs, EPL-2.0), run in a worker.
// elk-api.js is UMD, not a module: index.html loads it from node_modules as
// a classic script (window.ELK), and its worker is the elk-worker.min.js
// beside it (a single-file build inlines both and sets window.ELK_WORKER_URL).
// Ports sit where the DOM put them (FIXED_POS), so wires leave and enter
// where they are drawn and ELK orders nodes to cut crossings.
import type ElkApi from "elkjs/lib/elk-api.js";
import type { ElkExtendedEdge, ElkNode } from "elkjs/lib/elk-api";
import { GROUP_INPUT, GROUP_OUTPUT, splitPort, type GraphLevel } from "./fx/index.js";

const ELK = (window as unknown as { ELK: typeof ElkApi }).ELK;
const elkScript = document.querySelector<HTMLScriptElement>('script[src$="elk-api.js"]');
const ELK_WORKER = (window as unknown as { ELK_WORKER_URL?: string }).ELK_WORKER_URL ?? (elkScript ? elkScript.src.replace(/elk-api\.js$/, "elk-worker.min.js") : "");

export interface PortBox {
  name: string;
  side: "in" | "out";
  // Center, relative to the node's top left
  x: number;
  y: number;
}

export interface NodeBox {
  width: number;
  height: number;
  ports: PortBox[];
}

export interface LayoutOptions {
  layerSpacing: number;
  nodeSpacing: number;
}

let elk: InstanceType<typeof ElkApi> | undefined;

export interface LayoutResult {
  // Top-left corner of each node
  positions: Map<string, [number, number]>;
  // ELK's right-angle route of each link (by its input "node.port"): start,
  // bends, end; it keeps clear of nodes, including wires that run back to a
  // wrapped row
  routes: Map<string, [number, number][]>;
}

// Long chains make wide strips, so besides one row of layers this tries
// ELK's graph wrapping (rows of layers stacked to the view's shape) and keeps
// the layout that fits `view` at the largest zoom, less a penalty for wires
// that cross or run backward.
export async function autoLayout(graph: GraphLevel, boxes: Map<string, NodeBox>, { layerSpacing, nodeSpacing }: LayoutOptions, view: { width: number; height: number }): Promise<LayoutResult> {
  elk ??= new ELK({ workerUrl: ELK_WORKER });
  const portId = (node: string, side: string, name: string) => `${node}|${side}|${name}`;
  const ports = new Set<string>();
  const children: ElkNode[] = [...boxes].map(([id, box]) => ({
    id,
    width: box.width,
    height: box.height,
    // A group's inputs stay at the left edge and its outputs at the right
    layoutOptions: {
      "elk.portConstraints": "FIXED_POS",
      ...(graph.nodes[id]?.type === GROUP_INPUT ? { "elk.layered.layering.layerConstraint": "FIRST" } : {}),
      ...(graph.nodes[id]?.type === GROUP_OUTPUT ? { "elk.layered.layering.layerConstraint": "LAST" } : {}),
    },
    ports: box.ports.map((port) => {
      const pid = portId(id, port.side, port.name);
      ports.add(pid);
      return { id: pid, x: port.x - 1, y: port.y - 1, width: 2, height: 2, layoutOptions: { "elk.port.side": port.side === "in" ? "WEST" : "EAST" } };
    }),
  }));
  const edges = graph.links.flatMap((link, i) => {
    const [fromNode, fromPort] = splitPort(link.from);
    const [toNode, toPort] = splitPort(link.to);
    const source = portId(fromNode, "out", fromPort);
    const target = portId(toNode, "in", toPort);
    return ports.has(source) && ports.has(target) ? [{ id: `e${i}`, sources: [source], targets: [target] }] : [];
  });

  const base: Record<string, string> = {
    "elk.algorithm": "layered",
    "elk.direction": "RIGHT",
    "elk.layered.spacing.nodeNodeBetweenLayers": String(layerSpacing),
    "elk.spacing.nodeNode": String(nodeSpacing),
    "elk.layered.spacing.edgeNodeBetweenLayers": String(Math.round(nodeSpacing * 0.8)),
    "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
    "elk.layered.crossingMinimization.thoroughness": "30",
    "elk.edgeRouting": "ORTHOGONAL",
    "elk.separateConnectedComponents": "true",
    "elk.spacing.componentComponent": String(layerSpacing),
    "elk.padding": "[top=0,left=0,bottom=0,right=0]",
  };
  // The JSON's node order (stable, often how the author thinks) or free
  // reordering (fewer crossings)
  const ordered = { ...base, "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES" };
  const aspect = Math.max(0.3, view.width / Math.max(1, view.height));
  const wrapped = (options: Record<string, string>, strategy: string) => ({
    ...options,
    "elk.layered.wrapping.strategy": strategy,
    "elk.aspectRatio": aspect.toFixed(2),
    "elk.layered.wrapping.additionalEdgeSpacing": String(nodeSpacing),
    "elk.layered.wrapping.multiEdge.improveCuts": "true",
    "elk.layered.wrapping.multiEdge.improveWrappedEdges": "true",
  });
  const candidates = [base, ordered, wrapped(base, "SINGLE_EDGE"), wrapped(base, "MULTI_EDGE"), wrapped(ordered, "MULTI_EDGE")];
  const results = await Promise.all(candidates.map((options) => elk!.layout({ id: "root", layoutOptions: options, children, edges } as ElkNode).catch(() => undefined)));

  const inputOf = new Map(edges.map((edge, i) => [edge.id, graph.links[Number(edge.id.slice(1))]?.to ?? String(i)]));
  // Inside a group, inputs-left-to-outputs-right reads best: one row
  // whenever it fits at the smallest zoom a fit allows
  const zoomOf = (result: ElkNode | undefined) => (result ? Math.min(view.width / ((result.width ?? 1) + 80), view.height / ((result.height ?? 1) + 80)) : 0);
  const boundary = Object.values(graph.nodes).some((node) => node.type === GROUP_INPUT || node.type === GROUP_OUTPUT);
  const oneRow = boundary && Math.max(zoomOf(results[0]), zoomOf(results[1])) >= 0.36;
  let best: LayoutResult | undefined;
  let bestScore = -Infinity;
  for (const [i, result] of results.entries()) {
    if (!result?.children || (oneRow && i >= 2)) {
      continue;
    }
    const positions = new Map(result.children.map((child) => [child.id, [child.x ?? 0, child.y ?? 0] as [number, number]]));
    const routes = new Map<string, [number, number][]>();
    for (const edge of (result.edges ?? []) as ElkExtendedEdge[]) {
      const section = edge.sections?.[0];
      const input = inputOf.get(edge.id);
      if (section && input) {
        routes.set(input, [section.startPoint, ...(section.bendPoints ?? []), section.endPoint].map((p) => [p.x, p.y]));
      }
    }
    // Past this zoom a layout is readable enough; below it, size counts
    const zoom = Math.min(0.8, view.width / ((result.width ?? 1) + 80), view.height / ((result.height ?? 1) + 80));
    const { crossings, backward } = tangle(graph, boxes, positions);
    const score = zoom / (1 + 0.03 * crossings + 0.03 * backward);
    if (score > bestScore) {
      best = { positions, routes };
      bestScore = score;
    }
  }
  if (!best) {
    throw new Error("ELK found no layout");
  }
  return best;
}

// How hard a layout's wires are to follow, with wires as straight port-to-
// port segments: pairs that cross and wires running right to left
function tangle(graph: GraphLevel, boxes: Map<string, NodeBox>, positions: Map<string, [number, number]>) {
  const port = (node: string, side: "in" | "out", name: string): [number, number] | undefined => {
    const p = positions.get(node);
    const offset = boxes.get(node)?.ports.find((q) => q.side === side && q.name === name);
    return p && offset ? [p[0] + offset.x, p[1] + offset.y] : undefined;
  };
  const wires = graph.links.flatMap((link) => {
    const [fromNode, fromPort] = splitPort(link.from);
    const [toNode, toPort] = splitPort(link.to);
    const a = port(fromNode, "out", fromPort);
    const b = port(toNode, "in", toPort);
    return a && b ? [{ a, b }] : [];
  });
  const cross = (p: number[], q: number[], r: number[], s: number[]) => {
    const d = (a: number[], b: number[], c: number[]) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    return d(p, q, r) * d(p, q, s) < 0 && d(r, s, p) * d(r, s, q) < 0;
  };
  let crossings = 0;
  for (let i = 0; i < wires.length; i += 1) {
    for (let j = i + 1; j < wires.length; j += 1) {
      if (cross(wires[i].a, wires[i].b, wires[j].a, wires[j].b)) {
        crossings += 1;
      }
    }
  }
  const backward = wires.filter((wire) => wire.b[0] < wire.a[0]).length;
  return { crossings, backward };
}
