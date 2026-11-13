/**
 * Copernicus DEM GLO-30 (DECISION-001): 1°×1° Cloud-Optimised GeoTIFF tiles on AWS Open Data,
 * heights in metres (float32). Tiles that do not exist (open sea) are reported as missing.
 */

export const COPERNICUS_BASE = "https://copernicus-dem-30m.s3.amazonaws.com";

/** Tile covering [lat, lat+1) × [lon, lon+1), named after its south-west corner. */
export function copernicusTileName(latFloor: number, lonFloor: number): string {
  const ns = latFloor >= 0 ? "N" : "S";
  const ew = lonFloor >= 0 ? "E" : "W";
  const la = String(Math.abs(latFloor)).padStart(2, "0");
  const lo = String(Math.abs(lonFloor)).padStart(3, "0");
  return `Copernicus_DSM_COG_10_${ns}${la}_00_${ew}${lo}_00_DEM`;
}

export function copernicusTileUrl(name: string): string {
  return `${COPERNICUS_BASE}/${name}/${name}.tif`;
}

/**
 * Niveaux d'aperçu (overviews) des COG Copernicus, vérifiés sur une dalle réelle en 1.2.3 : 4 images,
 * pleine résolution puis 1/2, 1/4, 1/8 (environ 30, 60, 120, 240 m).
 */
export const COPERNICUS_OVERVIEWS = 3;
const COPERNICUS_RES_M = 30;

/**
 * Niveau de dalle pour un pas de grille réel : le plus grossier qui garde au moins 2 pixels par
 * cellule. 0 (pleine résolution) pour les cartes habituelles ; un pays entier lit 1/4 ou 1/8.
 */
export function demLevel(realStepM: number): number {
  let level = 0;
  while (level < COPERNICUS_OVERVIEWS && COPERNICUS_RES_M * 2 ** (level + 1) <= realStepM / 2) level++;
  return level;
}

/** Names of the tiles covering a lon/lat box. */
export function copernicusTilesFor(b: { west: number; south: number; east: number; north: number }): string[] {
  const names: string[] = [];
  for (let lat = Math.floor(b.south); lat <= Math.floor(b.north); lat++) {
    for (let lon = Math.floor(b.west); lon <= Math.floor(b.east); lon++) names.push(copernicusTileName(lat, lon));
  }
  return names;
}

/** One raster in lon/lat: pixel (c, r) centre is at (west + (c+0.5)·resLon, north − (r+0.5)·resLat). */
export interface DemRaster {
  west: number;
  north: number;
  resLon: number;
  resLat: number;
  width: number;
  height: number;
  data: Float32Array;
  /** Value meaning "no data" (none when undefined). */
  noData?: number;
}

/**
 * The part of a raster over a lon/lat box (plus `pad` pixels for the bilinear neighbours), as a
 * new raster with its own copy of the pixels; the raster itself when the box covers it all, null
 * when they do not overlap. Heights sampled inside the box are the same as on the whole raster.
 */
export function cropDem(
  r: DemRaster,
  b: { west: number; south: number; east: number; north: number },
  pad = 2,
): DemRaster | null {
  const c0 = Math.max(0, Math.floor((b.west - r.west) / r.resLon) - pad);
  const c1 = Math.min(r.width, Math.ceil((b.east - r.west) / r.resLon) + pad);
  const r0 = Math.max(0, Math.floor((r.north - b.north) / r.resLat) - pad);
  const r1 = Math.min(r.height, Math.ceil((r.north - b.south) / r.resLat) + pad);
  if (c1 <= c0 || r1 <= r0) return null;
  if (c0 === 0 && r0 === 0 && c1 === r.width && r1 === r.height) return r;
  const width = c1 - c0;
  const height = r1 - r0;
  const data = new Float32Array(width * height);
  for (let y = 0; y < height; y++) data.set(r.data.subarray((r0 + y) * r.width + c0, (r0 + y) * r.width + c1), y * width);
  return { ...r, west: r.west + c0 * r.resLon, north: r.north - r0 * r.resLat, width, height, data };
}

/**
 * Mean height over a square footprint of `sizeDeg` degrees around lon/lat (k×k bilinear taps),
 * so a sample spaced wider than the DEM pixels averages them instead of picking one (aliasing).
 */
export function sampleDemBox(rasters: DemRaster[], lon: number, lat: number, sizeLon: number, sizeLat: number, k: number): number {
  if (k <= 1) return sampleDem(rasters, lon, lat);
  let sum = 0;
  let n = 0;
  for (let j = 0; j < k; j++) {
    for (let i = 0; i < k; i++) {
      const z = sampleDem(rasters, lon + ((i + 0.5) / k - 0.5) * sizeLon, lat + ((j + 0.5) / k - 0.5) * sizeLat);
      if (Number.isFinite(z)) {
        sum += z;
        n++;
      }
    }
  }
  return n ? sum / n : NaN;
}

/** Bilinear height at lon/lat from the first raster that covers it; NaN when none does. */
export function sampleDem(rasters: DemRaster[], lon: number, lat: number): number {
  for (const r of rasters) {
    const fx = (lon - r.west) / r.resLon - 0.5;
    const fy = (r.north - lat) / r.resLat - 0.5;
    if (fx < -0.5 || fy < -0.5 || fx > r.width - 0.5 || fy > r.height - 0.5) continue;
    const x0 = Math.max(0, Math.min(r.width - 1, Math.floor(fx)));
    const y0 = Math.max(0, Math.min(r.height - 1, Math.floor(fy)));
    const x1 = Math.min(r.width - 1, x0 + 1);
    const y1 = Math.min(r.height - 1, y0 + 1);
    const tx = Math.max(0, Math.min(1, fx - x0));
    const ty = Math.max(0, Math.min(1, fy - y0));
    const v = (x: number, y: number) => {
      const z = r.data[y * r.width + x];
      return z === r.noData || !Number.isFinite(z) ? NaN : z;
    };
    const a = v(x0, y0), b = v(x1, y0), c = v(x0, y1), d = v(x1, y1);
    const top = a + (b - a) * tx;
    const bot = c + (d - c) * tx;
    const z = top + (bot - top) * ty;
    if (Number.isFinite(z)) return z;
    // A no-data neighbour: fall back to the nearest valid corner.
    for (const w of [a, b, c, d]) if (Number.isFinite(w)) return w;
    return NaN;
  }
  return NaN;
}
