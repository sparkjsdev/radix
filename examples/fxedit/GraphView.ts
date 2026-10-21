import { canLink, GROUP_INPUT, GROUP_OUTPUT, groupOf, splitPort, type NodeDef, type PortType, type Value } from "./fx/index.js";
import { choice, scrubber, valueEditor } from "./editors.js";
import { NEW_PORT, type Change, type GraphDoc } from "./GraphDoc.js";
import { Juice } from "./juice.js";
import { autoLayout, type NodeBox } from "./layout.js";
import { Palette } from "./palette.js";
import { depths, flowRoots, outputNodes, upstreamOf } from "./preview.js";
import type { EditorSettings } from "./settings.js";
import type { Sound } from "./sound.js";
import { Animator, Spring } from "./springs.js";
import type { Theme } from "./themes.js";
import { bezierPath, fitRoute, orthoPath, orthoRoute, Rope, routeOk, type Obstacle } from "./wires.js";

const SVG = "http://www.w3.org/2000/svg";
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 2.5;
// Screen px within which a dragged wire snaps to a port
const SNAP = 34;
const PROBE_TYPES = new Set<PortType>(["float", "vec3", "color", "bool"]);

interface PortView {
  el: HTMLElement;
  type: PortType;
  // Center relative to the node's top left
  x: number;
  y: number;
}

interface NodeView {
  id: string;
  el: HTMLElement;
  signature: string;
  x: Spring;
  y: Spring;
  scale: Spring;
  ins: Map<string, PortView>;
  outs: Map<string, PortView>;
  width: number;
  height: number;
  // Needs its transform written once more
  dirty: boolean;
  // Was moving last frame, so its wires update once more
  moving: boolean;
}

interface WireView {
  from: string;
  to: string;
  type: PortType;
  group: SVGGElement;
  path: SVGPathElement;
  flow: SVGPathElement;
  rope?: Rope;
  // ELK's route from the last layout, else orthoRoute's once both nodes rest
  route?: [number, number][];
  awake: boolean;
}

// Screen = world * zoom + (x, y)
interface Cam {
  x: number;
  y: number;
  zoom: number;
}

// A move into or out of a group. from and to are p, 0 for the parent and 1 for
// the inside, and ghost is a still copy of the level being left.
interface LevelMove {
  from: number;
  to: number;
  t: number;
  duration: number;
  ghost: HTMLElement;
  entering: boolean;
  // Parent camera before (p = 0) and with the card over the inside (p = 1),
  // the inside's own camera, and the card's center in the parent
  c0: Cam;
  cz: Cam;
  f: Cam;
  card: [number, number];
  // In the ghost on the way in, live on the way out
  cardEl?: HTMLElement;
}

const compose = (a: Cam, b: Cam): Cam => ({ x: a.x + a.zoom * b.x, y: a.y + a.zoom * b.y, zoom: a.zoom * b.zoom });
const invert = (c: Cam): Cam => ({ x: -c.x / c.zoom, y: -c.y / c.zoom, zoom: 1 / c.zoom });
const camCss = (c: Cam) => `translate(${c.x}px, ${c.y}px) scale(${c.zoom})`;
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const smooth = (a: number, b: number, t: number) => {
  const x = Math.max(0, Math.min(1, (t - a) / (b - a)));
  return x * x * (3 - 2 * x);
};

type Drag =
  | { kind: "pan"; pointer: number; x: number; y: number }
  | { kind: "nodes"; pointer: number; x: number; y: number; items: { view: NodeView; x: number; y: number }[]; moved: boolean }
  | { kind: "wire"; pointer: number; out: boolean; anchor: string; type: PortType; temp: SVGGElement; snapped?: string; x0: number; y0: number }
  | { kind: "marquee"; pointer: number; x: number; y: number; base: Set<string> };

