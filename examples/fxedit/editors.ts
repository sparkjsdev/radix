// Inline editors for a node's unlinked inputs and options: number scrubbers
// (drag sideways, Shift for fine steps, click to type), toggles, color
// swatches, vector rows, choice menus. Every editor reports input() while
// it changes and commit() when the gesture ends.
import type { PortType, Value } from "./fx/index.js";

export interface EditHandlers<T> {
  input(value: T): void;
  commit(): void;
}

export interface Range {
  min?: number;
  max?: number;
  step?: number;
  // Hard bounds and whole numbers (options)
  integer?: boolean;
}

export function formatNumber(value: number) {
  if (!Number.isFinite(value)) {
    return String(value);
  }
  const abs = Math.abs(value);
  return String(Number(abs >= 100 ? value.toFixed(1) : abs >= 1 ? value.toFixed(2) : value.toFixed(3)));
}

export function scrubber(value: number, range: Range, handlers: EditHandlers<number>, axis?: string) {
  const el = document.createElement("span");
  el.className = "fx-scrub fx-edit";
  el.tabIndex = 0;
  const fill = document.createElement("span");
  fill.className = "fx-fill";
  const text = document.createElement("span");
  text.className = "fx-num";
  if (axis) {
    const label = document.createElement("span");
    label.className = "fx-axis";
    label.textContent = axis;
    el.append(label);
  }
  el.append(fill, text);

  let current = value;
  const ranged = range.min !== undefined && range.max !== undefined && range.max > range.min;
  const show = (v: number) => {
    text.textContent = formatNumber(v);
    if (ranged) {
      fill.style.width = `${Math.max(0, Math.min(1, (v - range.min!) / (range.max! - range.min!))) * 100}%`;
    }
  };
  const clean = (v: number) => {
    let out = v;
    if (range.integer) {
      out = Math.round(out);
      out = Math.max(range.min ?? -Infinity, Math.min(range.max ?? Infinity, out));
    } else if (range.step) {
      out = Math.round(out / range.step) * range.step;
    }
    return Number(out.toPrecision(6));
  };
  show(current);

  let start: { x: number; value: number; moved: boolean; id: number } | undefined;
  el.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || el.classList.contains("typing")) {
      return;
    }
    event.stopPropagation();
    el.setPointerCapture(event.pointerId);
    start = { x: event.clientX, value: current, moved: false, id: event.pointerId };
    el.classList.add("scrubbing");
  });
  el.addEventListener("pointermove", (event) => {
    if (!start || event.pointerId !== start.id) {
      return;
    }
    const dx = event.clientX - start.x;
    if (!start.moved && Math.abs(dx) < 3) {
      return;
    }
    start.moved = true;
    const rate = (range.integer ? 0.08 : ranged ? (range.max! - range.min!) / 160 : Math.max(Math.abs(start.value), 0.5) * 0.01) * (event.shiftKey ? 0.1 : 1);
    const next = clean(start.value + dx * rate);
    if (next !== current) {
      current = next;
      show(current);
      handlers.input(current);
    }
  });
  const end = (event: PointerEvent) => {
    if (!start || event.pointerId !== start.id) {
      return;
    }
    const moved = start.moved;
    start = undefined;
    el.classList.remove("scrubbing");
    if (moved) {
      handlers.commit();
    } else if (event.type === "pointerup") {
      type();
    }
  };
  el.addEventListener("pointerup", end);
  el.addEventListener("pointercancel", end);
  el.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !el.classList.contains("typing")) {
      event.preventDefault();
      type();
    }
  });

  // Replace the number with a text field until Enter, Escape or blur
  const type = () => {
    el.classList.add("typing");
    const field = document.createElement("input");
    field.className = "fx-type";
    field.value = String(current);
    el.append(field);
    field.focus();
    field.select();
    let done = false;
    const finish = (apply: boolean) => {
      if (done) {
        return;
      }
      done = true;
      const next = Number(field.value);
      field.remove();
      el.classList.remove("typing");
      if (apply && field.value.trim() !== "" && Number.isFinite(next)) {
        current = clean(next);
        show(current);
        handlers.input(current);
        handlers.commit();
      }
    };
    field.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Enter") {
        finish(true);
      } else if (event.key === "Escape") {
        finish(false);
      }
    });
    field.addEventListener("blur", () => finish(true));
    field.addEventListener("pointerdown", (event) => event.stopPropagation());
  };
  return el;
}

const hex = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, "0");

export function colorEditor(value: number[], handlers: EditHandlers<number[]>) {
  const el = document.createElement("label");
  el.className = "fx-color fx-edit";
  const field = document.createElement("input");
  field.type = "color";
  field.value = `#${value.map(hex).join("")}`;
  el.style.setProperty("--swatch", field.value);
  // Above 1 (glow) the swatch shows the clamped color with a ring
  el.classList.toggle("hdr", value.some((v) => v > 1));
  field.addEventListener("input", () => {
    el.style.setProperty("--swatch", field.value);
    const n = parseInt(field.value.slice(1), 16);
    handlers.input([(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => Number((c / 255).toFixed(4))));
  });
  field.addEventListener("change", () => handlers.commit());
  el.append(field);
  return el;
}

export function toggle(value: boolean, handlers: EditHandlers<boolean>) {
  const el = document.createElement("button");
  el.className = "fx-toggle fx-edit";
  el.type = "button";
  let on = value;
  const show = () => {
    el.setAttribute("aria-pressed", String(on));
    el.textContent = on ? "true" : "false";
  };
  show();
  el.addEventListener("click", () => {
    on = !on;
    show();
    handlers.input(on);
    handlers.commit();
  });
  return el;
}

export function choice(value: string, choices: string[], handlers: EditHandlers<string>) {
  const el = document.createElement("select");
  el.className = "fx-choice fx-edit";
  for (const option of choices) {
    el.append(new Option(option, option, false, option === value));
  }
  el.addEventListener("change", () => {
    handlers.input(el.value);
    handlers.commit();
  });
  return el;
}

// The editor for an input of `type`
export function valueEditor(type: PortType, value: Value, range: Range, handlers: EditHandlers<Value>): HTMLElement {
  if (type === "bool") {
    return toggle(Boolean(value), handlers as EditHandlers<boolean>);
  }
  if (type === "float") {
    return scrubber(Number(value), range, handlers as EditHandlers<number>);
  }
  const values = [...(value as number[])];
  if (type === "color") {
    return colorEditor(values, handlers as EditHandlers<number[]>);
  }
  const row = document.createElement("span");
  row.className = "fx-vec fx-edit";
  values.forEach((v, i) => {
    row.append(scrubber(v, range, {
      input: (next) => {
        values[i] = next;
        handlers.input([...values]);
      },
      commit: handlers.commit,
    }, "xyzw"[i]));
  });
  return row;
}
