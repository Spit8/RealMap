/**
 * Real heights → game terrain. TF3 has one global water level (0 in the Map Editor), so real
 * water must be carved below 0 and every piece of land kept above it:
 *  - the reference height (real metres that become game 0) is sea level when the map touches the
 *    sea, else the low end of its lakes and rivers, else its lowest point;
 *  - land = (h − ref)·verticalScale, never below `landMin`;
 *  - water deepens from 0.5 m at the shore by `underwaterSlope` down to its depth: lakes, and the
 *    sea from the real sea floor (EMODnet / ETOPO) when known; rivers follow a cross-section
 *    scaled to their local width, so the middle always reaches `riverDepth`, and the sea or lake
 *    at a river mouth is dug to the river's depth. Rivers are always kept, so they stay
 *    continuous at the game's single water level; lakes not linked to a river that would need a
 *    trench deeper than `maxCarve` are left as land;
 *  - water pieces almost touching a river (`waterJoinM`) are joined by a channel, marshes
 *    (WorldCover wetland) become shallow lakes, and no river part is narrower than `riverMinWidth`;
 *  - river valleys: around a river higher up in reality, the land is lowered by the height the
 *    river must drop, fading out over a width set by `valleySlope` (a gentle valley, not a
 *    canyon; mountains further away and rivers already low are untouched);
 *  - banks: land near water may not rise faster than `bankSlope` (sea, lakes) or
 *    `riverBankSlope` (rivers, gentler), and the surface is smoothed across the waterline.
 * With `inlandWater` off, there are no rivers, canals or lakes at all: only the sea stays, and
 * river beds and lake floors keep their real height.
 */
import { frameProjection, type Frame } from "./area";
import { sampleDem, sampleDemBox, type DemRaster } from "./dem";
import { cellToWorld, worldToCell, type Grid } from "./grid";
import type { OsmShape } from "./osm";
import { repairRivers, taperedPieces, type RiverLine } from "./rivers";
import {
  blurGrid, closeMask, distanceTo, fillRings, floodFromEdges, labelComponents, maxFilter, nearestSource, strokePolyline,
} from "./raster";

export const WATER_NONE = 0;
export const WATER_SEA = 1;
export const WATER_LAKE = 2;
export const WATER_RIVER = 3;

export interface TerrainOptions {
  verticalScale: number;
  /** Real height that becomes game 0; null = automatic. */
  refHeight: number | null;
  /** Sea depth (game m) where there is no sea-floor data. */
  seaDepth: number;
  /** Deepest sea (game m) from sea-floor data (real depth × vertical scale, capped). */
  seaMaxDepth: number;
  /** Shallowest sea (game m) once off the shore ramp: sea-floor data only ever makes it deeper. */
  coastDepth: number;
  /** Deepest point of lakes and rivers (game m), reached away from their shores. */
  lakeDepth: number;
  riverDepth: number;
  /** How fast water deepens away from the shore (game m of depth per game m): no wall at the edge. */
  underwaterSlope: number;
  /** Lowest game height of land. */
  landMin: number;
  /** Deepest trench (game m below the surrounding land) allowed to carve a lake or river. */
  maxCarve: number;
  /** Highest slope (rise / run) of land next to the sea and lakes. */
  bankSlope: number;
  /** Highest slope of land next to rivers: gentle banks. */
  riverBankSlope: number;
  /** Width (game m) of the bank zone where those slopes apply, fading out to the real relief. */
  bankWidthM: number;
  /**
   * Slope of the ramp that lowers a high river's valley (drop / valley half-width): gentle, so
   * a river 100 m above the water level gets a valley ~830 m wide on each side, not a canyon.
   */
  valleySlope: number;
  /** Rivers and kept canals at least this wide (game m) so ships can use them; 0 = real width. */
  riverMinWidth: number;
  /** Relief smoothing half-width (game m): removes bumps (trees in Copernicus, DTM noise); 0 = none. */
  smoothM: number;
  /** Inland water pieces smaller than this (game hectares) become land; a pond on a river stays. */
  minLakeHa: number;
  /** Real metres taken off forests where the relief comes from Copernicus (a surface model). */
  canopyM: number;
  /** Repair the river network: rivers end in water or at the map edge (`rivers.ts`). */
  repairRivers: boolean;
  /** Dangling river ends closer than this (game m) to other water are joined straight. */
  riverJoinM: number;
  /** River sources widen from 1/4 to full width over this length (game m). */
  sourceTaperM: number;
  /** Water pieces closer than this (game m) to a river are joined to it by a channel; 0 = never. */
  waterJoinM: number;
  /** Marshes (WorldCover wetland, mangrove) become lakes when at least `wetlandMinHa` game hectares. */
  wetlandLakes: boolean;
  wetlandMinHa: number;
  /** Deepest point of those marsh lakes (game m). */
  marshDepth: number;
  /**
   * Rivers, canals and lakes (OSM water and marshes). Off: only the sea stays, and their beds keep
   * the real relief instead of being dug down to the game's single water level.
   */
  inlandWater: boolean;
}

