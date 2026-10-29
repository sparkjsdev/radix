// Effects: bursts of sparks, confetti or ripples in the graph's world layer,
// shakes and toasts. CSS animations on throwaway elements (fxedit.css).
                                         

export class Juice {
  theme       ;
  // Off with prefers-reduced-motion
  enabled = !matchMedia("(prefers-reduced-motion: reduce)").matches;
          layer             ;
          hud             ;

  // `layer` is in world coordinates, `hud` in screen coordinates
  constructor(layer             , hud             , theme       ) {
    this.layer = layer;
    this.hud = hud;
    this.theme = theme;
  }

  burst(x        , y        , { color, count, kind = this.theme.burst }                                                            = {}) {
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

          spawn(kind        , x        , y        , vars                        ) {
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
  shake(el         , name = "fx-shake") {
    if (!this.enabled) {
      return;
    }
    el.classList.remove(name);
    void (el               ).offsetWidth;
    el.classList.add(name);
    setTimeout(() => el.classList.remove(name), 700);
  }

  toast(text        , kind                          = "info") {
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


//# sourceURL=examples/fxedit/juice.ts