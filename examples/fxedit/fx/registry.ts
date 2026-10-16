// Node definitions by id. `fxNodes` (nodes/index.ts) holds the built-in set;
// make your own registry to add or replace nodes.
import type { NodeCategory, NodeDef } from "./types.js";

export class NodeRegistry {
  private defs = new Map<string, NodeDef>();

  constructor(defs: NodeDef[] = []) {
    this.register(...defs);
  }

  register(...defs: NodeDef[]) {
    for (const def of defs) {
      this.defs.set(def.id, def);
    }
  }

  get(id: string): NodeDef | undefined {
    return this.defs.get(id);
  }

  list(category?: NodeCategory): NodeDef[] {
    return [...this.defs.values()].filter((def) => !category || def.category === category);
  }
}
