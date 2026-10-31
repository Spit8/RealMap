/**
 * TF3 heightmap file: 16-bit grayscale PNG of (tiles·64+1)² samples, values stretched to
 * 0…65535; the game heights in metres are typed in the Map Editor's Minimum / Maximum Height on
 * import (FACT-001, FACT-006). Row 0 is the north edge (`core/grid.ts`, QUESTION-004).
 */
import { encode } from "fast-png";

export interface Normalized {
  data: Uint16Array;
  minM: number;
  maxM: number;
}

/**
 * Stretch heights to 0…65535 like the game's own export. The Map Editor only takes whole metres
 * for Minimum / Maximum Height, so the range is widened to whole metres (floor / ceil) and the
 * image is stretched over that range: the typed integers then give back the exact heights.
 */
export function normalize16(heights: Float32Array): Normalized {
  let lo = Infinity;
  let hi = -Infinity;
  for (const z of heights) {
    if (z < lo) lo = z;
    if (z > hi) hi = z;
  }
  const minM = Math.floor(lo);
  const maxM = Math.max(minM + 1, Math.ceil(hi));
  const data = new Uint16Array(heights.length);
  const k = 65535 / (maxM - minM);
  for (let i = 0; i < heights.length; i++) data[i] = Math.round((heights[i] - minM) * k);
  return { data, minM, maxM };
}

export function encodeHeightmapPng(width: number, height: number, data: Uint16Array): Uint8Array {
  return encode({ width, height, data, depth: 16, channels: 1 });
}

/** 8-bit grayscale PNG (biome maps). */
export function encodeGray8Png(width: number, height: number, data: Uint8Array): Uint8Array {
  return encode({ width, height, data, depth: 8, channels: 1 });
}
