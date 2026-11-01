/**
 * Railway alignment (DECISION-014). The real main line (OSM, `network.ts` `mainRail`) is only a
 * guide: a buildable alignment is designed here, on the game's own terrain, then laid as is by
 * the importcity mod right after the terrain (before towns, industries and roads):
 *  1. kept away from the placed towns (the guide often runs through their centres);
 *  2. smoothed until every curve has at least `minRadiusM` (the game's minimum is 55 m; real
 *     main lines are much wider);
 *  3. the cheapest vertical profile with at most `maxGrade` (a real grade, steeper in game when
 *     the heights are shrunk less than the distances), a deck above water, earthworks preferred
 *     to bridges and tunnels, tall bridges a last resort;
 *  4. bridges where the profile is high above the ground or over water, tunnels where it is
 *     deep below; a long crossing of open water (sea) splits the line;
 *  5. nodes every ~100 m with continuous tangents (the game draws an edge as a Hermite curve
 *     between its nodes' tangents), and the kind of the edge leaving each node.
 * Game limits (FACT-028): standard track `maxSlopeBuild` 0.085, `minCurveRadiusBuild` 55 m.
 */
import { worldToCell, type Grid } from "./grid";
import type { Frame } from "./area";
import { resample } from "./network";

export interface RailOptions {
  /** Smallest curve radius (game m). */
  minRadiusM: number;
  /** Steepest real grade (rise / run); converted to the game's slopes by `gameGrade`. */
  maxGrade: number;
  /** Distance kept from a town centre (game m), plus half the town's capacity in metres. */
  townClearanceM: number;
  /**
   * How far (game m) the line may leave the real one to suit the game's relief: along a bank
   * instead of across the river, along the valley floor (`corridorPath`). 0: the real line.
   */
  corridorM: number;
}

export const DEFAULT_RAIL: RailOptions = { minRadiusM: 300, maxGrade: 0.025, townClearanceM: 250, corridorM: 600 };

/** Edge leaving a node: normal track, bridge, tunnel. */
export type RailKind = "n" | "b" | "t";

export interface RailNode {
  x: number;
  y: number;
  z: number;
  /** Unit direction of the line at the node (3D). */
  tx: number;
  ty: number;
  tz: number;
  kind: RailKind;
}

export interface RailDesign {
  nodes: RailNode[];
  lengthM: number;
  /** Tightest curve and steepest grade of the design (game m, rise / run). */
  minRadiusM: number;
  maxGrade: number;
  bridges: number;
  tunnels: number;
  /** Highest bridge deck above dry ground (game m). */
  maxBridgeM: number;
}

export interface RailGround {
  game: Float32Array;
  water: Uint8Array;
}

export interface RailTown {
  x: number;
  y: number;
  capacity: number;
}

/** Step between design points (game m). */
const STEP = 50;
/** Nodes every NODE_EVERY design points (~100 m). */
const NODE_EVERY = 2;
/** Deck height above the water level (game m). */
const DECK_M = 8;
const BRIDGE_ABOVE_M = 10;
const TUNNEL_BELOW_M = 15;
/** Shorter bridges or tunnels (game m) become ordinary track. */
const MIN_STRUCTURE_M = 100;
/** Open water longer than this (game m) splits the line (no sea viaducts). */
const MAX_WATER_M = 1500;
/** Half-width of the ground smoothing window (design points). */
const SMOOTH_HALF = 4;
/** Below the game's `maxSlopeBuild` 0.085 (FACT-028). */
const MAX_GAME_GRADE = 0.08;

type P = [number, number];

/** Radius of the circle through three points (Infinity when aligned). */
export function circumradius(a: P, b: P, c: P): number {
  const ab = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const bc = Math.hypot(c[0] - b[0], c[1] - b[1]);
  const ca = Math.hypot(a[0] - c[0], a[1] - c[1]);
  const cross = Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
  return cross < 1e-9 ? Infinity : (ab * bc * ca) / (2 * cross);
}

