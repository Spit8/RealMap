/**
 * River network repair (phase 2): in reality a river ends in another river, a lake or the sea.
 * OSM lines often stop short (culverts, a stream tag downstream, a gap in the data), which leaves
 * rivers ending nowhere in game. For each river line (cell coordinates, drawn in flow direction as
 * in OSM):
 *  - an end touching another river, still water or the map edge is fine;
 *  - a dangling end close to another river or to still water is joined to it by a straight piece;
 *  - a dangling mouth further away is routed downhill to water or the map edge: priority-flood
 *    over the (coarsened) relief, which fills hollows so every cell drains somewhere;
 *  - a dangling source (upstream end) is kept — rivers do start from springs — but tapered so it
 *    does not start full width out of nowhere;
 *  - a mouth in still water (sea, lake) is carried a little into it and flared, so the river
 *    opens cleanly instead of meeting the shore through a thin neck.
 */

export type Pt = [number, number];

export interface RiverLine {
  /** Cell coordinates (fractional), in flow direction. */
  pts: Pt[];
  /** Half width in cells. */
  half: number;
  /** Taper the first / last end (a source). */
  taperStart?: boolean;
  taperEnd?: boolean;
}

export interface RepairOptions {
  /** Ends closer than this (cells) to other water are joined straight. */
  joinCells: number;
  /** Length (cells) over which a source widens from 1/4 to full width. */
  taperCells: number;
}

export interface RepairResult {
  /** The input lines with their taper flags set. */
  lines: RiverLine[];
  /** New pieces: straight joins and routed courses. */
  extra: RiverLine[];
  joined: number;
  routed: number;
  tapered: number;
  /** Mouths carried into still water. */
  mouths: number;
}

const EDGE_CELLS = 2;
/** A mouth in still water is carried this many river widths into it, 1.5 times as wide. */
const MOUTH_LENGTH = 1.5;
const MOUTH_FLARE = 1.5;

/** Cells along a polyline (1 cell wide), with `id` written into `ids`. */
function stampLine(ids: Int32Array, nx: number, ny: number, pts: Pt[], id: number): void {
  for (let k = 1; k < pts.length; k++) {
    const [ax, ay] = pts[k - 1];
    const [bx, by] = pts[k];
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) * 2));
    for (let s = 0; s <= n; s++) {
      const c = Math.round(ax + ((bx - ax) * s) / n);
      const r = Math.round(ay + ((by - ay) * s) / n);
      if (c >= 0 && r >= 0 && c < nx && r < ny) ids[r * nx + c] = id;
    }
  }
  if (pts.length === 1) {
    const [c, r] = pts[0].map(Math.round);
    if (c >= 0 && r >= 0 && c < nx && r < ny) ids[r * nx + c] = id;
  }
}

/** Min-heap of (priority, index). */
class Heap {
  private p: number[] = [];
  private v: number[] = [];
  get size(): number {
    return this.p.length;
  }
  push(pr: number, val: number): void {
    const { p, v } = this;
    let i = p.length;
    p.push(pr);
    v.push(val);
    while (i > 0) {
      const up = (i - 1) >> 1;
      if (p[up] <= p[i]) break;
      [p[up], p[i]] = [p[i], p[up]];
      [v[up], v[i]] = [v[i], v[up]];
      i = up;
    }
  }
  pop(): [number, number] {
    const { p, v } = this;
    const top: [number, number] = [p[0], v[0]];
    const lp = p.pop()!;
    const lv = v.pop()!;
    if (p.length) {
      p[0] = lp;
      v[0] = lv;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < p.length && p[l] < p[m]) m = l;
        if (r < p.length && p[r] < p[m]) m = r;
        if (m === i) break;
        [p[m], p[i]] = [p[i], p[m]];
        [v[m], v[i]] = [v[i], v[m]];
        i = m;
      }
    }
    return top;
  }
}

/**
 * Drainage on a grid: priority-flood from the outlets (`outlet` cells and the border), each cell
 * remembering the neighbour it was reached from. Following `parent` from any cell leads downhill
 * (hollows filled) to an outlet. NaN heights count as very low (sea without data).
 */
export function drainage(z: Float32Array, nx: number, ny: number, outlet: Uint8Array): Int32Array {
  const parent = new Int32Array(nx * ny).fill(-2); // -2 = not reached, -1 = outlet
  const level = new Float32Array(nx * ny);
  const heap = new Heap();
  const h = (i: number) => (Number.isFinite(z[i]) ? z[i] : -1e6);
  for (let i = 0; i < nx * ny; i++) {
    const c = i % nx;
    const r = (i - c) / nx;
    if (outlet[i] || c === 0 || r === 0 || c === nx - 1 || r === ny - 1) {
      parent[i] = -1;
      level[i] = h(i);
      heap.push(level[i], i);
    }
  }
  while (heap.size) {
    const [lv, i] = heap.pop();
    const c = i % nx;
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (!dc && !dr) continue;
        const cc = c + dc;
        const rr = (i - c) / nx + dr;
        if (cc < 0 || rr < 0 || cc >= nx || rr >= ny) continue;
        const j = rr * nx + cc;
        if (parent[j] !== -2) continue;
        parent[j] = i;
        level[j] = Math.max(h(j), lv + 1e-3);
        heap.push(level[j], j);
      }
    }
  }
  return parent;
}

