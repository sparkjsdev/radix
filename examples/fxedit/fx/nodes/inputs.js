// Inputs: the splat as it entered the graph, per-splat randomness, time and
// constants. Splat reads come from ctx.source, a copy taken before any write.
import { GpuSplats, TSL } from "@sparkjsdev/radix";
                                           

const { float, hash } = TSL;

export const inputNodes            = [
  {
    id: "input.center",
    label: "Splat center",
    description: "Where the splat is: its position as it entered the graph",
    category: "input",
    inputs: {},
    outputs: { value: "vec3" },
    build: (_, ctx) => ({ value: ctx.source.get("center") }),
  },
  {
    id: "input.rgb",
    label: "Splat color",
    description: "The splat's color as it entered the graph",
    category: "input",
    inputs: {},
    outputs: { value: "color" },
    build: (_, ctx) => ({ value: ctx.source.get("rgb") }),
  },
  {
    id: "input.opacity",
    label: "Splat opacity",
    description: "The splat's opacity as it entered the graph",
    category: "input",
    inputs: {},
    outputs: { value: "float" },
    build: (_, ctx) => ({ value: ctx.source.get("opacity") }),
  },
  {
    id: "input.normal",
    label: "Splat normal",
    description: "The splat's normal: the axis of its smallest scale",
    category: "input",
    inputs: {},
    outputs: { value: "vec3" },
    build: (_, ctx) => ({ value: GpuSplats.normalOf(ctx.source) }),
  },
  {
    id: "input.index",
    label: "Splat index",
    description: "The splat's number, and a stable random value in [0, 1) per splat",
    category: "input",
    inputs: {},
    // random: a hash of the index in [0, 1), stable per splat
    outputs: { index: "float", random: "float" },
    build: (_, ctx) => ({ index: float(ctx.index), random: hash(ctx.index) }),
  },
  {
    id: "input.time",
    label: "Time",
    description: "Seconds since the page loaded: makes things move",
    category: "input",
    inputs: {},
    outputs: { seconds: "float" },
    time: true,
    build: (_, ctx) => ({ seconds: ctx.time }),
  },
  {
    id: "input.click",
    label: "Click",
    description: "Where the scan was last clicked (in the modifier's space) and seconds since",
    category: "input",
    inputs: {},
    outputs: { point: "vec3", age: "float" },
    click: true,
    build: (_, ctx) => ({ point: ctx.click.point, age: ctx.click.age }),
  },
  {
    id: "input.camera",
    label: "Camera",
    description: "Where the camera is and which way it looks (in the modifier's space)",
    category: "input",
    inputs: {},
    // pixelSize: world size of one screen pixel at unit depth
    outputs: { position: "vec3", forward: "vec3", pixelSize: "float" },
    camera: true,
    build: (_, ctx) => ({ position: ctx.camera.position, forward: ctx.camera.forward, pixelSize: ctx.camera.pixelSize }),
  },
  {
    id: "input.float",
    label: "Number",
    description: "A constant number",
    category: "input",
    inputs: { value: { type: "float", default: 0, min: 0, max: 1 } },
    outputs: { value: "float" },
    build: ({ value }) => ({ value }),
  },
  {
    id: "input.vec3",
    label: "Vector",
    description: "A constant vector",
    category: "input",
    inputs: { value: { type: "vec3", default: [0, 0, 0], min: -1, max: 1 } },
    outputs: { value: "vec3" },
    build: ({ value }) => ({ value }),
  },
  {
    id: "input.color",
    label: "Color",
    description: "A constant color",
    category: "input",
    inputs: { value: { type: "color", default: [1, 1, 1] } },
    outputs: { value: "color" },
    build: ({ value }) => ({ value }),
  },
];


//# sourceURL=examples/fxedit/fx/nodes/inputs.ts