export interface GraphViewOptions {
  animator: Animator;
  sound: Sound;
  theme: Theme;
  settings: EditorSettings;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export class GraphView {
  readonly root: HTMLElement;
  readonly palette: Palette;
  readonly juice: Juice;
  theme: Theme;
  settings: EditorSettings;
  selection = new Set<string>();
  flow = false;
  probe?: string;
  // The pointer is over the editor (keys go to it)
  active = false;
  onProbe?: (port: string | undefined) => void;
  onFlow?: (on: boolean) => void;
  onHistory?: () => void;
  // After the doc entered or left a group
  onLevel?: () => void;

  private doc: GraphDoc;
  private animator: Animator;
  private sound: Sound;
  private world: HTMLElement;
  private layer: HTMLElement;
  private wireLayer: SVGGElement;
  private marquee: HTMLElement;
  private nodes = new Map<string, NodeView>();
  private wires = new Map<string, WireView>();
  private cam = { x: 0, y: 0, zoom: 1 };
  private camSprings = { x: new Spring(0, 0.2), y: new Spring(0, 0.2), zoom: new Spring(1, 1e-4) };
  private camAnimating = false;
  private drag?: Drag;
  private pointer = { x: 0, y: 0 };
  private space = false;
  private zTop = 1;
  private errors: string[] = [];
  // A layout is writing positions into the doc (sync leaves nodes alone)
  private laying = false;
  private reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  private crumbs: HTMLElement;
  // The level on screen (doc.path joined), each level's last camera, and the move under way
  private levelKey = "";
  private levelCams = new Map<string, Cam>();
  private levelMove?: LevelMove;
  private navigating = false;

  constructor(container: HTMLElement, doc: GraphDoc, { animator, sound, theme, settings }: GraphViewOptions) {
    this.doc = doc;
    this.animator = animator;
    this.sound = sound;
    this.theme = theme;
    this.settings = settings;

    this.root = document.createElement("div");
    this.root.className = "fx-graph";
    this.root.tabIndex = -1;
    this.world = document.createElement("div");
    this.world.className = "fx-world";
    const svg = document.createElementNS(SVG, "svg");
    svg.classList.add("fx-wires");
    this.wireLayer = document.createElementNS(SVG, "g");
    svg.append(this.wireLayer);
    this.layer = document.createElement("div");
    this.layer.className = "fx-nodes";
    const fxLayer = document.createElement("div");
    fxLayer.className = "fx-fx";
    this.world.append(svg, this.layer, fxLayer);
    this.marquee = document.createElement("div");
    this.marquee.className = "fx-marquee";
    this.marquee.hidden = true;
    const hud = document.createElement("div");
    hud.className = "fx-hud";
    this.crumbs = document.createElement("nav");
    this.crumbs.className = "fx-crumbs";
    this.crumbs.hidden = true;
    this.crumbs.addEventListener("pointerdown", (event) => event.stopPropagation());
    this.root.append(this.world, this.marquee, hud, this.crumbs);
    container.append(this.root);

    this.juice = new Juice(fxLayer, hud, theme);
    this.palette = new Palette(this.root, () => doc.paletteDefs());
    this.palette.onClose = () => this.root.focus({ preventScroll: true });

    this.root.addEventListener("pointerdown", (event) => this.pointerDown(event));
    this.root.addEventListener("pointermove", (event) => this.pointerMove(event));
    this.root.addEventListener("pointerup", (event) => this.pointerUp(event));
    this.root.addEventListener("pointercancel", (event) => this.pointerUp(event));
    this.root.addEventListener("wheel", (event) => this.wheel(event), { passive: false });
    this.root.addEventListener("dblclick", (event) => {
      // A press on a node captures the pointer to the root: look under it
      const target = (document.elementFromPoint(event.clientX, event.clientY) ?? event.target) as HTMLElement;
      const group = target.closest<HTMLElement>(".fx-node.group-node");
      if (group && !target.closest(".fx-edit, input, select, button, textarea")) {
        void this.enter(group.dataset.id!);
      } else if (!target.closest(".fx-node, .fx-palette, .fx-crumbs")) {
        this.openPalette(this.pointer.x, this.pointer.y);
      }
    });
    this.root.addEventListener("contextmenu", (event) => event.preventDefault());
    this.root.addEventListener("pointerenter", () => (this.active = true));
    this.root.addEventListener("pointerleave", () => (this.active = false));
    document.addEventListener("keydown", (event) => this.keyDown(event));
    document.addEventListener("keyup", (event) => {
      if (event.code === "Space") {
        this.space = false;
        this.root.classList.remove("space");
      }
    });
    new ResizeObserver(() => this.applyCamera()).observe(this.root);

    doc.on((change) => this.changed(change));
    animator.add((dt) => this.tick(dt));
    this.applyCamera();
  }

  get instant() {
    return this.settings.instant || this.reducedMotion;
  }

  private get motion() {
    return this.settings.motion[this.theme.name];
  }

  private changed(change: Change) {
    if (change.kind === "structure") {
      const moved = this.levelKey !== this.doc.path.join("/");
      if (change.reason === "load") {
        this.levelCams.clear();
      }
      if ((change.reason === "enter" || change.reason === "exit" || (change.reason === "history" && moved))) {
        // enter() and exit() animate; other level changes just show the level
        this.sync(true, true);
        if (!this.navigating) {
          void this.settle().then((cam) => this.setCamera(cam.x, cam.y, cam.zoom, false));
        }
      } else {
        this.sync(change.reason === "load");
      }
      if (change.reason === "load") {
        const unplaced = Object.values(this.doc.level.nodes).some((node) => !node.position);
        this.root.classList.toggle("appearing", unplaced);
        requestAnimationFrame(() => (unplaced ? void this.layout() : this.fit()));
      }
      this.updateCrumbs();
    } else if (change.kind === "layout") {
      this.sync(false);
    }
    this.onHistory?.();
  }

  // swap: another level replaces this one, so old nodes go at once under the level move
  private sync(load: boolean, swap = false) {
    const graph = this.doc.level;
    this.levelKey = this.doc.path.join("/");
    // A new graph replaces every node, and new ones without positions wait hidden for the layout
    for (const [id, view] of this.nodes) {
      if (load || !graph.nodes[id]) {
        this.removeNode(view, !swap);
      }
    }
    if (swap) {
      this.selection.clear();
    }
    if (load) {
      this.wires.forEach((wire) => wire.group.remove());
      this.wires.clear();
    }
    const center = this.screenToWorld(this.root.clientWidth / 2, this.root.clientHeight / 2);
    const built: NodeView[] = [];
    for (const [id, node] of Object.entries(graph.nodes)) {
      let view = this.nodes.get(id);
      const signature = this.signature(id);
      if (!view) {
        const [x, y] = node.position ?? [center[0] - 90 + (Math.random() - 0.5) * 30, center[1] - 50 + (Math.random() - 0.5) * 30];
        view = this.createNode(id, x, y);
        if (load && !swap && !node.position) {
          view.el.classList.add("pending");
        } else if (!load && !this.instant) {
          view.scale.value = 0.3;
        }
        built.push(view);
      } else if (view.signature !== signature) {
        this.buildNode(view);
        built.push(view);
      }
      view.signature = signature;
      const position = node.position;
      if (!this.laying && position && (position[0] !== Math.round(view.x.target) || position[1] !== Math.round(view.y.target))) {
        this.moveTo(view, position[0], position[1]);
        this.dropRoutes(id);
      }
    }
    built.forEach((view) => this.measure(view));

    const links = new Map(graph.links.map((link) => [link.to, link.from]));
    for (const [to, wire] of this.wires) {
      if (links.get(to) !== wire.from || !this.nodes.has(splitPort(wire.from)[0]) || !this.nodes.has(splitPort(to)[0])) {
        wire.group.remove();
        this.wires.delete(to);
      }
    }
    for (const [to, from] of links) {
      if (!this.wires.has(to) && this.nodes.has(splitPort(from)[0]) && this.nodes.has(splitPort(to)[0])) {
        this.addWire(from, to, !load);
      }
    }
    this.wires.forEach((wire) => this.updateWire(wire, 0));
    for (const id of this.selection) {
      if (!this.nodes.has(id)) {
        this.selection.delete(id);
      }
    }
    this.applySelection();
    this.applyFlow();
    this.applyProbe();
    this.applyErrors();
    this.animator.wake();
  }

  // Everything a node's DOM shows except its position
  private signature(id: string) {
    const graph = this.doc.level;
    const node = graph.nodes[id];
    const linked = graph.links.filter((link) => splitPort(link.to)[0] === id).map((link) => link.to).sort();
    const labels = Object.entries(graph.params ?? {}).filter(([, port]) => splitPort(port)[0] === id);
    // A group card or boundary shows the group's ports and name
    const inner = groupOf(node.type);
    const group = inner !== undefined ? this.doc.graph.groups?.[inner] : node.type === GROUP_INPUT || node.type === GROUP_OUTPUT ? this.doc.group : undefined;
    const shape = group && [group.label, group.inputs, group.outputs, Object.keys(group.nodes).length];
    return JSON.stringify([node.type, node.inputs, node.options, node.note, linked, labels, shape]);
  }

  private createNode(id: string, x: number, y: number): NodeView {
    const el = document.createElement("div");
    el.className = "fx-node";
    el.dataset.id = id;
    this.layer.append(el);
    const view: NodeView = {
      id, el, signature: "", x: new Spring(x), y: new Spring(y), scale: new Spring(1, 1e-3),
      ins: new Map(), outs: new Map(), width: 0, height: 0, dirty: true, moving: false,
    };
    this.nodes.set(id, view);
    this.buildNode(view);
    return view;
  }

  private removeNode(view: NodeView, animate: boolean) {
    this.nodes.delete(view.id);
    if (animate && !this.instant) {
      view.el.classList.add("leaving");
      setTimeout(() => view.el.remove(), 320);
    } else {
      view.el.remove();
    }
  }

  private buildNode(view: NodeView) {
    const { id, el } = view;
    const graph = this.doc.level;
    const node = graph.nodes[id];
    const def = this.doc.def(id);
    el.replaceChildren();
    view.ins.clear();
    view.outs.clear();
    el.className = `fx-node cat-${def?.category ?? "unknown"}${el.classList.contains("selected") ? " selected" : ""}`;

    const head = document.createElement("div");
    head.className = "fx-head";
    const title = document.createElement("span");
    title.className = "fx-title";
    title.textContent = def?.label ?? node.type;
    const name = document.createElement("span");
    name.className = "fx-id";
    name.textContent = id;
    head.append(title, name);
    head.title = def ? `${def.id}${def.description ? `\n${def.description}` : ""}` : `unknown node type ${node.type}`;
    el.append(head);
    const boundary = node.type === GROUP_INPUT ? "in" : node.type === GROUP_OUTPUT ? "out" : undefined;
    const groupName = groupOf(node.type);
    const group = groupName !== undefined ? this.doc.graph.groups?.[groupName] : undefined;
    if (group) {
      el.classList.add("group-node");
      const open = document.createElement("button");
      open.type = "button";
      open.className = "fx-open fx-edit";
      open.title = "Open the group (double-click, or Enter)";
      open.textContent = "open";
      open.addEventListener("click", () => void this.enter(id));
      head.append(open);
      const inside = Object.values(group.nodes).filter((n) => n.type !== GROUP_INPUT && n.type !== GROUP_OUTPUT).length;
      const meta = document.createElement("div");
      meta.className = "fx-group-meta";
      meta.textContent = `${inside} node${inside === 1 ? "" : "s"} inside`;
      el.append(meta);
    } else if (boundary) {
      el.classList.add("boundary", `boundary-${boundary}`);
      title.textContent = boundary === "in" ? "Inputs" : "Outputs";
      name.textContent = "group";
    }
    if (node.note) {
      const note = document.createElement("div");
      note.className = "fx-note";
      note.textContent = node.note;
      el.append(note);
    }
    if (!def) {
      return;
    }

    const rows = document.createElement("div");
    rows.className = "fx-rows";
    el.append(rows);
    const labels = new Map(Object.entries(graph.params ?? {}).map(([label, port]) => [port, label]));

    for (const [output, type] of Object.entries(def.outputs)) {
      const row = document.createElement("div");
      row.className = "fx-row out";
      if (boundary === "in") {
        row.append(this.removePortButton("in", output));
      }
      const label = document.createElement("span");
      label.className = "fx-label";
      label.textContent = output;
      row.append(label);
      if (PROBE_TYPES.has(type)) {
        const eye = document.createElement("button");
        eye.type = "button";
        eye.className = "fx-eye";
        eye.dataset.port = `${id}.${output}`;
        eye.title = "Probe: show this value as color";
        eye.addEventListener("click", () => this.onProbe?.(this.probe === eye.dataset.port ? undefined : eye.dataset.port));
        row.append(eye);
      }
      row.append(this.portElement(view, "out", output, type));
      rows.append(row);
    }
    if (boundary === "in") {
      rows.append(this.newPortRow(view, "out"));
    }

    for (const [input, inputDef] of Object.entries(def.inputs)) {
      const row = document.createElement("div");
      row.className = "fx-row in";
      row.append(this.portElement(view, "in", input, inputDef.type));
      const label = document.createElement("span");
      label.className = "fx-label";
      label.textContent = inputDef.label ?? input;
      label.title = `${input} (${inputDef.type})`;
      // A knob the graph advertises shows under its name
      const param = labels.get(`${id}.${input}`);
      if (param) {
        label.textContent = param;
        label.classList.add("param");
        label.title = `${param}: ${input} (${inputDef.type}), a knob this graph advertises`;
      }
      row.append(label);
      if (this.doc.sourceOf(`${id}.${input}`)) {
        row.classList.add("linked");
      } else if (this.doc.isAbsent(id, input)) {
        const set = document.createElement("button");
        set.type = "button";
        set.className = "fx-set fx-edit";
        set.textContent = "set";
        set.title = "Unset: this part of the splat is left alone";
        set.addEventListener("click", () => this.doc.setValue(id, input, structuredClone(inputDef.default)));
        row.classList.add("absent");
        row.append(set);
      } else {
        const value = node.inputs?.[input] ?? inputDef.default;
        row.append(valueEditor(inputDef.type, value, inputDef, {
          input: (next: Value) => {
            this.doc.setValue(id, input, next, `${id}.${input}`);
            this.sound.play("tick");
          },
          commit: () => this.doc.endGesture(),
        }));
        if (inputDef.optional) {
          const clear = document.createElement("button");
          clear.type = "button";
          clear.className = "fx-clear fx-edit";
          clear.textContent = "×";
          clear.title = "Unset";
          clear.addEventListener("click", () => this.doc.clearValue(id, input));
          row.append(clear);
        }
      }
      if (boundary === "out") {
        row.append(this.removePortButton("out", input));
      }
      rows.append(row);
    }
    if (boundary === "out") {
      rows.append(this.newPortRow(view, "in"));
    }

    for (const [option, optionDef] of Object.entries(def.options ?? {})) {
      const row = document.createElement("div");
      row.className = "fx-row opt";
      const label = document.createElement("span");
      label.className = "fx-label";
      label.textContent = option;
      row.append(label);
      const value = node.options?.[option] ?? optionDef.default;
      if (optionDef.choices) {
        row.append(choice(String(value), optionDef.choices, { input: (next) => this.doc.setOption(id, option, next), commit: () => {} }));
      } else {
        let pending = Number(value);
        row.append(scrubber(pending, { min: optionDef.min, max: optionDef.max, integer: true }, {
          input: (next) => {
            pending = next;
            this.sound.play("tick");
          },
          commit: () => this.doc.setOption(id, option, pending),
        }));
      }
      rows.append(row);
    }
  }

  private removePortButton(dir: "in" | "out", port: string) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "fx-clear fx-edit fx-port-remove";
    button.textContent = "×";
    button.title = `Remove the group's ${dir === "in" ? "input" : "output"} ${port}`;
    button.addEventListener("click", () => {
      this.doc.removeGroupPort(dir, port);
      this.sound.play("delete");
    });
    return button;
  }