/**
 * Repair the network. `still` = lake / sea cells on the grid; `real` = (smoothed) real heights on
 * the grid, used for flow direction and routing.
 */
export function repairRivers(
  lines: RiverLine[],
  nx: number,
  ny: number,
  still: Uint8Array,
  real: Float32Array,
  o: RepairOptions,
): RepairResult {
  const out = lines.map((l) => ({ ...l, taperStart: false, taperEnd: false }));
  const extra: RiverLine[] = [];
  const ids = new Int32Array(nx * ny);
  out.forEach((l, k) => stampLine(ids, nx, ny, l.pts, k + 1));
  // River systems (lines touching each other, 8-connected), to know when a route reaches *another* river.
  const system = new Int32Array(nx * ny);
  {
    let next = 0;
    const stack: number[] = [];
    for (let s = 0; s < ids.length; s++) {
      if (!ids[s] || system[s]) continue;
      system[s] = ++next;
      stack.push(s);
      while (stack.length) {
        const i = stack.pop()!;
        const c = i % nx;
        const r = (i - c) / nx;
        for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
          const cc = c + dc;
          const rr = r + dr;
          if (cc < 0 || rr < 0 || cc >= nx || rr >= ny) continue;
          const j = rr * nx + cc;
          if (ids[j] && !system[j]) {
            system[j] = next;
            stack.push(j);
          }
        }
      }
    }
  }
  const cellOf = ([x, y]: Pt): number => {
    const c = Math.round(x);
    const r = Math.round(y);
    return c >= 0 && r >= 0 && c < nx && r < ny ? r * nx + c : -1;
  };
  const nearEdge = ([x, y]: Pt) => x < EDGE_CELLS || y < EDGE_CELLS || x > nx - 1 - EDGE_CELLS || y > ny - 1 - EDGE_CELLS;

  /** Nearest other water (another line or still water) within `rad` cells of `p`, or null. */
  const nearestWater = (p: Pt, ownId: number, rad: number): Pt | null => {
    const c0 = Math.round(p[0]);
    const r0 = Math.round(p[1]);
    const R = Math.ceil(rad);
    let best: Pt | null = null;
    let bestD = Infinity;
    for (let r = Math.max(0, r0 - R); r <= Math.min(ny - 1, r0 + R); r++) {
      for (let c = Math.max(0, c0 - R); c <= Math.min(nx - 1, c0 + R); c++) {
        const i = r * nx + c;
        if (!(still[i] || (ids[i] && ids[i] !== ownId))) continue;
        const d = (c - p[0]) ** 2 + (r - p[1]) ** 2;
        if (d < bestD && d <= rad * rad) {
          bestD = d;
          best = [c, r];
        }
      }
    }
    return best;
  };
  const touching = (p: Pt, ownId: number) => nearEdge(p) || cellOf(p) < 0 || nearestWater(p, ownId, 1.5) !== null;

  // Coarse drainage grid (≤ ~768 cells a side) for routing.
  const k = Math.max(1, Math.ceil(Math.max(nx, ny) / 768));
  const cnx = Math.ceil(nx / k);
  const cny = Math.ceil(ny / k);
  let parent: Int32Array | null = null;
  const route = (p: Pt, ownSystem: number): Pt[] | null => {
    if (!parent) {
      const z = new Float32Array(cnx * cny).fill(NaN);
      const outlet = new Uint8Array(cnx * cny);
      for (let r = 0; r < ny; r++) {
        for (let c = 0; c < nx; c++) {
          const i = r * nx + c;
          const j = Math.floor(r / k) * cnx + Math.floor(c / k);
          if (still[i]) outlet[j] = 1;
          // The lowest point of each block, so valleys are not lost when coarsening.
          if (Number.isFinite(real[i]) && !(real[i] >= z[j])) z[j] = real[i];
        }
      }
      parent = drainage(z, cnx, cny, outlet);
    }
    const path: Pt[] = [p];
    let j = Math.floor(Math.round(p[1]) / k) * cnx + Math.floor(Math.round(p[0]) / k);
    for (let steps = 0; steps < cnx * cny && j >= 0; steps++) {
      const c = j % cnx;
      const r = (j - c) / cnx;
      const pt: Pt = [Math.min(nx - 1, c * k + (k - 1) / 2), Math.min(ny - 1, r * k + (k - 1) / 2)];
      path.push(pt);
      // Stop on another river system: the course joins it there.
      const fine = cellOf(pt);
      if (fine >= 0 && system[fine] && system[fine] !== ownSystem) break;
      if (parent[j] < 0) break;
      j = parent[j];
    }
    return path.length > 1 ? path : null;
  };

  /** Still water within `rad` cells of `p`. */
  const nearStill = (p: Pt, rad: number): boolean => {
    const R = Math.ceil(rad);
    for (let r = Math.max(0, Math.round(p[1]) - R); r <= Math.min(ny - 1, Math.round(p[1]) + R); r++) {
      for (let c = Math.max(0, Math.round(p[0]) - R); c <= Math.min(nx - 1, Math.round(p[0]) + R); c++) {
        if (still[r * nx + c] && (c - p[0]) ** 2 + (r - p[1]) ** 2 <= rad * rad) return true;
      }
    }
    return false;
  };
  /** Carry an end reaching still water on along its last segment, flared. */
  const mouthInto = (end: Pt, before: Pt, half: number): RiverLine | null => {
    const dx = end[0] - before[0];
    const dy = end[1] - before[1];
    const len = Math.hypot(dx, dy);
    if (!len || !nearStill(end, Math.max(1.5, half))) return null;
    const reach = Math.max(3, MOUTH_LENGTH * 2 * half);
    return { pts: [end, [end[0] + (dx / len) * reach, end[1] + (dy / len) * reach]], half: half * MOUTH_FLARE };
  };

  let joined = 0;
  let routed = 0;
  let tapered = 0;
  let mouths = 0;
  out.forEach((l, k2) => {
    const id = k2 + 1;
    const a = l.pts[0];
    const b = l.pts[l.pts.length - 1];
    const freeA = !touching(a, id);
    const freeB = !touching(b, id);
    // Ends already in still water: open them cleanly (the downstream one, or both when unsure).
    if (l.pts.length > 1) {
      for (const [end, before] of [[b, l.pts[l.pts.length - 2]], [a, l.pts[1]]] as const) {
        const m = mouthInto(end, before, l.half);
        if (m) {
          extra.push(m);
          mouths++;
        }
      }
    }
    if (!freeA && !freeB) return;
    const za = real[cellOf(a)] ?? NaN;
    const zb = real[cellOf(b)] ?? NaN;
    // The mouth is the OSM end (downstream), unless only the start dangles, or both dangle and the
    // start is clearly lower (line drawn upstream).
    let mouth: "a" | "b" | null;
    if (freeA && freeB) mouth = Number.isFinite(za) && Number.isFinite(zb) && za < zb - 5 ? "a" : "b";
    else if (freeB) mouth = "b";
    else mouth = Number.isFinite(za) && Number.isFinite(zb) && za < zb - 5 ? "a" : null;
    const source = freeA && mouth !== "a" ? "a" : freeB && mouth !== "b" ? "b" : null;
    if (source === "a") l.taperStart = true;
    if (source === "b") l.taperEnd = true;
    if (source) tapered++;
    if (!mouth) return;
    const p = mouth === "a" ? a : b;
    const near = nearestWater(p, id, o.joinCells);
    if (near) {
      extra.push({ pts: [p, near], half: l.half });
      joined++;
      return;
    }
    const course = route(p, system[cellOf(p)] || -1);
    if (course) {
      extra.push({ pts: course, half: l.half });
      routed++;
    }
  });
  return { lines: out, extra, joined, routed, tapered, mouths };
}