export const DEFAULT_TERRAIN: Omit<TerrainOptions, "verticalScale"> = {
  refHeight: null,
  seaDepth: 15,
  seaMaxDepth: 40,
  coastDepth: 20,
  lakeDepth: 8,
  riverDepth: 20,
  underwaterSlope: 0.5,
  landMin: 0.5,
  maxCarve: 30,
  bankSlope: 0.4,
  riverBankSlope: 0.15,
  bankWidthM: 200,
  valleySlope: 0.12,
  riverMinWidth: 64,
  smoothM: 16,
  minLakeHa: 2,
  canopyM: 10,
  repairRivers: true,
  riverJoinM: 100,
  sourceTaperM: 500,
  waterJoinM: 64,
  wetlandLakes: true,
  wetlandMinHa: 5,
  marshDepth: 20,
  inlandWater: true,
};

/**
 * Copernicus GLO-30 is a surface model: forests stand 10–25 m above the ground and show as bumps.
 * Take `canopyM` off the `forest` cells whose height came from it (`fromDsm`).
 */
export function flattenCanopy(real: Float32Array, fromDsm: Uint8Array, forest: Uint8Array, canopyM: number): void {
  if (canopyM <= 0) return;
  for (let i = 0; i < real.length; i++) if (fromDsm[i] && forest[i]) real[i] -= canopyM;
}

/** Relief smoothing over `smoothM` game metres (NaN = no data is kept as is). */
export function smoothHeights(real: Float32Array, g: Grid, smoothM: number): Float32Array {
  return blurGrid(real, g.nx, g.ny, smoothM / g.step);
}

/**
 * Inland water pieces (ponds, and stray bits of river area not linked to a river) of fewer than
 * `minCells` cells in all become land. A pond on a river belongs to the river's piece and stays.
 * Returns the number removed.
 */
export function dropSmallWater(mask: Uint8Array, g: Grid, minCells: number): number {
  if (minCells <= 1) return 0;
  const inland = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) inland[i] = mask[i] === WATER_LAKE || mask[i] === WATER_RIVER ? 1 : 0;
  const { labels, sizes } = labelComponents(inland, g.nx, g.ny);
  let removed = 0;
  const drop = new Uint8Array(sizes.length + 1);
  for (let k = 1; k <= sizes.length; k++) {
    if (sizes[k - 1] < minCells) {
      drop[k] = 1;
      removed++;
    }
  }
  for (let i = 0; i < mask.length; i++) if (drop[labels[i]]) mask[i] = WATER_NONE;
  return removed;
}

/** Separate river systems (rivers and the lakes they cross, 4-connected): 1 = all connected. */
export function countRiverPieces(mask: Uint8Array, g: Grid): number {
  const wet = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) wet[i] = mask[i] === WATER_RIVER || mask[i] === WATER_LAKE ? 1 : 0;
  const { labels, sizes } = labelComponents(wet, g.nx, g.ny);
  const hasRiver = new Uint8Array(sizes.length + 1);
  for (let i = 0; i < mask.length; i++) if (mask[i] === WATER_RIVER) hasRiver[labels[i]] = 1;
  return hasRiver.reduce((n, v) => n + v, 0);
}

/**
 * Real heights on the grid: IGN where it has data, Copernicus elsewhere (averaged over the
 * sample footprint when the grid is coarser than its 30 m pixels). NaN = no data at all.
 */
export function realHeights(f: Frame, g: Grid, ign: Float32Array | null, rasters: DemRaster[]): Float32Array {
  const out = ign ? Float32Array.from(ign) : new Float32Array(g.nx * g.ny).fill(NaN);
  if (!rasters.length) return out;
  const p = frameProjection(f);
  const realStep = g.step * f.scale;
  const k = Math.min(4, Math.ceil(realStep / 30));
  for (let r = 0; r < g.ny; r++) {
    for (let c = 0; c < g.nx; c++) {
      const i = r * g.nx + c;
      if (Number.isFinite(out[i])) continue;
      const [x, y] = cellToWorld(f, g, c, r);
      const [lon, lat] = p.toLonLat(x, y);
      if (k <= 1) out[i] = sampleDem(rasters, lon, lat);
      else {
        const sizeLat = realStep / 110_574;
        const sizeLon = realStep / (111_320 * Math.cos((lat * Math.PI) / 180));
        out[i] = sampleDemBox(rasters, lon, lat, sizeLon, sizeLat, k);
      }
    }
  }
  return out;
}

