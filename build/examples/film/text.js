// Timed type over the render: each caption is an element shown from `at`
// to `until` (film seconds) with an entrance and an exit computed from the
// playhead, so a frame looks the same however it was reached.
import { clamp01, easeOut, smooth } from "./timeline.js";

                                                                              

                              
             
                
               
                     
                  
                                                                       
                   
                 
                
 

                                                 
                       
                       
 

// Wraps every character of the element's text in a span (words kept whole
// so lines break between them)
function splitChars(element             ) {
  const chars                = [];
  const walk = (node      ) => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === Node.TEXT_NODE) {
        const fragment = document.createDocumentFragment();
        for (const word of (child.textContent ?? "").split(/(\s+)/)) {
          if (word === "") {
            continue;
          }
          if (/^\s+$/.test(word)) {
            fragment.append(word);
            continue;
          }
          const w = document.createElement("span");
          w.className = "w";
          for (const c of word) {
            const span = document.createElement("span");
            span.className = "c";
            span.textContent = c;
            chars.push(span);
            w.append(span);
          }
          fragment.append(w);
        }
        child.replaceWith(fragment);
      } else if (child.nodeType === Node.ELEMENT_NODE && !(child               ).classList.contains("keep")) {
        walk(child);
      }
    }
  };
  walk(element);
  return chars;
}

export class Captions {
          list            = [];
          root             ;

  constructor(root             ) {
    this.root = root;
  }

  add(spec             ) {
    const element = document.createElement("div");
    element.className = `cap ${spec.className ?? ""}`;
    element.innerHTML = spec.html;
    element.style.visibility = "hidden";
    this.root.append(element);
    const anim = spec.anim ?? "letters";
    const chars = anim === "letters" || anim === "type" ? splitChars(element) : [];
    const caption          = { stagger: anim === "type" ? 0.028 : 0.022, enter: 0.7, exit: 0.45, className: "", anim, ...spec, element, chars };
    this.list.push(caption);
    return element;
  }

  update(t        ) {
    for (const c of this.list) {
      const on = t >= c.at && t <= c.until;
      c.element.style.visibility = on ? "visible" : "hidden";
      if (!on) {
        continue;
      }
      const local = t - c.at;
      const out = clamp01((t - (c.until - c.exit)) / c.exit);
      const style = c.element.style;
      if (c.anim === "letters") {
        c.chars.forEach((char, i) => {
          const p = easeOut((local - i * c.stagger) / c.enter);
          const q = smooth((t - (c.until - c.exit) - i * c.stagger * 0.4) / c.exit);
          char.style.opacity = String(p * (1 - q));
          char.style.filter = `blur(${((1 - p) * 0.35 + q * 0.25).toFixed(3)}em)`;
          char.style.transform = `translateY(${((1 - p) * 0.35 - q * 0.15).toFixed(3)}em)`;
        });
      } else if (c.anim === "type") {
        const shown = Math.floor(local / c.stagger);
        c.chars.forEach((char, i) => (char.style.opacity = i < shown ? "1" : "0"));
        style.opacity = String(1 - out);
      } else {
        const p = easeOut(local / c.enter);
        const q = smooth(out);
        style.opacity = String(Math.min(p, 1 - q));
        if (c.anim === "rise") {
          style.transform = `translateY(${((1 - p) * 0.6 - q * 0.3).toFixed(3)}em)`;
          style.filter = `blur(${((1 - p) * 0.3 + q * 0.2).toFixed(3)}em)`;
        } else if (c.anim === "slam") {
          style.transform = `scale(${(1 + (1 - p) * 0.5 + local * 0.012).toFixed(4)})`;
          style.filter = `blur(${((1 - p) * 0.25 + q * 0.3).toFixed(3)}em)`;
          style.letterSpacing = "";
        } else if (c.anim === "wipe") {
          style.clipPath = `inset(0 ${((1 - p) * 100).toFixed(2)}% 0 0)`;
        }
      }
    }
  }
}


//# sourceURL=examples/film/text.ts