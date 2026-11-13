import { describe, expect, it } from "vitest";
import {
  bboxAreaKm2, fetchSplit, mergeOverpass, overpassAreaQuery, overpassLimits, overpassRuntimeError, queryForBbox, splitBbox, type Bbox,
} from "../src/lib/core/osm";

// Toute la Pologne, à peu près : une zone qu'Overpass ne traite pas d'un coup.
const POLAND: Bbox = { west: 14.1, south: 49, east: 24.2, north: 54.9 };
const OOM = "runtime error: Query ran out of memory in \"query\" at line 1. It would need at least 0 MB of RAM to continue.";

describe("overpassRuntimeError", () => {
  it("spots out of memory and time out answers", () => {
    expect(overpassRuntimeError({ elements: [], remark: OOM })).toBe(OOM);
    expect(overpassRuntimeError({ elements: [], remark: "runtime error: Query timed out in \"query\" at line 1 after 181 seconds." })).toMatch(/timed out/);
  });

  it("lets a normal answer through", () => {
    expect(overpassRuntimeError({ elements: [{ type: "node", id: 1 }] })).toBeNull();
    expect(overpassRuntimeError({ elements: [], remark: "runtime remark: Timeout is not set" })).toBeNull();
    expect(overpassRuntimeError(null)).toBeNull();
  });
});

describe("splitBbox", () => {
  it("covers the box with 4 quarters", () => {
    const q = splitBbox(POLAND);
    expect(q).toHaveLength(4);
    const deg2 = (b: Bbox) => (b.east - b.west) * (b.north - b.south);
    expect(q.reduce((n, b) => n + deg2(b), 0)).toBeCloseTo(deg2(POLAND), 6);
    expect(Math.min(...q.map((b) => b.west))).toBe(POLAND.west);
    expect(Math.max(...q.map((b) => b.east))).toBe(POLAND.east);
    expect(Math.min(...q.map((b) => b.south))).toBe(POLAND.south);
    expect(Math.max(...q.map((b) => b.north))).toBe(POLAND.north);
  });
});

describe("queryForBbox", () => {
  it("moves every statement to the new box and resizes the limits", () => {
    const query = overpassAreaQuery(POLAND, ["city", "town", "village"], 1250);
    const sub = splitBbox(POLAND)[3];
    const q = queryForBbox(query, POLAND, sub);
    expect(q).not.toContain("49,14.1,54.9,24.2");
    expect(q.split(`${sub.south},${sub.west},${sub.north},${sub.east}`)).toHaveLength(query.split("49,14.1,54.9,24.2").length);
    const { timeout, maxsize } = overpassLimits(sub);
    expect(q).toContain(`[timeout:${timeout}][maxsize:${maxsize}]`);
    expect(q.replace(/\[timeout:\d+\]\[maxsize:\d+\]/, "").split(`${sub.south},${sub.west},${sub.north},${sub.east}`).join("B"))
      .toBe(query.replace(/\[timeout:\d+\]\[maxsize:\d+\]/, "").split("49,14.1,54.9,24.2").join("B"));
  });
});

describe("mergeOverpass", () => {
  it("drops the elements already seen, order kept", () => {
    const a = { elements: [{ type: "node", id: 1 }, { type: "way", id: 7 }] };
    const b = { elements: [{ type: "way", id: 7 }, { type: "node", id: 7 }, { type: "node", id: 2 }] };
    expect(mergeOverpass([a, b]).elements).toEqual([{ type: "node", id: 1 }, { type: "way", id: 7 }, { type: "node", id: 7 }, { type: "node", id: 2 }]);
  });
});