/** Real length (m) of a lon/lat line. */
function lineLengthM(f: Frame, pts: [number, number][]): number {
  const p = frameProjection(f);
  let len = 0;
  let prev: [number, number] | null = null;
  for (const [lon, lat] of pts) {
    const q = p.toWorld(lon, lat);
    if (prev) len += Math.hypot(q[0] - prev[0], q[1] - prev[1]);
    prev = q;
  }
  return len * f.scale;
}

/** Default real widths (m) of OSM water lines without a `width` tag. */
const RIVER_WIDTH: Record<string, number> = { river: 30, canal: 10 };
/** One heightmap sample (game m): rivers are never thinner, narrower canals are dropped. */
const MIN_WATER_WIDTH = 4;
/**
 * A named canal at least this long (real m) is a waterway, kept even when narrow (e.g. the Douve
 * near Carentan is partly tagged as a canal): marsh ditches are short or unnamed.
 */
const NAMED_CANAL_M = 1000;
/** Half the widest gap (game m) closed between two pieces of river. */
const RIVER_GAP_M = 12;

function parseWidth(s: string | undefined): number | undefined {
  const n = s ? parseFloat(s.replace(",", ".")) : NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** River network repair settings (game m) and the relief it routes over. */
export interface NetworkOptions {
  /** Real heights on the grid (smoothed). */
  real: Float32Array;
  /** Dangling ends closer than this to other water are joined straight. */
  joinM: number;
  /** Sources widen from 1/4 to full width over this length. */
  taperM: number;
}

export interface WaterMask {
  mask: Uint8Array;
  /** Dangling ends joined straight, routed downhill, sources tapered, mouths opened into still water. */
  joined: number;
  routed: number;
  tapered: number;
  mouths: number;
}

/**
 * OSM water on the grid: WATER_LAKE for still water, WATER_RIVER for rivers (areas and lines).
 * River and canal lines are drawn last over their whole length, at least `riverMinWidth` game m
 * wide (navigable, sources included), gaps of up to ~24 game m between river pieces are closed and
 * narrower river parts (thin OSM river areas) are widened. With `net`, the network is repaired
 * first (`rivers.ts`): rivers end in water or at the map edge.
 */
export function waterMask(f: Frame, g: Grid, shapes: OsmShape[], riverMinWidth = 0, net?: NetworkOptions): WaterMask {
  const p = frameProjection(f);
  const mask = new Uint8Array(g.nx * g.ny);
  const toCell = ([lon, lat]: [number, number]): [number, number] => {
    const [x, y] = p.toWorld(lon, lat);
    return worldToCell(f, g, x, y);
  };
  // Areas first, lines on top (a river line inside a lake polygon stays a river).
  for (const s of shapes) {
    if (s.kind !== "polygon") continue;
    const river = s.tags.waterway === "riverbank" || s.tags.water === "river" || s.tags.water === "canal";
    fillRings(mask, g.nx, g.ny, s.rings.map((ring) => ring.map(toCell)), river ? WATER_RIVER : WATER_LAKE);
  }
  let lines: RiverLine[] = [];
  for (const s of shapes) {
    if (s.kind !== "line") continue;
    const kind = s.tags.waterway;
    if (!kind || !(kind in RIVER_WIDTH)) continue;
    const widthGame = (parseWidth(s.tags.width) ?? RIVER_WIDTH[kind]) / f.scale;
    // Small canals (drainage ditches in marshes) would grid the map: dropped, unless named and long.
    if (kind === "canal" && widthGame < MIN_WATER_WIDTH && !(s.tags.name && lineLengthM(f, s.pts) >= NAMED_CANAL_M)) continue;
    // Width in game metres, so the coarse preview grid does not widen rivers.
    lines.push({ pts: s.pts.map(toCell), half: Math.max(MIN_WATER_WIDTH, riverMinWidth, widthGame) / 2 / g.step });
  }
  let joined = 0;
  let routed = 0;
  let tapered = 0;
  let mouths = 0;
  if (net && lines.length) {
    // Still water the rivers may end in: lakes, river areas, and the sea (low land from the edge).
    const seaCand = new Uint8Array(mask.length);
    for (let i = 0; i < mask.length; i++) seaCand[i] = !Number.isFinite(net.real[i]) || net.real[i] <= 0.5 ? 1 : 0;
    const sea = floodFromEdges(seaCand, g.nx, g.ny);
    const still = new Uint8Array(mask.length);
    for (let i = 0; i < mask.length; i++) still[i] = mask[i] || sea[i] ? 1 : 0;
    const r = repairRivers(lines, g.nx, g.ny, still, net.real, { joinCells: net.joinM / g.step, taperCells: net.taperM / g.step });
    lines = [...r.lines, ...r.extra];
    joined = r.joined;
    routed = r.routed;
    tapered = r.tapered;
    mouths = r.mouths;
  }
  const minHalf = riverMinWidth / 2 / g.step;
  for (const l of lines) {
    for (const piece of taperedPieces(l, (net?.taperM ?? 0) / g.step, minHalf)) strokePolyline(mask, g.nx, g.ny, piece.pts, piece.half, WATER_RIVER);
  }
  // Bridges, culverts and loose OSM joins leave gaps: close those up to ~2·GAP_M game metres,
  // whatever the grid (at least 1.5 cells so diagonal joins count).
  const river = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) river[i] = mask[i] === WATER_RIVER ? 1 : 0;
  const closed = closeMask(river, g.nx, g.ny, Math.max(1.5, RIVER_GAP_M / g.step));
  for (let i = 0; i < mask.length; i++) if (closed[i] && !mask[i]) mask[i] = WATER_RIVER;
  enforceMinWidth(mask, g, riverMinWidth);
  return { mask, joined, routed, tapered, mouths };
}

