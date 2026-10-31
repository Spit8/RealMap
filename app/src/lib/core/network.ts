/**
 * Start-of-game roads and railway (v0.8). Phase 1: the real main roads and railways (OSM). Phase 2:
 * which towns the game should link by road — each town to 1 or 2 others along the real network,
 * never a full mesh — which industry (0 or 1) each town reaches, and the real main railway line.
 * The game builds them itself in the Map Editor (the importcity mod): its own routing and road
 * type for the year (FACT-024), so only the pairs and the rail points are written in the note.
 */
import { frameProjection, type Frame } from "./area";
import { overpassLimits, type Bbox } from "./osm";

export type WayKind = "road" | "rail";

/** A real road or railway (OSM way), lon/lat points with their OSM node ids. */
export interface NetworkWay {
  kind: WayKind;
  /** highway=… class for roads, usage=… for railways. */
  cls: string;
  nodes: number[];
  pts: [number, number][];
  name?: string;
}

export const ROAD_CLASSES = ["motorway", "trunk", "primary", "secondary"];

/** Main roads and main / branch railways, with their geometry and node ids (to build the graph). */
export function overpassNetworkQuery(b: Bbox): string {
  const q = `${b.south},${b.west},${b.north},${b.east}`;
  const { timeout, maxsize } = overpassLimits(b);
  return (
    `[out:json][timeout:${timeout}][maxsize:${maxsize}];(` +
    `way["highway"~"^(${ROAD_CLASSES.join("|")})$"](${q});` +
    `way["railway"="rail"]["usage"~"^(main|branch)$"](${q});` +
    `);out body geom;`
  );
}

interface OverpassWay {
  type: string;
  nodes?: number[];
  geometry?: ({ lat: number; lon: number } | null)[];
  tags?: Record<string, string>;
}

