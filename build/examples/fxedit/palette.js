// Node search: type to filter, arrows and Enter or a click to add. Opened by
// Tab, a double-click on empty canvas, or a wire dropped on nothing (then it
// lists only nodes that can take the wire).
                                                           

const CATEGORIES                 = ["group", "input", "field", "math", "color", "effect", "splat"];

// Subsequence match: higher for consecutive letters and word starts, -1 if
// the letters are not all there in order
export function fuzzyScore(query        , text        ) {
  if (!query) {
    return 0;
  }
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let score = 0;
  let last = -2;
  let at = 0;
  for (const c of q) {
    const i = t.indexOf(c, at);
    if (i < 0) {
      return -1;
    }
    score += 1 + (i === last + 1 ? 3 : 0) + (i === 0 || /[\s._/-]/.test(t[i - 1]) ? 2 : 0);
    last = i;
    at = i + 1;
  }
  return score - t.length * 0.01;
}

export class Palette {
           el             ;
          input                  ;
          list             ;
          title             ;
          defs                 ;
          shown            = [];
          selected = 0;
          filter                            ;
          pick                         ;
  onClose             ;

  // `defs`: what can be added right now (the level decides which groups)
  constructor(parent             , defs                 ) {
    this.defs = defs;
    this.el = document.createElement("div");
    this.el.className = "fx-palette";
    this.el.hidden = true;
    this.title = document.createElement("div");
    this.title.className = "fx-palette-title";
    this.input = document.createElement("input");
    this.input.placeholder = "search nodes…";
    this.input.spellcheck = false;
    this.list = document.createElement("div");
    this.list.className = "fx-palette-list";
    this.el.append(this.title, this.input, this.list);
    parent.append(this.el);

    this.input.addEventListener("input", () => {
      this.selected = 0;
      this.refresh();
    });
    this.input.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        this.selected = (this.selected + (event.key === "ArrowDown" ? 1 : -1) + this.shown.length) % Math.max(1, this.shown.length);
        this.highlight();
      } else if (event.key === "Enter") {
        event.preventDefault();
        const def = this.shown[this.selected];
        if (def) {
          this.choose(def);
        }
      } else if (event.key === "Escape" || event.key === "Tab") {
        event.preventDefault();
        this.hide();
      }
    });
    this.el.addEventListener("pointerdown", (event) => event.stopPropagation());
  }

  get open() {
    return !this.el.hidden;
  }

  // At (x, y) in the parent's coordinates
  show(x        , y        , pick                        , { filter, title = "add node" }                                                         = {}) {
    this.pick = pick;
    this.filter = filter;
    this.title.textContent = title;
    this.input.value = "";
    this.selected = 0;
    this.el.hidden = false;
    const parent = this.el.parentElement .getBoundingClientRect();
    this.el.style.left = `${Math.max(8, Math.min(x, parent.width - 280))}px`;
    this.el.style.top = `${Math.max(8, Math.min(y, parent.height - 340))}px`;
    this.el.classList.remove("popping");
    void this.el.offsetWidth;
    this.el.classList.add("popping");
    this.refresh();
    this.input.focus();
  }

  hide() {
    if (this.open) {
      this.el.hidden = true;
      this.pick = undefined;
      this.onClose?.();
    }
  }

          choose(def         ) {
    const pick = this.pick;
    this.hide();
    pick?.(def);
  }

          refresh() {
    const query = this.input.value.trim();
    const defs = this.defs().filter((def) => !this.filter || this.filter(def));
    this.list.replaceChildren();
    if (query) {
      // Label matches rank above id matches, descriptions last
      const score = (def         ) => Math.max(...[
        [fuzzyScore(query, def.label), 2],
        [fuzzyScore(query, def.id), 0],
        [fuzzyScore(query, def.description ?? ""), -2],
      ].filter(([s]) => s >= 0).map(([s, bonus]) => s + bonus), -1);
      this.shown = defs
        .map((def) => ({ def, score: score(def) }))
        .filter(({ score: s }) => s >= 0)
        .sort((a, b) => b.score - a.score)
        .map(({ def }) => def);
      this.shown.forEach((def, i) => this.list.append(this.item(def, i)));
    } else {
      this.shown = [];
      for (const category of CATEGORIES) {
        const group = defs.filter((def) => def.category === category);
        if (group.length === 0) {
          continue;
        }
        const heading = document.createElement("div");
        heading.className = `fx-palette-group cat-${category}`;
        heading.textContent = category;
        this.list.append(heading);
        for (const def of group) {
          this.list.append(this.item(def, this.shown.length));
          this.shown.push(def);
        }
      }
    }
    if (this.shown.length === 0) {
      const empty = document.createElement("div");
      empty.className = "fx-palette-empty";
      empty.textContent = "nothing fits";
      this.list.append(empty);
    }
    this.highlight();
  }

          item(def         , index        ) {
    const el = document.createElement("div");
    el.className = `fx-palette-item cat-${def.category}`;
    el.dataset.type = def.id;
    el.dataset.index = String(index);
    const label = document.createElement("span");
    label.className = "fx-palette-label";
    label.textContent = def.label;
    const description = document.createElement("span");
    description.className = "fx-palette-desc";
    description.textContent = def.description ?? def.id;
    el.append(label, description);
    el.addEventListener("pointerenter", () => {
      this.selected = index;
      this.highlight();
    });
    el.addEventListener("click", () => this.choose(def));
    return el;
  }

          highlight() {
    this.list.querySelectorAll(".fx-palette-item").forEach((el) => {
      const on = Number((el               ).dataset.index) === this.selected;
      el.classList.toggle("selected", on);
      if (on) {
        el.scrollIntoView({ block: "nearest" });
      }
    });
  }
}


//# sourceURL=examples/fxedit/palette.ts