/** Bilinear game height and nearest water class at (x, y). */
export function sampler(f: Frame, g: Grid, ground: RailGround) {
  const at = (c: number, r: number) => ground.game[Math.min(g.ny - 1, Math.max(0, r)) * g.nx + Math.min(g.nx - 1, Math.max(0, c))];
  return {
    z(x: number, y: number): number {
      const [fc, fr] = worldToCell(f, g, x, y);
      const c = Math.floor(fc);
      const r = Math.floor(fr);
      const u = fc - c;
      const v = fr - r;
      return (at(c, r) * (1 - u) + at(c + 1, r) * u) * (1 - v) + (at(c, r + 1) * (1 - u) + at(c + 1, r + 1) * u) * v;
    },
    wet(x: number, y: number): boolean {
      const [fc, fr] = worldToCell(f, g, x, y);
      const c = Math.min(g.nx - 1, Math.max(0, Math.round(fc)));
      const r = Math.min(g.ny - 1, Math.max(0, Math.round(fr)));
      return ground.water[r * g.nx + c] !== 0;
    },
  };
}

type Zone = { x: number; y: number; r: number };

/** Larger zones to avoid (game m): a whole conurbation, the line goes through it. */
const MAX_ZONE_M = 1500;

/**
 * Circles to keep out of: one per town, overlapping ones merged into their enclosing circle
 * (pushing out of one into the next would never settle). A zone wider than MAX_ZONE_M, or holding
 * an end of the line, cannot be avoided and is left out.
 */
export function townZones(towns: RailTown[], ends: P[], o: RailOptions): Zone[] {
  let zones = towns.map((t) => ({ x: t.x, y: t.y, r: Math.min(900, o.townClearanceM + 0.5 * t.capacity) }));
  for (let merged = true; merged; ) {
    merged = false;
    outer: for (let i = 0; i < zones.length; i++) {
      for (let j = i + 1; j < zones.length; j++) {
        const a = zones[i];
        const b = zones[j];
        const d = Math.hypot(b.x - a.x, b.y - a.y);
        if (d >= a.r + b.r) continue;
        let z = a;
        if (d + a.r <= b.r) z = b;
        else if (d + b.r > a.r) {
          const r = (d + a.r + b.r) / 2;
          const k = (r - a.r) / d;
          z = { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, r };
        }
        zones = zones.filter((_, k) => k !== i && k !== j).concat([z]);
        merged = true;
        break outer;
      }
    }
  }
  return zones.filter((z) => z.r <= MAX_ZONE_M && ends.every((e) => Math.hypot(e[0] - z.x, e[1] - z.y) >= z.r));
}

/**
 * The stretch of the line through a zone (first point inside to last point inside) replaced by the
 * shorter arc of the zone's circle between the points just outside: the line goes round the town
 * once, on the side it already leans to.
 */
function detour(pts: P[], z: Zone): P[] {
  const inside = (p: P) => Math.hypot(p[0] - z.x, p[1] - z.y) < z.r;
  const first = pts.findIndex(inside);
  if (first < 1) return pts;
  let last = pts.length - 1;
  while (!inside(pts[last])) last--;
  if (last >= pts.length - 1) return pts;
  const a0 = Math.atan2(pts[first - 1][1] - z.y, pts[first - 1][0] - z.x);
  const a1 = Math.atan2(pts[last + 1][1] - z.y, pts[last + 1][0] - z.x);
  const sweep = Math.atan2(Math.sin(a1 - a0), Math.cos(a1 - a0));
  const n = Math.max(1, Math.ceil((Math.abs(sweep) * z.r) / STEP));
  const arc: P[] = [];
  for (let k = 1; k < n; k++) {
    const t = a0 + (sweep * k) / n;
    arc.push([z.x + z.r * Math.cos(t), z.y + z.r * Math.sin(t)]);
  }
  return [...pts.slice(0, first), ...arc, ...pts.slice(last + 1)];
}

function lineLength(pts: P[]): number {
  let l = 0;
  for (let i = 1; i < pts.length; i++) l += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return l;
}