export function parseNetwork(json: { elements?: OverpassWay[] }): NetworkWay[] {
  const out: NetworkWay[] = [];
  for (const e of json.elements ?? []) {
    if (e.type !== "way" || !e.nodes || !e.geometry || e.nodes.length !== e.geometry.length) continue;
    const t = e.tags ?? {};
    const kind: WayKind | null = t.railway === "rail" ? "rail" : t.highway ? "road" : null;
    if (!kind) continue;
    const nodes: number[] = [];
    const pts: [number, number][] = [];
    e.geometry.forEach((g, k) => {
      if (!g) return;
      nodes.push(e.nodes![k]);
      pts.push([g.lon, g.lat]);
    });
    if (pts.length < 2) continue;
    out.push({ kind, cls: kind === "rail" ? (t.usage ?? "main") : t.highway, nodes, pts, name: t.name ?? t.ref });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Phase 2

export interface NetworkOptions {
  /** A town or industry farther than this (game m) from the real network is linked in a straight line. */
  attachM: number;
  /** An industry is linked to a town only within this road distance (game m). */
  industryReachM: number;
  /** A road between two towns that passes this close (game m) to a third town goes through it: not a pair. */
  throughTownM: number;
  /** Rail points every … game m. */
  railStepM: number;
}

export const DEFAULT_NETWORK: NetworkOptions = { attachM: 2000, industryReachM: 6000, throughTownM: 600, railStepM: 250 };

/** Road cost per metre by class: main roads are the natural links. */
const CLASS_COST: Record<string, number> = { motorway: 0.9, trunk: 0.8, primary: 1, secondary: 1.3 };

export interface RoadLink {
  /** "town:A|B" or "industry:A|<industry key>". */
  key: string;
  kind: "town" | "industry";
  /** Town names; for an industry link, `b` is the industry's name. */
  a: string;
  b: string;
  /** The industry linked (industry links). */
  industryKey?: string;
  tag?: string;
  /** Road length used to choose it (game m), and whether it follows the real network. */
  lengthM: number;
  real: boolean;
  /** Path for the map (game m). */
  pts: [number, number][];
}

export interface RailLine {
  key: string;
  name?: string;
  /** Points every `railStepM` along the real line, inside the map (game m). */
  pts: [number, number][];
}

export interface NetworkPlan {
  links: RoadLink[];
  rail: RailLine[];
}

/** Manual choices by link key: false = do not build. */
export type LinkPicks = Record<string, boolean>;

interface Node {
  x: number;
  y: number;
  adj: { to: number; w: number; len: number }[];
}

/** Graph of the ways of one kind, in game metres (nodes shared between ways join them). */
function buildGraph(f: Frame, ways: NetworkWay[], kind: WayKind): Node[] {
  const p = frameProjection(f);
  const index = new Map<number, number>();
  const nodes: Node[] = [];
  const at = (id: number, ll: [number, number]): number => {
    let k = index.get(id);
    if (k === undefined) {
      const [x, y] = p.toWorld(ll[0], ll[1]);
      k = nodes.push({ x, y, adj: [] }) - 1;
      index.set(id, k);
    }
    return k;
  };
  for (const w of ways) {
    if (w.kind !== kind) continue;
    const cost = kind === "road" ? (CLASS_COST[w.cls] ?? 1.3) : 1;
    for (let i = 1; i < w.nodes.length; i++) {
      const a = at(w.nodes[i - 1], w.pts[i - 1]);
      const b = at(w.nodes[i], w.pts[i]);
      const len = Math.hypot(nodes[a].x - nodes[b].x, nodes[a].y - nodes[b].y);
      nodes[a].adj.push({ to: b, w: len * cost, len });
      nodes[b].adj.push({ to: a, w: len * cost, len });
    }
  }
  return nodes;
}

/** Min-heap of (priority, value). */
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

/** Shortest paths from `src` (by weight `w`, or by length): distances, lengths and parents. */
function dijkstra(nodes: Node[], src: number, byLength = false): { dist: Float64Array; len: Float64Array; parent: Int32Array } {
  const dist = new Float64Array(nodes.length).fill(Infinity);
  const len = new Float64Array(nodes.length).fill(Infinity);
  const parent = new Int32Array(nodes.length).fill(-1);
  const heap = new Heap();
  dist[src] = 0;
  len[src] = 0;
  heap.push(0, src);
  while (heap.size) {
    const [d, i] = heap.pop();
    if (d > dist[i]) continue;
    for (const e of nodes[i].adj) {
      const nd = d + (byLength ? e.len : e.w);
      if (nd < dist[e.to]) {
        dist[e.to] = nd;
        len[e.to] = len[i] + e.len;
        parent[e.to] = i;
        heap.push(nd, e.to);
      }
    }
  }
  return { dist, len, parent };
}

function nearestNode(nodes: Node[], x: number, y: number, maxM: number): number {
  let best = -1;
  let bestD = maxM;
  for (let k = 0; k < nodes.length; k++) {
    const d = Math.hypot(nodes[k].x - x, nodes[k].y - y);
    if (d <= bestD && nodes[k].adj.length) {
      bestD = d;
      best = k;
    }
  }
  return best;
}

function pathTo(parent: Int32Array, nodes: Node[], to: number): [number, number][] {
  const pts: [number, number][] = [];
  for (let k = to; k >= 0; k = parent[k]) pts.push([nodes[k].x, nodes[k].y]);
  return pts.reverse();
}

/** Points every `step` game m along a polyline. */
export function resample(pts: [number, number][], step: number): [number, number][] {
  if (pts.length < 2) return pts.slice();
  const out: [number, number][] = [pts[0]];
  let carry = 0;
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1];
    const [bx, by] = pts[i];
    const seg = Math.hypot(bx - ax, by - ay);
    let s = step - carry;
    while (s <= seg) {
      out.push([ax + ((bx - ax) * s) / seg, ay + ((by - ay) * s) / seg]);
      s += step;
    }
    carry = seg - (s - step);
  }
  const last = pts[pts.length - 1];
  if (Math.hypot(last[0] - out[out.length - 1][0], last[1] - out[out.length - 1][1]) > step / 3) out.push(last);
  return out;
}

export interface NetTown {
  name: string;
  x: number;
  y: number;
}

export interface NetIndustry {
  key: string;
  tag: string;
  name: string;
  x: number;
  y: number;
  onWater: boolean;
}

/**
 * The links to build: each town to 1 or 2 others (cheapest real road first, never through a third
 * town; a town left alone gets its cheapest link), each town to at most one industry within reach,
 * and the main real railway. `picks[key] === false` drops a link.
 */