/**
 * Widen every river part narrower than `minWidthM` (game m): each cell on the middle line of a
 * river (no neighbour further from the banks) whose half width is short gets a disc of the
 * minimum width. Only land becomes river. Returns the cells added.
 */
export function enforceMinWidth(mask: Uint8Array, g: Grid, minWidthM: number): number {
  const minHalf = minWidthM / 2 / g.step;
  if (minHalf <= 0.75) return 0;
  const { nx, ny } = g;
  const other = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) other[i] = mask[i] === WATER_RIVER ? 0 : 1;
  const d = distanceTo(other, nx, ny);
  const disc = new Uint8Array(mask.length);
  for (let r = 0; r < ny; r++) {
    for (let c = 0; c < nx; c++) {
      const i = r * nx + c;
      if (other[i] || d[i] >= minHalf) continue;
      let ridge = true;
      for (let dr = -1; dr <= 1 && ridge; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          const cc = c + dc;
          const rr = r + dr;
          if (cc >= 0 && rr >= 0 && cc < nx && rr < ny && d[rr * nx + cc] > d[i]) {
            ridge = false;
            break;
          }
        }
      }
      if (ridge) strokePolyline(disc, nx, ny, [[c, r], [c, r]], minHalf, 1);
    }
  }
  let added = 0;
  for (let i = 0; i < mask.length; i++) {
    if (disc[i] && !mask[i]) {
      mask[i] = WATER_RIVER;
      added++;
    }
  }
  return added;
}

/**
 * Marshes as lakes (a gameplay reading of wetlands): WorldCover wetland / mangrove areas, small
 * gaps closed, of at least `minCells` cells become WATER_LAKE where there is no water yet.
 * Returns the marsh cells and the number of marshes.
 */
export function marshLakes(mask: Uint8Array, g: Grid, wetland: Uint8Array, minCells: number): { marsh: Uint8Array; count: number } {
  const closed = closeMask(wetland, g.nx, g.ny, Math.max(1.5, 12 / g.step));
  const { labels, sizes } = labelComponents(closed, g.nx, g.ny);
  const marsh = new Uint8Array(mask.length);
  const kept = new Set<number>();
  for (let i = 0; i < mask.length; i++) {
    if (!labels[i] || sizes[labels[i] - 1] < minCells) continue;
    kept.add(labels[i]);
    marsh[i] = 1;
    if (!mask[i]) mask[i] = WATER_LAKE;
  }
  return { marsh, count: kept.size };
}

/**
 * Join water that almost touches a river: two separate pieces (rivers, lakes, the sea) at most
 * `joinM` game m apart, one of them with river cells, get a channel `widthM` wide where they are
 * closest. Both pieces must have at least `minCells` cells: ponds and stray bits of river are
 * left alone (`dropSmallWater` removes them) instead of being meshed together. `real`: real heights, for the sea (≤ 0.5 m from the edge).
 * Returns the number of channels.
 */
