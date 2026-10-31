/**
 * Land cover from ESA WorldCover 10 m 2021 (FACT-015): 3°×3° Cloud-Optimised GeoTIFF tiles on AWS
 * Open Data, one byte per pixel (class code, 0 = no data), with overviews at 20, 40, 80… m.
 * Only the window over the area is read, at the coarsest overview that is still fine enough, so a
 * large area costs a few MB instead of the heavy OSM forest query (FACT-012).
 */
import { frameProjection, type Frame } from "./area";
import { COVER_FOREST, COVER_OPEN, COVER_ROCK, COVER_SCRUB } from "./biomes";
import { cellToWorld, type Grid } from "./grid";

export const WORLDCOVER_BASE = "https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map";
/** Full-resolution pixels per degree (1/12000° ≈ 10 m). */
export const WORLDCOVER_PX_PER_DEG = 12000;
export const WORLDCOVER_TILE_DEG = 3;
/** Number of overviews after the full-resolution image (36000 → 562 px). */
export const WORLDCOVER_LEVELS = 6;

type Bbox = { west: number; south: number; east: number; north: number };

/** Tile covering [lat, lat+3) × [lon, lon+3), named after its south-west corner (multiples of 3). */
export function worldcoverTileName(latFloor: number, lonFloor: number): string {
  const ns = latFloor >= 0 ? "N" : "S";
  const ew = lonFloor >= 0 ? "E" : "W";
  const la = String(Math.abs(latFloor)).padStart(2, "0");
  const lo = String(Math.abs(lonFloor)).padStart(3, "0");
  return `ESA_WorldCover_10m_2021_v200_${ns}${la}${ew}${lo}_Map`;
}

export function worldcoverTileUrl(name: string): string {
  return `${WORLDCOVER_BASE}/${name}.tif`;
}

const snap = (v: number) => Math.floor(v / WORLDCOVER_TILE_DEG) * WORLDCOVER_TILE_DEG;

/** Tiles covering a lon/lat box, with their south-west corner. */
export function worldcoverTilesFor(b: Bbox): { name: string; south: number; west: number }[] {
  const out: { name: string; south: number; west: number }[] = [];
  for (let lat = snap(b.south); lat <= snap(b.north); lat += WORLDCOVER_TILE_DEG) {
    for (let lon = snap(b.west); lon <= snap(b.east); lon += WORLDCOVER_TILE_DEG) {
      out.push({ name: worldcoverTileName(lat, lon), south: lat, west: lon });
    }
  }
  return out;
}

/**
 * Overview level to read for samples `realStepM` apart: the coarsest whose pixels (10·2^level m)
 * are not larger than the step, never finer than 20 m (level 1): biomes do not need more.
 */
export function worldcoverLevel(realStepM: number): number {
  let level = 1;
  while (level < WORLDCOVER_LEVELS && 10 * 2 ** (level + 1) <= realStepM) level++;
  return level;
}

/** Pixel window [x0, y0, x1, y1) of `b` in a tile at `level`, clipped to the tile; null if outside. */
export function worldcoverWindow(tile: { south: number; west: number }, level: number, b: Bbox): [number, number, number, number] | null {
  const ppd = WORLDCOVER_PX_PER_DEG / 2 ** level;
  const size = Math.floor((WORLDCOVER_TILE_DEG * WORLDCOVER_PX_PER_DEG) / 2 ** level);
  const north = tile.south + WORLDCOVER_TILE_DEG;
  const x0 = Math.max(0, Math.floor((b.west - tile.west) * ppd));
  const x1 = Math.min(size, Math.ceil((b.east - tile.west) * ppd));
  const y0 = Math.max(0, Math.floor((north - b.north) * ppd));
  const y1 = Math.min(size, Math.ceil((north - b.south) * ppd));
  return x1 > x0 && y1 > y0 ? [x0, y0, x1, y1] : null;
}

/** One window of class codes in lon/lat: pixel (c, r) centre is at (west + (c+0.5)·res, north − (r+0.5)·res). */
export interface CoverRaster {
  west: number;
  north: number;
  res: number;
  width: number;
  height: number;
  data: Uint8Array;
}

export function coverRasterFor(tile: { south: number; west: number }, level: number, win: [number, number, number, number], data: Uint8Array): CoverRaster {
  const res = 2 ** level / WORLDCOVER_PX_PER_DEG;
  return {
    west: tile.west + win[0] * res,
    north: tile.south + WORLDCOVER_TILE_DEG - win[1] * res,
    res,
    width: win[2] - win[0],
    height: win[3] - win[1],
    data,
  };
}

/**
 * WorldCover class → cover class: tree cover → forest; shrubland, moss & lichen → scrub; bare /
 * sparse vegetation, snow & ice → rock; grass, crops, built-up, wetland, water → open (water
 * itself comes from OSM).
 */
export function coverOfClass(code: number): number {
  switch (code) {
    case 10:
    case 95:
      return COVER_FOREST;
    case 20:
    case 100:
      return COVER_SCRUB;
    case 60:
    case 70:
      return COVER_ROCK;
    default:
      return COVER_OPEN;
  }
}

/** Class code at lon/lat (nearest pixel) from the first raster that covers it; 0 when none does. */
export function sampleCover(rasters: CoverRaster[], lon: number, lat: number): number {
  for (const r of rasters) {
    const c = Math.floor((lon - r.west) / r.res);
    const row = Math.floor((r.north - lat) / r.res);
    if (c < 0 || row < 0 || c >= r.width || row >= r.height) continue;
    const v = r.data[row * r.width + c];
    if (v) return v;
  }
  return 0;
}

/** WorldCover class codes on the grid (0 = no data); `coverOfClass` turns them into cover classes. */
export function landcoverCodes(f: Frame, g: Grid, rasters: CoverRaster[]): Uint8Array {
  const out = new Uint8Array(g.nx * g.ny);
  if (!rasters.length) return out;
  const p = frameProjection(f);
  for (let r = 0; r < g.ny; r++) {
    for (let c = 0; c < g.nx; c++) {
      const [x, y] = cellToWorld(f, g, c, r);
      const [lon, lat] = p.toLonLat(x, y);
      out[r * g.nx + c] = sampleCover(rasters, lon, lat);
    }
  }
  return out;
}

/** Cover classes on the grid. */
export function rasterizeLandcover(f: Frame, g: Grid, rasters: CoverRaster[]): Uint8Array {
  return landcoverCodes(f, g, rasters).map(coverOfClass);
}

/** WorldCover codes used by the industries (`industries.ts`). */
export const WC_TREE = 10;
export const WC_GRASS = 30;
export const WC_CROP = 40;
export const WC_WETLAND = 90;
export const WC_MANGROVE = 95;
