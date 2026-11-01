import { describe, expect, it } from "vitest";
import { makeFrame } from "../src/lib/core/area";
import { cellToWorld, previewGrid } from "../src/lib/core/grid";
import { resample } from "../src/lib/core/network";
import { alignHorizontal, circumradius, DEFAULT_RAIL, designRail, gameGrade, profile, structures, townZones } from "../src/lib/core/railway";

const f = makeFrame({ lon: 4.8357, lat: 45.764, size: 3, format: 0, landscape: false, scale: 1, verticalScale: null });
const g = previewGrid(f, 512);
const n = g.nx * g.ny;
/** Flat ground at 20 m, optional extra height and water from (x, y). */
function ground(height?: (x: number, y: number) => number, wet?: (x: number, y: number) => boolean) {
  const game = new Float32Array(n).fill(20);
  const water = new Uint8Array(n);
  for (let r = 0; r < g.ny; r++) for (let c = 0; c < g.nx; c++) {
    const [x, y] = cellToWorld(f, g, c, r);
    if (height) game[r * g.nx + c] = 20 + height(x, y);
    if (wet?.(x, y)) {
      water[r * g.nx + c] = 3;
      game[r * g.nx + c] = -5;
    }
  }
  return { game, water };
}
const minR = (pts: [number, number][]) => {
  let m = Infinity;
  for (let i = 1; i < pts.length - 1; i++) m = Math.min(m, circumradius(pts[i - 1], pts[i], pts[i + 1]));
  return m;
};

describe("railway alignment", () => {
  it("opens every curve up to the minimum radius", () => {
    // A zigzag: 90° corners every 1 km.
    const guide: [number, number][] = [[-5000, 0], [-4000, 0], [-4000, 1000], [-3000, 1000], [-3000, 0], [-2000, 0], [-2000, 1000], [0, 1000], [5000, 1000]];
    expect(minR(resample(guide, 50))).toBeLessThan(DEFAULT_RAIL.minRadiusM);
    const pts = alignHorizontal(guide, [], DEFAULT_RAIL);
    expect(minR(pts)).toBeGreaterThanOrEqual(DEFAULT_RAIL.minRadiusM * 0.95);
    expect(pts[0]).toEqual([-5000, 0]);
  });

  it("keeps away from a town the guide goes through", () => {
    const town = { x: 0, y: 0, capacity: 400 };
    const pts = alignHorizontal([[-5000, 0], [5000, 0]], [town], DEFAULT_RAIL);
    const need = DEFAULT_RAIL.townClearanceM + 0.5 * town.capacity;
    for (const [x, y] of pts) expect(Math.hypot(x, y)).toBeGreaterThanOrEqual(need * 0.95);
    expect(minR(pts)).toBeGreaterThanOrEqual(DEFAULT_RAIL.minRadiusM * 0.95);
  });

  it("merges overlapping towns, leaves out a conurbation and a town at an end", () => {
    const ends: [number, number][] = [[-5000, 0], [5000, 0]];
    const pair = townZones([{ x: -200, y: 0, capacity: 100 }, { x: 200, y: 0, capacity: 100 }], ends, DEFAULT_RAIL);
    expect(pair).toHaveLength(1);
    expect(pair[0].r).toBeCloseTo(500, 6);
    const city = Array.from({ length: 8 }, (_, k) => ({ x: -1400 + k * 400, y: 0, capacity: 400 }));
    expect(townZones(city, ends, DEFAULT_RAIL)).toHaveLength(0);
    expect(townZones([{ x: 4900, y: 0, capacity: 100 }], ends, DEFAULT_RAIL)).toHaveLength(0);
    // Many towns along the guide: still a line, no longer than twice the guide.
    const guide = resample([[-6000, 0], [6000, 0]], 50);
    const many = Array.from({ length: 60 }, (_, k) => ({ x: -5500 + k * 190, y: (k % 3) * 80, capacity: 300 }));
    const pts = alignHorizontal(guide, many, DEFAULT_RAIL);
    let len = 0;
    for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    expect(len).toBeLessThan(2 * 12000 + 100);
  });

  it("goes round towns once, without winding or folding back", () => {
    // A wavy guide through a row of towns, off their centres on alternate sides.
    const guide = resample(Array.from({ length: 41 }, (_, k) => [-10000 + k * 500, Math.sin(k / 3) * 400] as [number, number]), 50);
    const towns = [-6000, -3000, 0, 3000, 6000].map((x, k) => ({ x, y: (k % 2 ? 150 : -150) + Math.sin(x / 1500) * 400, capacity: 300 }));
    const pts = alignHorizontal(guide, towns, DEFAULT_RAIL);
    let turn = 0;
    for (let i = 1; i + 1 < pts.length; i++) {
      const a1 = Math.atan2(pts[i][1] - pts[i - 1][1], pts[i][0] - pts[i - 1][0]);
      const a2 = Math.atan2(pts[i + 1][1] - pts[i][1], pts[i + 1][0] - pts[i][0]);
      const d = Math.abs(Math.atan2(Math.sin(a2 - a1), Math.cos(a2 - a1)));
      expect(d).toBeLessThan(Math.PI / 4);
      turn += d;
    }
    // Each town costs at most a half turn out and back: never a loop round it.
    expect(turn).toBeLessThan(Math.PI * (1 + towns.length));
    for (const t of towns) for (const p of pts) expect(Math.hypot(p[0] - t.x, p[1] - t.y)).toBeGreaterThan(0.95 * (250 + 150));
    for (let i = 1; i < pts.length; i++) expect(pts[i][0]).toBeGreaterThan(pts[i - 1][0] - 1);
  });

  it("climbs a hill at most at the maximum grade, through a tunnel when the cut is too deep", () => {
    const n = 120;
    const hill = Array.from({ length: n }, (_, i) => 20 + 120 * Math.exp(-(((i - 60) * 50) ** 2) / (2 * 600 ** 2)));
    const wet = hill.map(() => false);
    const z = profile(hill, wet, 50, 0.025);
    for (let i = 1; i < n; i++) expect(Math.abs(z[i] - z[i - 1])).toBeLessThanOrEqual(0.025 * 50 + 1e-6);
    expect(structures(hill, z, wet, 50)).toContain("t");
  });

  it("bridges a river, splits on a sea crossing, tangents continuous", () => {
    const river = ground(undefined, (x) => Math.abs(x) < 60);
    const [line] = designRail(f, g, river, [[-6000, 2000], [6000, 2000]], []);
    expect(line.bridges).toBe(1);
    expect(line.nodes.filter((p) => Math.abs(p.x) < 60).some((p) => p.kind === "b")).toBe(true);
    expect(Math.min(...line.nodes.filter((p) => Math.abs(p.x) < 60).map((p) => p.z))).toBeGreaterThanOrEqual(8 - 1e-6);
    // Unit tangents, changing smoothly from node to node.
    for (let i = 1; i < line.nodes.length; i++) {
      const a = line.nodes[i - 1];
      const b = line.nodes[i];
      expect(Math.hypot(b.tx, b.ty, b.tz)).toBeCloseTo(1, 6);
      expect(a.tx * b.tx + a.ty * b.ty + a.tz * b.tz).toBeGreaterThan(0.9);
    }
    const sea = ground(undefined, (x) => x > -1500 && x < 1700);
    expect(designRail(f, g, sea, [[-6000, 2000], [6000, 2000]], [])).toHaveLength(2);
  });

  it("goes down from a plateau into a valley without a tall viaduct, in both directions", () => {
    // Plateau at 80 m, a 1.2 km slope down to a valley at 20 m, then a plateau again.
    const n = 160;
    const g0 = Array.from({ length: n }, (_, i) => {
      const x = i * 50;
      return x < 2000 ? 80 : x < 3200 ? 80 - (60 * (x - 2000)) / 1200 : x < 5000 ? 20 : x < 6200 ? 20 + (60 * (x - 5000)) / 1200 : 80;
    });
    const wet = g0.map(() => false);
    for (const ground of [g0, [...g0].reverse()]) {
      const z = profile(ground, wet, 50, 0.04);
      for (let i = 1; i < n; i++) expect(Math.abs(z[i] - z[i - 1])).toBeLessThanOrEqual(0.04 * 50 + 1e-6);
      for (let i = 0; i < n; i++) expect(z[i] - ground[i]).toBeLessThan(30);
    }
    const a = profile(g0, wet, 50, 0.04);
    const b = profile([...g0].reverse(), wet, 50, 0.04).reverse();
    for (let i = 0; i < n; i++) expect(Math.abs(a[i] - b[i])).toBeLessThanOrEqual(1);
  });

  it("keeps the deck above water and converts a real grade into the game's", () => {
    const groundW = Array.from({ length: 40 }, (_, i) => (i >= 18 && i <= 21 ? -5 : 2));
    const wetW = groundW.map((h) => h < 0);
    const z = profile(groundW, wetW, 50, 0.04);
    for (let i = 18; i <= 21; i++) expect(z[i]).toBeGreaterThanOrEqual(8);
    expect(gameGrade(0.025, 3, 1 / Math.sqrt(3))).toBeCloseTo(0.025 * Math.sqrt(3), 6);
    expect(gameGrade(0.05, 4, 1)).toBe(0.08);
  });
});