describe("fetchSplit", () => {
  /** Un faux serveur : refuse au-delà de `maxKm2`, sinon renvoie les lieux de la grille dans la zone. */
  function server(maxKm2: number) {
    const places = [] as { type: string; id: number; lon: number; lat: number }[];
    let id = 0;
    for (let lon = 14.15; lon < 24.2; lon += 0.25) for (let lat = 49.05; lat < 54.9; lat += 0.25) places.push({ type: "node", id: ++id, lon, lat });
    const calls: Bbox[] = [];
    const fetchOne = async (_q: string, b: Bbox) => {
      calls.push(b);
      if (bboxAreaKm2(b) > maxKm2) return { elements: [], remark: OOM };
      return { elements: places.filter((p) => p.lon >= b.west && p.lon <= b.east && p.lat >= b.south && p.lat <= b.north) };
    };
    return { places, calls, fetchOne };
  }
  const tooLarge = (r: string) => new Error(`too large: ${r}`);

  it("answers at once when the server copes", async () => {
    const s = server(Infinity);
    const got = await fetchSplit("q", POLAND, s.fetchOne, { tooLarge });
    expect(got.parts).toBe(1);
    expect(s.calls).toHaveLength(1);
    expect((got.json as { elements: unknown[] }).elements).toHaveLength(s.places.length);
  });

  it("splits until the pieces pass, every place once", async () => {
    const s = server(bboxAreaKm2(POLAND) / 10);
    const splits: number[] = [];
    const got = await fetchSplit(overpassAreaQuery(POLAND, ["village"]), POLAND, s.fetchOne, { tooLarge, onSplit: (_r, d) => splits.push(d) });
    expect(got.parts).toBe(16);
    expect(splits).toEqual([1, 2, 2, 2, 2]);
    const ids = (got.json as { elements: { id: number }[] }).elements.map((e) => e.id).sort((a, b) => a - b);
    expect(ids).toEqual(s.places.map((p) => p.id));
  });

  it("gives up past the deepest split", async () => {
    const s = server(0);
    await expect(fetchSplit("q", POLAND, s.fetchOne, { tooLarge, maxDepth: 2 })).rejects.toThrow(/too large: runtime error/);
  });
});

// ---- Réduction des données d'une très grande zone (1.2.3) ----
import { cropToFrame, douglasPeucker, reduceOsm, simplifyShape, simplifyTolerance, simplifyWays } from "../src/lib/core/simplify";
import { demLevel } from "../src/lib/core/dem";
import { EMODNET_MAX_PX, emodnetUrl } from "../src/lib/core/bathymetry";
import type { NetworkWay } from "../src/lib/core/network";
import type { OsmShape } from "../src/lib/core/osm";

/** Une ligne en zigzag de `n` points vers l'est, amplitude `amp` degrés. */
const zigzag = (n: number, amp = 1e-5): [number, number][] => Array.from({ length: n }, (_, i) => [19 + i * 1e-4, 52 + (i % 2 ? amp : 0)]);

describe("simplifyTolerance", () => {
  it("leaves usual maps alone", () => {
    expect(simplifyTolerance(4 * 1)).toBe(0);
    expect(simplifyTolerance(4 * 8)).toBe(0);
    expect(simplifyTolerance(4 * 84)).toBe(168);
  });
});

describe("douglasPeucker", () => {
  it("handles a million points without overflowing the stack", () => {
    const pts = zigzag(1_000_000);
    const keep = douglasPeucker(pts, 50, new Uint8Array(pts.length));
    expect(keep[0]).toBe(1);
    expect(keep[pts.length - 1]).toBe(1);
    expect(keep.reduce((n, k) => n + k, 0)).toBeLessThan(10);
  });

  it("keeps a real corner", () => {
    const pts: [number, number][] = [[19, 52], [19.01, 52], [19.01, 52.01]];
    expect([...douglasPeucker(pts, 50, new Uint8Array(3))]).toEqual([1, 1, 1]);
  });
});

describe("simplifyWays", () => {
  it("keeps nodes and points aligned, ends and junctions kept", () => {
    const a: NetworkWay = { kind: "road", cls: "primary", nodes: Array.from({ length: 101 }, (_, i) => i), pts: zigzag(101) };
    // Une seconde voie qui croise la première au nœud 50.
    const b: NetworkWay = { kind: "road", cls: "secondary", nodes: [1000, 50, 1001], pts: [[19.005, 51.99], a.pts[50], [19.005, 52.01]] };
    const [sa, sb] = simplifyWays([a, b], 100);
    expect(sa.nodes.length).toBe(sa.pts.length);
    expect(sa.nodes).toEqual([0, 50, 100]);
    expect(sa.pts[1]).toEqual(a.pts[50]);
    expect(sb.nodes).toEqual([1000, 50, 1001]);
  });
});