/** Lateral step of the corridor (game m). */
const LANE_M = 50;
/** Cost of a design segment over water, per metre (a bridge), and of one beside the water (per point). */
const WATER_COST = 25;
const BANK_COST = 15;
/** Cost per point inside a town zone, per lane of deviation from the real line, per lane changed. */
const TOWN_COST = 400;
const DEVIATION_COST = 2;
const SHIFT_COST = 5;
/** Cost per metre of each grade (of the ground) above the game's grade, in multiples of it. */
const SLOPE_COST = 40;

/**
 * Step 0: the cheapest path on the game's terrain within `corridorM` of the real line (dynamic
 * programming over stations every STEP m along it, lanes every LANE_M across it, at most 2 lanes
 * from one station to the next): water to cross is a bridge, the bank beside it, steep ground and
 * towns cost more, and leaving the real line costs a little. In reality lines often run along a
 * river the game widens and deepens: following them exactly would put the line in the water or
 * across it again and again. The ends stay on the real line.
 */
export function corridorPath(f: Frame, s: ReturnType<typeof sampler>, guide: P[], towns: RailTown[], o: RailOptions, grade: number): P[] {
  const W = Math.round(o.corridorM / LANE_M);
  const c = resample(guide, STEP);
  const n = c.length;
  if (W <= 0 || n < 3) return guide;
  const L = 2 * W + 1;
  // Normals smoothed over ±4 stations (bends do not cross the lanes).
  const nrm = c.map((_, i) => {
    const a = c[Math.max(0, i - 4)];
    const b = c[Math.min(n - 1, i + 4)];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const d = Math.hypot(dx, dy) || 1;
    return [-dy / d, dx / d];
  });
  const hw = f.widthM / 2 - 100;
  const hh = f.heightM / 2 - 100;
  const zones = townZones(towns, [c[0], c[n - 1]], o);
  const X = new Float64Array(n * L);
  const Y = new Float64Array(n * L);
  const Z = new Float64Array(n * L);
  const wet = new Uint8Array(n * L);
  const ok = new Uint8Array(n * L);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < L; j++) {
      const k = i * L + j;
      const x = c[i][0] + nrm[i][0] * (j - W) * LANE_M;
      const y = c[i][1] + nrm[i][1] * (j - W) * LANE_M;
      X[k] = x;
      Y[k] = y;
      ok[k] = Math.abs(x) <= hw && Math.abs(y) <= hh ? 1 : 0;
      Z[k] = s.z(x, y);
      wet[k] = s.wet(x, y) ? 1 : 0;
    }
  }
  const node = (i: number, j: number): number => {
    const k = i * L + j;
    if (!ok[k] || ((i === 0 || i === n - 1) && j !== W)) return Infinity;
    let v = DEVIATION_COST * Math.abs(j - W);
    if (!wet[k] && ((j > 0 && wet[k - 1]) || (j < L - 1 && wet[k + 1]))) v += BANK_COST;
    if (zones.some((z) => Math.hypot(X[k] - z.x, Y[k] - z.y) < z.r)) v += TOWN_COST;
    return v;
  };
  const edge = (a: number, b: number): number => {
    const len = Math.hypot(X[b] - X[a], Y[b] - Y[a]) || 1;
    let v = len;
    // Water at the ends or in between (a 50 m step can jump over a narrow river).
    let w = wet[a] || wet[b];
    for (let q = 1; q < 4 && !w; q++) w = s.wet(X[a] + ((X[b] - X[a]) * q) / 4, Y[a] + ((Y[b] - Y[a]) * q) / 4) ? 1 : 0;
    if (w) v += WATER_COST * len;
    const over = Math.abs(Z[b] - Z[a]) / len - grade;
    if (over > 0) v += (SLOPE_COST * len * over) / Math.max(grade, 1e-3);
    return v;
  };
  let cost = new Float64Array(L);
  for (let j = 0; j < L; j++) cost[j] = node(0, j);
  const back = new Int32Array(n * L);
  for (let i = 1; i < n; i++) {
    const next = new Float64Array(L).fill(Infinity);
    for (let j = 0; j < L; j++) {
      const here = node(i, j);
      if (!Number.isFinite(here)) continue;
      for (let k = Math.max(0, j - 2); k <= Math.min(L - 1, j + 2); k++) {
        if (!Number.isFinite(cost[k])) continue;
        const v = cost[k] + edge((i - 1) * L + k, i * L + j) + SHIFT_COST * Math.abs(j - k) + here;
        if (v < next[j]) {
          next[j] = v;
          back[i * L + j] = k;
        }
      }
    }
    cost = next;
  }
  if (!Number.isFinite(cost[W])) return guide;
  const out: P[] = new Array(n);
  for (let i = n - 1, j = W; i >= 0; i--) {
    out[i] = [X[i * L + j], Y[i * L + j]];
    if (i > 0) j = back[i * L + j];
  }
  return out;
}