export function bridgeWater(mask: Uint8Array, g: Grid, real: Float32Array, joinM: number, widthM: number, minCells: number): number {
  const maxCells = joinM / g.step;
  if (maxCells <= 0) return 0;
  const { nx, ny } = g;
  const n = mask.length;
  const seaCand = new Uint8Array(n);
  for (let i = 0; i < n; i++) seaCand[i] = !Number.isFinite(real[i]) || real[i] <= 0.5 ? 1 : 0;
  const sea = floodFromEdges(seaCand, nx, ny);
  const wet = new Uint8Array(n);
  for (let i = 0; i < n; i++) wet[i] = mask[i] || sea[i] ? 1 : 0;
  const { labels, sizes } = labelComponents(wet, nx, ny);
  const hasRiver = new Uint8Array(sizes.length + 1);
  for (let i = 0; i < n; i++) if (mask[i] === WATER_RIVER && !sea[i]) hasRiver[labels[i]] = 1;
  if (!hasRiver.some((x) => x)) return 0;
  const counts = (k: number) => sizes[k - 1] >= minCells;
  const { dist, idx } = nearestSource(wet, nx, ny);
  const best = new Map<number, { d: number; a: number; b: number }>();
  const K = sizes.length + 1;
  for (let r = 0; r < ny; r++) {
    for (let c = 0; c < nx; c++) {
      const i = r * nx + c;
      if (idx[i] < 0 || dist[i] > maxCells) continue;
      for (const j of [c < nx - 1 ? i + 1 : -1, r < ny - 1 ? i + nx : -1]) {
        if (j < 0 || idx[j] < 0) continue;
        const la = labels[idx[i]];
        const lb = labels[idx[j]];
        if (la === lb || !(hasRiver[la] || hasRiver[lb]) || !counts(la) || !counts(lb)) continue;
        const d = dist[i] + dist[j] + 1;
        if (d > maxCells + 1) continue;
        const key = Math.min(la, lb) * K + Math.max(la, lb);
        const cur = best.get(key);
        if (!cur || d < cur.d) best.set(key, { d, a: idx[i], b: idx[j] });
      }
    }
  }
  const channel = new Uint8Array(n);
  const at = (k: number): [number, number] => [k % nx, Math.floor(k / nx)];
  for (const { a, b } of best.values()) strokePolyline(channel, nx, ny, [at(a), at(b)], Math.max(0.75, widthM / 2 / g.step), 1);
  for (let i = 0; i < n; i++) if (channel[i] && !mask[i] && !sea[i]) mask[i] = WATER_RIVER;
  return best.size;
}

/** OSM water on the grid without network repair (see `waterMask`). */
export function rasterizeWater(f: Frame, g: Grid, shapes: OsmShape[], riverMinWidth = 0): Uint8Array {
  return waterMask(f, g, shapes, riverMinWidth).mask;
}

export interface TerrainResult {
  /** Game heights (m), water level 0. */
  game: Float32Array;
  /** Final water classes per cell. */
  water: Uint8Array;
  refHeight: number;
  minM: number;
  maxM: number;
  waterShare: number;
  /** Steep land slope (rise / run, game metres): 99th percentile, so lone cliffs do not dominate. */
  maxSlope: number;
}

function percentile(values: number[], q: number): number {
  if (!values.length) return NaN;
  values.sort((a, b) => a - b);
  return values[Math.min(values.length - 1, Math.floor(q * (values.length - 1)))];
}

/** Depth of a water cell next to the shore (game m): with land at `landMin` (0.5), a 1 m step. */
const SHORE_DEPTH = 0.5;
/**
 * Shallowest river water (game m), even at the bank: the game builds roads across very shallow
 * water on a fill instead of a bridge (QUESTION-013). The land bank stays gentle.
 */
const RIVER_SHORE_DEPTH = 2;
/** A river widens no profile beyond this half width (cells): wider water is deep anyway. */
const MAX_RIVER_HALF_CELLS = 64;
/** Around a river mouth the sea or lake is dug to the river's depth over this distance (game m). */
const MOUTH_M = 300;
/**
 * Distance from the bank (game m) where a river reaches its full depth. The game's own rivers take
 * ~48 m (FACT-023) but are 110–165 m wide; ours are narrower (64 m), so the submerged slope is
 * steeper (~0.7 m/m, a straight slope) and most of the bed is at full depth (a V-shaped bed looked shallow). The
 * visible land banks stay gentle (`riverBankSlope`).
 */
const RIVER_BED_M = 20;

/**
 * `seaFloor`: real sea-floor height per cell (negative below sea level, NaN = unknown), used for
 * the sea's depth; without it the sea is `seaDepth` deep. `marsh`: lake cells that were marshes
 * (`marshDepth` deep).
 */
