/**
 * Towns from OpenStreetMap (`place=*` nodes) → the Map Editor's towns_industries import file
 * (FACT-002): `{ towns = { {name, position={x,y}, sizeFactors={res,com,ind}} }, industries = {} }`.
 * Places are picked by population, then settled on valid ground of the composed terrain.
 */
import { frameProjection, type Frame } from "./area";
import { cellToWorld, worldToCell } from "./grid";
import type { LuaValue } from "./luadata";
import { msg, type Msg } from "./msg";
import { distanceTo } from "./raster";
import { WATER_LAKE, WATER_RIVER, WATER_SEA } from "./terrain";

export type PlaceKind = "city" | "town" | "village";

export interface OsmPlace {
  name: string;
  lon: number;
  lat: number;
  place: PlaceKind;
  population?: number;
}

/** Limites déclarées de la requête des lieux, quelle que soit la zone (des nœuds seulement). */
export const PLACES_TIMEOUT_S = 90;
export const PLACES_MAXSIZE = 64 * 1024 * 1024;

export function overpassTownsQuery(
  b: { west: number; south: number; east: number; north: number },
  kinds: PlaceKind[],
): string {
  const bbox = `${b.south},${b.west},${b.north},${b.east}`;
  const sel = kinds.map((k) => `node["place"="${k}"]["name"](${bbox});`).join("");
  // Requête légère (des nœuds seulement, environ 45 000 pour la Pologne) : limites modestes, admise vite.
  return `[out:json][timeout:${PLACES_TIMEOUT_S}][maxsize:${PLACES_MAXSIZE}];(${sel});out body;`;
}

interface OverpassElement {
  type: string;
  lat?: number;
  lon?: number;
  tags?: Record<string, string>;
}

