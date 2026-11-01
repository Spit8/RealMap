/**
 * Real land use from OSM (DECISION-015): beaches, sand and dunes (no trees there in game), and the
 * commercial / industrial areas that set the share of each land use in a town. One Overpass query:
 * beaches with their geometry (rasterized), business areas only with their bounds (thousands of
 * small polygons around a city; their area is all the towns need).
 */
import { frameProjection, type Frame } from "./area";
import { fillRings } from "./raster";
import { worldToCell, type Grid } from "./grid";
import { distanceTo } from "./raster";
import { overpassLimits, parseOverpassShapes, type Bbox, type OsmShape } from "./osm";
import { COVER_OPEN } from "./biomes";

/** A commercial or industrial area: its bounds (lon/lat) and kind. */
export interface BusinessArea {
  kind: "com" | "ind";
  west: number;
  south: number;
  east: number;
  north: number;
}

export interface LandUse {
  beaches: OsmShape[];
  business: BusinessArea[];
}

export function overpassLandQuery(b: Bbox): string {
  const q = `${b.south},${b.west},${b.north},${b.east}`;
  const { timeout, maxsize } = overpassLimits(b);
  return (
    `[out:json][timeout:${timeout}][maxsize:${maxsize}];` +
    `(way["natural"~"^(beach|sand|dune)$"](${q});relation["natural"~"^(beach|sand|dune)$"](${q}););out geom;` +
    `(way["landuse"~"^(commercial|retail|industrial)$"](${q});relation["landuse"~"^(commercial|retail|industrial)$"](${q}););out bb tags;`
  );
}

interface BbElement {
  type: string;
  tags?: Record<string, string>;
  bounds?: { minlat: number; minlon: number; maxlat: number; maxlon: number };
}

export function parseLandUse(json: { elements?: (BbElement & Record<string, unknown>)[] }): LandUse {
  const beaches = parseOverpassShapes(json as Parameters<typeof parseOverpassShapes>[0]).filter(
    (s) => s.kind === "polygon" && /^(beach|sand|dune)$/.test(s.tags.natural ?? ""),
  );
  const business: BusinessArea[] = [];
  for (const e of json.elements ?? []) {
    const lu = e.tags?.landuse;
    if (!e.bounds || !lu || !/^(commercial|retail|industrial)$/.test(lu)) continue;
    const b = e.bounds;
    business.push({ kind: lu === "industrial" ? "ind" : "com", west: b.minlon, south: b.minlat, east: b.maxlon, north: b.maxlat });
  }
  return { beaches, business };
}

/** Beach cells (1) on the grid. */
export function rasterizeBeaches(f: Frame, g: Grid, beaches: OsmShape[]): Uint8Array {
  const mask = new Uint8Array(g.nx * g.ny);
  const p = frameProjection(f);
  const toCell = ([lon, lat]: [number, number]): [number, number] => {
    const [x, y] = p.toWorld(lon, lat);
    return worldToCell(f, g, x, y);
  };
  for (const s of beaches) if (s.kind === "polygon") fillRings(mask, g.nx, g.ny, s.rings.map((r) => r.map(toCell)), 1);
  return mask;
}

/** WorldCover classes that are sand or dunes on a shore: bare / sparse, shrubland, moss. */
const SHORE_SAND = new Set([60, 20, 100]);
/** How far from the sea or a lake a bare / scrub cell counts as a beach (game m), and how high. */
export const BEACH_M = 150;
export const BEACH_MAX_Z = 5;

/**
 * Beaches become open land: the game's import generator grows coast trees on its scrub and rock
 * biomes near the water (FACT-029). A beach is an OSM beach / sand / dune cell, or a sandy
 * WorldCover cell low and close to still water (not rivers). Returns the number of cells changed.
 */
export function clearBeaches(
  cover: Uint8Array, codes: Uint8Array | null, beaches: Uint8Array | null, game: Float32Array, water: Uint8Array, g: Grid,
): number {
  const still = new Uint8Array(water.length);
  for (let i = 0; i < water.length; i++) still[i] = water[i] === 1 || water[i] === 2 ? 1 : 0;
  const dist = distanceTo(still, g.nx, g.ny);
  let changed = 0;
  for (let i = 0; i < cover.length; i++) {
    if (water[i] || cover[i] === COVER_OPEN) continue;
    const osm = beaches?.[i] === 1;
    const sandy = !!codes && SHORE_SAND.has(codes[i]) && dist[i] * g.step <= BEACH_M && game[i] <= BEACH_MAX_Z;
    if (!osm && !sandy) continue;
    cover[i] = COVER_OPEN;
    changed++;
  }
  return changed;
}

/** Share of each land use in a town's capacity. */
export interface LandShares {
  res: number;
  com: number;
  ind: number;
  /** From real areas (false: the default split). */
  real: boolean;
}

