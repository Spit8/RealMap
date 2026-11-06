/**
 * Start-of-game roads and railway. Phase 1: the real main roads and railways (OSM). Phase 2:
 * which towns the game should link by road — small separate networks of at most
 * `maxNetworkTowns` towns along the real roads, never a lone town (each town has another town or an
 * industry), or only the user's links once changed by hand (DECISION-019) — each industry's access
 * to its nearest town (shown on the map; it keeps that town from being alone), and the real main
 * railway line. The game builds the roads itself in the Map Editor (the importcity mod): its own
 * routing and road type for the year, and it links the industries while doing so (FACT-024).
 * Only the town pairs and the rail points are written in the note.
 */
import { frameProjection, type Frame } from "./area";
import { overpassLimits, type Bbox } from "./osm";
import type { RailDesign, RailNode } from "./railway";

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

/**
 * Main roads and railways, with their geometry and node ids (to build the graph). Every running
 * line is kept: crossovers, junction links and short pieces often have no `usage` tag (FACT-031),
 * only tourist / military / industrial / test lines and yards, sidings and spurs are left out.
 */
export function overpassNetworkQuery(b: Bbox): string {
  const q = `${b.south},${b.west},${b.north},${b.east}`;
  const { timeout, maxsize } = overpassLimits(b);
  return (
    `[out:json][timeout:${timeout}][maxsize:${maxsize}];(` +
    `way["highway"~"^(${ROAD_CLASSES.join("|")})$"](${q});` +
    `way["railway"="rail"]["usage"!~"^(tourism|military|industrial|test)$"]["service"!~"^(yard|siding|spur)$"](${q});` +
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
    out.push({ kind, cls: kind === "rail" ? (t.usage === "branch" ? "branch" : "main") : t.highway, nodes, pts, name: t.name ?? t.ref });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Phase 2

export interface NetworkOptions {
  /** A town farther than this (game m) from the real network is linked in a straight line. */
  attachM: number;
  /** A road between two towns that passes this close (game m) to a third town goes through it: not a pair. */
  throughTownM: number;
  /** Points of the guide line every … game m (the alignment is designed from it, `railway.ts`). */
  railStepM: number;
  /**
   * Most towns in one road network at the start: several separate networks for the player to join.
   * A town with neither a town nor an industry linked still gets its cheapest link beyond it.
   */
  maxNetworkTowns: number;
}

export const DEFAULT_NETWORK: NetworkOptions = { attachM: 2000, throughTownM: 600, railStepM: 50, maxNetworkTowns: 3 };

/** Road cost per metre by class: main roads are the natural links. */
const CLASS_COST: Record<string, number> = { motorway: 0.9, trunk: 0.8, primary: 1, secondary: 1.3 };

export interface RoadLink {
  /** "town:A|B" (names sorted), or "ind:<industry key>" for an industry's access. */
  key: string;
  kind: "town" | "industry";
  /** Town names, or the industry's name (a) and its town (b). */
  a: string;
  b: string;
  /** Road length used to choose it (game m), and whether it follows the real network. */
  lengthM: number;
  real: boolean;
  /** The real road used to choose it (game m); the map draws the planned link straight. */
  pts: [number, number][];
}

export interface RailLine {
  key: string;
  name?: string;
  /** The real line (guide), or once designed the nodes' positions (game m), for the map. */
  pts: [number, number][];
  /** The designed alignment the mod lays (`railway.ts`), and its figures. */
  nodes?: RailNode[];
  design?: Omit<RailDesign, "nodes">;
}

export interface NetworkPlan {
  links: RoadLink[];
  rail: RailLine[];
}

/** Manual choices by link key: false = do not build, true = build (a road added by hand). */
export type LinkPicks = Record<string, boolean>;

/** A railway line added by hand between two points (lon/lat), `key` = `rail:user:<id>`. */
export interface CustomRail {
  key: string;
  from: [number, number];
  to: [number, number];
}

interface Node {
  x: number;
  y: number;
  adj: { to: number; w: number; len: number }[];
}

/** Railway ends this close (game m) to another track are joined (OSM pieces that almost touch). */
const RAIL_JOIN_M = 25;

/**
 * Graph of the ways of one kind, in game metres (nodes shared between ways join them; for railways
 * a loose end is also joined to the nearest track vertex within RAIL_JOIN_M).
 */
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
  if (kind === "rail") joinLooseEnds(nodes, RAIL_JOIN_M);
  return nodes;
}

/** Each vertex with a single neighbour joined to the nearest vertex within `maxM` it is not linked to. */
function joinLooseEnds(nodes: Node[], maxM: number): void {
  const cell = (v: number) => Math.floor(v / maxM);
  const grid = new Map<string, number[]>();
  nodes.forEach((n, k) => {
    const key = `${cell(n.x)},${cell(n.y)}`;
    (grid.get(key) ?? grid.set(key, []).get(key)!).push(k);
  });
  for (let k = 0; k < nodes.length; k++) {
    const n = nodes[k];
    if (n.adj.length !== 1) continue;
    let best = -1;
    let bestD = maxM;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      for (const j of grid.get(`${cell(n.x) + dx},${cell(n.y) + dy}`) ?? []) {
        if (j === k || n.adj.some((e) => e.to === j)) continue;
        const d = Math.hypot(nodes[j].x - n.x, nodes[j].y - n.y);
        if (d <= bestD) {
          bestD = d;
          best = j;
        }
      }
    }
    if (best < 0) continue;
    n.adj.push({ to: best, w: bestD, len: bestD });
    nodes[best].adj.push({ to: k, w: bestD, len: bestD });
  }
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

/** A placed industry to link to its nearest town (land industries only). */
export interface NetIndustry {
  key: string;
  name: string;
  x: number;
  y: number;
}

/** Disjoint sets of towns (road networks). */
class Networks {
  private up: number[];
  private n: number[];
  constructor(count: number) {
    this.up = Array.from({ length: count }, (_, k) => k);
    this.n = new Array(count).fill(1);
  }
  find(k: number): number {
    while (this.up[k] !== k) k = this.up[k] = this.up[this.up[k]];
    return k;
  }
  size(k: number): number {
    return this.n[this.find(k)];
  }
  join(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return;
    this.up[rb] = ra;
    this.n[ra] += this.n[rb];
  }
}

/**
 * The town roads and industry accesses to build.
 *  - Each land industry gets an access to its nearest town (real road cost, else straight × 1.5).
 *  - Town pairs, cheapest real road first, never through a third town: each town at most 2 links
 *    and each network at most `maxNetworkTowns` towns, so the map starts with several separate
 *    networks. A town left with neither a town nor an industry gets its cheapest link anyway.
 *  - `picks[key] === false` drops a town pair, `true` builds it first (added by hand, even through
 *    a town). With `frozen` (the town roads were changed by hand), only those pairs and the ones
 *    added by hand; a frozen list matching no pair of this map (another area) counts as automatic.
 */
export function planRoads(
  f: Frame,
  ways: NetworkWay[],
  towns: NetTown[],
  industries: NetIndustry[] = [],
  picks: LinkPicks = {},
  o: NetworkOptions = DEFAULT_NETWORK,
  frozenIn: string[] | null = null,
): RoadLink[] {
  const pairKey = (i: number, j: number) => `town:${[towns[i].name, towns[j].name].sort().join("|")}`;
  const roads = buildGraph(f, ways, "road");
  const attach = towns.map((t) => nearestNode(roads, t.x, t.y, o.attachM));
  const trees = attach.map((n) => (n >= 0 ? dijkstra(roads, n) : null));

  // Industry accesses: the nearest town by road (or straight × 1.5 off the network).
  const access: RoadLink[] = [];
  const served = new Uint8Array(towns.length);
  for (const ind of industries) {
    const at = nearestNode(roads, ind.x, ind.y, o.attachM);
    let best = -1;
    let bestCost = Infinity;
    let bestLen = 0;
    let bestPts: [number, number][] = [];
    for (let k = 0; k < towns.length; k++) {
      const straight = Math.hypot(towns[k].x - ind.x, towns[k].y - ind.y);
      const tree = trees[k];
      const real = !!tree && at >= 0 && Number.isFinite(tree.dist[at]);
      const cost = real ? tree!.dist[at] : straight * 1.5;
      if (cost >= bestCost) continue;
      best = k;
      bestCost = cost;
      bestLen = real ? tree!.len[at] : straight;
      bestPts = real
        ? [[towns[k].x, towns[k].y], ...pathTo(tree!.parent, roads, at), [ind.x, ind.y]]
        : [[towns[k].x, towns[k].y], [ind.x, ind.y]];
    }
    if (best < 0) continue;
    served[best] = 1;
    access.push({ key: `ind:${ind.key}`, kind: "industry", a: ind.name, b: towns[best].name, lengthM: Math.round(bestLen), real: bestPts.length > 2, pts: bestPts });
  }

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
        if (through && picks[pairKey(i, j)] !== true) continue;
        cands.push({ i, j, cost: tree.dist[to], len: tree.len[to], real: true, pts: [[towns[i].x, towns[i].y], ...pts, [towns[j].x, towns[j].y]] });
      } else {
        cands.push({ i, j, cost: straight * 1.5, len: straight, real: false, pts: [[towns[i].x, towns[i].y], [towns[j].x, towns[j].y]] });
      }
    }
  }
  cands.sort((a, b) => a.cost - b.cost);
  const townKey = (c: Cand) => pairKey(c.i, c.j);
  // A frozen list from another map (or an empty one) matches no pair here: automatic choice.
  const frozen = frozenIn && cands.some((c) => frozenIn.includes(townKey(c))) ? frozenIn : null;
  const deg = new Array(towns.length).fill(0);
  const nets = new Networks(towns.length);
  const chosen: Cand[] = [];
  const take = (c: Cand) => {
    chosen.push(c);
    deg[c.i]++;
    deg[c.j]++;
    nets.join(c.i, c.j);
  };
  const usable = cands.filter((c) => picks[townKey(c)] !== false);
  // Roads added by hand first.
  for (const c of usable) if (picks[townKey(c)] === true) take(c);
  const kept = new Set(frozen ?? []);
  for (const c of usable) {
    if (chosen.includes(c)) continue;
    if (frozen) {
      if (kept.has(townKey(c))) take(c);
      continue;
    }
    if (deg[c.i] >= 2 || deg[c.j] >= 2 || nets.find(c.i) === nets.find(c.j)) continue;
    if (nets.size(c.i) + nets.size(c.j) > o.maxNetworkTowns) continue;
    take(c);
  }
  // Never a lone town: one with neither a town nor an industry gets its cheapest link.
  for (let k = 0; k < towns.length && !frozen; k++) {
    if (deg[k] || served[k]) continue;
    const c = usable.find((x) => (x.i === k || x.j === k) && !chosen.includes(x));
    if (c) take(c);
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
  return [...links, ...access];
}

