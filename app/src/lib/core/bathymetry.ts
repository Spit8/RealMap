/**
 * Sea-floor heights (FACT-018): EMODnet Bathymetry (Europe, 1/960° ≈ 115 m, WCS GeoTIFF float32,
 * land included) and, elsewhere or when it fails, NOAA ETOPO 1′ (≈ 1.8 km, ERDDAP JSON). Heights
 * are metres, negative below sea level; both answer without a key.
 */
import type { DemRaster } from "./dem";

type Bbox = { west: number; south: number; east: number; north: number };

export const EMODNET_WCS = "https://ows.emodnet-bathymetry.eu/wcs";
export const ETOPO_ERDDAP = "https://coastwatch.pfeg.noaa.gov/erddap/griddap/etopo180.json";

/** Rough extent of the EMODnet grid (European seas). */
const EMODNET_EXTENT: Bbox = { west: -36, south: 15, east: 43, north: 90 };

/** Grow a box by `deg` on every side, so edge cells still have neighbours to interpolate from. */
export function growBbox(b: Bbox, deg: number): Bbox {
  return { west: b.west - deg, south: b.south - deg, east: b.east + deg, north: b.north + deg };
}

export function inEmodnet(b: Bbox): boolean {
  const e = EMODNET_EXTENT;
  return b.west >= e.west && b.east <= e.east && b.south >= e.south && b.north <= e.north;
}

const fix = (v: number) => Math.round(v * 1e5) / 1e5;

/** Pixels par degré de la grille EMODnet (1/960°). */
export const EMODNET_PX_PER_DEG = 960;

/** Au plus 4 Mpx (16 Mo en float32) par réponse EMODnet : au-delà, le serveur réduit la grille. */
export const EMODNET_MAX_PX = 4_000_000;

/**
 * Requête WCS sur une zone. Une très grande zone (un pays : environ 10 000 × 6 000 px natifs, 230 Mo)
 * est demandée réduite avec `SCALESIZE=i(largeur),j(hauteur)` (vérifié sur le serveur en 1.2.3 :
 * i = longitudes, j = latitudes, géoréférencement juste). Les zones habituelles restent natives.
 */
export function emodnetUrl(b: Bbox): string {
  const w = Math.ceil((b.east - b.west) * EMODNET_PX_PER_DEG);
  const h = Math.ceil((b.north - b.south) * EMODNET_PX_PER_DEG);
  const k = Math.sqrt((w * h) / EMODNET_MAX_PX);
  const scale = k > 1 ? `&SCALESIZE=i(${Math.max(1, Math.floor(w / k))}),j(${Math.max(1, Math.floor(h / k))})` : "";
  return (
    `${EMODNET_WCS}?service=WCS&version=2.0.1&request=GetCoverage&coverageId=emodnet__mean` +
    `&subset=Lat(${fix(b.south)},${fix(b.north)})&subset=Long(${fix(b.west)},${fix(b.east)})&format=image/tiff${scale}`
  );
}

export function etopoUrl(b: Bbox): string {
  return `${ETOPO_ERDDAP}?altitude%5B(${fix(b.south)}):1:(${fix(b.north)})%5D%5B(${fix(b.west)}):1:(${fix(b.east)})%5D`;
}

/** ERDDAP table (`[lat, lon, altitude]` rows on a regular grid) → raster, row 0 north. */
export function parseEtopoJson(json: { table?: { columnNames?: string[]; rows?: number[][] } }): DemRaster | null {
  const rows = json.table?.rows ?? [];
  const names = json.table?.columnNames ?? ["latitude", "longitude", "altitude"];
  const iLat = names.indexOf("latitude");
  const iLon = names.indexOf("longitude");
  const iAlt = names.indexOf("altitude");
  if (!rows.length || iLat < 0 || iLon < 0 || iAlt < 0) return null;
  const lats = [...new Set(rows.map((r) => r[iLat]))].sort((a, b) => b - a);
  const lons = [...new Set(rows.map((r) => r[iLon]))].sort((a, b) => a - b);
  if (lats.length < 2 || lons.length < 2) return null;
  const resLat = Math.abs(lats[0] - lats[1]);
  const resLon = Math.abs(lons[1] - lons[0]);
  const data = new Float32Array(lats.length * lons.length).fill(NaN);
  const row = new Map(lats.map((v, k) => [v, k]));
  const col = new Map(lons.map((v, k) => [v, k]));
  for (const r of rows) data[row.get(r[iLat])! * lons.length + col.get(r[iLon])!] = r[iAlt];
  // Sample centres on the grid nodes: the raster's pixel (0, 0) centre is (lons[0], lats[0]).
  return {
    west: lons[0] - resLon / 2,
    north: lats[0] + resLat / 2,
    resLon,
    resLat,
    width: lons.length,
    height: lats.length,
    data,
  };
}