export function composeTerrain(
  real: Float32Array,
  g: Grid,
  osmWater: Uint8Array,
  o: TerrainOptions,
  seaFloor: Float32Array | null = null,
  marsh: Uint8Array | null = null,
): TerrainResult {
  const n = g.nx * g.ny;
  // Sea: no data or at / below sea level, connected to the map edge.
  const seaCand = new Uint8Array(n);
  for (let i = 0; i < n; i++) seaCand[i] = !Number.isFinite(real[i]) || real[i] <= 0.5 ? 1 : 0;
  const sea = floodFromEdges(seaCand, g.nx, g.ny);
  const water = new Uint8Array(n);
  let anySea = false;
  for (let i = 0; i < n; i++) {
    if (sea[i]) {
      water[i] = WATER_SEA;
      anySea = true;
    } else water[i] = osmWater[i];
  }

  let ref = o.refHeight;
  if (ref === null || !Number.isFinite(ref)) {
    if (anySea) ref = 0;
    else {
      const wet: number[] = [];
      const all: number[] = [];
      for (let i = 0; i < n; i += 1 + Math.floor(n / 200_000)) {
        if (!Number.isFinite(real[i])) continue;
        all.push(real[i]);
        if (water[i]) wet.push(real[i]);
      }
      ref = wet.length >= 20 ? percentile(wet, 0.05) : percentile(all, 0);
      if (!Number.isFinite(ref)) ref = 0;
    }
  }
  const v = o.verticalScale;
  // Inland holes without data: treat as the reference height.
  const h = (i: number) => (Number.isFinite(real[i]) ? real[i] : ref!);

  // Rivers are always kept (continuous, at the water level; their banks are lowered below). A lake
  // not linked to a river and too high above the reference would need a canyon: it stays land.
  const inland = new Uint8Array(n);
  for (let i = 0; i < n; i++) inland[i] = water[i] === WATER_LAKE || water[i] === WATER_RIVER ? 1 : 0;
  const { labels, sizes } = labelComponents(inland, g.nx, g.ny);
  const linked = new Uint8Array(sizes.length + 1);
  for (let i = 0; i < n; i++) if (water[i] === WATER_RIVER) linked[labels[i]] = 1;
  for (let i = 0; i < n; i++) {
    if (water[i] === WATER_LAKE && !linked[labels[i]] && (h(i) - ref) * v > o.maxCarve) water[i] = WATER_NONE;
  }

  // Water deepens away from the shore (no wall at the edge) down to its kind's depth; the sea
  // follows the real sea floor where it is known.
  const land = new Uint8Array(n);
  for (let i = 0; i < n; i++) land[i] = water[i] ? 0 : 1;
  const fromShore = distanceTo(land, g.nx, g.ny);
  // Rivers: the shape of the game's own cross-section (FACT-023), full depth from `RIVER_BED_M`, and,
  // for rivers narrower than that, a profile scaled to the local half width (the furthest any nearby
  // river cell is from its bank) so the middle of every river reaches `riverDepth`.
  const riverShore = new Float32Array(n);
  let widest = 0;
  for (let i = 0; i < n; i++) {
    if (water[i] !== WATER_RIVER) continue;
    riverShore[i] = fromShore[i];
    widest = Math.max(widest, fromShore[i]);
  }
  const localHalf = widest ? maxFilter(riverShore, g.nx, g.ny, Math.min(MAX_RIVER_HALF_CELLS, Math.ceil(widest))) : riverShore;
  // River mouths: still water next to a river is dug to the river's depth (no sill at the mouth),
  // never steeper from its own shore than a river bank.
  const riverCells = new Uint8Array(n);
  for (let i = 0; i < n; i++) riverCells[i] = water[i] === WATER_RIVER ? 1 : 0;
  const toRiver = widest ? distanceTo(riverCells, g.nx, g.ny) : null;
  const mouthSlope = (o.riverDepth - SHORE_DEPTH) / Math.max(g.step, o.riverMinWidth / 2);
  const smooth = (t: number) => t * t * (3 - 2 * t);
  const game = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const w = water[i];
    if (!w) {
      game[i] = Math.max(o.landMin, (h(i) - ref) * v);
      continue;
    }
    if (w === WATER_RIVER) {
      const fromBank = (fromShore[i] - 0.5) * g.step;
      const own = o.riverDepth * Math.min(1, fromBank / RIVER_BED_M);
      const t = Math.min(1, (fromShore[i] - 0.5) / Math.max(0.5, localHalf[i] - 0.5));
      game[i] = -Math.max(Math.min(RIVER_SHORE_DEPTH, o.riverDepth), own, o.riverDepth * smooth(t));
      continue;
    }
    let deepest = w === WATER_LAKE ? (marsh?.[i] ? o.marshDepth : o.lakeDepth) : Math.max(o.coastDepth, o.seaDepth);
    if (w === WATER_SEA && seaFloor && Number.isFinite(seaFloor[i])) {
      deepest = Math.max(o.coastDepth, Math.min(o.seaMaxDepth, -seaFloor[i] * v));
    }
    let depth = Math.min(deepest, SHORE_DEPTH + (fromShore[i] - 1) * g.step * o.underwaterSlope);
    const dm = toRiver ? toRiver[i] * g.step : Infinity;
    if (dm < MOUTH_M) {
      const mouth = Math.min(o.riverDepth * (1 - smooth(dm / MOUTH_M)), SHORE_DEPTH + (fromShore[i] - 0.5) * g.step * mouthSlope);
      depth = Math.max(depth, mouth);
    }
    game[i] = -depth;
  }

  lowerRiverValleys(game, water, labels, linked, g, (i) => (h(i) - ref!) * v, o);

  // Banks: land rises at most bankSlope from the sea and lakes, riverBankSlope from rivers.
  const still = new Uint8Array(n);
  const flowing = new Uint8Array(n);
  let wetCount = 0;
  for (let i = 0; i < n; i++) {
    if (!water[i]) continue;
    wetCount++;
    if (water[i] === WATER_RIVER) flowing[i] = 1;
    else still[i] = 1;
  }
  if (wetCount && wetCount < n) {
    // Only within `bankWidthM` of the water, fading out: hills and mountains further away keep
    // their height (an unbounded slope cap would flatten everything near a river).
    for (const [mask, slope] of [[still, o.bankSlope], [flowing, o.riverBankSlope]] as const) {
      if (!mask.some((x) => x)) continue;
      const dist = distanceTo(mask, g.nx, g.ny);
      for (let i = 0; i < n; i++) {
        if (water[i]) continue;
        const d = dist[i] * g.step;
        if (d >= o.bankWidthM) continue;
        const cap = o.landMin + (d - g.step / 2) * slope;
        if (game[i] <= cap) continue;
        const t = d / o.bankWidthM;
        game[i] -= (game[i] - cap) * (1 - t * t * (3 - 2 * t));
      }
    }
    // Soften the kinks the slope caps leave (valley floor and rim); water cells are left out.
    if (o.smoothM > 0) {
      const land = Float32Array.from(game);
      for (let i = 0; i < n; i++) if (water[i]) land[i] = NaN;
      const soft = blurGrid(land, g.nx, g.ny, o.smoothM / 2 / g.step);
      for (let i = 0; i < n; i++) if (!water[i]) game[i] = Math.max(o.landMin, soft[i]);
    }
    // Across the waterline: the first water cell and the two land cells (whatever the grid) are
    // eased towards a smooth surface (two water rows lifted the bed of narrow rivers), only ever towards the waterline (shore water shallower, bank land lower), land
    // kept at or above `landMin`, water at or below −SHORE_DEPTH.
    const toWater = distanceTo(land.map((x) => 1 - x), g.nx, g.ny);
    const across = blurGrid(game, g.nx, g.ny, 1);
    for (let i = 0; i < n; i++) {
      if (water[i]) {
        // Rivers keep their bed (that first ring is a large part of a river on the 16 m preview
        // grid); only on grids coarser than the bed slope would they get a wall at the bank.
        if (fromShore[i] <= 1 && (water[i] !== WATER_RIVER || g.step > RIVER_BED_M)) game[i] = Math.min(-SHORE_DEPTH, Math.max(game[i], across[i]));
      } else if (toWater[i] <= 2) game[i] = Math.max(o.landMin, Math.min(game[i], across[i]));
    }
  }

  let minM = Infinity;
  let maxM = -Infinity;
  const slopes: number[] = [];
  const every = 1 + Math.floor(n / 200_000);
  for (let r = 0; r < g.ny; r++) {
    for (let c = 0; c < g.nx; c++) {
      const i = r * g.nx + c;
      const z = game[i];
      if (z < minM) minM = z;
      if (z > maxM) maxM = z;
      if (i % every === 0 && c > 0 && r > 0 && !water[i] && !water[i - 1] && !water[i - g.nx]) {
        slopes.push(Math.max(Math.abs(z - game[i - 1]), Math.abs(z - game[i - g.nx])) / g.step);
      }
    }
  }
  const maxSlope = slopes.length ? percentile(slopes, 0.99) : 0;
  return { game, water, refHeight: ref, minM, maxM, waterShare: wetCount / n, maxSlope };
}

