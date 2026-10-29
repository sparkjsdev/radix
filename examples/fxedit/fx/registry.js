// Node definitions by id. `fxNodes` (nodes/index.ts) holds the built-in set;
// make your own registry to add or replace nodes.
                                                        

export class NodeRegistry {
          defs = new Map                 ();

  constructor(defs            = []) {
    this.register(...defs);
  }

  register(...defs           ) {
    for (const def of defs) {
      this.defs.set(def.id, def);
    }
  }

  get(id        )                      {
    return this.defs.get(id);
  }

  list(category               )            {
    return [...this.defs.values()].filter((def) => !category || def.category === category);
  }
}


//# sourceURL=examples/fxedit/fx/registry.ts