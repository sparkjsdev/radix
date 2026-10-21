import { NodeRegistry } from "../registry.js";
import { colorNodes } from "./color.js";
import { fieldNodes } from "./fields.js";
import { inputNodes } from "./inputs.js";
import { mathNodes } from "./math.js";
import { splatNodes } from "./splat.js";
import { worldLabsNodes } from "./worldlabs.js";

export const builtinNodes = [...inputNodes, ...fieldNodes, ...mathNodes, ...colorNodes, ...worldLabsNodes, ...splatNodes];

export const fxNodes = new NodeRegistry(builtinNodes);