/** Separate road networks among `towns` with the town links left in (a lone town counts as one). */
export function roadNetworks(towns: string[], links: RoadLink[], picks: LinkPicks = {}): number {
  const at = new Map(towns.map((n, k) => [n, k]));
  const nets = new Networks(towns.length);
  for (const l of links) {
    if (l.kind !== "town" || picks[l.key] === false) continue;
    const a = at.get(l.a);
    const b = at.get(l.b);
    if (a !== undefined && b !== undefined) nets.join(a, b);
  }
  return new Set(towns.map((_, k) => nets.find(k))).size;
}

/** The real main railway line(s) and the lines added by hand. */
export function planRail(f: Frame, ways: NetworkWay[], towns: NetTown[], customRails: CustomRail[] = [], o: NetworkOptions = DEFAULT_NETWORK): RailLine[] {
  return [...mainRail(f, ways, towns, o), ...customRails.map((c) => userRail(f, ways, c, o))];
}

/** Town roads, industry accesses and railway in one go (`planRoads` + `planRail`). */
export function planNetwork(
  f: Frame,
  ways: NetworkWay[],
  towns: NetTown[],
  picks: LinkPicks = {},
  o: NetworkOptions = DEFAULT_NETWORK,
  customRails: CustomRail[] = [],
  frozen: string[] | null = null,
  industries: NetIndustry[] = [],
): NetworkPlan {
  return { links: planRoads(f, ways, towns, industries, picks, o, frozen), rail: planRail(f, ways, towns, customRails, o) };
}