export function planNetwork(
  f: Frame,
  ways: NetworkWay[],
  towns: NetTown[],
  industries: NetIndustry[],
  picks: LinkPicks = {},
  o: NetworkOptions = DEFAULT_NETWORK,
): NetworkPlan {
  const roads = buildGraph(f, ways, "road");
  const attach = towns.map((t) => nearestNode(roads, t.x, t.y, o.attachM));
  const trees = attach.map((n) => (n >= 0 ? dijkstra(roads, n) : null));

  // Town pairs: real road cost, or the straight line (×1.5) when one is off the network.
  type Cand = { i: number; j: number; cost: number; len: number; real: boolean; pts: [number, number][] };
  const cands: Cand[] = [];
  for (let i = 0; i < towns.length; i++) {
    for (let j = i + 1; j < towns.length; j++) {
      const straight = Math.hypot(towns[i].x - towns[j].x, towns[i].y - towns[j].y);
      const tree = trees[i];
      const to = attach[j];
      if (tree && to >= 0 && Number.isFinite(tree.dist[to])) {
        const pts = pathTo(tree.parent, roads, to);
        const through = towns.some(
          (t, k) => k !== i && k !== j && pts.some(([x, y]) => Math.hypot(x - t.x, y - t.y) < o.throughTownM),
        );
        if (through) continue;
        cands.push({ i, j, cost: tree.dist[to], len: tree.len[to], real: true, pts: [[towns[i].x, towns[i].y], ...pts, [towns[j].x, towns[j].y]] });
      } else {
        cands.push({ i, j, cost: straight * 1.5, len: straight, real: false, pts: [[towns[i].x, towns[i].y], [towns[j].x, towns[j].y]] });
      }
    }
  }
  cands.sort((a, b) => a.cost - b.cost);
  const deg = new Array(towns.length).fill(0);
  const chosen: Cand[] = [];
  const townKey = (c: Cand) => `town:${[towns[c.i].name, towns[c.j].name].sort().join("|")}`;
  const usable = cands.filter((c) => picks[townKey(c)] !== false);
  for (const c of usable) {
    if (deg[c.i] < 2 && deg[c.j] < 2) {
      chosen.push(c);
      deg[c.i]++;
      deg[c.j]++;
    }
  }
  // A town still alone gets its cheapest link, even to a town that already has two.
  for (let k = 0; k < towns.length; k++) {
    if (deg[k]) continue;
    const c = usable.find((x) => (x.i === k || x.j === k) && !chosen.includes(x));
    if (c) {
      chosen.push(c);
      deg[c.i]++;
      deg[c.j]++;
    }
  }
  const links: RoadLink[] = chosen.map((c) => ({
    key: townKey(c),
    kind: "town",
    a: towns[c.i].name,
    b: towns[c.j].name,
    lengthM: Math.round(c.len),
    real: c.real,
    pts: c.pts,
  }));
  // Removed by hand: listed, so they can be added back.
  for (const c of cands) {
    const key = townKey(c);
    if (picks[key] === false && !links.some((l) => l.key === key)) {
      links.push({ key, kind: "town", a: towns[c.i].name, b: towns[c.j].name, lengthM: Math.round(c.len), real: c.real, pts: c.pts });
    }
  }

  // One industry per town at most: cheapest town–industry pairs first, within reach.
  type ICand = { t: number; m: NetIndustry; len: number; real: boolean; pts: [number, number][] };
  const icands: ICand[] = [];
  for (const m of industries) {
    if (m.onWater) continue;
    const node = nearestNode(roads, m.x, m.y, o.attachM);
    towns.forEach((t, k) => {
      const tree = trees[k];
      if (tree && node >= 0 && Number.isFinite(tree.dist[node])) {
        if (tree.len[node] > o.industryReachM) return;
        icands.push({ t: k, m, len: tree.len[node], real: true, pts: [[t.x, t.y], ...pathTo(tree.parent, roads, node), [m.x, m.y]] });
      } else {
        const d = Math.hypot(t.x - m.x, t.y - m.y);
        if (d * 1.5 <= o.industryReachM) icands.push({ t: k, m, len: d * 1.5, real: false, pts: [[t.x, t.y], [m.x, m.y]] });
      }
    });
  }
  icands.sort((a, b) => a.len - b.len);
  const townHas = new Set<number>();
  const industryHas = new Set<string>();
  // A town whose industry link was removed by hand gets no other one (nothing swapped in).
  towns.forEach((t, k) => {
    if (Object.entries(picks).some(([key, v]) => v === false && key.startsWith(`industry:${t.name}|`))) townHas.add(k);
  });
  for (const c of icands) {
    const key = `industry:${towns[c.t].name}|${c.m.key}`;
    if (picks[key] === false && !links.some((l) => l.key === key)) {
      links.push({ key, kind: "industry", a: towns[c.t].name, b: c.m.name, industryKey: c.m.key, tag: c.m.tag, lengthM: Math.round(c.len), real: c.real, pts: c.pts });
      continue;
    }
    if (townHas.has(c.t) || industryHas.has(c.m.key)) continue;
    const link: RoadLink = {
      key, kind: "industry", a: towns[c.t].name, b: c.m.name, industryKey: c.m.key, tag: c.m.tag,
      lengthM: Math.round(c.len), real: c.real, pts: c.pts,
    };
    links.push(link);
    townHas.add(c.t);
    industryHas.add(c.m.key);
  }

  return { links, rail: mainRail(f, ways, towns, o) };
}

