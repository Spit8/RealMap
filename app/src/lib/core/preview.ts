/**
 * Approximate top view of the game map: biome colours tinted by altitude, hill-shaded, water in
 * blue (everything below the game's water level 0). Rows / columns follow the grid (north up).
 */
import type { Grid } from "./grid";
import { WATER_SEA, type TerrainResult } from "./terrain";

export const WATER_RGB: [number, number, number] = [60, 120, 210];

export const COVER_RGB: [number, number, number][] = [
  [190, 205, 140], // open
  [78, 122, 60], // forest
  [150, 150, 95], // scrub
  [165, 158, 148], // rock
];

export interface PreviewImage {
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
}

/** Coarse copy of the terrain for hover readouts (game height, water class, cover per cell). */
export interface HoverGrid {
  width: number;
  height: number;
  /** Game metres per hover cell. */
  cell: number;
  heights: Float32Array;
  water: Uint8Array;
  cover: Uint8Array;
}

export function hoverGrid(t: TerrainResult, cover: Uint8Array, g: Grid, maxPx = 256): HoverGrid {
  const k = Math.max(1, Math.ceil(Math.max(g.nx, g.ny) / maxPx));
  const width = Math.ceil(g.nx / k);
  const height = Math.ceil(g.ny / k);
  const heights = new Float32Array(width * height);
  const water = new Uint8Array(width * height);
  const cov = new Uint8Array(width * height);
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      const i = r * k * g.nx + c * k;
      const o = r * width + c;
      heights[o] = t.game[i];
      water[o] = t.water[i];
      cov[o] = cover[i];
    }
  }
  return { width, height, cell: k * g.step, heights, water, cover: cov };
}

export function renderPreview(t: TerrainResult, cover: Uint8Array, g: Grid, maxPx = 1024): PreviewImage {
  const k = Math.max(1, Math.ceil(Math.max(g.nx, g.ny) / maxPx));
  const width = Math.ceil(g.nx / k);
  const height = Math.ceil(g.ny / k);
  const rgba = new Uint8ClampedArray(width * height * 4);
  const span = Math.max(1, t.maxM);
  // Light from the north-west, slopes exaggerated a little for readability.
  const lx = -0.5, ly = -0.5, lz = 0.7071;
  const at = (c: number, r: number) => t.game[Math.min(g.ny - 1, Math.max(0, r)) * g.nx + Math.min(g.nx - 1, Math.max(0, c))];
  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      const c = px * k;
      const r = py * k;
      const i = r * g.nx + c;
      const o = (py * width + px) * 4;
      const w = t.water[i];
      if (w) {
        // Darker with depth (0 → 40 m), so the shore slope and the sea floor show.
        const depth = Math.min(1, Math.max(0, -t.game[i] / 40));
        const deep = 1.15 - 0.6 * Math.sqrt(depth) - (w === WATER_SEA ? 0.05 : 0);
        rgba[o] = Math.min(255, WATER_RGB[0] * deep);
        rgba[o + 1] = Math.min(255, WATER_RGB[1] * deep);
        rgba[o + 2] = Math.min(255, WATER_RGB[2] * deep);
        rgba[o + 3] = 255;
        continue;
      }
      const dzx = ((at(c + k, r) - at(c - k, r)) / (2 * k * g.step)) * 2;
      const dzy = ((at(c, r + k) - at(c, r - k)) / (2 * k * g.step)) * 2;
      const len = Math.hypot(dzx, dzy, 1);
      // Normal (−dzx, dzy, 1): rows grow southwards.
      const shade = Math.max(0, (-dzx * lx + dzy * ly + lz) / len);
      const light = 0.45 + 0.75 * shade;
      const alt = Math.min(1, Math.max(0, t.game[i] / span));
      const base = COVER_RGB[cover[i]] ?? COVER_RGB[0];
      for (let ch = 0; ch < 3; ch++) rgba[o + ch] = (base[ch] + (245 - base[ch]) * alt * 0.45) * light;
      rgba[o + 3] = 255;
    }
  }
  return { width, height, rgba };
}
