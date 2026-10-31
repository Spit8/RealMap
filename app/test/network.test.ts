import { describe, expect, it } from "vitest";
import { frameProjection, makeFrame } from "../src/lib/core/area";
import { networkData, overpassNetworkQuery, parseNetwork, planNetwork, resample, type NetworkWay } from "../src/lib/core/network";

const f = makeFrame({ lon: 4.8357, lat: 45.764, size: 1, format: 0, landscape: false, scale: 1, verticalScale: null });
const p = frameProjection(f);
let nextId = 1;
/** A way through game-metre points (ids shared when points coincide). */
const ids = new Map<string, number>();
function way(kind: "road" | "rail", cls: string, pts: [number, number][]): NetworkWay {
  return {
    kind,
    cls,
    nodes: pts.map(([x, y]) => {
      const k = `${x},${y}`;
      if (!ids.has(k)) ids.set(k, nextId++);
      return ids.get(k)!;
    }),
    pts: pts.map(([x, y]) => p.toLonLat(x, y)),
  };
}

describe("network", () => {
  it("parses roads and railways from Overpass", () => {
    const json: { elements: { type: string; nodes: number[]; geometry: { lat: number; lon: number }[]; tags: Record<string, string> }[] } = {
      elements: [
        { type: "way", nodes: [1, 2], geometry: [{ lat: 45, lon: 4 }, { lat: 45.1, lon: 4.1 }], tags: { highway: "primary", ref: "D 7" } },
        { type: "way", nodes: [3, 4], geometry: [{ lat: 45, lon: 4 }, { lat: 45.1, lon: 4.2 }], tags: { railway: "rail", usage: "main" } },
      ],
    };
    const w = parseNetwork(json);
    expect(w.map((x) => [x.kind, x.cls, x.name])).toEqual([["road", "primary", "D 7"], ["rail", "main", undefined]]);
    expect(overpassNetworkQuery({ west: 4, south: 45, east: 5, north: 46 })).toContain('way["railway"="rail"]["usage"~"^(main|branch)$"]');
  });

  it("links each town to 1 or 2 others along the real roads, never a full mesh", () => {
    // Five towns on a line along one road, 1.5 km apart.
    const xs = [-3000, -1500, 0, 1500, 3000];
    const road = way("road", "primary", xs.map((x) => [x, 0] as [number, number]));
    const towns = xs.map((x, k) => ({ name: `T${k}`, x, y: 0 }));
    const plan = planNetwork(f, [road], towns, []);
    const town = plan.links.filter((l) => l.kind === "town");
    // Neighbours only: T0–T1, T1–T2, T2–T3, T3–T4.
    expect(town.map((l) => `${l.a}-${l.b}`).sort()).toEqual(["T0-T1", "T1-T2", "T2-T3", "T3-T4"]);
    expect(town.every((l) => l.real)).toBe(true);
    const deg = new Map<string, number>();
    for (const l of town) for (const n of [l.a, l.b]) deg.set(n, (deg.get(n) ?? 0) + 1);
    for (const t of towns) expect(deg.get(t.name)).toBeGreaterThanOrEqual(1);
    for (const t of towns) expect(deg.get(t.name)).toBeLessThanOrEqual(2);
  });

  it("links each town to at most one industry, within reach; a removed link is not replaced", () => {
    const road = way("road", "secondary", [[-2000, 1000], [0, 1000], [2000, 1000]]);
    const towns = [{ name: "A", x: -2000, y: 1000 }, { name: "B", x: 2000, y: 1000 }];
    const inds = [
      { key: "q", tag: "quarry", name: "Carrière de A", x: -1500, y: 1000, onWater: false },
      { key: "f", tag: "farm", name: "Ferme de A", x: -1800, y: 1200, onWater: false },
      { key: "w", tag: "fishing_grounds", name: "Pêche", x: 2100, y: 1000, onWater: true },
    ];
    const plan = planNetwork(f, [road], towns, inds);
    const ind = plan.links.filter((l) => l.kind === "industry");
    expect(ind.filter((l) => l.a === "A")).toHaveLength(1);
    expect(ind.some((l) => l.tag === "fishing_grounds")).toBe(false);
    const key = ind.find((l) => l.a === "A")!.key;
    const without = networkData(planNetwork(f, [road], towns, inds, { [key]: false }), { [key]: false });
    expect(without.industryLinks.filter((l) => l.town === "A")).toHaveLength(0);
  });

  it("keeps the longest real main line, resampled inside the map", () => {
    const rail = way("rail", "main", [[-6000, -500], [0, -400], [6000, -300]]);
    const spur = way("rail", "main", [[3000, 3000], [3500, 3000]]);
    const plan = planNetwork(f, [rail, spur], [], []);
    expect(plan.rail).toHaveLength(1);
    const pts = plan.rail[0].pts;
    for (const [x, y] of pts) {
      expect(Math.abs(x)).toBeLessThanOrEqual(f.widthM / 2);
      expect(Math.abs(y)).toBeLessThanOrEqual(f.heightM / 2);
    }
    for (let i = 1; i < pts.length - 1; i++) expect(Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1])).toBeCloseTo(250, 0);
  });

  it("resamples a polyline", () => {
    expect(resample([[0, 0], [1000, 0]], 250).map(([x]) => x)).toEqual([0, 250, 500, 750, 1000]);
  });
});