/** The game's usual split (also the mean of the real shares). */
export const DEFAULT_SHARES: LandShares = { res: 0.5, com: 0.3, ind: 0.2, real: false };
const MIN_SHARE = 0.1;
const MAX_SHARE = 0.45;
const MAX_BUSINESS = 0.6;

/** Real m² of a lon/lat box (small boxes). */
function boxM2(a: { west: number; south: number; east: number; north: number }): number {
  const lat = ((a.south + a.north) / 2) * (Math.PI / 180);
  return (a.east - a.west) * 111_320 * Math.cos(lat) * (a.north - a.south) * 110_574;
}

/** What surrounds a town (real m²): commercial and industrial areas, built-up land. */
export interface TownLand {
  com: number;
  ind: number;
  built: number;
}

/**
 * Commercial and industrial area (real m²) of the business areas whose centre is within `radiusM`
 * (real m) of a point. Bounding boxes overstate an area: counted at 60 %.
 */
export function businessAround(lon: number, lat: number, radiusM: number, business: BusinessArea[]): { com: number; ind: number } {
  let com = 0;
  let ind = 0;
  const cosLat = Math.cos(lat * (Math.PI / 180));
  for (const a of business) {
    const dx = ((a.west + a.east) / 2 - lon) * 111_320 * cosLat;
    const dy = ((a.south + a.north) / 2 - lat) * 110_574;
    if (dx * dx + dy * dy > radiusM * radiusM) continue;
    const m2 = 0.6 * boxM2(a);
    if (a.kind === "com") com += m2;
    else ind += m2;
  }
  return { com, ind };
}

/**
 * Land-use shares of the towns: each town's commercial / industrial part of its built-up land,
 * compared with the median town of the map, scales the game's usual split (30 % / 20 %), so
 * a town with twice the average commerce gets twice the commercial share; each share within
 * 10–45 % and housing at least 40 %. Towns without any business area keep the usual split.
 */
export function townShares(lands: TownLand[]): LandShares[] {
  const ratio = lands.map((l) => {
    if (l.com + l.ind <= 0) return null;
    const total = Math.max(l.built, l.com + l.ind);
    return { com: l.com / total, ind: l.ind / total };
  });
  const known = ratio.filter((r): r is { com: number; ind: number } => r !== null);
  if (!known.length) return lands.map(() => DEFAULT_SHARES);
  // The median town of the map gets the usual split (a few very industrial towns would pull a
  // mean up and every other town down to the floor).
  const median = (v: number[]) => {
    const o = [...v].sort((x, y) => x - y);
    const h = o.length >> 1;
    return o.length % 2 ? o[h] : (o[h - 1] + o[h]) / 2;
  };
  const meanCom = median(known.map((r) => r.com));
  const meanInd = median(known.map((r) => r.ind));
  const clamp = (v: number) => Math.min(MAX_SHARE, Math.max(MIN_SHARE, v));
  const round = (v: number) => Math.round(v * 100) / 100;
  return ratio.map((r) => {
    if (!r) return DEFAULT_SHARES;
    let com = clamp(meanCom > 0 ? (DEFAULT_SHARES.com * r.com) / meanCom : DEFAULT_SHARES.com);
    let ind = clamp(meanInd > 0 ? (DEFAULT_SHARES.ind * r.ind) / meanInd : DEFAULT_SHARES.ind);
    // Housing stays at least 40 % of a town.
    if (com + ind > MAX_BUSINESS) {
      const k = MAX_BUSINESS / (com + ind);
      com *= k;
      ind *= k;
    }
    com = round(com);
    ind = round(ind);
    return { res: round(1 - com - ind), com, ind, real: true };
  });
}

/**
 * How far around a town (real m) its land is counted: wider for a bigger town (2 km at 10 000
 * inhabitants, 5 km at 500 000; business parks lie on the outskirts).
 */
export function townLandRadiusM(population: number): number {
  return Math.min(6000, 1500 + 500 * Math.sqrt(Math.max(0, population) / 10_000));
}

/** WorldCover built-up class. */
export const WC_BUILT = 50;

/** Built-up area (real m²) within `radiusM` (real m) of a world point, from the WorldCover codes on the grid. */
export function builtAround(codes: Uint8Array | null, f: Frame, g: Grid, x: number, y: number, radiusM: number): number {
  if (!codes) return 0;
  const [cc, cr] = worldToCell(f, g, x, y);
  const rc = radiusM / f.scale / g.step;
  let cells = 0;
  for (let r = Math.max(0, Math.floor(cr - rc)); r <= Math.min(g.ny - 1, Math.ceil(cr + rc)); r++) {
    for (let c = Math.max(0, Math.floor(cc - rc)); c <= Math.min(g.nx - 1, Math.ceil(cc + rc)); c++) {
      if ((c - cc) ** 2 + (r - cr) ** 2 > rc * rc) continue;
      if (codes[r * g.nx + c] === WC_BUILT) cells++;
    }
  }
  return cells * (g.step * f.scale) ** 2;
}
