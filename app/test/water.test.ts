import { describe, expect, it } from "vitest";
import type { Grid } from "../src/lib/core/grid";
import { maxFilter } from "../src/lib/core/raster";
import {
  bridgeWater, composeTerrain, DEFAULT_TERRAIN, enforceMinWidth, marshLakes, WATER_LAKE, WATER_NONE, WATER_RIVER,
} from "../src/lib/core/terrain";

/** A 4 m grid of 120 × 80 cells (only `nx`, `ny`, `step` matter here). */
const g: Grid = { nx: 120, ny: 80, step: 4 };
const n = g.nx * g.ny;
const opts = { ...DEFAULT_TERRAIN, verticalScale: 1, smoothM: 0 };

/** River cells in columns [c0, c1] of every row between r0 and r1. */
function band(mask: Uint8Array, c0: number, c1: number, r0 = 0, r1 = g.ny - 1, v = WATER_RIVER): void {
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) mask[r * g.nx + c] = v;
}

const flat = () => new Float32Array(n).fill(20);

describe("water passes", () => {
  it("joins two rivers 40 m apart, not two rivers 200 m apart", () => {
    const near = new Uint8Array(n);
    band(near, 20, 27); // 32 m wide
    band(near, 38, 45); // 10 cells = 40 m of land between them
    expect(bridgeWater(near, g, flat(), 64, 32, 10)).toBe(1);
    const far = new Uint8Array(n);
    band(far, 10, 17);
    band(far, 68, 75); // 200 m apart
    expect(bridgeWater(far, g, flat(), 64, 32, 10)).toBe(0);
  });

  it("leaves small ponds next to a river alone", () => {
    const mask = new Uint8Array(n);
    band(mask, 20, 27);
    band(mask, 32, 34, 30, 32, WATER_LAKE); // a 9-cell pond 16 m away
    expect(bridgeWater(mask, g, flat(), 64, 32, 100)).toBe(0);
    expect(bridgeWater(mask, g, flat(), 64, 32, 5)).toBe(1);
  });

  it("widens river parts narrower than the minimum width", () => {
    const mask = new Uint8Array(n);
    band(mask, 50, 51); // 8 m wide
    expect(enforceMinWidth(mask, g, 32)).toBeGreaterThan(0);
    // Each row is now at least 7 cells (≈ 28–32 m) of river.
    for (let r = 2; r < g.ny - 2; r++) {
      let k = 0;
      for (let c = 0; c < g.nx; c++) if (mask[r * g.nx + c] === WATER_RIVER) k++;
      expect(k).toBeGreaterThanOrEqual(7);
    }
    const wide = new Uint8Array(n);
    band(wide, 50, 61);
    expect(enforceMinWidth(wide, g, 32)).toBe(0);
  });

  it("turns marshes of at least the minimum area into lakes", () => {
    const mask = new Uint8Array(n);
    const wet = new Uint8Array(n);
    band(wet, 10, 40, 10, 40, 1); // 31 × 31 cells ≈ 1.5 ha
    band(wet, 80, 82, 10, 12, 1); // 9 cells
    const m = marshLakes(mask, g, wet, 200);
    expect(m.count).toBe(1);
    expect(mask[20 * g.nx + 20]).toBe(WATER_LAKE);
    expect(mask[11 * g.nx + 81]).toBe(WATER_NONE);
  });

  it("square max filter", () => {
    const src = new Float32Array(n);
    src[40 * g.nx + 60] = 5;
    const out = maxFilter(src, g.nx, g.ny, 3);
    expect(out[43 * g.nx + 63]).toBe(5);
    expect(out[44 * g.nx + 60]).toBe(0);
  });

  it("rivers follow the game's cross-section; a narrow one still reaches 70 % in the middle (FACT-023)", () => {
    const real = new Float32Array(n).fill(30);
    const osm = new Uint8Array(n);
    band(osm, 56, 63);
    for (let r = 0; r < g.ny; r++) for (let c = 56; c <= 63; c++) real[r * g.nx + c] = 10;
    const t = composeTerrain(real, g, osm, opts);
    const row = 40 * g.nx;
    expect(Math.min(t.game[row + 59], t.game[row + 60])).toBeLessThanOrEqual(-opts.riverDepth * 0.7 + 1e-4);
    // A 128 m wide river: flat bed at full depth from ~48 m, about −6 m at 32 m from the bank.
    const wide = new Uint8Array(n);
    band(wide, 30, 61);
    const w = composeTerrain(real, g, wide, opts);
    expect(w.game[row + 45]).toBeCloseTo(-opts.riverDepth, 4);
    expect(w.game[row + 38]).toBeLessThan(-5);
    expect(w.game[row + 38]).toBeGreaterThan(-opts.riverDepth);
    // Shallow at the bank, deeper towards the middle, no step bigger than the shore one.
    expect(t.game[row + 56]).toBeGreaterThan(-2);
    expect(t.game[row + 55]).toBeGreaterThanOrEqual(opts.landMin);
    expect(t.game[row + 55]).toBeLessThan(2);
  });

  it("digs the sea at a river mouth", () => {
    // Sea (real −2) in the west quarter, a river reaching it along row 40.
    const real = new Float32Array(n).fill(10);
    const osm = new Uint8Array(n);
    for (let r = 0; r < g.ny; r++) for (let c = 0; c < 30; c++) real[r * g.nx + c] = -2;
    band(osm, 30, g.nx - 1, 36, 43);
    const t = composeTerrain(real, g, osm, opts);
    // Sea just off the mouth vs the same distance from the shore elsewhere.
    expect(t.game[40 * g.nx + 28]).toBeLessThan(t.game[10 * g.nx + 28] - 2);
  });
});
