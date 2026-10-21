// UI effects: bursts, shakes and toasts as CSS animations on throwaway elements
import type { Theme } from "./themes.js";

export class Juice {
  theme: Theme;
  enabled = !matchMedia("(prefers-reduced-motion: reduce)").matches;
  private layer: HTMLElement;
  private hud: HTMLElement;

  // layer is in world coordinates, hud in screen coordinates
  constructor(layer: HTMLElement, hud: HTMLElement, theme: Theme) {
    this.layer = layer;
    this.hud = hud;
    this.theme = theme;
  }

  burst(x: number, y: number, { color, count, kind = this.theme.burst }: { color?: string; count?: number; kind?: Theme["burst"] } = {}) {
    if (!this.enabled) {
      return;
    }
    const colors = color ? [color, ...this.theme.colors] : this.theme.colors;
    if (kind === "ripple") {
      for (let i = 0; i < (count ?? 2); i += 1) {
        this.spawn("ripple", x, y, { "--delay": `${i * 90}ms`, "--color": colors[i % colors.length] });
      }
      return;
    }
    const n = count ?? (kind === "confetti" ? 18 : 14);
    for (let i = 0; i < n; i += 1) {
      const angle = kind === "confetti" ? -Math.PI / 2 + (Math.random() - 0.5) * 2.2 : (i / n) * Math.PI * 2 + Math.random() * 0.4;
      const distance = kind === "confetti" ? 50 + Math.random() * 60 : 26 + Math.random() * 30;
      this.spawn(kind, x, y, {
        "--dx": `${Math.cos(angle) * distance}px`,
        "--dy": `${Math.sin(angle) * distance}px`,
        "--rot": `${Math.round((Math.random() - 0.5) * 900)}deg`,
        "--angle": `${angle}rad`,
        "--color": colors[i % colors.length],
        "--delay": `${Math.round(Math.random() * 60)}ms`,
      });
    }
  }

  private spawn(kind: string, x: number, y: number, vars: Record<string, string>) {
    const el = document.createElement("i");
    el.className = `fx-particle ${kind}`;
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    for (const [name, value] of Object.entries(vars)) {
      el.style.setProperty(name, value);
    }
    el.addEventListener("animationend", () => el.remove(), { once: true });
    setTimeout(() => el.remove(), 2000);
    this.layer.append(el);
  }

  // Restartable one-shot animation class
  shake(el: Element, name = "fx-shake") {
    if (!this.enabled) {
      return;
    }
    el.classList.remove(name);
    void (el as HTMLElement).offsetWidth;
    el.classList.add(name);
    setTimeout(() => el.classList.remove(name), 700);
  }

  toast(text: string, kind: "info" | "error" | "ok" = "info") {
    const el = document.createElement("div");
    el.className = `fx-toast ${kind}`;
    el.textContent = text;
    this.hud.append(el);
    while (this.hud.children.length > 3) {
      this.hud.firstElementChild?.remove();
    }
    setTimeout(() => el.classList.add("leaving"), 2400);
    setTimeout(() => el.remove(), 2900);
  }
}
