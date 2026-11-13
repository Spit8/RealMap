import { describe, expect, it } from "vitest";
import { estimateSeconds, GEOFABRIK_KM2, inExtract, parseGeofabrikIndex, pickExtracts, plainName, totalSeconds, updateRate } from "../src/lib/core/geofabrik";
import { bboxAreaKm2 } from "../src/lib/core/osm";

/** Un rectangle GeoJSON (MultiPolygon). */
const rect = (w: number, s: number, e: number, n: number) => [[[[w, s], [e, s], [e, n], [w, n], [w, s]]]];
const feature = (id: string, parent: string | undefined, box: [number, number, number, number]) => ({
  properties: { id, parent, name: id, urls: { pbf: `https://download.geofabrik.de/${id}-latest.osm.pbf` } },
  geometry: { type: "MultiPolygon", coordinates: rect(...box) },
});

/**
 * Un continent, un pays découpé en deux régions (avec une bande de mer au nord du pays), un pays
 * voisin sans région, un regroupement qui chevauche, et une enclave rattachée à un autre continent.
 */
const index = parseGeofabrikIndex({
  features: [
    feature("europe", undefined, [0, 40, 30, 60]),
    feature("russia", undefined, [20, 50, 60, 70]),
    feature("poland", "europe", [10, 48, 20, 55.5]),
    feature("south", "poland", [10, 48, 20, 51.5]),
    feature("north", "poland", [10, 51.5, 20, 55]),
    feature("germany", "europe", [5, 47, 10, 55]),
    feature("dach", "europe", [5, 45, 17, 55]),
    feature("kaliningrad", "russia", [19, 54, 22, 55]),
  ] as never,
});

describe("parseGeofabrikIndex", () => {
  it("keeps extracts with a file and a polygon", () => {
    expect(index.map((e) => e.id)).toContain("kaliningrad");
    expect(parseGeofabrikIndex({ features: [{ properties: { id: "x" }, geometry: null }] } as never)).toEqual([]);
  });

  it("tells points inside an extract", () => {
    const pl = index.find((e) => e.id === "poland")!;
    expect(inExtract(pl, 15, 50)).toBe(true);
    expect(inExtract(pl, 25, 50)).toBe(false);
  });
});

describe("pickExtracts", () => {
  const ids = (b: Parameters<typeof pickExtracts>[1]) => pickExtracts(index, b).map((e) => e.id);

  it("takes the regions, not the whole country nor its sea band", () => {
    expect(ids({ west: 11, south: 49, east: 19, north: 55.4 })).toEqual(["north", "south"]);
  });

  it("covers a neighbour without regions and an enclave of another continent", () => {
    expect(ids({ west: 8, south: 49, east: 21.5, north: 54.8 })).toEqual(["germany", "kaliningrad", "north", "south"]);
  });

  it("never picks a continent for open sea", () => {
    expect(ids({ west: 1, south: 41, east: 4, north: 44 })).toEqual([]);
  });

  it("is used only above the threshold", () => {
    expect(bboxAreaKm2({ west: 4.6, south: 45.6, east: 5.1, north: 45.9 })).toBeLessThan(GEOFABRIK_KM2);
    expect(bboxAreaKm2({ west: 14, south: 49, east: 24, north: 55 })).toBeGreaterThan(GEOFABRIK_KM2);
  });
});

describe("plainName", () => {
  it("drops the HTML of some index names", () => {
    expect(plainName("Województwo mazowieckie<br />(Mazovian Voivodeship)")).toBe("Województwo mazowieckie (Mazovian Voivodeship)");
    expect(plainName("Nord-Norge<br>(Northern Norway)")).toBe("Nord-Norge (Northern Norway)");
    expect(plainName("Bosnia &amp; Herzegovina")).toBe("Bosnia & Herzegovina");
    expect(plainName("Poland")).toBe("Poland");
  });
});

describe("time estimates", () => {
  const rates = { download: 10e6, read: 50e6 };
  it("adds download and reading for one region", () => {
    expect(estimateSeconds({ download: 100e6, read: 100e6 }, rates)).toBeCloseTo(12);
    expect(estimateSeconds({ download: 0, read: 0 }, rates)).toBe(0);
  });

  it("reads each region while the next one downloads", () => {
    const list = [{ download: 100e6, read: 100e6 }, { download: 100e6, read: 100e6 }, { download: 0, read: 50e6 }];
    // Cached region read first (1 s), then 10 s + 10 s of downloads, the last read (2 s) after.
    expect(totalSeconds(list, rates)).toBeCloseTo(22);
    expect(totalSeconds(list, rates)).toBeLessThan(list.reduce((n, c) => n + estimateSeconds(c, rates), 0));
  });

  it("learns the measured speed, ignoring tiny samples", () => {
    expect(updateRate(10e6, 100e6, 5)).toBeCloseTo(15e6);
    expect(updateRate(10e6, 1e6, 0.1)).toBe(10e6);
  });
});