/** Widest river valley (game m on each side): beyond it the relief is never touched. */
const MAX_VALLEY_M = 4000;

/**
 * Rivers sit at the game's single water level, so a river higher up in reality needs its valley
 * lowered. Around each river (and lake on a river) the land is lowered by the height that river
 * cell must drop (`heightAt`, game m), fading out smoothly over `need / valleySlope` metres.
 * The local relief (banks, hills) is kept, mountains away from the river are untouched, and a
 * river already at the water level (plains) changes nothing.
 */
function lowerRiverValleys(
  game: Float32Array,
  water: Uint8Array,
  labels: Int32Array,
  linked: Uint8Array,
  g: Grid,
  heightAt: (i: number) => number,
  o: TerrainOptions,
): void {
  const n = game.length;
  const src = new Uint8Array(n);
  let any = false;
  for (let i = 0; i < n; i++) {
    if (water[i] === WATER_RIVER || (water[i] === WATER_LAKE && linked[labels[i]])) {
      src[i] = 1;
      any = true;
    }
  }
  if (!any || o.valleySlope <= 0) return;
  const { dist, idx } = nearestSource(src, g.nx, g.ny);
  const lower = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (water[i] || idx[i] < 0) continue;
    const need = heightAt(idx[i]);
    if (!(need > 0)) continue;
    const reach = Math.min(MAX_VALLEY_M, need / o.valleySlope);
    const t = (dist[i] * g.step) / reach;
    if (t < 1) lower[i] = need * (1 - t * t * (3 - 2 * t));
  }
  // Neighbouring river cells at different heights leave creases between their zones: blur them.
  const soft = blurGrid(lower, g.nx, g.ny, Math.max(32, o.smoothM) / g.step);
  for (let i = 0; i < n; i++) if (!water[i]) game[i] = Math.max(o.landMin, game[i] - soft[i]);
}