/** Steps 1–2: away from towns, curves no tighter than `minRadiusM` (end points fixed). */
export function alignHorizontal(guide: P[], towns: RailTown[], o: RailOptions): P[] {
  let pts = resample(guide, STEP);
  if (pts.length < 3) return pts;
  const zones = townZones(towns, [pts[0], pts[pts.length - 1]], o);
  for (const z of zones) pts = detour(pts, z);
  pts = resample(pts, STEP);
  // Points the smoothing pulls back into a zone go straight out to its circle (radially: they stay
  // on the side the detour chose).
  const keepOut = () => {
    for (let i = 1; i < pts.length - 1; i++) {
      for (const z of zones) {
        const dx = pts[i][0] - z.x;
        const dy = pts[i][1] - z.y;
        const d = Math.hypot(dx, dy);
        if (d >= z.r || d < 1e-6) continue;
        pts[i] = [z.x + (dx / d) * z.r, z.y + (dy / d) * z.r];
      }
    }
  };
  // Detours never more than double the line (a guard: the loop below must not wander).
  const maxLength = 2 * lineLength(pts);
  for (let iter = 0; iter < 800; iter++) {
    let tight = false;
    const next = pts.map((p) => [p[0], p[1]] as P);
    for (let i = 1; i < pts.length - 1; i++) {
      if (circumradius(pts[i - 1], pts[i], pts[i + 1]) >= o.minRadiusM) continue;
      tight = true;
      // Pull the point (and a little its neighbours) towards the chord: the curve opens up.
      for (let k = Math.max(1, i - 1); k <= Math.min(pts.length - 2, i + 1); k++) {
        const w = k === i ? 0.5 : 0.15;
        const mx = (pts[k - 1][0] + pts[k + 1][0]) / 2;
        const my = (pts[k - 1][1] + pts[k + 1][1]) / 2;
        next[k] = [next[k][0] + (mx - next[k][0]) * w, next[k][1] + (my - next[k][1]) * w];
      }
    }
    pts = next;
    if (iter % 10 === 9) {
      pts = resample(pts, STEP);
      if (lineLength(pts) > maxLength) break;
    }
    // Towns win over the smoothing: the curve opens up around them.
    keepOut();
    if (!tight) break;
  }
  pts = resample(pts, STEP);
  keepOut();
  return pts;
}

/** Height levels of the profile search (game m). */
const LEVEL_M = 0.25;
/** Bridges higher than this (game m) are priced as a last resort. */
const TALL_BRIDGE_M = 30;

/**
 * Cost of the track at `h` m above the ground (negative: below), per design point. Embankments
 * and cuttings are cheap and grow with their height; a bridge or a tunnel costs much more, a tall
 * bridge even more, so the profile balances cut and fill instead of keeping its first height.
 */
function heightCost(h: number, wet: boolean): number {
  if (wet) return 0.1 * Math.max(0, h);
  if (h > BRIDGE_ABOVE_M) return 300 + 25 * h + (h > TALL_BRIDGE_M ? 400 * (h - TALL_BRIDGE_M) : 0);
  if (h < -TUNNEL_BELOW_M) return 400 + 10 * -h;
  return h * h;
}

