/**
 * IGN RGE ALTI (France, bare-earth terrain model) through the Géoplateforme WMS (FACT-011):
 * GetMap with FORMAT=image/x-bil;bits=32 returns little-endian float32 heights laid exactly on the
 * requested pixel grid. The WMS needs an EPSG code while the map uses its own local projection
 * (`area.ts`), so the UTM rectangle around the map is requested at the grid's step and resampled
 * (bilinear) onto the grid.
 */
import proj4 from "proj4";
import { frameOutline, frameProjection, type Frame } from "./area";
import { cellToWorld, type Grid } from "./grid";

export const IGN_WMS = "https://data.geopf.fr/wms-r/wms";
export const IGN_LAYER = "ELEVATION.ELEVATIONGRIDCOVERAGE.HIGHRES";
/** Values below this are "no data" (outside France, sea). */
export const IGN_NODATA_BELOW = -1000;

/** Rough coverage of the RGE ALTI: metropolitan France and Corsica, Antilles, Guyane, Réunion, Mayotte. */
const COVERAGE: [number, number, number, number][] = [
  [-5.5, 41.2, 9.8, 51.2],
  [-63.2, 14.3, -60.7, 18.2],
  [-54.7, 2.0, -51.5, 6.0],
  [55.1, -21.5, 55.9, -20.8],
  [44.9, -13.1, 45.4, -12.5],
];

export function inIgnCoverage(lon: number, lat: number): boolean {
  return COVERAGE.some(([w, s, e, n]) => lon >= w && lon <= e && lat >= s && lat <= n);
}

/** UTM raster requested from the WMS: pixel (0, 0) centred on (`e0`, `n0`), `step` real metres. */
export interface IgnRaster {
  e0: number;
  n0: number;
  step: number;
  w: number;
  h: number;
}

export interface IgnBlock {
  /** First column / row of the block in the raster, and its size in pixels. */
  c0: number;
  r0: number;
  w: number;
  h: number;
  /** WMS 1.3.0 BBOX in UTM (minE, minN, maxE, maxN): pixel centres on the raster's. */
  bbox: [number, number, number, number];
}

/** The UTM rectangle covering the map (plus two pixels), at the grid's real step. */
export function ignRaster(f: Frame, g: Grid): IgnRaster {
  const step = g.step * f.scale;
  let minE = Infinity, minN = Infinity, maxE = -Infinity, maxN = -Infinity;
  for (const ll of frameOutline(f, 32)) {
    const [e, n] = proj4("WGS84", f.utm, ll);
    minE = Math.min(minE, e);
    maxE = Math.max(maxE, e);
    minN = Math.min(minN, n);
    maxN = Math.max(maxN, n);
  }
  const e0 = Math.floor(minE / step - 2) * step;
  const n0 = Math.ceil(maxN / step + 2) * step;
  return { e0, n0, step, w: Math.ceil((maxE - e0) / step) + 3, h: Math.ceil((n0 - minN) / step) + 3 };
}

/** Split the raster into WMS requests of at most `maxPx`² pixels. */
export function ignBlocks(r: IgnRaster, maxPx = 2048): IgnBlock[] {
  const blocks: IgnBlock[] = [];
  for (let r0 = 0; r0 < r.h; r0 += maxPx) {
    for (let c0 = 0; c0 < r.w; c0 += maxPx) {
      const w = Math.min(maxPx, r.w - c0);
      const h = Math.min(maxPx, r.h - r0);
      const minE = r.e0 + (c0 - 0.5) * r.step;
      const maxN = r.n0 - (r0 - 0.5) * r.step;
      blocks.push({ c0, r0, w, h, bbox: [minE, maxN - h * r.step, minE + w * r.step, maxN] });
    }
  }
  return blocks;
}

export function ignBlockUrl(f: Frame, b: IgnBlock): string {
  const bbox = b.bbox.map((v) => v.toFixed(3)).join(",");
  return (
    `${IGN_WMS}?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&LAYERS=${IGN_LAYER}&STYLES=` +
    `&CRS=EPSG:${f.epsg}&BBOX=${bbox}&WIDTH=${b.w}&HEIGHT=${b.h}&FORMAT=image/x-bil;bits=32`
  );
}

/** Decode a BIL answer (little-endian float32, row 0 = north); null when it is not one (an error page). */
export function decodeBil(bytes: Uint8Array, w: number, h: number): Float32Array | null {
  if (bytes.byteLength !== w * h * 4) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Float32Array(w * h);
  for (let i = 0; i < out.length; i++) {
    const z = view.getFloat32(i * 4, true);
    out[i] = z < IGN_NODATA_BELOW ? NaN : z;
  }
  return out;
}

/** Copy a decoded block into the raster (NaN = no data). */
export function pasteBlock(raster: Float32Array, r: IgnRaster, b: IgnBlock, data: Float32Array): void {
  for (let k = 0; k < b.h; k++) raster.set(data.subarray(k * b.w, (k + 1) * b.w), (b.r0 + k) * r.w + b.c0);
}

/**
 * The UTM raster on the map grid (bilinear; NaN where a neighbour has no data). The UTM position
 * of each cell is interpolated from a coarse lattice: the mapping is smooth, and projecting 13 M
 * cells one by one would take seconds.
 */
export function resampleToGrid(f: Frame, g: Grid, r: IgnRaster, raster: Float32Array): Float32Array {
  const p = frameProjection(f);
  const conv = proj4("WGS84", f.utm);
  const K = 32;
  const lx = Math.ceil((g.nx - 1) / K) + 1;
  const ly = Math.ceil((g.ny - 1) / K) + 1;
  const le = new Float64Array(lx * ly);
  const ln = new Float64Array(lx * ly);
  for (let j = 0; j < ly; j++) {
    for (let i = 0; i < lx; i++) {
      const [x, y] = cellToWorld(f, g, i * K, j * K);
      const [e, n] = conv.forward(p.toLonLat(x, y));
      le[j * lx + i] = e;
      ln[j * lx + i] = n;
    }
  }
  const out = new Float32Array(g.nx * g.ny).fill(NaN);
  for (let row = 0; row < g.ny; row++) {
    const fj = row / K;
    const j0 = Math.min(ly - 2, Math.floor(fj));
    const tj = fj - j0;
    for (let col = 0; col < g.nx; col++) {
      const fi = col / K;
      const i0 = Math.min(lx - 2, Math.floor(fi));
      const ti = fi - i0;
      const a = j0 * lx + i0;
      const lerp = (v: Float64Array) =>
        (v[a] * (1 - ti) + v[a + 1] * ti) * (1 - tj) + (v[a + lx] * (1 - ti) + v[a + lx + 1] * ti) * tj;
      const px = (lerp(le) - r.e0) / r.step;
      const py = (r.n0 - lerp(ln)) / r.step;
      const c0 = Math.floor(px);
      const r0 = Math.floor(py);
      if (c0 < 0 || r0 < 0 || c0 + 1 >= r.w || r0 + 1 >= r.h) continue;
      const u = px - c0;
      const v = py - r0;
      const k = r0 * r.w + c0;
      out[row * g.nx + col] =
        (raster[k] * (1 - u) + raster[k + 1] * u) * (1 - v) + (raster[k + r.w] * (1 - u) + raster[k + r.w + 1] * u) * v;
    }
  }
  return out;
}
