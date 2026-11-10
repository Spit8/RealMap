/**
 * A sampling grid over the game map: the full heightmap grid (one sample every 4 game metres) or
 * a coarser one for the quick preview. Cell (c, r) sits at game x = −W/2 + c·step and, row 0 being
 * the north edge (QUESTION-004), y = H/2 − r·step.
 */
import { SAMPLE_M, type Frame } from "./area";

export interface Grid {
  nx: number;
  ny: number;
  /** Game metres between samples. */
  step: number;
}

export function fullGrid(f: Frame): Grid {
  return { nx: f.samplesX, ny: f.samplesY, step: SAMPLE_M };
}

/** Heightmap samples of the full map (every grid of the export is this big). */
export function gridSamples(f: Frame): number {
  return f.samplesX * f.samplesY;
}

/**
 * Most samples of a map the game offers without experimental features, the largest tested in game:
 * Très Grande 1:1 (64 × 64 tiles, 4097 × 4097). The experimental sizes go up to 3 times that
 * (Gigantomane, 7169 × 7169 in 1:1).
 */
export const TESTED_MAX_SAMPLES = (64 * 64 + 1) ** 2;

/** Longest side of the preview grid (samples). */
export const PREVIEW_PX = 1024;

/** Coarser grid whose longest side is at most `maxPx` samples. */
export function previewGrid(f: Frame, maxPx = PREVIEW_PX): Grid {
  const k = Math.max(1, Math.ceil((Math.max(f.samplesX, f.samplesY) - 1) / (maxPx - 1)));
  return {
    nx: Math.floor((f.samplesX - 1) / k) + 1,
    ny: Math.floor((f.samplesY - 1) / k) + 1,
    step: SAMPLE_M * k,
  };
}

export function cellToWorld(f: Frame, g: Grid, c: number, r: number): [number, number] {
  return [-f.widthM / 2 + c * g.step, f.heightM / 2 - r * g.step];
}

/** Fractional cell coordinates of a game point. */
export function worldToCell(f: Frame, g: Grid, x: number, y: number): [number, number] {
  return [(x + f.widthM / 2) / g.step, (f.heightM / 2 - y) / g.step];
}
