/**
 * Map sizes and formats of the game's "new map" screen, as tiles X × Y
 * (`gui/menu/new_game_or_map_settings_page.tl`, `getNumTiles`; FACT-010). Labels are the game's
 * French strings (base.mo). On PC the game lists only Small…Very Large and 1:1…1:3; the others
 * appear with `experimentalMapFeatures = true` in `<UD>/settings.lua` (base `mod.json`, FACT-010).
 */
import { TILE_M } from "./area";

export const MAP_SIZES = [
  { id: "tiny", label: "Minuscule", experimental: true },
  { id: "small", label: "Petite", experimental: false },
  { id: "medium", label: "Moyenne", experimental: false },
  { id: "large", label: "Grande", experimental: false },
  { id: "veryLarge", label: "Très Grande", experimental: false },
  { id: "huge", label: "Énorme", experimental: true },
  { id: "megalomaniac", label: "Mégalomane", experimental: true },
  { id: "gigantomaniac", label: "Gigantomane", experimental: true },
] as const;

export const MAP_FORMATS = [
  { label: "1 : 1", experimental: false },
  { label: "1 : 2", experimental: false },
  { label: "1 : 3", experimental: false },
  { label: "1 : 4", experimental: true },
  { label: "1 : 5", experimental: true },
] as const;

/** [size][format] → [tilesX, tilesY] (X is the short side). */
const TILES: [number, number][][] = [
  [[16, 16], [10, 20], [8, 24], [8, 24], [6, 30]],
  [[32, 32], [22, 44], [18, 54], [16, 54], [14, 70]],
  [[44, 44], [32, 64], [26, 78], [22, 88], [20, 100]],
  [[56, 56], [40, 80], [32, 96], [28, 112], [24, 126]],
  [[64, 64], [44, 88], [36, 108], [32, 128], [28, 140]],
  [[80, 80], [56, 112], [46, 138], [40, 160], [34, 170]],
  [[96, 96], [66, 132], [54, 162], [48, 192], [42, 210]],
  [[112, 112], [80, 160], [64, 192], [56, 224], [50, 250]],
];

function clampIndex(i: number, n: number): number {
  return Math.max(0, Math.min(n - 1, Math.round(i) || 0));
}

/** Size and format indices the game offers (all of them with experimental map features). */
export function availableSizes(experimental: boolean): number[] {
  return MAP_SIZES.flatMap((s, i) => (experimental || !s.experimental ? [i] : []));
}

export function availableFormats(experimental: boolean): number[] {
  return MAP_FORMATS.flatMap((f, i) => (experimental || !f.experimental ? [i] : []));
}

/** Nearest offered index (a saved choice the game does not list without experimental features). */
export function nearestAvailable(index: number, available: number[]): number {
  let best = available[0];
  for (const i of available) if (Math.abs(i - index) < Math.abs(best - index)) best = i;
  return best;
}

export function isExperimental(size: number, format: number): boolean {
  return MAP_SIZES[clampIndex(size, MAP_SIZES.length)].experimental || MAP_FORMATS[clampIndex(format, MAP_FORMATS.length)].experimental;
}

/** `experimentalMapFeatures = true|false` in the text of `<UD>/settings.lua`; null when absent. */
export function parseExperimentalMapFeatures(settingsLua: string): boolean | null {
  const m = settingsLua.match(/experimentalMapFeatures\s*=\s*(true|false)/);
  return m ? m[1] === "true" : null;
}

/** Tiles of a game map; `landscape` swaps the axes so the long side runs east–west. */
export function mapTiles(size: number, format: number, landscape = false): { tilesX: number; tilesY: number } {
  const [a, b] = TILES[clampIndex(size, TILES.length)][clampIndex(format, MAP_FORMATS.length)];
  return landscape ? { tilesX: b, tilesY: a } : { tilesX: a, tilesY: b };
}

export function formatKm(m: number): string {
  return (m / 1000).toLocaleString("fr-FR", { maximumFractionDigits: 1 });
}

/** "Grande (1 : 3) — 8,2 × 24,6 km" */
export function mapSizeLabel(size: number, format: number, landscape = false): string {
  const { tilesX, tilesY } = mapTiles(size, format, landscape);
  const s = MAP_SIZES[clampIndex(size, MAP_SIZES.length)].label;
  const fmt = MAP_FORMATS[clampIndex(format, MAP_FORMATS.length)].label;
  return `${s} (${fmt}) — ${formatKm(tilesX * TILE_M)} × ${formatKm(tilesY * TILE_M)} km`;
}