/** Farthest a clicked point may be from the real tracks to follow them (game m). */
const RAIL_ATTACH_M = 1500;

/**
 * A line added by hand: the shortest path on the real railways (any class) between the tracks
 * nearest to its two points, else the straight line; resampled like the main line.
 */
export function userRail(f: Frame, ways: NetworkWay[], c: CustomRail, o: NetworkOptions = DEFAULT_NETWORK): RailLine {
  const p = frameProjection(f);
  const a = p.toWorld(c.from[0], c.from[1]);
  const b = p.toWorld(c.to[0], c.to[1]);
  const nodes = buildGraph(f, ways, "rail");
  const na = nearestNode(nodes, a[0], a[1], RAIL_ATTACH_M);
  const nb = nearestNode(nodes, b[0], b[1], RAIL_ATTACH_M);
  let pts: [number, number][] = [a, b];
  let real = false;
  if (na >= 0 && nb >= 0 && na !== nb) {
    const r = dijkstra(nodes, na, true);
    if (Number.isFinite(r.dist[nb])) {
      pts = [a, ...pathTo(r.parent, nodes, nb), b];
      real = true;
    }
  }
  return { key: c.key, name: real ? "Voie ajoutée (voies réelles)" : "Voie ajoutée (ligne directe)", pts: resample(pts, o.railStepM) };
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

/** Note fields read by the importcity mod (`<UD>/towns_industries/realmap_note_<name>.lua`). */
export function networkData(plan: NetworkPlan, picks: LinkPicks, railGrade?: number): {
  connections: { a: string; b: string }[];
  rail: { lines: NoteNode[][]; grade?: number };
} {
  const on = plan.links.filter((l) => l.kind === "town" && picks[l.key] !== false);
  return {
    // Town pairs: the game's connection command routes and builds them.
    connections: on.map((l) => ({ a: l.a, b: l.b })),
    // Designed lines only: nodes with height, unit tangent and the kind of the edge they start.
    // Its steepest game grade: the mod keeps to it when it lowers the track under a road (DECISION-035).
    rail: { lines: plan.rail.filter((r) => picks[r.key] !== false && r.nodes).map((r) => r.nodes!.map(noteNode)), grade: railGrade },
  };
}

type NoteNode = { x: number; y: number; z: number; tx: number; ty: number; tz: number; kind: string };

function noteNode(p: RailNode): NoteNode {
  const r1 = (v: number) => Math.round(v * 10) / 10;
  const r4 = (v: number) => Math.round(v * 1e4) / 1e4;
  return { x: r1(p.x), y: r1(p.y), z: r1(p.z), tx: r4(p.tx), ty: r4(p.ty), tz: r4(p.tz), kind: p.kind };
}