describe("simplifyShape", () => {
  const ring = (cx: number, cy: number, r: number, n: number): [number, number][] => {
    const pts = Array.from({ length: n }, (_, i) => [cx + r * Math.cos((2 * Math.PI * i) / n), cy + r * Math.sin((2 * Math.PI * i) / n)] as [number, number]);
    return [...pts, pts[0]];
  };

  it("keeps a lake as a valid ring, drops a pond smaller than the tolerance", () => {
    const lake: OsmShape = { kind: "polygon", tags: { natural: "water" }, rings: [ring(19, 52, 0.05, 2000)] };
    const s = simplifyShape(lake, 100)!;
    expect(s.kind === "polygon" && s.rings[0].length).toBeGreaterThanOrEqual(4);
    expect(s.kind === "polygon" && s.rings[0].length).toBeLessThan(200);
    const pond: OsmShape = { kind: "polygon", tags: { natural: "water" }, rings: [ring(19, 52, 0.0002, 40)] };
    expect(simplifyShape(pond, 100)).toBeNull();
  });
});

describe("cropToFrame / reduceOsm", () => {
  const frame = { west: 19, south: 52, east: 19.2, north: 52.2 };

  it("keeps what touches the frame, whole", () => {
    const inside = { name: "A", lon: 19.1, lat: 52.1, place: "village" };
    const outside = { name: "B", lon: 21, lat: 50, place: "village" };
    const across: OsmShape = { kind: "line", tags: { waterway: "river" }, pts: [[18.5, 52.1], [19.5, 52.1]] };
    const far: OsmShape = { kind: "line", tags: { waterway: "river" }, pts: [[22, 50], [23, 50]] };
    expect(cropToFrame([inside, outside], frame)).toEqual([inside]);
    expect(cropToFrame([across, far], frame)).toEqual([across]);
    expect(cropToFrame([{ kind: "com", west: 19.15, south: 52.15, east: 19.3, north: 52.3 }], frame)).toHaveLength(1);
  });

  it("changes nothing for a usual map whose data lies in the frame", () => {
    const l = {
      water: [{ kind: "line", tags: { waterway: "river" }, pts: zigzag(50).map(([x, y]) => [x + 0.05, y + 0.05] as [number, number]) } as OsmShape],
      places: [{ name: "A", lon: 19.1, lat: 52.1, place: "village" as const }],
      sites: [],
      roads: [],
      land: { beaches: [], business: [] },
    };
    expect(reduceOsm(l, frame, 0)).toEqual(l);
  });
});

describe("demLevel", () => {
  it("reads full resolution for usual maps, overviews for a country", () => {
    expect(demLevel(4 * 3)).toBe(0);
    expect(demLevel(12 * 8)).toBe(0);
    expect(demLevel(1010)).toBe(3);
    expect(demLevel(337)).toBe(2);
    expect(demLevel(100_000)).toBe(3);
  });
});

describe("emodnetUrl", () => {
  it("keeps the native grid for a usual area", () => {
    expect(emodnetUrl({ west: 4, south: 43, east: 5, north: 44 })).not.toContain("SCALESIZE");
  });

  it("asks a country-sized area scaled down", () => {
    const u = emodnetUrl({ west: 14, south: 49, east: 24.3, north: 55 });
    const m = u.match(/SCALESIZE=i\((\d+)\),j\((\d+)\)/)!;
    expect(+m[1] * +m[2]).toBeLessThanOrEqual(EMODNET_MAX_PX);
    expect(+m[1] / +m[2]).toBeCloseTo(10.3 / 6, 1);
  });
});