/**
 * Step 3: the cheapest profile (dynamic programming over height levels): |grade| ≤ maxGrade,
 * a deck over water, at least 0.5 m on land, earthworks preferred to bridges and tunnels. The
 * result does not depend on the direction of the line.
 */
export function profile(ground: number[], wet: boolean[], step: number, maxGrade: number): number[] {
  const n = ground.length;
  if (n === 0) return [];
  const smooth = ground.map((_, i) => {
    let sum = 0;
    let k = 0;
    for (let j = Math.max(0, i - SMOOTH_HALF); j <= Math.min(n - 1, i + SMOOTH_HALF); j++) {
      sum += ground[j];
      k++;
    }
    return sum / k;
  });
  const floor = (i: number) => (wet[i] ? DECK_M : 0.5);
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < n; i++) {
    lo = Math.min(lo, Math.max(smooth[i], floor(i)));
    hi = Math.max(hi, Math.max(smooth[i], floor(i)));
  }
  const base = Math.floor(lo / LEVEL_M);
  const L = Math.ceil(hi / LEVEL_M) - base + 1;
  const reach = Math.max(1, Math.floor((maxGrade * step) / LEVEL_M + 1e-9));
  const zOf = (l: number) => (base + l) * LEVEL_M;
  const local = (i: number, l: number) => {
    const z = zOf(l);
    if (z < floor(i) - 1e-9) return Infinity;
    return heightCost(z - smooth[i], wet[i]);
  };
  let cost = new Float64Array(L);
  for (let l = 0; l < L; l++) cost[l] = local(0, l);
  const back = new Int32Array(n * L);
  const deque = new Int32Array(L);
  for (let i = 1; i < n; i++) {
    const next = new Float64Array(L);
    // Sliding minimum of the previous costs over [l - reach, l + reach].
    let head = 0;
    let tail = 0;
    let added = 0;
    for (let l = 0; l < L; l++) {
      while (added < L && added <= l + reach) {
        while (tail > head && cost[deque[tail - 1]] >= cost[added]) tail--;
        deque[tail++] = added++;
      }
      while (deque[head] < l - reach) head++;
      const from = deque[head];
      back[i * L + l] = from;
      next[l] = cost[from] + local(i, l);
    }
    cost = next;
  }
  let best = 0;
  for (let l = 1; l < L; l++) if (cost[l] < cost[best]) best = l;
  const z = new Array<number>(n);
  for (let i = n - 1; i >= 0; i--) {
    z[i] = zOf(best);
    if (i > 0) best = back[i * L + best];
  }
  return z;
}

/** The steepest game grade for a real grade (heights shrink by verticalScale, distances by scale). */
export function gameGrade(realGrade: number, scale: number, verticalScale: number): number {
  return Math.min(MAX_GAME_GRADE, realGrade * scale * verticalScale);
}

/** Step 4: the kind of each segment i → i+1, short structures merged into their neighbours. */
export function structures(ground: number[], z: number[], wet: boolean[], step: number): RailKind[] {
  const kinds: RailKind[] = [];
  for (let i = 0; i + 1 < z.length; i++) {
    const g = (ground[i] + ground[i + 1]) / 2;
    const h = (z[i] + z[i + 1]) / 2 - g;
    kinds.push(wet[i] || wet[i + 1] || h > BRIDGE_ABOVE_M ? "b" : h < -TUNNEL_BELOW_M ? "t" : "n");
  }
  // Runs shorter than MIN_STRUCTURE_M of bridge / tunnel become track (water stays a bridge).
  const minRun = Math.ceil(MIN_STRUCTURE_M / step);
  for (let i = 0; i < kinds.length; ) {
    let j = i;
    while (j < kinds.length && kinds[j] === kinds[i]) j++;
    if (kinds[i] !== "n" && j - i < minRun && !wet.slice(i, j + 1).some((w) => w)) for (let k = i; k < j; k++) kinds[k] = "n";
    i = j;
  }
  return kinds;
}

