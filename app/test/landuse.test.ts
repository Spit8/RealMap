import { describe, expect, it } from "vitest";
import { makeFrame } from "../src/lib/core/area";
import { COVER_FOREST, COVER_OPEN, COVER_ROCK, COVER_SCRUB } from "../src/lib/core/biomes";
import { previewGrid } from "../src/lib/core/grid";
import { businessAround, clearBeaches, DEFAULT_SHARES, parseLandUse, townShares } from "../src/lib/core/landuse";
import { availableGoods, drawGoods, seededRandom, startGoods, townNeeds } from "../src/lib/core/townneeds";
import { WATER_RIVER, WATER_SEA } from "../src/lib/core/terrain";

const f = makeFrame({ lon: -1.6, lat: 49.6, size: 0, format: 0, landscape: false, scale: 1, verticalScale: null });
const g = previewGrid(f, 40);

describe("beaches", () => {
  it("turns sandy shore cells into open land, not inland rock nor river banks", () => {
    const n = g.nx * g.ny;
    const water = new Uint8Array(n);
    const game = new Float32Array(n).fill(2);
    const cover = new Uint8Array(n).fill(COVER_ROCK);
    const codes = new Uint8Array(n).fill(60);
    // Sea in the first column, a river in the last one.
    for (let r = 0; r < g.ny; r++) {
      water[r * g.nx] = WATER_SEA;
      water[r * g.nx + g.nx - 1] = WATER_RIVER;
    }
    const changed = clearBeaches(cover, codes, null, game, water, g);
    expect(changed).toBeGreaterThan(0);
    expect(cover[5 * g.nx + 1]).toBe(COVER_OPEN);
    // Far from the sea (and next to the river only): still rock.
    expect(cover[5 * g.nx + g.nx - 2]).toBe(COVER_ROCK);
    // An OSM beach anywhere, even forest, becomes open.
    const beach = new Uint8Array(n);
    beach[5 * g.nx + 20] = 1;
    cover[5 * g.nx + 20] = COVER_FOREST;
    clearBeaches(cover, null, beach, game, water, g);
    expect(cover[5 * g.nx + 20]).toBe(COVER_OPEN);
    expect(cover[5 * g.nx + 21]).not.toBe(COVER_SCRUB);
  });

  it("parses beaches with geometry and business areas from bounds", () => {
    const land = parseLandUse({
      elements: [
        { type: "way", tags: { natural: "beach" }, geometry: [{ lat: 0, lon: 0 }, { lat: 0, lon: 1 }, { lat: 1, lon: 1 }, { lat: 0, lon: 0 }] },
        { type: "way", tags: { landuse: "retail" }, bounds: { minlat: 1, minlon: 2, maxlat: 1.01, maxlon: 2.01 } },
        { type: "way", tags: { landuse: "industrial" }, bounds: { minlat: 1, minlon: 2, maxlat: 1.01, maxlon: 2.01 } },
      ],
    });
    expect(land.beaches).toHaveLength(1);
    expect(land.business.map((b) => b.kind)).toEqual(["com", "ind"]);
  });
});

