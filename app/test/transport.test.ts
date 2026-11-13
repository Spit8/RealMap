import { describe, expect, it } from "vitest";
import { cropDem, sampleDem, sampleDemBox, type DemRaster } from "../src/lib/core/dem";
import { addPart, chunkItems, pointsOf, requestHead, requestMessages, type WorkerInput } from "../src/lib/workers/transport";
import type { TerrainRequest } from "../src/lib/workers/terrain.worker";

/** A 1°×1° tile of 360×360 pixels with a bumpy height field. */
function tile(): DemRaster {
  const width = 360, height = 360;
  const data = new Float32Array(width * height);
  for (let r = 0; r < height; r++) for (let c = 0; c < width; c++) data[r * width + c] = 100 + 50 * Math.sin(c / 7) + 30 * Math.cos(r / 5) + ((c * r) % 13);
  return { west: 4, north: 46, resLon: 1 / 360, resLat: 1 / 360, width, height, data, noData: -32767 };
}

describe("cropDem", () => {
  const r = tile();
  const box = { west: 4.31, south: 45.22, east: 4.67, north: 45.58 };

  it("keeps the heights inside the box", () => {
    const c = cropDem(r, box)!;
    expect(c.width).toBeLessThan(r.width);
    expect(c.height).toBeLessThan(r.height);
    for (let i = 0; i < 400; i++) {
      const lon = box.west + ((i * 37) % 400) / 400 * (box.east - box.west);
      const lat = box.south + ((i * 91) % 400) / 400 * (box.north - box.south);
      expect(sampleDem([c], lon, lat)).toBeCloseTo(sampleDem([r], lon, lat), 3);
      expect(sampleDemBox([c], lon, lat, 0.004, 0.004, 4)).toBeCloseTo(sampleDemBox([r], lon, lat, 0.004, 0.004, 4), 3);
    }
  });

  it("returns the raster itself when the box covers it, null when apart", () => {
    expect(cropDem(r, { west: 3.5, south: 44.5, east: 5.5, north: 46.5 })).toBe(r);
    expect(cropDem(r, { west: 6, south: 44, east: 7, north: 45 })).toBeNull();
  });
});

describe("chunkItems", () => {
  it("keeps every item in order, batches under the weight", () => {
    const items = Array.from({ length: 1000 }, (_, i) => ({ pts: new Array((i % 17) + 1).fill([0, 0]) }));
    const batches = chunkItems(items, pointsOf, 500);
    expect(batches.flat()).toEqual(items);
    for (const b of batches) expect(b.length === 1 || b.reduce((n, x) => n + pointsOf(x), 0) <= 500).toBe(true);
  });

  it("sends an item heavier than the limit alone", () => {
    const big = { pts: new Array(10).fill([0, 0]) };
    expect(chunkItems([big, big], pointsOf, 3)).toEqual([[big], [big]]);
  });

  it("counts points of shapes and ways", () => {
    expect(pointsOf({ kind: "polygon", rings: [[[0, 0], [1, 0], [1, 1]], [[0, 0]]] })).toBe(4);
    expect(pointsOf({ kind: "line", pts: [[0, 0], [1, 1]] })).toBe(2);
    expect(pointsOf({ name: "Lyon", lon: 4.8, lat: 45.7 })).toBe(1);
  });
});

