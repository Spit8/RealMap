/**
 * Biome maps for the Map Editor's "Import Heightmap → Biomes" tab (FACT-007): three 8-bit
 * grayscale PNGs the size of the heightmap — `<name>_biomes.png` (biome index i written as
 * ⌊i·63.75⌋: 0/63/127/191/255), `<name>_mountains.png` and `<name>_rivers.png` (0/255 masks).
 * Which biome is forest, rock… is not known yet (QUESTION-002): the mapping is a setting, the
 * defaults follow the game's export where indices rise with altitude.
 */
import type { Grid } from "./grid";
import { WATER_RIVER, type TerrainResult } from "./terrain";

export const COVER_OPEN = 0;
export const COVER_FOREST = 1;
export const COVER_SCRUB = 2;
export const COVER_ROCK = 3;

export const COVER_LABELS = ["Ouvert (champs, prés, villes)", "Forêt", "Landes, broussailles", "Roche, éboulis, glacier"];

export interface BiomeMapping {
  water: number;
  /** Biome index per cover class (COVER_OPEN… COVER_ROCK). */
  cover: [number, number, number, number];
}

export const DEFAULT_BIOMES: BiomeMapping = { water: 0, cover: [1, 2, 3, 4] };

/** Without land cover data: very steep land is rock, the rest open. */
export function fallbackCover(t: TerrainResult, g: Grid): Uint8Array {
  const out = new Uint8Array(g.nx * g.ny);
  for (let r = 1; r < g.ny; r++) {
    for (let c = 1; c < g.nx; c++) {
      const i = r * g.nx + c;
      const s = Math.max(Math.abs(t.game[i] - t.game[i - 1]), Math.abs(t.game[i] - t.game[i - g.nx])) / g.step;
      if (s > 0.8) out[i] = COVER_ROCK;
    }
  }
  return out;
}

export const biomeByte = (index: number) => Math.floor(Math.max(0, Math.min(4, index)) * 63.75);

export function biomeImage(cover: Uint8Array, t: TerrainResult, m: BiomeMapping): Uint8Array {
  const out = new Uint8Array(cover.length);
  for (let i = 0; i < out.length; i++) out[i] = biomeByte(t.water[i] ? m.water : m.cover[cover[i]] ?? 1);
  return out;
}

/** Mountains: steep land (> 50 %) or the top quarter of a map with real relief. */
export function mountainsImage(t: TerrainResult, g: Grid): Uint8Array {
  const out = new Uint8Array(g.nx * g.ny);
  const high = t.maxM > 150 ? t.maxM * 0.75 : Infinity;
  for (let r = 0; r < g.ny; r++) {
    for (let c = 0; c < g.nx; c++) {
      const i = r * g.nx + c;
      if (t.water[i]) continue;
      const dx = c > 0 ? Math.abs(t.game[i] - t.game[i - 1]) : 0;
      const dy = r > 0 ? Math.abs(t.game[i] - t.game[i - g.nx]) : 0;
      if (Math.max(dx, dy) / g.step > 0.5 || t.game[i] > high) out[i] = 255;
    }
  }
  return out;
}

/**
 * Test map to identify the biomes in game: gentle west→east ramp (5 → 25 m) and five vertical
 * stripes, biome 0 to 4 from west to east.
 */
export function biomeTestPattern(nx: number, ny: number): { heights: Float32Array; biomes: Uint8Array } {
  const heights = new Float32Array(nx * ny);
  const biomes = new Uint8Array(nx * ny);
  for (let r = 0; r < ny; r++) {
    for (let c = 0; c < nx; c++) {
      const i = r * nx + c;
      heights[i] = 5 + (20 * c) / Math.max(1, nx - 1);
      biomes[i] = biomeByte(Math.min(4, Math.floor((5 * c) / nx)));
    }
  }
  return { heights, biomes };
}

/** Channel widths (game m, west → east) and depths (m, north → south) of the river test map. */
export const RIVER_TEST_WIDTHS = [8, 16, 24, 32, 48, 64];
export const RIVER_TEST_DEPTHS = [2, 4, 6, 8, 10];
export const RIVER_TEST_LAND = 5;

/**
 * Test map to find which rivers ships can use (QUESTION-009): flat land at 5 m, one north–south
 * channel per (width, depth) pair, widths growing west → east, depths north → south. Heights run
 * from −10 to 5 m: import with Minimum −10, Maximum 5, Water Level 0, then look at the
 * « Navigable Waters » layer. `sampleM` = game metres between samples (4 in a heightmap).
 */
export function riverTestPattern(nx: number, ny: number, sampleM = 4): Float32Array {
  const heights = new Float32Array(nx * ny).fill(RIVER_TEST_LAND);
  const cols = RIVER_TEST_WIDTHS.length;
  const rows = RIVER_TEST_DEPTHS.length;
  for (let j = 0; j < rows; j++) {
    const r0 = Math.floor((ny * (j + 0.1)) / rows);
    const r1 = Math.floor((ny * (j + 0.9)) / rows);
    for (let k = 0; k < cols; k++) {
      const half = RIVER_TEST_WIDTHS[k] / sampleM / 2;
      const cc = (nx * (k + 0.5)) / cols;
      for (let r = r0; r < r1; r++) {
        for (let c = Math.ceil(cc - half); c < cc + half; c++) heights[r * nx + c] = -RIVER_TEST_DEPTHS[j];
      }
    }
  }
  // One sample at the deepest value so the 16-bit range is always −10…5.
  heights[0] = -Math.max(...RIVER_TEST_DEPTHS);
  return heights;
}

export function riversImage(t: TerrainResult): Uint8Array {
  const out = new Uint8Array(t.water.length);
  for (let i = 0; i < out.length; i++) if (t.water[i] === WATER_RIVER) out[i] = 255;
  return out;
}