/** OSM `population` tags are free text ("12 345", "12,345", "ca. 5000"): keep the digits of the first number. */
export function parsePopulation(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const m = /\d[\d\s.,']*/.exec(s);
  if (!m) return undefined;
  const n = Number(m[0].replace(/[\s.,']/g, ""));
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Places, one per `placeKey` (two OSM nodes of the same name ~10 m apart: the most populous one). */
export function parseOverpassPlaces(json: { elements?: OverpassElement[] }, preferredLang = "fr"): OsmPlace[] {
  const byKey = new Map<string, OsmPlace>();
  for (const e of json.elements ?? []) {
    const t = e.tags ?? {};
    const place = t.place as PlaceKind;
    if (e.type !== "node" || e.lat === undefined || e.lon === undefined) continue;
    if (place !== "city" && place !== "town" && place !== "village") continue;
    const name = t[`name:${preferredLang}`] || t.name;
    if (!name) continue;
    const p: OsmPlace = { name, lon: e.lon, lat: e.lat, place, population: parsePopulation(t.population) };
    const key = placeKey(p);
    const prev = byKey.get(key);
    if (!prev || (p.population ?? 0) > (prev.population ?? 0)) byKey.set(key, p);
  }
  return [...byKey.values()];
}

/** Population assumed for a place without a `population` tag. */
const ESTIMATED_POPULATION: Record<PlaceKind, number> = { city: 50_000, town: 5_000, village: 500 };

/** Stable identity of an OSM place across runs (name + position to ~10 m), used for manual picks. */
export function placeKey(p: { name: string; lon: number; lat: number }): string {
  return `${p.name}|${p.lon.toFixed(4)},${p.lat.toFixed(4)}`;
}

/**
 * Town capacity in game (sum of residential, commercial, industrial) for a population:
 * `refCapacity` at 10 000 inhabitants, scaled by (population / 10 000)^`sizeExponent`, clamped.
 * Towns of a standard game measure 240–820 (FACT-016); exponent 0.5 keeps big cities playable.
 */
export function targetCapacity(population: number, o: TownsOptions): number {
  const c = o.refCapacity * Math.pow(Math.max(1, population) / 10_000, o.sizeExponent);
  return Math.round(Math.min(o.maxCapacity, Math.max(o.minCapacity, c)));
}

export interface PlaceFilter {
  minPopulation: number;
  /** Places without a population tag count with an estimate from their kind. */
  includeUnknown: boolean;
}

/** Manual choices by `placeKey`: true = always a town, false = never; absent = by the filter. */
export type TownPicks = Record<string, boolean>;

export type RankedPlace = OsmPlace & { key: string; rank: number; estimated: boolean; forced: boolean };

/** Population, or an estimate from the place kind. */
function rankOf(p: OsmPlace): { rank: number; estimated: boolean } {
  return { rank: p.population ?? ESTIMATED_POPULATION[p.place], estimated: !p.population };
}

const byRank = (a: RankedPlace, b: RankedPlace) => b.rank - a.rank || a.name.localeCompare(b.name);

/**
 * Places to turn into towns: the ones picked by hand first, then the filter's `maxAuto` most
 * populous. The filter's choice is made without the manual picks, so adding a town adds one and
 * removing a town removes one: nothing is swapped in or out behind the user's back. In France the
 * OSM kind says little about size (FACT-014: Valognes, 6 800 inhabitants, is a "village"), so
 * population is the criterion.
 */
export function selectTowns(places: OsmPlace[], o: PlaceFilter, picks: TownPicks = {}, maxAuto = Infinity): RankedPlace[] {
  const forced: RankedPlace[] = [];
  const auto: RankedPlace[] = [];
  for (const p of places) {
    const key = placeKey(p);
    const pick = picks[key];
    const { rank, estimated } = rankOf(p);
    if (pick === true) forced.push({ ...p, key, rank, estimated, forced: true });
    else if ((!estimated || o.includeUnknown) && rank >= o.minPopulation) auto.push({ ...p, key, rank, estimated, forced: false });
  }
  const kept = auto.sort(byRank).slice(0, maxAuto).filter((p) => picks[p.key] !== false);
  return [...forced.sort(byRank), ...kept];
}

/**
 * Towns the game itself puts on a map of this size (indicative, FACT-021): up to 41 on a Large
 * map (56 × 56 tiles), 13 on a Small one (32 × 32): about one per 76 tiles.
 */
export function gameTownLimit(f: { tilesX: number; tilesY: number }): number {
  return Math.max(1, Math.round((41 * f.tilesX * f.tilesY) / 3136));
}

export type CandidateStatus = "placed" | "dropped" | "limit" | "off";

/** Every place of the map with what became of it, for the town list and the map markers. */
export interface TownCandidate {
  key: string;
  name: string;
  /** Type OSM du lieu (filtre des listes). */
  place: PlaceKind;
  lon: number;
  lat: number;
  rank: number;
  estimated: boolean;
  /** Manual choice, or null when the filter decides. */
  pick: boolean | null;
  status: CandidateStatus;
  reason?: Msg;
  capacity?: number;
}

export function townCandidates(
  places: OsmPlace[],
  picks: TownPicks,
  towns: MapTown[],
  dropped: DroppedTown[],
  selected: RankedPlace[],
): TownCandidate[] {
  const placed = new Map(towns.map((t) => [t.key, t]));
  const lost = new Map(dropped.map((d) => [d.key, d.reason]));
  const chosen = new Set(selected.map((s) => s.key));
  return places
    .map((p): TownCandidate => {
      const key = placeKey(p);
      const { rank, estimated } = rankOf(p);
      const t = placed.get(key);
      const status: CandidateStatus = t ? "placed" : lost.has(key) ? "dropped" : chosen.has(key) ? "limit" : "off";
      const reason = lost.get(key);
      return { key, name: p.name, place: p.place, lon: p.lon, lat: p.lat, rank, estimated, pick: picks[key] ?? null, status, reason, capacity: t?.capacity };
    })
    .sort((a, b) => b.rank - a.rank || a.name.localeCompare(b.name));
}

export interface TownsOptions {
  /** Game capacity of a town of 10 000 inhabitants. */
  refCapacity: number;
  /** How capacity grows with population: 1 = proportional, 0.5 = square root, 0 = all equal. */
  sizeExponent: number;
  minCapacity: number;
  maxCapacity: number;
  /** Towns chosen by the filter (manual additions come on top, removals are not replaced). */
  maxTowns: number;
  /** Game metres between two towns (the more populous one wins). */
  minSpacingM: number;
  /** Game metres a town centre keeps from the sea and lakes (QUESTION-008: towns too close to the sea do not appear). */
  waterClearanceM: number;
  /** Game metres a town centre keeps from rivers (towns on rivers do appear: a small margin only). */
  riverClearanceM: number;
  /** Game metres a town centre keeps from the map edge. */
  edgeMarginM: number;
  /** How far (game m) a town may be moved to find valid ground; beyond it, it is dropped. */
  maxShiftM: number;
}

export const DEFAULT_TOWNS: TownsOptions = {
  refCapacity: 100,
  sizeExponent: 0.5,
  minCapacity: 60,
  maxCapacity: 2500,
  maxTowns: 20,
  minSpacingM: 1000,
  waterClearanceM: 400,
  riverClearanceM: 100,
  edgeMarginM: 500,
  maxShiftM: 3000,
};

export interface MapTown {
  key: string;
  name: string;
  /** Final game position. */
  x: number;
  y: number;
  /** Position of the OSM place, before any move. */
  ox: number;
  oy: number;
  /** Game metres moved (0 when the OSM place was fine), and why. */
  shift: number;
  moveReason?: Msg;
  /** Target capacity in game (applied by the importcity mod, FACT-016). */
  capacity: number;
  place: PlaceKind;
  population?: number;
  /** Picked by hand. */
  forced: boolean;
  /** Share of each land use in its capacity (real commercial / industrial areas, `landuse.ts`). */
  shares?: { res: number; com: number; ind: number; real: boolean };
  /** Goods asked for by its commercial and industrial land use (`townneeds.ts`). */
  needs?: { com: string[]; ind: string[] };
}

export interface DroppedTown {
  key: string;
  name: string;
  reason: Msg;
}

/** Valid-ground test for town centres on a grid, from a composed terrain. */
export interface TownGround {
  nx: number;
  ny: number;
  step: number;
  /** Game metres to the nearest sea / lake cell, and to the nearest river cell. */
  waterDist: Float32Array;
  riverDist: Float32Array;
  game: Float32Array;
  water: Uint8Array;
}

/** Steepest local relief around a cell (3×3 range over 2 steps). */
function localSlope(t: TownGround, c: number, r: number): number {
  let lo = Infinity;
  let hi = -Infinity;
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      const cc = Math.min(t.nx - 1, Math.max(0, c + dc));
      const rr = Math.min(t.ny - 1, Math.max(0, r + dr));
      const z = t.game[rr * t.nx + cc];
      if (z < lo) lo = z;
      if (z > hi) hi = z;
    }
  }
  return (hi - lo) / (2 * t.step);
}

const MAX_TOWN_SLOPE = 0.2;

/** Nearest cell to (c0, r0) within R cells where `valid` holds: coarse pass, then refine. */
export function nearestValidCell(c0: number, r0: number, R: number, valid: (c: number, r: number) => boolean): [number, number] | null {
  const stride = Math.max(1, Math.floor(R / 150));
  let best: [number, number] | null = null;
  let bestD = Infinity;
  const scan = (cc: number, rc: number, rad: number, s: number) => {
    for (let r = rc - rad; r <= rc + rad; r += s) {
      for (let c = cc - rad; c <= cc + rad; c += s) {
        const d = (c - c0) ** 2 + (r - r0) ** 2;
        if (d < bestD && d <= R * R && valid(c, r)) {
          bestD = d;
          best = [c, r];
        }
      }
    }
  };
  scan(c0, r0, R, stride);
  // `best` is assigned inside scan(): TypeScript cannot follow it.
  const coarse = best as [number, number] | null;
  if (coarse && stride > 1) scan(coarse[0], coarse[1], stride, 1);
  return best;
}

/** Steepest local relief around a cell of a height grid (3×3 range over 2 steps). */
export function slopeAt(game: Float32Array, nx: number, ny: number, step: number, c: number, r: number): number {
  return localSlope({ nx, ny, step, game } as TownGround, c, r);
}

/**
 * Put the selected places on valid ground (land, away from water and the map edge, gentle slope):
 * a place on invalid ground moves to the nearest valid cell within `maxShiftM`, else is dropped;
 * spacing between towns is checked after moving. `toCell` / `toWorld` map game metres to cells.
 */
export function settleTowns(
  places: RankedPlace[],
  ground: TownGround,
  toCell: (x: number, y: number) => [number, number],
  toWorld: (c: number, r: number) => [number, number],
  placeToWorld: (p: OsmPlace) => [number, number],
  halfW: number,
  halfH: number,
  o: TownsOptions,
): { towns: MapTown[]; dropped: DroppedTown[] } {
  /** Why a cell cannot hold a town centre, or null when it can. */
  const problem = (c: number, r: number): Msg | null => {
    if (c < 0 || r < 0 || c >= ground.nx || r >= ground.ny) return msg("why.offMap");
    const i = r * ground.nx + c;
    if (ground.water[i]) return msg("why.inWater");
    if (ground.waterDist[i] < o.waterClearanceM) return msg("why.nearSea");
    if (ground.riverDist[i] < o.riverClearanceM) return msg("why.nearRiver");
    const [x, y] = toWorld(c, r);
    if (Math.abs(x) > halfW - o.edgeMarginM || Math.abs(y) > halfH - o.edgeMarginM) return msg("why.nearEdge");
    return localSlope(ground, c, r) < MAX_TOWN_SLOPE ? null : msg("why.slope");
  };
  const valid = (c: number, r: number) => problem(c, r) === null;
  const search = (c0: number, r0: number, R: number) => nearestValidCell(c0, r0, R, valid);

  const towns: MapTown[] = [];
  const dropped: DroppedTown[] = [];
  for (const p of places) {
    const [ox, oy] = placeToWorld(p);
    if (Math.abs(ox) > halfW || Math.abs(oy) > halfH) continue;
    const [fc, fr] = toCell(ox, oy);
    const c0 = Math.round(fc);
    const r0 = Math.round(fr);
    let x = ox;
    let y = oy;
    const why = problem(c0, r0);
    if (why) {
      const found = search(c0, r0, Math.ceil(o.maxShiftM / ground.step));
      if (!found) {
        dropped.push({ key: p.key, name: p.name, reason: msg("why.noLandNear", { why, m: Math.round(o.maxShiftM) }) });
        continue;
      }
      [x, y] = toWorld(found[0], found[1]);
    }
    const near = towns.find((t) => Math.hypot(t.x - x, t.y - y) < o.minSpacingM);
    if (near) {
      dropped.push({ key: p.key, name: p.name, reason: msg("why.nearTown", { town: near.name }) });
      continue;
    }
    towns.push({
      key: p.key,
      name: p.name,
      x,
      y,
      ox,
      oy,
      shift: Math.hypot(x - ox, y - oy),
      moveReason: why ?? undefined,
      capacity: targetCapacity(p.rank, o),
      place: p.place,
      population: p.population,
      forced: p.forced,
    });
  }
  return { towns, dropped };
}

/** Lakes smaller than this (game m²) count like rivers for town clearance. */
const MIN_LAKE_M2 = 50_000;

/** 1 on lake cells whose connected lake covers at least `minCells` cells. */
function bigLakes(water: Uint8Array, nx: number, ny: number, minCells: number): Uint8Array {
  const out = new Uint8Array(water.length);
  const seen = new Uint8Array(water.length);
  const stack: number[] = [];
  const comp: number[] = [];
  for (let s = 0; s < water.length; s++) {
    if (water[s] !== WATER_LAKE || seen[s]) continue;
    comp.length = 0;
    stack.push(s);
    seen[s] = 1;
    while (stack.length) {
      const i = stack.pop()!;
      comp.push(i);
      const c = i % nx;
      for (const j of [c > 0 ? i - 1 : -1, c < nx - 1 ? i + 1 : -1, i - nx, i + nx]) {
        if (j >= 0 && j < water.length && !seen[j] && water[j] === WATER_LAKE) {
          seen[j] = 1;
          stack.push(j);
        }
      }
    }
    if (comp.length >= minCells) for (const i of comp) out[i] = 1;
  }
  return out;
}

/** Places inside the game map (the lon/lat bbox fetched from OSM is a little larger). */
export function placesInFrame(f: Frame, places: OsmPlace[]): OsmPlace[] {
  const p = frameProjection(f);
  return places.filter((pl) => {
    const [x, y] = p.toWorld(pl.lon, pl.lat);
    return Math.abs(x) <= f.widthM / 2 && Math.abs(y) <= f.heightM / 2;
  });
}

/** Town placement on a composed terrain (game frame + grid). */
export function placeTowns(
  f: Frame,
  g: { nx: number; ny: number; step: number },
  t: { game: Float32Array; water: Uint8Array },
  places: RankedPlace[],
  o: TownsOptions,
): { towns: MapTown[]; dropped: DroppedTown[] } {
  const distOf = (keep: (w: number, i: number) => boolean): Float32Array => {
    const src = new Uint8Array(t.water.length);
    for (let i = 0; i < src.length; i++) src[i] = keep(t.water[i], i) ? 1 : 0;
    const d = distanceTo(src, g.nx, g.ny);
    for (let i = 0; i < d.length; i++) d[i] *= g.step;
    return d;
  };
  // Ponds are no reason to push a town away: only lakes of a few hectares count as "lakes".
  const big = bigLakes(t.water, g.nx, g.ny, MIN_LAKE_M2 / (g.step * g.step));
  const isOpenWater = (i: number) => t.water[i] === WATER_SEA || (t.water[i] === WATER_LAKE && big[i] === 1);
  const waterDist = distOf((_, i) => isOpenWater(i));
  const riverDist = distOf((w, i) => w === WATER_RIVER || (w === WATER_LAKE && !big[i]));
  const p = frameProjection(f);
  return settleTowns(
    places,
    { nx: g.nx, ny: g.ny, step: g.step, waterDist, riverDist, game: t.game, water: t.water },
    (x, y) => worldToCell(f, g, x, y),
    (c, r) => cellToWorld(f, g, c, r),
    (pl) => p.toWorld(pl.lon, pl.lat),
    f.widthM / 2,
    f.heightM / 2,
    o,
  );
}

/**
 * The value written to `<UD>/towns_industries/<name>.lua`. Size factors stay 1: the import only
 * multiplies the capacity the game draws itself; the real sizes are applied by the importcity mod
 * from `townSizesData` (FACT-016). `industries` comes from `industriesData` (industries.ts).
 */
export function townsIndustriesData(towns: MapTown[], industries: LuaValue[] = []): LuaValue {
  return {
    towns: towns.map((t) => ({
      name: t.name,
      position: { x: round1(t.x), y: round1(t.y) },
      sizeFactors: [1, 1, 1],
    })),
    industries,
  };
}

const round1 = (v: number) => Math.round(v * 10) / 10;

/**
 * Town targets for the importcity mod (the `towns` field of `<UD>/towns_industries/realmap_note_<name>.lua`): capacity,
 * land-use shares from real areas (when known) and the goods asked for, which the mod applies with
 * `makeTownUpdateCargoNeedsCmd` (the import file only takes cargo categories, FACT-029).
 */
export function townSizesData(towns: MapTown[]): LuaValue {
  return towns.map((t) => ({
    name: t.name,
    x: round1(t.x),
    y: round1(t.y),
    population: t.population ?? 0,
    capacity: t.capacity,
    ...(t.shares?.real ? { shares: { res: t.shares.res, com: t.shares.com, ind: t.shares.ind } } : {}),
    ...(t.needs ? { needs: { com: t.needs.com, ind: t.needs.ind } } : {}),
  }));
}