export interface BuiltTerrain {
  terrain: TerrainResult;
  /** Real heights with no source at all, before filling. */
  missing: number;
  lakesDropped: number;
  riverPieces: number;
  /** River ends joined straight / routed downhill to water, sources tapered, mouths opened. */
  riversJoined: number;
  riversRouted: number;
  sourcesTapered: number;
  riverMouths: number;
  /** Channels joining water that almost touched a river, and marshes turned into lakes. */
  waterBridged: number;
  marshLakes: number;
}

/** Real-world data of the area, as downloaded (phase 1). */
export interface TerrainSources {
  /** IGN heights on the grid (NaN = no data), or null. */
  ign: Float32Array | null;
  /** Copernicus tiles. */
  rasters: DemRaster[];
  /** Sea-floor heights (EMODnet / ETOPO, negative below sea level). */
  bathy: DemRaster[];
  /** 1 = tree cover (WorldCover), or null without land cover. */
  forest: Uint8Array | null;
  /** 1 = wetland or mangrove (WorldCover), or null without land cover. */
  wetland?: Uint8Array | null;
  /** OSM water. */
  shapes: OsmShape[];
}

/** Real sea-floor height on the cells that may be sea (no land data, or at / below 0.5 m). */
export function seaFloorGrid(f: Frame, g: Grid, real: Float32Array, bathy: DemRaster[]): Float32Array | null {
  if (!bathy.length) return null;
  const p = frameProjection(f);
  const out = new Float32Array(g.nx * g.ny).fill(NaN);
  for (let r = 0; r < g.ny; r++) {
    for (let c = 0; c < g.nx; c++) {
      const i = r * g.nx + c;
      if (Number.isFinite(real[i]) && real[i] > 0.5) continue;
      const [x, y] = cellToWorld(f, g, c, r);
      const [lon, lat] = p.toLonLat(x, y);
      out[i] = sampleDem(bathy, lon, lat);
    }
  }
  return out;
}

/**
 * The whole relief pipeline (phase 2): real heights (IGN, else Copernicus) → forest canopy off
 * the Copernicus cells → smoothing → OSM water (navigable rivers, small ponds dropped) → game
 * terrain, the sea following the real sea floor.
 */
export function buildTerrain(f: Frame, g: Grid, src: TerrainSources, o: TerrainOptions): BuiltTerrain {
  const raw = realHeights(f, g, src.ign, src.rasters);
  let missing = 0;
  for (const z of raw) if (!Number.isFinite(z)) missing++;
  if (src.forest) {
    const fromDsm = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) fromDsm[i] = !src.ign || !Number.isFinite(src.ign[i]) ? 1 : 0;
    flattenCanopy(raw, fromDsm, src.forest, o.canopyM);
  }
  const real = smoothHeights(raw, g, o.smoothM);
  // Without inland water (one game water level for all of it), only the sea is left: river beds
  // and lake floors keep their real height (no carving, no lowered valley, no capped bank).
  const inland = o.inlandWater !== false;
  const net = inland && o.repairRivers ? { real, joinM: o.riverJoinM, taperM: o.sourceTaperM } : undefined;
  const wm: WaterMask = inland
    ? waterMask(f, g, src.shapes, o.riverMinWidth, net)
    : { mask: new Uint8Array(g.nx * g.ny), joined: 0, routed: 0, tapered: 0, mouths: 0 };
  const water = wm.mask;
  const cells = (ha: number) => (ha * 10_000) / (g.step * g.step);
  const marsh = inland && o.wetlandLakes && src.wetland ? marshLakes(water, g, src.wetland, cells(o.wetlandMinHa)) : null;
  const waterBridged = inland ? bridgeWater(water, g, real, o.waterJoinM, o.riverMinWidth, cells(o.minLakeHa)) : 0;
  const lakesDropped = dropSmallWater(water, g, cells(o.minLakeHa));
  const riverPieces = countRiverPieces(water, g);
  const seaFloor = seaFloorGrid(f, g, raw, src.bathy);
  return {
    terrain: composeTerrain(real, g, water, o, seaFloor, marsh?.marsh ?? null),
    missing,
    lakesDropped,
    riverPieces,
    riversJoined: wm.joined,
    riversRouted: wm.routed,
    sourcesTapered: wm.tapered,
    riverMouths: wm.mouths,
    waterBridged,
    marshLakes: marsh?.count ?? 0,
  };
}
