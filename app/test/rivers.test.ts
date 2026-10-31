import { describe, expect, it } from "vitest";
import { drainage, repairRivers, taperedPieces, type RiverLine } from "../src/lib/core/rivers";

const nx = 60;
const ny = 40;
const opts = { joinCells: 5, taperCells: 10 };

/** Relief sloping down to the west (sea in the first columns). */
function westSlope(): { real: Float32Array; still: Uint8Array } {
  const real = new Float32Array(nx * ny);
  const still = new Uint8Array(nx * ny);
  for (let r = 0; r < ny; r++) {
    for (let c = 0; c < nx; c++) {
      real[r * nx + c] = c * 2;
      if (c < 3) still[r * nx + c] = 1;
    }
  }
  return { real, still };
}

describe("river network repair", () => {
  it("joins an end that stops just short of another river", () => {
    const { real, still } = westSlope();
    const main: RiverLine = { pts: [[50, 20], [2, 20]], half: 1 }; // reaches the sea
    const trib: RiverLine = { pts: [[30, 5], [30, 17]], half: 1 }; // stops 3 cells short
    const r = repairRivers([main, trib], nx, ny, still, real, opts);
    expect(r.joined).toBe(1);
    expect(r.routed).toBe(0);
    const join = r.extra.find((e) => e.pts[0][0] === 30)!;
    expect(join.pts[0]).toEqual([30, 17]);
    expect(join.pts[1][1]).toBeGreaterThanOrEqual(19);
  });

  it("routes a mouth far from any water downhill to the sea", () => {
    const { real, still } = westSlope();
    const lone: RiverLine = { pts: [[55, 30], [40, 30]], half: 1 };
    const r = repairRivers([lone], nx, ny, still, real, opts);
    expect(r.routed).toBe(1);
    const end = r.extra[0].pts[r.extra[0].pts.length - 1];
    expect(end[0]).toBeLessThan(4); // reached the sea (or the west edge)
    // The source end (east, higher) is tapered.
    expect(r.lines[0].taperStart).toBe(true);
    expect(r.tapered).toBe(1);
  });

  it("leaves rivers that already end in water or at the edge alone", () => {
    const { real, still } = westSlope();
    const ok: RiverLine = { pts: [[59, 10], [2, 10]], half: 1 };
    const r = repairRivers([ok], nx, ny, still, real, opts);
    expect(r.joined + r.routed).toBe(0);
    expect(r.tapered).toBe(0);
    // Its mouth is only carried into the sea, flared.
    expect(r.mouths).toBe(1);
    expect(r.extra[0].pts[0]).toEqual([2, 10]);
    expect(r.extra[0].pts[1][0]).toBeLessThan(2);
    expect(r.extra[0].half).toBeGreaterThan(1);
  });

  it("drains out of a hollow (hollows are filled)", () => {
    // A bowl in the middle of a plain sloping west: water must still find the west edge.
    const z = new Float32Array(nx * ny);
    for (let r = 0; r < ny; r++) for (let c = 0; c < nx; c++) z[r * nx + c] = c + 30 * Math.exp(-((c - 30) ** 2 + (r - 20) ** 2) / 50) * -1;
    const parent = drainage(z, nx, ny, new Uint8Array(nx * ny));
    let j = 20 * nx + 30;
    let steps = 0;
    while (parent[j] >= 0 && steps++ < nx * ny) j = parent[j];
    expect(parent[j]).toBe(-1);
    const c = j % nx;
    const r = (j - c) / nx;
    expect(c === 0 || r === 0 || c === nx - 1 || r === ny - 1).toBe(true);
  });

  it("tapers a source from 1/4 to full width", () => {
    const pieces = taperedPieces({ pts: [[0, 0], [5, 0], [10, 0], [20, 0], [30, 0]], half: 4, taperStart: true }, 20);
    expect(pieces[0].half).toBeLessThan(2);
    expect(pieces[pieces.length - 1].half).toBe(4);
    for (let i = 1; i < pieces.length; i++) expect(pieces[i].half).toBeGreaterThanOrEqual(pieces[i - 1].half);
  });
});
