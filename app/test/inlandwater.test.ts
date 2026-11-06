import { describe, expect, it } from "vitest";
import { makeFrame } from "../src/lib/core/area";
import { previewGrid } from "../src/lib/core/grid";
import type { OsmShape } from "../src/lib/core/osm";
import { buildTerrain, DEFAULT_TERRAIN, WATER_LAKE, WATER_RIVER, WATER_SEA, type TerrainSources } from "../src/lib/core/terrain";

/** A valley rising from west to east, crossed by a river, with a lake: the « Rivers and lakes » option. */
describe("inland water option", () => {
  const f = makeFrame({ lon: 6.0, lat: 45.2, size: 0, format: 0, landscape: false, scale: 3, verticalScale: null });
  const g = previewGrid(f, 160);
  const n = g.nx * g.ny;
  const ign = new Float32Array(n);
  for (let r = 0; r < g.ny; r++) for (let c = 0; c < g.nx; c++) ign[r * g.nx + c] = 200 + (c / g.nx) * 300;
  const shapes: OsmShape[] = [
    { kind: "line", tags: { waterway: "river", name: "Test" }, pts: [[5.98, 45.19], [6.02, 45.21]] },
    { kind: "polygon", tags: { natural: "water", water: "river" }, rings: [[[5.995, 45.195], [6.0, 45.195], [6.0, 45.2], [5.995, 45.2], [5.995, 45.195]]] },
    { kind: "polygon", tags: { natural: "water" }, rings: [[[6.005, 45.19], [6.012, 45.19], [6.012, 45.195], [6.005, 45.195], [6.005, 45.19]]] },
  ] as OsmShape[];
  const src: TerrainSources = { ign, rasters: [], bathy: [], forest: null, wetland: null, shapes };
  const opts = { ...DEFAULT_TERRAIN, verticalScale: 1, smoothM: 0 };
  const count = (water: Uint8Array, k: number) => water.reduce((s, w) => s + (w === k ? 1 : 0), 0);

  it("carves rivers and lakes when on", () => {
    const t = buildTerrain(f, g, src, opts).terrain;
    expect(count(t.water, WATER_RIVER)).toBeGreaterThan(0);
    expect(t.minM).toBeLessThan(0);
  });

  it("keeps the real relief everywhere when off: no river, no lake, no lowered valley", () => {
    const b = buildTerrain(f, g, src, { ...opts, inlandWater: false });
    const t = b.terrain;
    expect(count(t.water, WATER_RIVER) + count(t.water, WATER_LAKE)).toBe(0);
    expect(b.riverPieces).toBe(0);
    for (let i = 0; i < n; i++) expect(t.game[i]).toBeCloseTo(Math.max(opts.landMin, ign[i] - t.refHeight), 3);
  });

  it("keeps the sea when off", () => {
    const sea = Float32Array.from(ign);
    for (let r = 0; r < g.ny; r++) for (let c = 0; c < 10; c++) sea[r * g.nx + c] = -5;
    const t = buildTerrain(f, g, { ...src, ign: sea }, { ...opts, inlandWater: false }).terrain;
    expect(count(t.water, WATER_SEA)).toBeGreaterThan(0);
    expect(count(t.water, WATER_RIVER) + count(t.water, WATER_LAKE)).toBe(0);
  });
});