/**
 * Half widths along a line: 1/4 → full over `taperCells` from a tapered end, never below
 * `minHalf` (the navigable width).
 */
export function taperedPieces(l: RiverLine, taperCells: number, minHalf = 0): { pts: Pt[]; half: number }[] {
  if (!l.taperStart && !l.taperEnd) return [{ pts: l.pts, half: l.half }];
  const cum = [0];
  for (let i = 1; i < l.pts.length; i++) cum.push(cum[i - 1] + Math.hypot(l.pts[i][0] - l.pts[i - 1][0], l.pts[i][1] - l.pts[i - 1][1]));
  const total = cum[cum.length - 1];
  const widthAt = (s: number) => {
    let f = 1;
    if (l.taperStart) f = Math.min(f, 0.25 + 0.75 * Math.min(1, s / taperCells));
    if (l.taperEnd) f = Math.min(f, 0.25 + 0.75 * Math.min(1, (total - s) / taperCells));
    return Math.max(Math.min(minHalf, l.half), l.half * f);
  };
  const pieces: { pts: Pt[]; half: number }[] = [];
  for (let i = 1; i < l.pts.length; i++) pieces.push({ pts: [l.pts[i - 1], l.pts[i]], half: widthAt((cum[i - 1] + cum[i]) / 2) });
  return pieces;
}
