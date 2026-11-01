import { describe, expect, it } from "vitest";
import { frameProjection, makeFrame } from "../src/lib/core/area";
import {
  networkData,
  overpassNetworkQuery,
  parseNetwork,
  planNetwork,
  resample,
  userRail,
  type NetworkWay,
} from "../src/lib/core/network";

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
    // Every running line, crossovers and untagged pieces included; no yards, sidings, spurs.
    const q = overpassNetworkQuery({ west: 4, south: 45, east: 5, north: 46 });
    expect(q).toContain('["usage"!~"^(tourism|military|industrial|test)$"]["service"!~"^(yard|siding|spur)$"]');
  });

  it("links each town to 1 or 2 others along the real roads, never a full mesh", () => {
    // Five towns on a line along one road, 1.5 km apart.
    const xs = [-3000, -1500, 0, 1500, 3000];
    const road = way("road", "primary", xs.map((x) => [x, 0] as [number, number]));
    const towns = xs.map((x, k) => ({ name: `T${k}`, x, y: 0 }));
    const plan = planNetwork(f, [road], towns);
    const town = plan.links.filter((l) => l.kind === "town");
    // Neighbours only: T0–T1, T1–T2, T2–T3, T3–T4.
    expect(town.map((l) => `${l.a}-${l.b}`).sort()).toEqual(["T0-T1", "T1-T2", "T2-T3", "T3-T4"]);
    expect(town.every((l) => l.real)).toBe(true);
    const deg = new Map<string, number>();
    for (const l of town) for (const n of [l.a, l.b]) deg.set(n, (deg.get(n) ?? 0) + 1);
    for (const t of towns) expect(deg.get(t.name)).toBeGreaterThanOrEqual(1);
    for (const t of towns) expect(deg.get(t.name)).toBeLessThanOrEqual(2);
  });

  it("writes only the town pairs left in, and the rail lines", () => {
    const road = way("road", "secondary", [[-2000, 1000], [0, 1000], [2000, 1000]]);
    const towns = [{ name: "A", x: -2000, y: 1000 }, { name: "B", x: 2000, y: 1000 }];
    const plan = planNetwork(f, [road], towns);
    expect(networkData(plan, {}).connections).toEqual([{ a: "A", b: "B" }]);
    const key = plan.links[0].key;
    // Removed by hand: still listed (to add it back), not written.
    const off = planNetwork(f, [road], towns, { [key]: false });
    expect(off.links.map((l) => l.key)).toContain(key);
    expect(networkData(off, { [key]: false }).connections).toEqual([]);
  });

  it("keeps the longest real main line, resampled inside the map", () => {
    const rail = way("rail", "main", [[-6000, -500], [0, -400], [6000, -300]]);
    const spur = way("rail", "main", [[3000, 3000], [3500, 3000]]);
    const plan = planNetwork(f, [rail, spur], []);
    expect(plan.rail).toHaveLength(1);
    const pts = plan.rail[0].pts;
    for (const [x, y] of pts) {
      expect(Math.abs(x)).toBeLessThanOrEqual(f.widthM / 2);
      expect(Math.abs(y)).toBeLessThanOrEqual(f.heightM / 2);
    }
    for (let i = 1; i < pts.length - 1; i++) expect(Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1])).toBeCloseTo(50, 0);
  });

  it("resamples a polyline", () => {
    expect(resample([[0, 0], [1000, 0]], 250).map(([x]) => x)).toEqual([0, 250, 500, 750, 1000]);
  });

  it("builds a road added by hand first, even through a town", () => {
    const xs = [-3000, 0, 3000];
    const road = way("road", "primary", xs.map((x) => [x, 5000] as [number, number]));
    const towns = xs.map((x, k) => ({ name: `U${k}`, x, y: 5000 }));
    const auto = planNetwork(f, [road], towns);
    expect(auto.links.map((l) => `${l.a}-${l.b}`)).not.toContain("U0-U2");
    const forced = planNetwork(f, [road], towns, { "town:U0|U2": true });
    expect(forced.links.map((l) => `${l.a}-${l.b}`)).toContain("U0-U2");
  });

  it("lays a railway added by hand along the real tracks, else straight", () => {
    // A real line bending north between x = -4000 and 4000.
    const track = way("rail", "main", [[-4000, -6000], [0, -4000], [4000, -6000]]);
    const from = p.toLonLat(-4000, -6100);
    const to = p.toLonLat(4000, -6100);
    const along = userRail(f, [track], { key: "rail:user:a", from, to });
    expect(along.key).toBe("rail:user:a");
    expect(Math.max(...along.pts.map(([, y]) => y))).toBeGreaterThan(-4200);
    const straight = userRail(f, [], { key: "rail:user:b", from, to });
    expect(Math.max(...straight.pts.map(([, y]) => y))).toBeLessThan(-6000);
    expect(straight.pts.length).toBeGreaterThan(100);
    // In the plan, after the main line.
    const plan = planNetwork(f, [track], [], {}, undefined, [{ key: "rail:user:a", from, to }]);
    expect(plan.rail.map((r) => r.key)).toContain("rail:user:a");
  });

  it("follows a line through an untagged crossover and across a small OSM gap", () => {
    // Two pieces of main line joined by an untagged link, then a 10 m gap before the last piece.
    const a = way("rail", "main", [[-3500, 2500], [-1000, 2500]]);
    const link = way("rail", "main", [[-1000, 2500], [-900, 2550], [-800, 2500]]);
    const b = way("rail", "main", [[-800, 2500], [1000, 2500]]);
    const c = way("rail", "main", [[1010, 2500], [3500, 2500]]);
    const plan = planNetwork(f, [a, link, b, c], []);
    expect(plan.rail).toHaveLength(1);
    const xs = plan.rail[0].pts.map(([x]) => x);
    expect(Math.min(...xs)).toBeLessThan(-3000);
    expect(Math.max(...xs)).toBeGreaterThan(3000);
  });

  it("once the roads were changed by hand, removing one never brings in another", () => {
    // Five towns on a line: auto gives the four neighbour links.
    const xs = [-3000, -1500, 0, 1500, 3000];
    const road = way("road", "primary", xs.map((x) => [x, -2000] as [number, number]));
    const towns = xs.map((x, k) => ({ name: `M${k}`, x, y: -2000 }));
    const auto = planNetwork(f, [road], towns);
    const frozen = auto.links.map((l) => l.key);
    const off = { "town:M1|M2": false, "town:M2|M3": false };
    const on = (plan: ReturnType<typeof planNetwork>, picks: Record<string, boolean>) =>
      plan.links.filter((l) => picks[l.key] !== false).map((l) => `${l.a}-${l.b}`).sort();
    // Frozen: exactly the kept links, M2 left without a road; the removed ones still listed.
    const manual = planNetwork(f, [road], towns, off, undefined, [], frozen);
    expect(on(manual, off)).toEqual(["M0-M1", "M3-M4"]);
    expect(manual.links.map((l) => l.key)).toEqual(expect.arrayContaining(["town:M1|M2", "town:M2|M3"]));
    // A town added later gets no road by itself; a road added by hand is built.
    const more = [...towns, { name: "M5", x: 4500, y: -2000 }];
    expect(on(planNetwork(f, [road], more, off, undefined, [], frozen), off)).toEqual(["M0-M1", "M3-M4"]);
    const added = { ...off, "town:M4|M5": true };
    expect(on(planNetwork(f, [road], more, added, undefined, [], frozen), added)).toEqual(["M0-M1", "M3-M4", "M4-M5"]);
  });

});