/**
 * The real main line(s): the longest path of the longest main-line network, clipped to the map
 * and resampled; a second one only when it passes within 1 km of 3 placed towns or more.
 */
function mainRail(f: Frame, ways: NetworkWay[], towns: NetTown[], o: NetworkOptions): RailLine[] {
  const nodes = buildGraph(f, ways.filter((w) => w.cls === "main" || w.cls === "branch"), "rail");
  const hw = f.widthM / 2 - 100;
  const hh = f.heightM / 2 - 100;
  const inside = ([x, y]: [number, number]) => Math.abs(x) <= hw && Math.abs(y) <= hh;
  const seen = new Uint8Array(nodes.length);
  const lines: { pts: [number, number][]; len: number; towns: number }[] = [];
  for (let s = 0; s < nodes.length; s++) {
    if (seen[s] || !nodes[s].adj.length) continue;
    // Component, then its longest path by two sweeps (exact on trees, good enough on rail networks).
    const comp: number[] = [];
    const stack = [s];
    seen[s] = 1;
    while (stack.length) {
      const k = stack.pop()!;
      comp.push(k);
      for (const e of nodes[k].adj) if (!seen[e.to]) {
        seen[e.to] = 1;
        stack.push(e.to);
      }
    }
    const far = (from: number) => {
      const r = dijkstra(nodes, from, true);
      let best = from;
      for (const k of comp) if (Number.isFinite(r.dist[k]) && r.dist[k] > r.dist[best]) best = k;
      return { best, r };
    };
    const a = far(comp[0]).best;
    const { best: b, r } = far(a);
    // Resampled, then cut to the map: the longest piece inside counts.
    let piece: [number, number][] = [];
    let best: [number, number][] = [];
    for (const pt of resample(pathTo(r.parent, nodes, b), o.railStepM)) {
      if (inside(pt)) piece.push(pt);
      else piece = [];
      if (piece.length > best.length) best = piece;
    }
    if (best.length < 3) continue;
    const served = towns.filter((t) => best.some(([x, y]) => Math.hypot(x - t.x, y - t.y) < 1000)).length;
    lines.push({ pts: best, len: best.length, towns: served });
  }
  lines.sort((x, y) => y.len - x.len);
  const keep = lines.slice(0, 1).concat(lines.slice(1).filter((l) => l.towns >= 3).slice(0, 1));
  return keep.map((l, k) => ({ key: `rail:${k}`, pts: l.pts }));
}

/** Note fields read by the importcity mod (`<UD>/importcity/<name>.lua`). */
export function networkData(plan: NetworkPlan, picks: LinkPicks): {
  connections: { a: string; b: string }[];
  industryLinks: { town: string; tag: string; x: number; y: number }[];
  rail: { lines: { x: number; y: number }[][] };
} {
  const on = plan.links.filter((l) => picks[l.key] !== false);
  const r1 = (v: number) => Math.round(v * 10) / 10;
  return {
    connections: on.filter((l) => l.kind === "town").map((l) => ({ a: l.a, b: l.b })),
    industryLinks: on
      .filter((l) => l.kind === "industry")
      .map((l) => ({ town: l.a, tag: l.tag!, x: r1(l.pts[l.pts.length - 1][0]), y: r1(l.pts[l.pts.length - 1][1]) })),
    rail: { lines: plan.rail.filter((r) => picks[r.key] !== false).map((r) => r.pts.map(([x, y]) => ({ x: r1(x), y: r1(y) }))) },
  };
}
