export function bezierPath(x1: number, y1: number, x2: number, y2: number) {
  // Backward wires (to a wrapped row) get short handles instead of wide loops
  const dy = Math.abs(y2 - y1);
  const dx = x2 < x1 ? Math.min(140, 50 + dy * 0.2) : Math.max(36, Math.min(Math.abs(x2 - x1) * 0.5, 260), Math.min(120, dy * 0.4));
  return `M${x1.toFixed(1)} ${y1.toFixed(1)}C${(x1 + dx).toFixed(1)} ${y1.toFixed(1)} ${(x2 - dx).toFixed(1)} ${y2.toFixed(1)} ${x2.toFixed(1)} ${y2.toFixed(1)}`;
}

type P = [number, number];

// A right-angle route with rounded corners, each corner its curve's control point
export function orthoPath(points: P[], radius = 12) {
  const f = (v: number) => v.toFixed(1);
  let d = `M${f(points[0][0])} ${f(points[0][1])}`;
  for (let i = 1; i < points.length - 1; i += 1) {
    const [p, c, n] = [points[i - 1], points[i], points[i + 1]];
    const lin = Math.hypot(c[0] - p[0], c[1] - p[1]);
    const lout = Math.hypot(n[0] - c[0], n[1] - c[1]);
    const r = Math.min(radius, lin / 2, lout / 2);
    if (r < 0.5) {
      d += `L${f(c[0])} ${f(c[1])}`;
      continue;
    }
    const inX = c[0] - ((c[0] - p[0]) / lin) * r;
    const inY = c[1] - ((c[1] - p[1]) / lin) * r;
    const outX = c[0] + ((n[0] - c[0]) / lout) * r;
    const outY = c[1] + ((n[1] - c[1]) / lout) * r;
    d += `L${f(inX)} ${f(inY)}Q${f(c[0])} ${f(c[1])} ${f(outX)} ${f(outY)}`;
  }
  const last = points[points.length - 1];
  return `${d}L${f(last[0])} ${f(last[1])}`;
}

export interface Obstacle {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

// Drops repeated points and the middles of straight runs. A run that doubles
// back keeps its turn, so a port's stub never merges into it.
function simplify(points: P[]) {
  const out: P[] = [];
  for (const p of points) {
    const q = out[out.length - 1];
    if (q && Math.abs(q[0] - p[0]) < 0.5 && Math.abs(q[1] - p[1]) < 0.5) {
      continue;
    }
    const o = out[out.length - 2];
    const straight = o && q && ((Math.abs(o[0] - q[0]) < 0.5 && Math.abs(q[0] - p[0]) < 0.5) || (Math.abs(o[1] - q[1]) < 0.5 && Math.abs(q[1] - p[1]) < 0.5));
    if (straight && (q[0] - o[0]) * (p[0] - q[0]) + (q[1] - o[1]) * (p[1] - q[1]) > 0) {
      out[out.length - 1] = p;
      continue;
    }
    out.push(p);
  }
  return out;
}

// Turns that double back on the segment before
function reversals(route: P[]) {
  let count = 0;
  for (let i = 1; i < route.length - 1; i += 1) {
    const [o, q, p] = [route[i - 1], route[i], route[i + 1]];
    if ((q[0] - o[0]) * (p[0] - q[0]) + (q[1] - o[1]) * (p[1] - q[1]) < 0) {
      count += 1;
    }
  }
  return count;
}

// Whether a route leaves a rightward and enters b from the left, level, without doubling back
export function routeOk(route: P[], a: P, b: P, stub = 6) {
  const n = route.length;
  if (n < 2) {
    return false;
  }
  if (n === 2) {
    return Math.abs(a[1] - b[1]) < 1 && b[0] > a[0];
  }
  const first = route[1];
  const last = route[n - 2];
  return Math.abs(first[1] - a[1]) < 1 && first[0] >= a[0] + stub && Math.abs(last[1] - b[1]) < 1 && last[0] <= b[0] - stub && reversals(route) === 0;
}

// A right-angle route from a to b around the nodes: the best of a few
// candidates by nodes crossed, then bends, then length
export function orthoRoute(a: P, b: P, obstacles: Obstacle[], ends: [string, string], stub = 16): P[] {
  const out = a[0] + stub;
  const into = b[0] - stub;
  const candidates: P[][] = [];
  if (into > out) {
    const xs = new Set([(out + into) / 2]);
    for (const o of obstacles) {
      for (const x of [o.x - stub, o.x + o.w + stub]) {
        if (x > out && x < into) {
          xs.add(x);
        }
      }
    }
    xs.forEach((x) => candidates.push([a, [x, a[1]], [x, b[1]], b]));
  }
  const ys = new Set([a[1], b[1]]);
  for (const o of obstacles) {
    ys.add(o.y - stub);
    ys.add(o.y + o.h + stub);
  }
  ys.forEach((y) => candidates.push([a, [out, a[1]], [out, y], [into, y], [into, b[1]], b]));

  // Nodes crossed. The first and last segments may touch their own node.
  const hits = (route: P[]) => {
    let count = 0;
    for (let i = 0; i < route.length - 1; i += 1) {
      const [p, q] = [route[i], route[i + 1]];
      const x0 = Math.min(p[0], q[0]);
      const x1 = Math.max(p[0], q[0]);
      const y0 = Math.min(p[1], q[1]);
      const y1 = Math.max(p[1], q[1]);
      for (const o of obstacles) {
        if ((i === 0 && o.id === ends[0]) || (i === route.length - 2 && o.id === ends[1])) {
          continue;
        }
        if (x1 > o.x - 2 && x0 < o.x + o.w + 2 && y1 > o.y - 2 && y0 < o.y + o.h + 2) {
          count += 1;
        }
      }
    }
    return count;
  };
  let best = candidates[0];
  let bestScore = Infinity;
  for (const candidate of candidates) {
    const route = simplify(candidate);
    let length = 0;
    for (let i = 0; i < route.length - 1; i += 1) {
      length += Math.abs(route[i + 1][0] - route[i][0]) + Math.abs(route[i + 1][1] - route[i][1]);
    }
    const score = hits(route) * 10000 + reversals(route) * 5000 + (route.length - 2) * 60 + length;
    if (score < bestScore) {
      best = route;
      bestScore = score;
    }
  }
  return best;
}

// A stored route with its ends moved to the ports, its first and last segments kept level
export function fitRoute(route: P[], a: P, b: P): P[] {
  const points = route.map((p) => [p[0], p[1]] as P);
  if (points.length > 2 && Math.abs(points[1][1] - points[0][1]) < 1) {
    points[1][1] = a[1];
  }
  const n = points.length;
  if (n > 2 && Math.abs(points[n - 2][1] - points[n - 1][1]) < 1) {
    points[n - 2][1] = b[1];
  }
  points[0] = a;
  points[n - 1] = b;
  return points;
}

interface Point {
  x: number;
  y: number;
  px: number;
  py: number;
}

const SEGMENTS = 12;
const GRAVITY = 0.45;
const SLACK = 1.07;

export class Rope {
  private points: Point[] = [];