  private newPortRow(view: NodeView, dir: "in" | "out") {
    const row = document.createElement("div");
    row.className = `fx-row ${dir} new-port`;
    const label = document.createElement("span");
    label.className = "fx-label";
    label.textContent = dir === "out" ? "drop a wire: new input" : "drop a wire: new output";
    const port = this.portElement(view, dir, NEW_PORT, "float");
    port.classList.add("new");
    port.title = "Drop a wire here to add a port to the group";
    row.append(...(dir === "in" ? [port, label] : [label, port]));
    return row;
  }

  private portElement(view: NodeView, dir: "in" | "out", name: string, type: PortType) {
    const el = document.createElement("span");
    el.className = `fx-port ${dir} type-${type}`;
    el.dataset.node = view.id;
    el.dataset.dir = dir;
    el.dataset.port = name;
    el.title = type;
    (dir === "in" ? view.ins : view.outs).set(name, { el, type, x: 0, y: 0 });
    return el;
  }

  private measure(view: NodeView) {
    view.width = view.el.offsetWidth;
    view.height = view.el.offsetHeight;
    for (const port of [...view.ins.values(), ...view.outs.values()]) {
      let x = port.el.offsetWidth / 2;
      let y = port.el.offsetHeight / 2;
      for (let e: HTMLElement | null = port.el; e && e !== view.el; e = e.offsetParent as HTMLElement | null) {
        x += e.offsetLeft;
        y += e.offsetTop;
      }
      port.x = x;
      port.y = y;
    }
  }

  private moveTo(view: NodeView, x: number, y: number, instant = this.instant) {
    view.x.target = x;
    view.y.target = y;
    if (instant) {
      view.x.snap();
      view.y.snap();
    }
    view.dirty = true;
    this.animator.wake();
  }

  private tick(dt: number) {
    const { stiffness, damping, tilt } = this.motion;
    const instant = this.instant;
    let active = this.stepLevelMove(dt);

    if (this.camAnimating) {
      const { x, y, zoom } = this.camSprings;
      const moving = [x.step(dt, stiffness * 0.7, 1), y.step(dt, stiffness * 0.7, 1), zoom.step(dt, stiffness * 0.7, 1)].some(Boolean);
      this.cam = { x: x.value, y: y.value, zoom: zoom.value };
      this.applyCamera();
      this.camAnimating = moving;
      active ||= moving;
    }

    const moved = new Set<string>();
    for (const view of this.nodes.values()) {
      let moving = false;
      if (instant) {
        view.x.snap();
        view.y.snap();
        view.scale.snap();
      } else {
        moving = view.x.step(dt, stiffness, damping);
        moving = view.y.step(dt, stiffness, damping) || moving;
        moving = view.scale.step(dt, stiffness * 1.4, damping * 0.6) || moving;
      }
      if (moving || view.dirty || view.moving) {
        const angle = instant ? 0 : clamp(view.x.velocity * tilt, -12, 12);
        view.el.style.transform = `translate3d(${view.x.value.toFixed(2)}px, ${view.y.value.toFixed(2)}px, 0) rotate(${angle.toFixed(2)}deg) scale(${view.scale.value.toFixed(4)})`;
        view.dirty = moving;
        moved.add(view.id);
      }
      view.moving = moving;
      active ||= moving;
    }

    for (const wire of this.wires.values()) {
      if (wire.awake || moved.has(splitPort(wire.from)[0]) || moved.has(splitPort(wire.to)[0])) {
        this.updateWire(wire, dt);
        active ||= wire.awake;
      }
    }
    if (this.drag?.kind === "wire") {
      this.updateTemp();
    }
    return active;
  }

  private portPosition(port: string, dir: "in" | "out"): [number, number] | undefined {
    const [node, name] = splitPort(port);
    const view = this.nodes.get(node);
    const p = view && (dir === "in" ? view.ins : view.outs).get(name);
    return view && p ? [view.x.value + p.x, view.y.value + p.y] : undefined;
  }

  private addWire(from: string, to: string, fresh: boolean) {
    const [fromNode, fromPort] = splitPort(from);
    const type = this.doc.def(fromNode)?.outputs[fromPort] ?? "float";
    const group = document.createElementNS(SVG, "g");
    group.classList.add("fx-wire", `type-${type}`);
    if (fresh && !this.instant) {
      group.classList.add("fresh");
    }
    const path = document.createElementNS(SVG, "path");
    path.classList.add("fx-wire-path");
    const flow = document.createElementNS(SVG, "path");
    flow.classList.add("fx-flow");
    group.append(path, flow);
    this.wireLayer.append(group);
    const wire: WireView = { from, to, type, group, path, flow, awake: true };
    this.wires.set(to, wire);
    return wire;
  }

  // At its target and not being dragged
  private resting(id: string) {
    const view = this.nodes.get(id);
    const dragged = this.drag?.kind === "nodes" && this.drag.items.some((item) => item.view === view);
    return Boolean(view && !dragged && view.x.value === view.x.target && view.y.value === view.y.target);
  }