describe("requestMessages", () => {
  const line = (n: number) => ({ kind: "line" as const, tags: {}, pts: Array.from({ length: n }, (_, i) => [i, i] as [number, number]) });
  const req = {
    area: { lon: 4.5, lat: 45.5, size: 1, format: 0, landscape: false, scale: 1, verticalScale: null },
    mode: "preview",
    ign: new Float32Array([1, 2, 3]),
    rasters: [tile(), tile()],
    bathy: [{ ...tile(), west: 3 }],
    water: Array.from({ length: 50 }, () => line(10_000)),
    cover: [{ west: 4, north: 46, res: 0.01, width: 4, height: 4, data: new Uint8Array(16).fill(10) }],
    places: [{ name: "A", lon: 4.5, lat: 45.5, place: "town" }],
    sites: [],
    roads: [{ kind: "road", cls: "primary", nodes: [1, 2], pts: [[4.5, 45.5], [4.6, 45.6]] }],
    land: { beaches: [line(3)], business: [] },
    terrain: {},
    biomes: {},
    filter: {},
    picks: {},
    towns: {},
    industryPicks: {},
    industries: {},
    linkPicks: {},
    rail: {},
  } as unknown as TerrainRequest;

  it("rebuilds the same request on the worker side, rasters cut to the box", () => {
    const crop = { west: 4.31, south: 45.22, east: 4.67, north: 45.58 };
    const msgs = [...requestMessages(req, crop)];
    expect(msgs[0].msg.kind).toBe("begin");
    expect(msgs.at(-1)!.msg.kind).toBe("run");
    // 500 000 points of water: at least three messages.
    expect(msgs.filter((m) => m.msg.kind === "part" && m.msg.field === "water").length).toBeGreaterThanOrEqual(3);
    let got: TerrainRequest | null = null;
    for (const { msg } of msgs as { msg: WorkerInput }[]) {
      if (msg.kind === "begin") got = structuredClone(msg.req);
      else if (msg.kind === "part") addPart(got!, msg.field, msg.items);
      else if (msg.kind === "ign") got!.ign = msg.ign;
    }
    expect(got!.water).toEqual(req.water);
    expect(got!.places).toEqual(req.places);
    expect(got!.roads).toEqual(req.roads);
    expect(got!.land).toEqual(req.land);
    expect(got!.cover).toEqual(req.cover);
    expect(got!.ign).toBe(req.ign);
    expect(got!.rasters).toHaveLength(2);
    expect(got!.rasters[0].width).toBeLessThan(req.rasters[0].width);
    // Bathymetry is sent whole, as a copy (the cache keeps the original buffer).
    expect(got!.bathy[0].width).toBe(req.bathy[0].width);
    expect(got!.bathy[0].data).not.toBe(req.bathy[0].data);
    expect(sampleDem(got!.rasters, 4.5, 45.4)).toBeCloseTo(sampleDem(req.rasters, 4.5, 45.4), 3);
  });

  it("begins with the settings only", () => {
    const head = requestHead(req);
    expect(head.rasters).toEqual([]);
    expect(head.water).toEqual([]);
    expect(head.ign).toBeNull();
    expect(head.cover).toEqual([]);
    expect(head.land).toEqual({ beaches: [], business: [] });
    expect(head.area).toEqual(req.area);
  });
});

// Une grande zone (toute la Pologne) : des centaines de milliers de lieux ponctuels.
describe("large OSM lists", () => {
  const place = (i: number) => ({ name: `P${i}`, lon: 19 + i * 1e-6, lat: 52, place: "village" });

  it("adds a batch of 300 000 items without overflowing the stack", () => {
    const req = requestHead({ places: [], land: { beaches: [], business: [] } } as unknown as TerrainRequest);
    const items = Array.from({ length: 300_000 }, (_, i) => place(i));
    expect(() => addPart(req, "places", items)).not.toThrow();
    expect(() => addPart(req, "land.business", items)).not.toThrow();
    expect(req.places).toHaveLength(300_000);
    expect(req.places[0]).toBe(items[0]);
    expect(req.places.at(-1)).toBe(items.at(-1));
    expect(req.land!.business).toHaveLength(300_000);
  });

  it("caps the item count of a batch, order kept", () => {
    const items = Array.from({ length: 1000 }, (_, i) => place(i));
    const batches = chunkItems(items, pointsOf, 1_000_000, 300);
    expect(batches.map((b) => b.length)).toEqual([300, 300, 300, 100]);
    expect(batches.flat()).toEqual(items);
  });

  it("sends 120 000 places in several messages", () => {
    const req = { ...requestHead({ land: undefined } as unknown as TerrainRequest), rasters: [], bathy: [], cover: null, places: Array.from({ length: 120_000 }, (_, i) => place(i)) } as unknown as TerrainRequest;
    const msgs = [...requestMessages(req, null)].filter((m) => m.msg.kind === "part" && m.msg.field === "places");
    expect(msgs.length).toBeGreaterThanOrEqual(3);
  });
});