  constructor(x1: number, y1: number, x2: number, y2: number) {
    for (let i = 0; i <= SEGMENTS; i += 1) {
      const t = i / SEGMENTS;
      const x = x1 + (x2 - x1) * t;
      const y = y1 + (y2 - y1) * t;
      this.points.push({ x, y, px: x, py: y });
    }
  }

  // The second and second-last points sit just outside the ports so the rope
  // leaves and enters sideways. True while it moves.
  step(dt: number, x1: number, y1: number, x2: number, y2: number) {
    const p = this.points;
    const n = SEGMENTS;
    const reach = Math.min(22, Math.hypot(x2 - x1, y2 - y1) / 5);
    const pin = (point: Point, x: number, y: number) => {
      point.x = point.px = x;
      point.y = point.py = y;
    };
    const steps = Math.max(1, Math.min(3, Math.round(dt * 60)));
    let energy = 0;
    for (let s = 0; s < steps; s += 1) {
      for (let i = 2; i < n - 1; i += 1) {
        const point = p[i];
        const vx = (point.x - point.px) * 0.94;
        const vy = (point.y - point.py) * 0.94;
        point.px = point.x;
        point.py = point.y;
        point.x += vx;
        point.y += vy + GRAVITY;
      }
      pin(p[0], x1, y1);
      pin(p[1], x1 + reach, y1);
      pin(p[n - 1], x2 - reach, y2);
      pin(p[n], x2, y2);
      const length = (Math.hypot(x2 - x1 - 2 * reach, y2 - y1) * SLACK + 12) / (n - 2);
      for (let iteration = 0; iteration < 10; iteration += 1) {
        for (let i = 1; i < n - 1; i += 1) {
          const a = p[i];
          const b = p[i + 1];
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const d = Math.hypot(dx, dy) || 1e-6;
          const k = (d - length) / d;
          const aFixed = i === 1;
          const bFixed = i + 1 === n - 1;
          const wa = aFixed ? 0 : bFixed ? 1 : 0.5;
          const wb = bFixed ? 0 : aFixed ? 1 : 0.5;
          a.x += dx * k * wa;
          a.y += dy * k * wa;
          b.x -= dx * k * wb;
          b.y -= dy * k * wb;
        }
      }
      energy = 0;
      for (let i = 2; i < n - 1; i += 1) {
        energy += Math.abs(p[i].x - p[i].px) + Math.abs(p[i].y - p[i].py);
      }
    }
    return energy > 0.08;
  }

  path() {
    const p = this.points;
    let d = `M${p[0].x.toFixed(1)} ${p[0].y.toFixed(1)}`;
    for (let i = 1; i < p.length - 1; i += 1) {
      const mx = (p[i].x + p[i + 1].x) / 2;
      const my = (p[i].y + p[i + 1].y) / 2;
      d += `Q${p[i].x.toFixed(1)} ${p[i].y.toFixed(1)} ${mx.toFixed(1)} ${my.toFixed(1)}`;
    }
    const last = p[p.length - 1];
    return `${d}L${last.x.toFixed(1)} ${last.y.toFixed(1)}`;
  }
}