  private obstacles(): Obstacle[] {
    return [...this.nodes.values()].map((view) => ({ id: view.id, x: view.x.target, y: view.y.target, w: view.width, h: view.height }));
  }

  // Its wires get new routes once it rests
  private dropRoutes(node: string) {
    for (const wire of this.wires.values()) {
      if (splitPort(wire.from)[0] === node || splitPort(wire.to)[0] === node) {
        wire.route = undefined;
        wire.awake = true;
      }
    }
  }

  private updateWire(wire: WireView, dt: number) {
    const a = this.portPosition(wire.from, "out");
    const b = this.portPosition(wire.to, "in");
    if (!a || !b) {
      return;
    }
    let d: string;
    const [fromNode, toNode] = [splitPort(wire.from)[0], splitPort(wire.to)[0]];
    // Resting wires take right-angle routes (with ropes only backward ones), moving ones curves
    if (this.resting(fromNode) && this.resting(toNode) && (this.theme.wire !== "rope" || b[0] < a[0])) {
      // A stored route that no longer leaves and enters its ports sideways is replaced
      let route = wire.route && fitRoute(wire.route, a, b);
      if (!route || !routeOk(route, a, b)) {
        route = wire.route = orthoRoute(a, b, this.obstacles(), [fromNode, toNode]);
      }
      wire.rope = undefined;
      wire.awake = false;
      d = orthoPath(route);
    } else if (this.theme.wire === "rope" && !this.instant) {
      wire.rope ??= new Rope(a[0], a[1], b[0], b[1]);
      wire.awake = wire.rope.step(dt, a[0], a[1], b[0], b[1]);
      d = wire.rope.path();
    } else {
      wire.rope = undefined;
      wire.awake = false;
      d = bezierPath(a[0], a[1], b[0], b[1]);
    }
    wire.path.setAttribute("d", d);
    wire.flow.setAttribute("d", d);
  }

  screenToWorld(x: number, y: number): [number, number] {
    return [(x - this.cam.x) / this.cam.zoom, (y - this.cam.y) / this.cam.zoom];
  }

  worldToScreen(x: number, y: number): [number, number] {
    return [x * this.cam.zoom + this.cam.x, y * this.cam.zoom + this.cam.y];
  }

  private applyCamera() {
    const { x, y, zoom } = this.cam;
    this.world.style.transform = `translate(${x}px, ${y}px) scale(${zoom})`;
    this.root.style.setProperty("--cam-x", `${x}px`);
    this.root.style.setProperty("--cam-y", `${y}px`);
    this.root.style.setProperty("--zoom", String(zoom));
    // Semantic zoom holds still while a level move sweeps the zoom
    if (!this.levelMove) {
      this.root.classList.toggle("zoom-mid", zoom < 0.5);
      this.root.classList.toggle("zoom-far", zoom < 0.32);
    }
  }

  private setCamera(x: number, y: number, zoom: number, animate: boolean) {
    const springs = this.camSprings;
    if (animate && !this.instant) {
      springs.x.value = this.cam.x;
      springs.y.value = this.cam.y;
      springs.zoom.value = this.cam.zoom;
      springs.x.target = x;
      springs.y.target = y;
      springs.zoom.target = zoom;
      this.camAnimating = true;
      this.animator.wake();
    } else {
      this.camAnimating = false;
      this.cam = { x, y, zoom };
      this.applyCamera();
    }
  }

  private zoomAt(sx: number, sy: number, factor: number) {
    const zoom = clamp(this.cam.zoom * factor, MIN_ZOOM, MAX_ZOOM);
    const k = zoom / this.cam.zoom;
    this.setCamera(sx - (sx - this.cam.x) * k, sy - (sy - this.cam.y) * k, zoom, false);
  }

  // Frame every node where it is headed, or at positions
  fit({ animate = true, positions }: { animate?: boolean; positions?: Map<string, [number, number]> } = {}) {
    if (this.nodes.size === 0) {
      return;
    }
    const cam = this.fitCamera(positions);
    this.setCamera(cam.x, cam.y, cam.zoom, animate);
  }