/**
 * The whole design for one guide line, in pieces (a sea crossing splits it); pieces shorter than
 * 500 m are dropped.
 */
export function designRail(f: Frame, g: Grid, ground: RailGround, guide: P[], towns: RailTown[], o: RailOptions = DEFAULT_RAIL): RailDesign[] {
  const s = sampler(f, g, ground);
  const grade = gameGrade(o.maxGrade, f.scale, f.verticalScale);
  const pts = alignHorizontal(corridorPath(f, s, guide, towns, o, grade), towns, o);
  if (pts.length < 3) return [];
  // Split on long open water.
  const wetAll = pts.map(([x, y]) => s.wet(x, y));
  const pieces: P[][] = [];
  let cur: P[] = [];
  for (let i = 0; i < pts.length; ) {
    if (!wetAll[i]) {
      cur.push(pts[i]);
      i++;
      continue;
    }
    let j = i;
    while (j < pts.length && wetAll[j]) j++;
    if ((j - i) * STEP > MAX_WATER_M) {
      if (cur.length) pieces.push(cur);
      cur = [];
    } else for (let k = i; k < j; k++) cur.push(pts[k]);
    i = j;
  }
  if (cur.length) pieces.push(cur);
  return pieces.filter((p) => (p.length - 1) * STEP >= 500).map((p) => designPiece(p, s, grade));
}

/**
 * Steps 3–4 on points `step` m apart: profile, structures and the nodes the mod lays (also used for
 * the roads, `roads.ts`).
 */
export function designPiece(pts: P[], s: ReturnType<typeof sampler>, grade: number, step = STEP): RailDesign {
  const ground = pts.map(([x, y]) => s.z(x, y));
  const wet = pts.map(([x, y]) => s.wet(x, y));
  const z = profile(ground, wet, step, grade);
  const kinds = structures(ground, z, wet, step);
  // Nodes every NODE_EVERY points, plus every change of kind (so a bridge starts and ends on a node).
  const idx: number[] = [0];
  for (let i = 1; i < pts.length - 1; i++) {
    if (i % NODE_EVERY === 0 || kinds[i] !== kinds[i - 1]) idx.push(i);
  }
  idx.push(pts.length - 1);
  const nodes: RailNode[] = idx.map((i, k) => {
    const a = idx[Math.max(0, k - 1)];
    const b = idx[Math.min(idx.length - 1, k + 1)];
    const dx = pts[b][0] - pts[a][0];
    const dy = pts[b][1] - pts[a][1];
    const dz = z[b] - z[a];
    const d = Math.hypot(dx, dy, dz) || 1;
    // The edge leaving the node: a bridge or tunnel if any of its design segments is one.
    const span = kinds.slice(i, idx[k + 1] ?? i);
    const kind: RailKind = span.includes("b") ? "b" : span.includes("t") ? "t" : "n";
    return { x: pts[i][0], y: pts[i][1], z: z[i], tx: dx / d, ty: dy / d, tz: dz / d, kind };
  });
  let minR = Infinity;
  for (let i = 1; i < pts.length - 1; i++) minR = Math.min(minR, circumradius(pts[i - 1], pts[i], pts[i + 1]));
  let maxG = 0;
  for (let i = 1; i < z.length; i++) maxG = Math.max(maxG, Math.abs(z[i] - z[i - 1]) / step);
  let maxBridge = 0;
  for (let i = 0; i < kinds.length; i++) if (kinds[i] === "b" && !wet[i]) maxBridge = Math.max(maxBridge, z[i] - ground[i]);
  const runs = (k: RailKind) => kinds.filter((x, i) => x === k && kinds[i - 1] !== k).length;
  return {
    nodes,
    lengthM: (pts.length - 1) * step,
    minRadiusM: Number.isFinite(minR) ? Math.round(minR) : 0,
    maxGrade: Math.round(maxG * 1000) / 1000,
    bridges: runs("b"),
    tunnels: runs("t"),
    maxBridgeM: Math.round(maxBridge),
  };
}