describe("town shares and needs", () => {
  it("shares from real areas, within bounds, default without data", () => {
    expect(townShares([{ com: 0, ind: 0, built: 1e6 }])).toEqual([DEFAULT_SHARES]);
    // ~0.6 km² of industry within 3 km, none further.
    const ind = { kind: "ind" as const, west: 4.8, south: 45.7, east: 4.8 + 0.013, north: 45.7 + 0.009 };
    const near = businessAround(4.8, 45.7, 3000, [ind]);
    expect(near.ind).toBeGreaterThan(5e5);
    expect(businessAround(5.0, 45.7, 3000, [ind]).ind).toBe(0);
    // Twice the average industry → twice the usual industrial share; no commerce → the floor.
    const [a, b, c] = townShares([
      { com: 1e5, ind: 4e5, built: 2e6 },
      { com: 2e5, ind: 1e5, built: 2e6 },
      { com: 0, ind: 0, built: 2e6 },
    ]);
    expect(a.real && b.real && !c.real).toBe(true);
    expect(a.ind).toBeCloseTo(0.2 * (0.2 / 0.125), 2);
    expect(a.com).toBeCloseTo(0.2, 2);
    // Housing never under 40 %.
    const [busy] = townShares([{ com: 9, ind: 9, built: 10 }, { com: 1, ind: 1, built: 10 }]);
    expect(busy.res).toBeGreaterThanOrEqual(0.4 - 1e-9);
    expect(c).toEqual(DEFAULT_SHARES);
    const [low] = townShares([{ com: 0, ind: 1, built: 10 }, { com: 5, ind: 1, built: 10 }]);
    expect(low.com).toBe(0.1);
    for (const s of [a, b, low]) expect(s.res + s.com + s.ind).toBeCloseTo(1, 2);
  });

  it("draws at random, never near the good's factory", () => {
    const industries = [
      { tag: "forest", x: 0, y: 0 },
      { tag: "saw_mill", x: 0, y: 0 },
      { tag: "farm", x: 10000, y: 0 },
    ];
    const com = availableGoods(industries, "temperate", ["vegetables", "meat", "clothes"]);
    expect(com.map((g) => g.cargo)).toEqual(["vegetables"]);
    // A town next to the only farm gets no vegetables (the game draws its own need).
    const towns = [{ x: 500, y: 0, capacity: 50 }, { x: 9000, y: 0, capacity: 50 }, { x: 5000, y: 0, capacity: 50 }];
    expect(drawGoods(towns, com, seededRandom("a"))).toEqual([["vegetables"], [], ["vegetables"]]);
    // Several goods, many towns: varied, the same for the same seed, none near its producer.
    const goods = ["fish", "meat", "vegetables"].map((cargo, k) => ({ cargo, at: [{ tag: cargo, x: k * 20000 - 20000, y: 30000 }] }));
    const many = Array.from({ length: 60 }, (_, i) => ({ x: (i % 10) * 4000 - 20000, y: Math.floor(i / 10) * 4000 - 10000, capacity: 100 }));
    const a = drawGoods(many, goods, seededRandom("map"));
    expect(drawGoods(many, goods, seededRandom("map"))).toEqual(a);
    const per = (c: string) => a.filter((x) => x[0] === c).length;
    for (const c of ["fish", "meat", "vegetables"]) {
      expect(per(c)).toBeGreaterThan(5);
      expect(per(c)).toBeLessThan(0.6 * many.length);
    }
    // A new town: tier 0 only (no beverages, furniture, machines), fish only when made on the map.
    expect(startGoods([{ cargo: "beverages" }, { cargo: "meat" }, { cargo: "vehicles" }, { cargo: "furniture" }]).map((g) => g.cargo)).toEqual(["meat"]);
    expect(startGoods([{ cargo: "fish", at: [] }, { cargo: "fish", at: [{ tag: "fishing_grounds", x: 0, y: 0 }] }]).length).toBe(1);
    const needs = townNeeds(towns, industries, "temperate", "s");
    expect(needs.every((x) => x.com.length === 1 && x.ind.length === 1)).toBe(true);
    // Next to the saw mill: never planks (its producer), another good instead.
    expect(needs[0].ind).not.toEqual(["planks"]);
  });

  it("draws among the tier 0 goods of the economy, like a new game, those made on the map preferred", () => {
    // Lyon case: only the refinery chain is complete; the towns did all ask for fuel.
    const industries = [{ tag: "oil_platform", x: 0, y: 40000 }, { tag: "oil_refinery", x: 0, y: 30000 }];
    const towns = Array.from({ length: 40 }, (_, i) => ({ x: (i % 8) * 3000, y: Math.floor(i / 8) * 3000, capacity: 100 }));
    const needs = townNeeds(towns, industries, "temperate", "lyon");
    const ind = needs.map((n) => n.ind[0]);
    // Temperate tier 0 industrial goods: bricks, fuel, planks (no cement in this economy).
    expect(new Set(ind)).toEqual(new Set(["bricks", "fuel", "planks"]));
    // Spread like the game (its balance dominates the light preference for fuel, made here).
    for (const c of ["bricks", "fuel", "planks"]) {
      const k = ind.filter((x) => x === c).length;
      expect(k).toBeGreaterThan(0.2 * towns.length);
      expect(k).toBeLessThan(0.5 * towns.length);
    }
    // Commercial: meat and vegetables, no fish without fishing grounds, nothing of tier 1.
    expect(new Set(needs.map((n) => n.com[0]))).toEqual(new Set(["meat", "vegetables"]));
  });
});