  // Where every node is headed, or positions: [x0, y0, x1, y1]
  private bounds(positions?: Map<string, [number, number]>): [number, number, number, number] {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const [id, view] of this.nodes) {
      const [x, y] = positions?.get(id) ?? [view.x.target, view.y.target];
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x + view.width);
      y1 = Math.max(y1, y + view.height);
    }
    return this.nodes.size ? [x0, y0, x1, y1] : [0, 0, 1, 1];
  }

  private fitCamera(positions?: Map<string, [number, number]>): Cam {
    const [x0, y0, x1, y1] = this.bounds(positions);
    const width = this.root.clientWidth;
    const height = this.root.clientHeight;
    const pad = 40;
    // The whole graph unless too small to read, else it overflows and pans
    const zoom = clamp(Math.min((width - 2 * pad) / Math.max(1, x1 - x0), (height - 2 * pad) / Math.max(1, y1 - y0)), 0.36, 1.1);
    const x = (x1 - x0) * zoom > width - 2 * pad ? pad - x0 * zoom : width / 2 - ((x0 + x1) / 2) * zoom;
    const y = (y1 - y0) * zoom > height - 2 * pad ? pad - y0 * zoom : height / 2 - ((y0 + y1) / 2) * zoom;
    return { x, y, zoom };
  }

  async layout({ animate = true, quiet = false }: { animate?: boolean; quiet?: boolean } = {}) {
    const boxes = new Map<string, NodeBox>();
    for (const [id, view] of this.nodes) {
      boxes.set(id, {
        width: view.width,
        height: view.height,
        ports: [
          ...[...view.ins].map(([name, port]) => ({ name, side: "in" as const, x: port.x, y: port.y })),
          ...[...view.outs].map(([name, port]) => ({ name, side: "out" as const, x: port.x, y: port.y })),
        ],
      });
    }
    let positions: Map<string, [number, number]>;
    let routes: Map<string, [number, number][]>;
    try {
      ({ positions, routes } = await autoLayout(this.doc.level, boxes, this.settings, { width: this.root.clientWidth, height: this.root.clientHeight }));
    } catch (error) {
      this.juice.toast(`layout failed: ${String(error)}`, "error");
      this.nodes.forEach((view) => view.el.classList.remove("pending"));
      this.root.classList.remove("appearing");
      return;
    }
    for (const wire of this.wires.values()) {
      wire.route = routes.get(wire.to);
      wire.awake = true;
    }
    const instant = !animate || this.instant;
    // Hidden new nodes appear in place left to right, then the wires fade in
    const appearing = [...this.nodes.values()].some((view) => view.el.classList.contains("pending"));
    let last = 0;
    for (const [id, [x, y]] of positions) {
      const view = this.nodes.get(id);
      if (!view?.el.classList.contains("pending")) {
        continue;
      }
      this.moveTo(view, x, y, true);
      const delay = instant ? 0 : Math.min(450, x * 0.3);
      last = Math.max(last, delay);
      setTimeout(() => {
        view.el.classList.remove("pending");
        if (!instant) {
          view.scale.value = 0.85;
          view.scale.velocity = 1.5;
        }
        this.animator.wake();
      }, delay);
    }
    if (appearing) {
      setTimeout(() => this.root.classList.remove("appearing"), last + 180);
    }
    for (const [id, [x, y]] of positions) {
      const view = this.nodes.get(id);
      if (!view || (view.x.target === x && view.y.target === y)) {
        continue;
      }
      const delay = instant ? 0 : x * this.motion.stagger;
      const go = () => {
        this.moveTo(view, x, y, instant);
        if (!instant) {
          view.scale.velocity += 1.2;
        }
      };
      if (delay > 0) {
        setTimeout(go, delay);
      } else {
        go();
      }
    }
    // Staggered nodes get their targets later: the doc change must not move
    // them now, and the fit frames the layout itself
    this.laying = true;
    this.doc.moveNodes(positions);
    this.laying = false;
    if (!quiet) {
      this.fit({ animate: !instant && !appearing, positions });
      this.sound.play("drop");
    }
  }

  setFlow(on: boolean) {
    this.flow = on;
    this.applyFlow();
    this.onFlow?.(on);
  }

  setProbe(port: string | undefined) {
    this.probe = port;
    this.applyProbe();
  }

  setErrors(errors: string[]) {
    this.errors = errors;
    this.applyErrors();
  }

  private applyFlow() {
    const graph = this.doc.level;
    const reach = upstreamOf(graph, flowRoots(graph, this.doc.lookup));
    const depth = depths(graph);
    const deepest = Math.max(0, ...[...reach].map((id) => depth.get(id) ?? 0));
    const period = 1 / Math.max(0.05, this.settings.flowSpeed);
    this.root.classList.toggle("flow-on", this.flow);
    this.root.style.setProperty("--flow-period", `${period.toFixed(3)}s`);
    const delay = (id: string) => `${(((depth.get(id) ?? 0) / (deepest + 1)) * period).toFixed(3)}s`;
    for (const [id, view] of this.nodes) {
      view.el.style.setProperty("--flow-delay", delay(id));
      view.el.classList.toggle("unreached", !reach.has(id));
      view.el.classList.toggle("timed", Boolean(this.doc.def(id)?.time));
    }
    for (const wire of this.wires.values()) {
      const from = splitPort(wire.from)[0];
      wire.group.style.setProperty("--flow-delay", delay(from));
      wire.group.classList.toggle("unreached", !reach.has(splitPort(wire.to)[0]));
    }
  }

  private applyProbe() {
    const node = this.probe ? splitPort(this.probe)[0] : undefined;
    const on = Boolean(node && this.nodes.has(node));
    const chain = on ? upstreamOf(this.doc.level, [node!]) : new Set<string>();
    this.root.classList.toggle("probing", on);
    for (const [id, view] of this.nodes) {
      view.el.classList.toggle("probe-chain", chain.has(id));
      view.el.classList.toggle("probed", id === node);
    }
    for (const wire of this.wires.values()) {
      wire.group.classList.toggle("probe-chain", chain.has(splitPort(wire.from)[0]) && chain.has(splitPort(wire.to)[0]));
    }
    this.root.querySelectorAll<HTMLElement>(".fx-eye").forEach((eye) => eye.classList.toggle("on", eye.dataset.port === this.probe));
  }

  // Marks the nodes that validation messages name
  private applyErrors() {
    const byNode = new Map<string, string[]>();
    const mark = (id: string | undefined, message: string) => {
      if (id && this.nodes.has(id)) {
        byNode.set(id, [...(byNode.get(id) ?? []), message]);
      }
    };
    const here = this.doc.groupName;
    for (const full of this.errors) {
      // Messages about a group's inside show there; elsewhere they mark its cards
      const inGroup = /^Group ([^:\s]+): (.*)$/.exec(full);
      if (inGroup && inGroup[1] !== here) {
        for (const [id, node] of Object.entries(this.doc.level.nodes)) {
          if (groupOf(node.type) === inGroup[1]) {
            mark(id, full);
          }
        }
        continue;
      }
      if (!inGroup && here !== undefined) {
        continue;
      }
      const message = inGroup ? inGroup[2] : full.replace(/^(Node [^/\s:(]+)\/\S+/, "$1");
      const cycle = /^Cycle through (.+)$/.exec(message);
      if (cycle) {
        cycle[1].split(" -> ").forEach((id) => mark(id, message));
        continue;
      }
      const link = /^Link ([^.\s]+)\.\S+ -> ([^.\s]+)\./.exec(message);
      if (link) {
        mark(link[1], message);
        mark(link[2], message);
        continue;
      }
      const match = /^Node ([^\s:(]+)/.exec(message) ?? /^Input ([^.\s]+)\./.exec(message) ?? /^Param "[^"]*": (?:no input |optional input )?([^.\s]+)\./.exec(message);
      mark(match?.[1], message);
    }
    for (const [id, view] of this.nodes) {
      const messages = byNode.get(id);
      view.el.classList.toggle("has-error", Boolean(messages));
      view.el.querySelector(".fx-head")?.setAttribute("data-error", messages?.join("\n") ?? "");
    }
    return byNode;
  }

  shakeErrors() {
    for (const view of this.nodes.values()) {
      if (view.el.classList.contains("has-error")) {
        this.juice.shake(view.el, this.theme.name === "neon" ? "fx-glitch" : "fx-shake");
      }
    }
  }

  celebrate() {
    for (const id of outputNodes(this.doc.level, this.doc.lookup)) {
      const view = this.nodes.get(id);
      if (view) {
        this.juice.burst(view.x.target + view.width / 2, view.y.target + 16, { count: this.theme.burst === "confetti" ? 26 : undefined });
        this.juice.shake(view.el, "fx-pop");
      }
    }
  }

  setTheme(theme: Theme) {
    this.theme = theme;
    this.juice.theme = theme;
    let i = 0;
    for (const view of this.nodes.values()) {
      this.measure(view);
      if (!this.instant) {
        const kick = () => {
          view.scale.velocity -= 1.5;
          this.animator.wake();
        };
        setTimeout(kick, (i += 1) * 18);
      }
    }
    for (const wire of this.wires.values()) {
      wire.rope = undefined;
      wire.awake = true;
    }
    this.animator.wake();
  }

  // Motion or flow settings changed
  refresh() {
    this.applyFlow();
    this.nodes.forEach((view) => (view.dirty = true));
    this.wires.forEach((wire) => (wire.awake = true));
    this.animator.wake();
  }

  undo() {
    if (this.doc.undo()) {
      this.sound.play("pick");
    }
  }

  redo() {
    if (this.doc.redo()) {
      this.sound.play("pick");
    }
  }

  // Screen center of a node or port, for scripted tours
  locate(node: string, port?: { dir: "in" | "out"; name: string }) {
    const view = this.nodes.get(node);
    if (!view) {
      return undefined;
    }
    const rect = this.root.getBoundingClientRect();
    const p = port ? (port.dir === "in" ? view.ins : view.outs).get(port.name) : undefined;
    const [x, y] = this.worldToScreen(view.x.value + (p ? p.x : view.width / 2), view.y.value + (p ? p.y : 14));
    return { x: rect.left + x, y: rect.top + y };
  }

  // Lays out a new level and returns its last camera, else a fit
  private async settle(): Promise<Cam> {
    if (Object.values(this.doc.level.nodes).some((node) => !node.position)) {
      await this.layout({ animate: false, quiet: true });
    }
    return this.levelCams.get(this.levelKey) ?? this.fitCamera();
  }

  // A still copy of the level on screen to animate while the layer shows the next
  private makeGhost(card?: string) {
    const ghost = this.world.cloneNode(true) as HTMLElement;
    ghost.classList.add("fx-ghost");
    ghost.setAttribute("aria-hidden", "true");
    if (card) {
      ghost.querySelector(`.fx-node[data-id="${CSS.escape(card)}"]`)?.classList.add("zoom-card");
    }
    return ghost;
  }

  // The parent camera that lays the card (world box r) over the inside's box b
  // as the inside's camera f frames it
  private cardCamera(r: [number, number, number, number], b: [number, number, number, number], f: Cam): Cam {
    const [bx0, by0, bx1, by1] = [b[0] * f.zoom + f.x, b[1] * f.zoom + f.y, b[2] * f.zoom + f.x, b[3] * f.zoom + f.y];
    const zoom = Math.max((bx1 - bx0) / Math.max(1, r[2] - r[0]), (by1 - by0) / Math.max(1, r[3] - r[1]));
    return { zoom, x: (bx0 + bx1) / 2 - ((r[0] + r[2]) / 2) * zoom, y: (by0 + by1) / 2 - ((r[1] + r[3]) / 2) * zoom };
  }

  // The parent zooms through the card as the inside grows out of it
  async enter(id: string) {
    const view = this.nodes.get(id);
    if (!view || this.navigating || !this.doc.isGroupNode(id)) {
      return;
    }
    this.navigating = true;
    if (this.probe) {
      this.onProbe?.(undefined);
    }
    const c0 = { ...this.cam };
    this.levelCams.set(this.levelKey, c0);
    const card: [number, number, number, number] = [view.x.target, view.y.target, view.x.target + view.width, view.y.target + view.height];
    const ghost = this.makeGhost(id);
    this.root.insertBefore(ghost, this.world);
    this.world.style.opacity = "0";
    this.doc.enter(id);
    const f = await this.settle();
    const cardEl = ghost.querySelector<HTMLElement>(".zoom-card") ?? undefined;
    this.startLevelMove({ ghost, entering: true, c0, cz: this.cardCamera(card, this.bounds(), f), f, card: [(card[0] + card[2]) / 2, (card[1] + card[3]) / 2], from: 0, to: 1, cardEl });
    this.sound.play("open");
    this.onLevel?.();
  }

  // Back up to depth (default one level): the inside shrinks into its card
  async exit(depth = this.doc.path.length - 1) {
    if (depth < 0 || depth >= this.doc.path.length || this.navigating) {
      return;
    }
    this.navigating = true;
    if (this.probe) {
      this.onProbe?.(undefined);
    }
    const anchor = this.doc.path[depth];
    const f = { ...this.cam };
    this.levelCams.set(this.levelKey, f);
    const inside = this.bounds();
    const ghost = this.makeGhost();
    this.root.insertBefore(ghost, this.world.nextSibling);
    this.world.style.opacity = "0";
    this.doc.exit(depth);
    const c0 = await this.settle();
    const view = this.nodes.get(anchor);
    const [x0, y0, x1, y1] = this.bounds();
    const card: [number, number, number, number] = view
      ? [view.x.target, view.y.target, view.x.target + view.width, view.y.target + view.height]
      : [(x0 + x1) / 2 - 90, (y0 + y1) / 2 - 50, (x0 + x1) / 2 + 90, (y0 + y1) / 2 + 50];
    view?.el.classList.add("zoom-card");
    this.startLevelMove({ ghost, entering: false, c0, cz: this.cardCamera(card, inside, f), f, card: [(card[0] + card[2]) / 2, (card[1] + card[3]) / 2], from: 1, to: 0, cardEl: view?.el });
    if (view) {
      this.selection = new Set([anchor]);
      this.applySelection();
    }
    this.sound.play("pick");
    this.onLevel?.();
  }

  private startLevelMove(move: Omit<LevelMove, "t" | "duration">) {
    this.camAnimating = false;
    this.levelMove = { ...move, t: 0, duration: this.instant ? 0 : 0.62 };
    this.root.classList.add("level-moving");
    this.stepLevelMove(0);
    this.animator.wake();
  }

  // Both levels' cameras come from one eased p, so the inside stays on the card
  private stepLevelMove(dt: number): boolean {
    const move = this.levelMove;
    if (!move) {
      return false;
    }
    move.t = Math.min(move.duration, move.t + dt);
    const k = move.duration > 0 ? easeInOut(move.t / move.duration) : 1;
    const p = move.from + (move.to - move.from) * k;
    const { c0, cz, card: [cx, cy] } = move;
    const zoom = c0.zoom * (cz.zoom / c0.zoom) ** p;
    const sx = cx * c0.zoom + c0.x + (cx * cz.zoom + cz.x - (cx * c0.zoom + c0.x)) * p;
    const sy = cy * c0.zoom + c0.y + (cy * cz.zoom + cz.y - (cy * c0.zoom + c0.y)) * p;
    const parent: Cam = { zoom, x: sx - cx * zoom, y: sy - cy * zoom };
    const inside = compose(compose(parent, invert(cz)), move.f);
    const parentOpacity = 1 - smooth(0.35, 0.9, p);
    const insideOpacity = smooth(0.12, 0.6, p);
    this.cam = move.entering ? inside : parent;
    this.applyCamera();
    move.ghost.style.transform = camCss(move.entering ? parent : inside);
    move.ghost.style.opacity = String(move.entering ? parentOpacity : insideOpacity);
    this.world.style.opacity = String(move.entering ? insideOpacity : parentOpacity);
    move.cardEl?.style.setProperty("--open", p.toFixed(3));
    if (move.t < move.duration) {
      return true;
    }
    move.cardEl?.classList.remove("zoom-card");
    move.cardEl?.style.removeProperty("--open");
    move.ghost.remove();
    this.world.style.opacity = "";
    this.levelMove = undefined;
    this.navigating = false;
    this.root.classList.remove("level-moving");
    this.cam = move.entering ? { ...move.f } : { ...move.c0 };
    this.applyCamera();
    return false;
  }

  private updateCrumbs() {
    const path = this.doc.path;
    this.crumbs.replaceChildren();
    this.crumbs.hidden = path.length === 0;
    this.root.classList.toggle("in-group", path.length > 0);
    if (path.length === 0) {
      return;
    }
    const back = document.createElement("button");
    back.type = "button";
    back.className = "fx-crumb-back";
    back.textContent = "‹";
    back.title = "Up a level (Esc, ⌘↑)";
    back.addEventListener("click", () => void this.exit());
    this.crumbs.append(back);
    const labels = [this.doc.graph.name ?? "graph"];
    let level = this.doc.graph as { nodes: Record<string, { type: string }> };
    for (const id of path) {
      const name = groupOf(level.nodes[id]?.type ?? "") ?? "";
      const group = this.doc.graph.groups?.[name];
      labels.push(group?.label ?? name);
      level = group ?? level;
    }
    labels.forEach((text, i) => {
      if (i > 0) {
        const sep = document.createElement("span");
        sep.className = "fx-crumb-sep";
        sep.textContent = "›";
        this.crumbs.append(sep);
      }
      if (i < path.length) {
        const crumb = document.createElement("button");
        crumb.type = "button";
        crumb.className = "fx-crumb";
        crumb.textContent = text;
        crumb.title = i === 0 ? "Back to the top" : `Back to ${text}`;
        crumb.addEventListener("click", () => void this.exit(i));
        this.crumbs.append(crumb);
        return;
      }
      const current = document.createElement("span");
      current.className = "fx-crumb current";
      current.textContent = text;
      current.title = "Double-click to rename this group";
      current.addEventListener("dblclick", () => {
        current.contentEditable = "true";
        current.focus();
        getSelection()?.selectAllChildren(current);
      });
      current.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === "Escape") {
          event.preventDefault();
          if (event.key === "Escape") {
            current.textContent = text;
          }
          current.blur();
        }
        event.stopPropagation();
      });
      current.addEventListener("blur", () => {
        current.contentEditable = "false";
        this.doc.renameGroup(current.textContent ?? "");
      });
      this.crumbs.append(current);
    });
  }

  // The nodes pull together before the card replaces them
  groupSelection() {
    const ids = [...this.selection].filter((id) => {
      const type = this.doc.level.nodes[id]?.type;
      return this.nodes.has(id) && type !== GROUP_INPUT && type !== GROUP_OUTPUT && !this.doc.def(id)?.output;
    });
    const problem = ids.length === 0 ? "select nodes to group (Shift-drag)" : this.doc.groupProblem(ids);
    if (problem) {
      this.juice.toast(problem, "error");
      this.sound.play("error");
      return;
    }
    const views = ids.map((id) => this.nodes.get(id)!);
    const cx = views.reduce((sum, v) => sum + v.x.target + v.width / 2, 0) / views.length;
    const cy = views.reduce((sum, v) => sum + v.y.target + v.height / 2, 0) / views.length;
    if (!this.instant) {
      for (const view of views) {
        this.moveTo(view, cx - view.width / 2, cy - view.height / 2);
        view.scale.target = 0.55;
      }
    }
    setTimeout(() => {
      const id = this.doc.groupNodes(ids);
      views.forEach((view) => (view.scale.target = 1));
      if (!id) {
        return;
      }
      this.selection = new Set([id]);
      this.applySelection();
      const view = this.nodes.get(id);
      if (view) {
        this.moveTo(view, cx - view.width / 2, cy - view.height / 2, true);
        this.doc.moveNodes(new Map([[id, [view.x.target, view.y.target]]]));
        this.juice.burst(cx, cy, { count: this.theme.burst === "confetti" ? 22 : 14 });
      }
      this.juice.toast("grouped: double-click the card to open it", "ok");
      this.sound.play("add");
    }, this.instant ? 0 : 220);
  }

  ungroupSelection() {
    const groups = [...this.selection].filter((id) => this.doc.isGroupNode(id));
    if (groups.length === 0) {
      this.juice.toast("select a group card to ungroup", "error");
      this.sound.play("error");
      return;
    }
    const placed: string[] = [];
    for (const id of groups) {
      const card = this.nodes.get(id);
      const [ox, oy] = card ? [card.x.value + card.width / 2, card.y.value + card.height / 2] : [0, 0];
      const ids = this.doc.ungroup(id);
      for (const nodeId of ids) {
        const view = this.nodes.get(nodeId);
        if (view && card && !this.instant) {
          view.x.value = ox - view.width / 2;
          view.y.value = oy - view.height / 2;
          view.scale.value = 0.4;
          view.dirty = true;
        }
      }
      placed.push(...ids);
    }
    this.selection = new Set(placed);
    this.applySelection();
    this.sound.play("open");
    this.animator.wake();
  }

  toggleGroup() {
    const ids = [...this.selection];
    if (ids.length > 0 && ids.every((id) => this.doc.isGroupNode(id))) {
      this.ungroupSelection();
    } else {
      this.groupSelection();
    }
  }

  private local(event: { clientX: number; clientY: number }): [number, number] {
    const rect = this.root.getBoundingClientRect();
    return [event.clientX - rect.left, event.clientY - rect.top];
  }

  private pointerDown(event: PointerEvent) {
    const target = event.target as HTMLElement;
    [this.pointer.x, this.pointer.y] = this.local(event);
    if (this.palette.open && !target.closest(".fx-palette")) {
      this.palette.hide();
    }
    if (this.drag || target.closest(".fx-palette")) {
      return;
    }
    const port = target.closest<HTMLElement>(".fx-port");
    if (port && event.button === 0) {
      this.startWire(port, event);
      return;
    }
    if (target.closest(".fx-edit, input, select, button, textarea")) {
      return;
    }
    const [sx, sy] = this.local(event);
    const nodeEl = target.closest<HTMLElement>(".fx-node");
    if (nodeEl && event.button === 0 && !this.space) {
      this.startNodeDrag(nodeEl.dataset.id!, event);
    } else if (event.button === 0 && event.shiftKey) {
      this.drag = { kind: "marquee", pointer: event.pointerId, x: sx, y: sy, base: new Set(this.selection) };
      this.marquee.hidden = false;
      this.updateMarquee(sx, sy);
    } else {
      if (event.button === 0 && !nodeEl && !this.space && !event.shiftKey && this.selection.size > 0) {
        this.selection.clear();
        this.applySelection();
      }
      this.drag = { kind: "pan", pointer: event.pointerId, x: sx, y: sy };
      this.root.classList.add("panning");
    }
    this.root.setPointerCapture(event.pointerId);
    this.root.focus({ preventScroll: true });
  }

  private startNodeDrag(id: string, event: PointerEvent) {
    if (event.shiftKey) {
      if (this.selection.has(id)) {
        this.selection.delete(id);
      } else {
        this.selection.add(id);
      }
    } else if (!this.selection.has(id)) {
      this.selection.clear();
      this.selection.add(id);
    }
    this.applySelection();
    const [x, y] = this.screenToWorld(...this.local(event));
    const items = [...this.selection].flatMap((selected) => {
      const view = this.nodes.get(selected);
      return view ? [{ view, x: view.x.target, y: view.y.target }] : [];
    });
    for (const { view } of items) {
      this.dropRoutes(view.id);
      view.el.classList.add("dragging");
      view.el.style.zIndex = String((this.zTop += 1));
      view.scale.target = 1.04;
    }
    this.drag = { kind: "nodes", pointer: event.pointerId, x, y, items, moved: false };
    this.sound.play("pick");
    this.animator.wake();
  }

  private startWire(portEl: HTMLElement, event: PointerEvent) {
    const node = portEl.dataset.node!;
    const name = portEl.dataset.port!;
    if (name === NEW_PORT) {
      return;
    }
    let out = portEl.dataset.dir === "out";
    let anchor = `${node}.${name}`;
    if (!out) {
      const from = this.doc.sourceOf(anchor);
      if (from) {
        // Grab the wire off the input and carry it from its source
        this.doc.unlink(anchor);
        this.sound.play("disconnect");
        out = true;
        anchor = from;
      }
    }
    const [anchorNode, anchorPort] = splitPort(anchor);
    const def = this.doc.def(anchorNode);
    const type = out ? def?.outputs[anchorPort] : def?.inputs[anchorPort]?.type;
    if (!type) {
      return;
    }
    const temp = document.createElementNS(SVG, "g");
    temp.classList.add("fx-wire", "temp", `type-${type}`);
    temp.append(document.createElementNS(SVG, "path"));
    this.wireLayer.append(temp);
    const [sx, sy] = this.local(event);
    this.drag = { kind: "wire", pointer: event.pointerId, out, anchor, type, temp, x0: sx, y0: sy };
    this.root.classList.add("wiring");
    for (const view of this.nodes.values()) {
      for (const [portName, port] of out ? view.ins : view.outs) {
        const other = `${view.id}.${portName}`;
        const ok = !(out ? this.doc.canConnect(anchor, other) : this.doc.canConnect(other, anchor));
        port.el.classList.toggle("compatible", ok);
        port.el.classList.toggle("incompatible", !ok);
      }
    }
    this.root.setPointerCapture(event.pointerId);
    this.sound.play("pick");
    this.updateTemp();
  }

  private updateTemp() {
    const drag = this.drag;
    if (drag?.kind !== "wire") {
      return;
    }
    const anchor = this.portPosition(drag.anchor, drag.out ? "out" : "in");
    if (!anchor) {
      return;
    }
    const end = drag.snapped ? this.portPosition(drag.snapped, drag.out ? "in" : "out") : undefined;
    const [ex, ey] = end ?? this.screenToWorld(this.pointer.x, this.pointer.y);
    const d = drag.out ? bezierPath(anchor[0], anchor[1], ex, ey) : bezierPath(ex, ey, anchor[0], anchor[1]);
    drag.temp.firstElementChild!.setAttribute("d", d);
  }

  private pointerMove(event: PointerEvent) {
    const [sx, sy] = this.local(event);
    const dx = sx - this.pointer.x;
    const dy = sy - this.pointer.y;
    this.pointer.x = sx;
    this.pointer.y = sy;
    const drag = this.drag;
    if (!drag || event.pointerId !== drag.pointer) {
      return;
    }
    if (drag.kind === "pan") {
      this.setCamera(this.cam.x + dx, this.cam.y + dy, this.cam.zoom, false);
    } else if (drag.kind === "nodes") {
      const [wx, wy] = this.screenToWorld(sx, sy);
      const ox = wx - drag.x;
      const oy = wy - drag.y;
      if (!drag.moved && Math.hypot(ox, oy) * this.cam.zoom < 3) {
        return;
      }
      drag.moved = true;
      for (const item of drag.items) {
        this.moveTo(item.view, item.x + ox, item.y + oy);
      }
    } else if (drag.kind === "wire") {
      const [wx, wy] = this.screenToWorld(sx, sy);
      let best: string | undefined;
      let bestDistance = SNAP / this.cam.zoom;
      for (const view of this.nodes.values()) {
        for (const [name, port] of drag.out ? view.ins : view.outs) {
          if (!port.el.classList.contains("compatible")) {
            continue;
          }
          const distance = Math.hypot(view.x.value + port.x - wx, view.y.value + port.y - wy);
          if (distance < bestDistance) {
            bestDistance = distance;
            best = `${view.id}.${name}`;
          }
        }
      }
      if (best !== drag.snapped) {
        this.root.querySelectorAll(".fx-port.hover").forEach((el) => el.classList.remove("hover"));
        if (best) {
          const [node, name] = splitPort(best);
          (drag.out ? this.nodes.get(node)?.ins : this.nodes.get(node)?.outs)?.get(name)?.el.classList.add("hover");
          this.sound.play("tick");
        }
        drag.snapped = best;
      }
      this.updateTemp();
    } else if (drag.kind === "marquee") {
      this.updateMarquee(sx, sy);
    }
  }

  private pointerUp(event: PointerEvent) {
    const drag = this.drag;
    if (!drag || event.pointerId !== drag.pointer) {
      return;
    }
    this.drag = undefined;
    this.root.classList.remove("panning");
    if (drag.kind === "nodes") {
      const positions = new Map<string, [number, number]>();
      for (const { view } of drag.items) {
        view.el.classList.remove("dragging");
        view.dirty = true;
        view.scale.target = 1;
        if (drag.moved) {
          view.scale.velocity -= this.motion.squash;
          positions.set(view.id, [view.x.target, view.y.target]);
        }
      }
      if (drag.moved) {
        this.doc.moveNodes(positions);
        this.sound.play("drop");
      }
      this.animator.wake();
    } else if (drag.kind === "wire") {
      this.endWire(drag, event);
    } else if (drag.kind === "marquee") {
      this.marquee.hidden = true;
    }
  }

  private endWire(drag: Extract<Drag, { kind: "wire" }>, event: PointerEvent) {
    drag.temp.remove();
    this.root.classList.remove("wiring");
    this.root.querySelectorAll(".fx-port.compatible, .fx-port.incompatible, .fx-port.hover").forEach((el) => el.classList.remove("compatible", "incompatible", "hover"));
    if (drag.snapped) {
      const [from, to] = drag.out ? [drag.anchor, drag.snapped] : [drag.snapped, drag.anchor];
      const error = this.doc.link(from, to);
      if (error) {
        this.juice.toast(error, "error");
        this.sound.play("error");
      } else {
        const at = this.portPosition(to, "in");
        if (at) {
          this.juice.burst(at[0], at[1], { count: this.theme.burst === "confetti" ? 10 : 8 });
        }
        this.sound.play("connect");
      }
      return;
    }
    const hit = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>(".fx-port");
    if (hit) {
      const other = `${hit.dataset.node}.${hit.dataset.port}`;
      const error = (hit.dataset.dir === "in") === drag.out
        ? (drag.out ? this.doc.canConnect(drag.anchor, other) : this.doc.canConnect(other, drag.anchor))
        : "Connect an output to an input";
      if (error) {
        const nodeEl = hit.closest(".fx-node");
        if (nodeEl) {
          this.juice.shake(nodeEl, this.theme.name === "neon" ? "fx-glitch" : "fx-shake");
        }
        this.juice.toast(error, "error");
        this.sound.play("error");
      }
      return;
    }
    const [sx, sy] = this.local(event);
    if (Math.hypot(sx - drag.x0, sy - drag.y0) < 12) {
      return;
    }
    // Dropped on nothing: add a node that takes the wire
    const type = drag.type;
    const filter = (def: NodeDef) => drag.out
      ? Object.values(def.inputs).some((input) => canLink(type, input.type))
      : Object.values(def.outputs).some((output) => canLink(output, type));
    this.palette.show(sx, sy, (def) => {
      const [wx, wy] = this.screenToWorld(sx, sy);
      const id = this.doc.addNode(def.id, [drag.out ? wx : wx - 190, wy - 30]);
      this.popAdded(id);
      // The first port of the wire's own type, else the first that fits
      if (drag.out) {
        const inputs = Object.entries(def.inputs);
        const input = (inputs.find(([, i]) => i.type === type) ?? inputs.find(([, i]) => canLink(type, i.type)))?.[0];
        if (input) {
          this.doc.link(drag.anchor, `${id}.${input}`);
        }
      } else {
        const outputs = Object.entries(def.outputs);
        const output = (outputs.find(([, o]) => o === type) ?? outputs.find(([, o]) => canLink(o, type)))?.[0];
        if (output) {
          this.doc.link(`${id}.${output}`, drag.anchor);
        }
      }
      this.sound.play("connect");
    }, { filter, title: drag.out ? `takes ${type}` : `gives ${type}` });
    this.sound.play("open");
  }

  private updateMarquee(sx: number, sy: number) {
    const drag = this.drag;
    if (drag?.kind !== "marquee") {
      return;
    }
    const x0 = Math.min(drag.x, sx);
    const y0 = Math.min(drag.y, sy);
    const x1 = Math.max(drag.x, sx);
    const y1 = Math.max(drag.y, sy);
    Object.assign(this.marquee.style, { left: `${x0}px`, top: `${y0}px`, width: `${x1 - x0}px`, height: `${y1 - y0}px` });
    const [wx0, wy0] = this.screenToWorld(x0, y0);
    const [wx1, wy1] = this.screenToWorld(x1, y1);
    this.selection = new Set(drag.base);
    for (const view of this.nodes.values()) {
      if (view.x.value < wx1 && view.x.value + view.width > wx0 && view.y.value < wy1 && view.y.value + view.height > wy0) {
        this.selection.add(view.id);
      }
    }
    this.applySelection();
  }

  private applySelection() {
    for (const [id, view] of this.nodes) {
      view.el.classList.toggle("selected", this.selection.has(id));
    }
  }

  private wheel(event: WheelEvent) {
    if ((event.target as HTMLElement).closest(".fx-palette")) {
      return;
    }
    event.preventDefault();
    const [sx, sy] = this.local(event);
    // Mouse wheels and pinches zoom; two-finger scrolls pan
    const mouseWheel = event.deltaMode === 1 || (event.deltaX === 0 && Math.abs(event.deltaY) >= 40 && Number.isInteger(event.deltaY));
    if (event.ctrlKey || event.metaKey || mouseWheel) {
      const scale = event.deltaMode === 1 ? 0.05 : event.ctrlKey ? 0.012 : 0.0018;
      this.zoomAt(sx, sy, Math.exp(-event.deltaY * scale));
    } else {
      this.setCamera(this.cam.x - event.deltaX, this.cam.y - event.deltaY, this.cam.zoom, false);
    }
  }

  openPalette(sx: number, sy: number) {
    this.palette.show(sx, sy, (def) => {
      const [wx, wy] = this.screenToWorld(sx, sy);
      const id = this.doc.addNode(def.id, [wx - 20, wy - 20]);
      this.popAdded(id);
      this.selection = new Set([id]);
      this.applySelection();
    });
    this.sound.play("open");
  }

  private popAdded(id: string) {
    const view = this.nodes.get(id);
    if (view) {
      this.juice.burst(view.x.target + view.width / 2, view.y.target + view.height / 2, { count: 10 });
    }
    this.sound.play("add");
  }

  deleteSelection() {
    const ids = [...this.selection].filter((id) => this.nodes.has(id));
    if (ids.length === 0) {
      return;
    }
    for (const id of ids) {
      const view = this.nodes.get(id)!;
      this.juice.burst(view.x.value + view.width / 2, view.y.value + view.height / 2, { count: 12 });
    }
    this.selection.clear();
    this.doc.removeNodes(ids);
    this.sound.play("delete");
  }

  private keyDown(event: KeyboardEvent) {
    if (!this.active && !this.root.contains(document.activeElement)) {
      return;
    }
    const target = event.target as HTMLElement;
    if (this.palette.open || target.closest?.("input, textarea, select") || target.isContentEditable) {
      return;
    }
    const mod = event.metaKey || event.ctrlKey;
    const key = event.key.toLowerCase();
    if (event.code === "Space") {
      this.space = true;
      this.root.classList.add("space");
    } else if (event.key === "Tab") {
      this.openPalette(this.pointer.x, this.pointer.y);
    } else if (event.key === "Delete" || event.key === "Backspace") {
      this.deleteSelection();
    } else if (mod && key === "z") {
      if (event.shiftKey) {
        this.redo();
      } else {
        this.undo();
      }
    } else if (mod && key === "y") {
      this.redo();
    } else if (mod && key === "a") {
      this.selection = new Set(this.nodes.keys());
      this.applySelection();
    } else if (mod && key === "g") {
      if (event.shiftKey) {
        this.ungroupSelection();
      } else {
        this.groupSelection();
      }
    } else if ((event.key === "Enter" && !mod) || (mod && event.key === "ArrowDown")) {
      const [only] = this.selection;
      if (this.selection.size !== 1 || !this.doc.isGroupNode(only)) {
        return;
      }
      void this.enter(only);
    } else if (mod && event.key === "ArrowUp") {
      void this.exit();
    } else if (!mod && key === "l") {
      void this.layout();
    } else if (!mod && key === "f") {
      this.fit();
    } else if (!mod && key === "p") {
      this.setFlow(!this.flow);
    } else if (event.key === "Escape") {
      if (this.probe) {
        this.onProbe?.(undefined);
      } else if (this.selection.size > 0 || this.doc.path.length === 0) {
        this.selection.clear();
        this.applySelection();
      } else {
        void this.exit();
      }
    } else {
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
  }
}