describe("railway corridor", () => {
  const wetRuns = (d: { nodes: { x: number; y: number }[] }, wet: (x: number, y: number) => boolean) => {
    let k = 0;
    let prev = false;
    for (const [x, y] of resample(d.nodes.map((p) => [p.x, p.y] as [number, number]), 20)) {
      const w = wet(x, y);
      if (w && !prev) k++;
      prev = w;
    }
    return k;
  };

  it("keeps to one bank of a meandering river the real line crosses again and again", () => {
    // River winding 300 m either side of y = 0; the real line runs straight along y = 0.
    const river = (x: number, y: number) => Math.abs(y - 300 * Math.sin(x / 1500)) < 40;
    const t = ground(undefined, river);
    const guide: [number, number][] = [[-5000, -600], [-4500, 0], [4500, 0], [5000, -600]];
    const real = designRail(f, g, t, guide, [], { ...DEFAULT_RAIL, corridorM: 0 });
    const bank = designRail(f, g, t, guide, [], DEFAULT_RAIL);
    const sum = (ds: typeof real) => ds.reduce((n, d) => n + wetRuns(d, river), 0);
    expect(sum(real)).toBeGreaterThanOrEqual(2);
    expect(sum(bank)).toBe(0);
    // Ends unchanged, never more than the corridor away from the real line.
    expect(bank[0].nodes[0]).toMatchObject({ x: -5000, y: -600 });
    for (const p of bank[0].nodes) expect(Math.abs(p.y)).toBeLessThanOrEqual(DEFAULT_RAIL.corridorM + 650);
  });

  it("still crosses a river that cannot be avoided, once", () => {
    const river = (x: number) => Math.abs(x) < 40;
    const t = ground(undefined, (x) => river(x));
    const d = designRail(f, g, t, [[-5000, 0], [5000, 0]], [], DEFAULT_RAIL);
    expect(d).toHaveLength(1);
    expect(wetRuns(d[0], (x) => river(x))).toBe(1);
    expect(d[0].bridges).toBe(1);
  });
});

