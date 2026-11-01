import { describe, expect, it } from "vitest";
import { decode } from "fast-png";
import { frameBBox, frameProjection, makeFrame, utmZone, type Area } from "../src/lib/core/area";
import {
  biomeByte, biomeImage, DEFAULT_BIOMES, COVER_FOREST, COVER_OPEN, COVER_ROCK, COVER_SCRUB,
  riverTestPattern,
} from "../src/lib/core/biomes";
import { copernicusTileName, copernicusTilesFor, sampleDem, sampleDemBox, type DemRaster } from "../src/lib/core/dem";
import { cellToWorld, fullGrid, previewGrid, worldToCell } from "../src/lib/core/grid";
import { encodeHeightmapPng, normalize16 } from "../src/lib/core/heightmap";
import { decodeBil, ignBlocks, ignRaster, resampleToGrid } from "../src/lib/core/ign";
import proj4 from "proj4";
import { parseUserdata, toUserdata } from "../src/lib/core/luadata";
import {
  coverOfClass, coverRasterFor, sampleCover, worldcoverLevel, worldcoverTileName, worldcoverTilesFor, worldcoverWindow,
} from "../src/lib/core/landcover";
import {
  availableFormats, availableSizes, isExperimental, mapSizeLabel, mapTiles, nearestAvailable, parseExperimentalMapFeatures,
} from "../src/lib/core/mapsizes";
import {
  assembleRings, bboxAreaKm2, minWaterPerimeterM, overpassAreaQuery, overpassLimits, parseOverpassShapes,
  parseOverpassStatus, roundBbox, type OsmShape,
} from "../src/lib/core/osm";
import { hoverGrid, renderPreview } from "../src/lib/core/preview";
import { b64ToBytes, b64ToFloats, bytesToB64, floatsToB64 } from "../src/lib/core/b64";
import {
  blurGrid, closeMask, distanceTo, fillRings, floodFromEdges, labelComponents, strokePolyline,
} from "../src/lib/core/raster";
import {
  composeTerrain, countRiverPieces, DEFAULT_TERRAIN, dropSmallWater, rasterizeWater, realHeights, smoothHeights,
  WATER_LAKE, WATER_NONE, WATER_RIVER, WATER_SEA,
} from "../src/lib/core/terrain";
import {
  DEFAULT_TOWNS, gameTownLimit, overpassTownsQuery, parsePopulation, placeKey, placeTowns, selectTowns, targetCapacity, townCandidates,
  townsIndustriesData, townSizesData, type RankedPlace, type TownPicks,
  type OsmPlace, type PlaceKind,
} from "../src/lib/core/towns";

const area = (patch: Partial<Area> = {}): Area => ({
  lon: 4.8357, lat: 45.764, size: 3, format: 0, landscape: false, scale: 1, verticalScale: null, ...patch,
});
const LYON = area();

describe("map sizes (FACT-010)", () => {
  it("matches the game's table", () => {
    expect(mapTiles(3, 0)).toEqual({ tilesX: 56, tilesY: 56 });
    expect(mapTiles(1, 1)).toEqual({ tilesX: 22, tilesY: 44 });
    expect(mapTiles(1, 1, true)).toEqual({ tilesX: 44, tilesY: 22 });
    expect(mapTiles(7, 4)).toEqual({ tilesX: 50, tilesY: 250 });
    expect(mapTiles(99, -3)).toEqual({ tilesX: 112, tilesY: 112 });
  });

  it("labels sizes in km with the game's names", () => {
    expect(mapSizeLabel(3, 0)).toBe("Grande (1 : 1) — 14,3 × 14,3 km");
    expect(mapSizeLabel(7, 0)).toBe("Gigantomane (1 : 1) — 28,7 × 28,7 km");
  });

  it("offers only the game's standard sizes and formats without experimental map features", () => {
    expect(availableSizes(false)).toEqual([1, 2, 3, 4]);
    expect(availableFormats(false)).toEqual([0, 1, 2]);
    expect(availableSizes(true)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(availableFormats(true)).toEqual([0, 1, 2, 3, 4]);
    expect(nearestAvailable(7, availableSizes(false))).toBe(4);
    expect(nearestAvailable(0, availableSizes(false))).toBe(1);
    expect(nearestAvailable(4, availableFormats(false))).toBe(2);
    expect(isExperimental(3, 2)).toBe(false);
    expect(isExperimental(3, 3)).toBe(true);
  });

  it("reads experimentalMapFeatures from settings.lua", () => {
    expect(parseExperimentalMapFeatures("\t\texperimentalMapFeatures = false,\n")).toBe(false);
    expect(parseExperimentalMapFeatures("experimentalMapFeatures = true,")).toBe(true);
    expect(parseExperimentalMapFeatures("experimentalOptimizeShaders = true,")).toBeNull();
  });
});

describe("Overpass (FACT-012)", () => {
  it("parses /api/status", () => {
    const free = "Connected as: 369841217\nCurrent time: 2026-10-30T16:53:13Z\nAnnounced endpoint: lambert.openstreetmap.de/\nRate limit: 2\n2 slots available now.\nCurrently running queries (pid, space limit, time limit, start time):\n";
    expect(parseOverpassStatus(free)).toEqual({ slots: 2, free: 2, waitS: 0 });
    const busy = "Rate limit: 2\nSlot available after: 2026-10-30T17:00:05Z, in 42 seconds.\nSlot available after: 2026-10-30T17:00:30Z, in 67 seconds.\n";
    expect(parseOverpassStatus(busy)).toEqual({ slots: 2, free: 0, waitS: 42 });
    expect(parseOverpassStatus("<html>error</html>").slots).toBe(0);
  });

  it("declares limits that grow with the area, below the 180 s / 512 MiB defaults", () => {
    // ≈ 170 km²: 60 s + 1 s per 50 km², 64 MiB.
    const small = overpassLimits({ west: 4.7, south: 45.7, east: 4.9, north: 45.8 });
    expect(small).toEqual({ timeout: 63, maxsize: 64 * 1024 * 1024 });
    const big = overpassLimits({ west: 4, south: 45, east: 6, north: 47 });
    expect(big.timeout).toBe(180);
    expect(big.maxsize).toBe(256 * 1024 * 1024);
    const q = overpassAreaQuery({ west: 4.7, south: 45.7, east: 4.9, north: 45.8 }, ["town"]);
    expect(q.startsWith("[out:json][timeout:63][maxsize:67108864];(")).toBe(true);
    expect(q).not.toContain("forest");
    expect(q).not.toContain("length()");
  });

  it("skips ponds too small to show at the chosen scale", () => {
    expect(minWaterPerimeterM(1)).toBe(60);
    expect(minWaterPerimeterM(3)).toBe(75);
    const q = overpassAreaQuery({ west: 4.7, south: 45.7, east: 4.9, north: 45.8 }, ["town"], 75);
    expect(q).toContain(`way["natural"="water"](if:length()>75)(45.7,4.7,45.8,4.9);`);
    // River and canal lines are kept whatever their length.
    expect(q).toContain(`way["waterway"~"^(river|canal)$"](45.7,4.7,45.8,4.9);`);
  });

  it("rounds the bbox outward so nearby areas share a cached answer", () => {
    const b = roundBbox({ west: 4.8312, south: 45.7011, east: 4.9399, north: 45.8001 });
    expect(b).toEqual({ west: 4.83, south: 45.7, east: 4.94, north: 45.81 });
    expect(roundBbox({ west: 4.8301, south: 45.7004, east: 4.9302, north: 45.8099 })).toEqual(b);
    expect(bboxAreaKm2({ west: 0, south: 0, east: 1, north: 1 })).toBeCloseTo(12309, -1);
  });
});

describe("WorldCover land cover (FACT-015)", () => {
  it("names 3° tiles after their south-west corner", () => {
    expect(worldcoverTileName(45, 3)).toBe("ESA_WorldCover_10m_2021_v200_N45E003_Map");
    expect(worldcoverTileName(-3, -60)).toBe("ESA_WorldCover_10m_2021_v200_S03W060_Map");
    expect(worldcoverTilesFor({ west: 4.5, south: 45.5, east: 5.1, north: 45.9 }).map((t) => t.name)).toEqual([
      "ESA_WorldCover_10m_2021_v200_N45E003_Map",
    ]);
    expect(worldcoverTilesFor({ west: -0.5, south: 47.9, east: 0.5, north: 48.1 })).toHaveLength(4);
  });

  it("picks the coarsest overview not coarser than the sample step, never finer than 20 m", () => {
    expect(worldcoverLevel(4)).toBe(1);
    expect(worldcoverLevel(39)).toBe(1);
    expect(worldcoverLevel(40)).toBe(2);
    expect(worldcoverLevel(72)).toBe(2);
    expect(worldcoverLevel(10_000)).toBe(6);
  });

  it("windows a bbox in a tile and maps pixels back to lon/lat", () => {
    const tile = { south: 45, west: 3 };
    // Window measured on the real file (Lyon, level 2): [4649, 6119, 6360, 7290].
    const win = worldcoverWindow(tile, 2, { west: 4.55, south: 45.57, east: 5.12, north: 45.96 })!;
    [4649, 6119, 6360, 7290].forEach((v, i) => expect(Math.abs(win[i] - v)).toBeLessThanOrEqual(1));
    expect(worldcoverWindow(tile, 2, { west: 7, south: 45, east: 8, north: 46 })).toBeNull();
    const r = coverRasterFor(tile, 2, [10, 20, 12, 22], Uint8Array.from([10, 20, 60, 80]));
    expect(r.west).toBeCloseTo(3 + 10 / 3000);
    expect(r.north).toBeCloseTo(48 - 20 / 3000);
    expect(sampleCover([r], r.west + 0.5 * r.res, r.north - 0.5 * r.res)).toBe(10);
    expect(sampleCover([r], r.west + 1.5 * r.res, r.north - 1.5 * r.res)).toBe(80);
    expect(sampleCover([r], 0, 0)).toBe(0);
  });

  it("maps WorldCover classes to cover classes", () => {
    expect(coverOfClass(10)).toBe(COVER_FOREST);
    expect(coverOfClass(20)).toBe(COVER_SCRUB);
    expect(coverOfClass(60)).toBe(COVER_ROCK);
    expect(coverOfClass(70)).toBe(COVER_ROCK);
    expect(coverOfClass(40)).toBe(COVER_OPEN);
    expect(coverOfClass(0)).toBe(COVER_OPEN);
  });
});

describe("area", () => {
  it("Large square → 14 336 m, 3585 samples (FACT-006)", () => {
    const f = makeFrame(LYON);
    expect(f.widthM).toBe(14336);
    expect(f.samplesX).toBe(3585);
    expect(f.zone).toBe(31);
    expect(f.epsg).toBe(32631);
  });

  it("puts the centre at the origin and round-trips", () => {
    const p = frameProjection(makeFrame(LYON));
    const [x, y] = p.toWorld(LYON.lon, LYON.lat);
    expect(Math.abs(x)).toBeLessThan(1e-6);
    expect(Math.abs(y)).toBeLessThan(1e-6);
    const [lon, lat] = p.toLonLat(5000, -3000);
    const [x2, y2] = p.toWorld(lon, lat);
    expect(x2).toBeCloseTo(5000, 3);
    expect(y2).toBeCloseTo(-3000, 3);
  });

  it("scale 4 covers four times the ground, same game size", () => {
    const f1 = makeFrame(LYON);
    const f4 = makeFrame(area({ scale: 4 }));
    expect(f4.samplesX).toBe(f1.samplesX);
    const [e1] = frameProjection(f1).toLocal(1000, 0);
    const [e4] = frameProjection(f4).toLocal(1000, 0);
    expect(e4).toBeCloseTo(4 * e1, 6);
    const b1 = frameBBox(f1);
    const b4 = frameBBox(f4);
    expect((b4.east - b4.west) / (b1.east - b1.west)).toBeCloseTo(4, 1);
  });

  it("vertical scale defaults to 1/√scale", () => {
    expect(makeFrame(area({ scale: 4 })).verticalScale).toBeCloseTo(0.5, 9);
    expect(makeFrame(area({ scale: 4, verticalScale: 0.8 })).verticalScale).toBe(0.8);
  });

  it("x points east, y points north", () => {
    const p = frameProjection(makeFrame(LYON));
    expect(p.toLonLat(1000, 0)[0]).toBeGreaterThan(LYON.lon);
    expect(p.toLonLat(0, 1000)[1]).toBeGreaterThan(LYON.lat);
  });

  it("is not turned: the north edge follows a parallel, the west edge a meridian (FACT-022)", () => {
    // Far from the UTM zone's central meridian (3° E), where a UTM square turned by ~2°.
    const f = makeFrame(area({ lon: 5.9, lat: 45.2 }));
    const p = frameProjection(f);
    const hx = f.widthM / 2;
    const hy = f.heightM / 2;
    expect(Math.abs(p.toLonLat(-hx, hy)[1] - p.toLonLat(hx, hy)[1])).toBeLessThan(0.01);
    expect(Math.abs(p.toLonLat(-hx, hy)[0] - p.toLonLat(-hx, -hy)[0])).toBeLessThan(0.01);
  });

  it("utm zones", () => {
    expect(utmZone(-0.1, 51.5)).toEqual({ zone: 30, south: false });
    expect(utmZone(151.2, -33.9)).toEqual({ zone: 56, south: true });
  });
});

describe("grid", () => {
  it("full and preview grids span the map, row 0 north", () => {
    const f = makeFrame(LYON);
    const g = fullGrid(f);
    expect(cellToWorld(f, g, 0, 0)).toEqual([-7168, 7168]);
    expect(cellToWorld(f, g, g.nx - 1, g.ny - 1)).toEqual([7168, -7168]);
    const p = previewGrid(f, 640);
    expect(p.nx).toBeLessThanOrEqual(640);
    expect((p.nx - 1) * p.step).toBeLessThanOrEqual(f.widthM);
    expect(worldToCell(f, p, ...cellToWorld(f, p, 7, 9))).toEqual([7, 9]);
  });
});

describe("IGN", () => {
  it("requests the UTM rectangle around the map and resamples it onto the grid", () => {
    const f = makeFrame(area({ scale: 2, size: 0 }));
    const g = fullGrid(f);
    const r = ignRaster(f, g);
    const blocks = ignBlocks(r, 512);
    expect(blocks.reduce((s, x) => s + x.w * x.h, 0)).toBe(r.w * r.h);
    const b = blocks[0];
    expect(b.bbox[2] - b.bbox[0]).toBeCloseTo(b.w * r.step, 6);
    expect(b.bbox[0] + r.step / 2).toBeCloseTo(r.e0, 6);
    // A plane in UTM (height = easting / 100) comes back as the same plane on the grid.
    const raster = new Float32Array(r.w * r.h);
    for (let k = 0; k < r.h; k++) for (let c = 0; c < r.w; c++) raster[k * r.w + c] = (r.e0 + c * r.step) / 100;
    const out = resampleToGrid(f, g, r, raster);
    const p = frameProjection(f);
    const conv = proj4("WGS84", f.utm);
    for (const [c, k] of [[0, 0], [g.nx - 1, g.ny - 1], [517, 300]]) {
      const [e] = conv.forward(p.toLonLat(...cellToWorld(f, g, c, k)));
      expect(out[k * g.nx + c]).toBeCloseTo(e / 100, 1);
    }
  });

  it("decodes little-endian float32 and no-data", () => {
    const buf = new ArrayBuffer(8);
    const dv = new DataView(buf);
    dv.setFloat32(0, 161.5, true);
    dv.setFloat32(4, -99999, true);
    const out = decodeBil(new Uint8Array(buf), 2, 1)!;
    expect(out[0]).toBeCloseTo(161.5);
    expect(Number.isNaN(out[1])).toBe(true);
    expect(decodeBil(new Uint8Array(3), 2, 1)).toBeNull();
  });
});

describe("dem", () => {
  it("names Copernicus tiles after their south-west corner", () => {
    expect(copernicusTileName(45, 4)).toBe("Copernicus_DSM_COG_10_N45_00_E004_00_DEM");
    expect(copernicusTileName(-34, -71)).toBe("Copernicus_DSM_COG_10_S34_00_W071_00_DEM");
    expect(copernicusTilesFor({ west: 4.9, south: 45.9, east: 5.1, north: 46.1 })).toHaveLength(4);
  });

  const ramp: DemRaster = {
    west: 4, north: 46, resLon: 0.1, resLat: 0.1, width: 11, height: 11,
    data: Float32Array.from({ length: 121 }, (_, i) => 10 * (i % 11) + 1000 * Math.floor(i / 11)),
  };

  it("samples bilinearly and averages footprints", () => {
    expect(sampleDem([ramp], 4.05, 45.95)).toBeCloseTo(0, 6);
    expect(sampleDem([ramp], 4.1, 45.95)).toBeCloseTo(5, 6);
    expect(Number.isNaN(sampleDem([ramp], 6, 45))).toBe(true);
    // A linear ramp averages to its centre value.
    expect(sampleDemBox([ramp], 4.3, 45.5, 0.2, 0.2, 4)).toBeCloseTo(sampleDem([ramp], 4.3, 45.5), 6);
  });

  it("real heights: IGN first, Copernicus fills the gaps", () => {
    const f = makeFrame(area({ lon: 4.5, lat: 45.5, size: 0 }));
    const g = previewGrid(f, 64);
    const flat: DemRaster = { west: 4, north: 46, resLon: 0.01, resLat: 0.01, width: 101, height: 101, data: new Float32Array(101 * 101).fill(42) };
    const ign = new Float32Array(g.nx * g.ny).fill(7);
    ign[0] = NaN;
    const h = realHeights(f, g, ign, [flat]);
    expect(h[0]).toBeCloseTo(42);
    expect(h[1]).toBe(7);
  });
});

describe("raster", () => {
  it("fills polygons with holes (even-odd)", () => {
    const m = new Uint8Array(100);
    fillRings(m, 10, 10, [[[0.5, 0.5], [8.5, 0.5], [8.5, 8.5], [0.5, 8.5]], [[3.5, 3.5], [5.5, 3.5], [5.5, 5.5], [3.5, 5.5]]], 2);
    expect(m[1 * 10 + 1]).toBe(2);
    expect(m[4 * 10 + 4]).toBe(0);
    expect(m[9 * 10 + 9]).toBe(0);
  });

  it("strokes thick lines", () => {
    const m = new Uint8Array(100);
    strokePolyline(m, 10, 10, [[0, 5], [9, 5]], 1, 3);
    expect(m[5 * 10 + 3]).toBe(3);
    expect(m[4 * 10 + 3]).toBe(3);
    expect(m[2 * 10 + 3]).toBe(0);
  });

  it("floods from the edges only", () => {
    const cand = new Uint8Array(25).fill(1);
    cand[6] = cand[7] = cand[8] = cand[11] = cand[13] = cand[16] = cand[17] = cand[18] = 0; // ring around 12
    const out = floodFromEdges(cand, 5, 5);
    expect(out[0]).toBe(1);
    expect(out[12]).toBe(0);
  });

  it("distance transform", () => {
    const src = new Uint8Array(25);
    src[0] = 1;
    const d = distanceTo(src, 5, 5);
    expect(d[4]).toBe(4);
    expect(d[24]).toBeCloseTo(4 * Math.SQRT2, 5);
  });
});

describe("osm", () => {
  it("assembles multipolygon pieces into rings", () => {
    const rings = assembleRings([[[0, 0], [1, 0]], [[1, 1], [1, 0]], [[1, 1], [0, 1], [0, 0]]]);
    expect(rings).toHaveLength(1);
    expect(rings[0][0]).toEqual(rings[0][rings[0].length - 1]);
  });

  it("parses ways and relations", () => {
    const g = (pts: number[][]) => pts.map(([lon, lat]) => ({ lon, lat }));
    const shapes = parseOverpassShapes({
      elements: [
        { type: "way", tags: { natural: "water" }, geometry: g([[0, 0], [1, 0], [1, 1], [0, 0]]) },
        { type: "way", tags: { waterway: "river" }, geometry: g([[0, 0], [1, 1]]) },
        { type: "relation", tags: { natural: "water" }, members: [
          { type: "way", role: "outer", geometry: g([[0, 0], [2, 0], [2, 2]]) },
          { type: "way", role: "outer", geometry: g([[2, 2], [0, 2], [0, 0]]) },
        ] },
      ],
    });
    expect(shapes.map((s) => s.kind)).toEqual(["polygon", "line", "polygon"]);
  });
});

describe("terrain", () => {
  const f = makeFrame(area({ size: 0 }));
  const g = previewGrid(f, 50);
  const n = g.nx * g.ny;
  // No smoothing here, so the slope caps can be checked exactly.
  // No coast floor here, so the sea depths can be checked against seaDepth / the sea floor.
  const opts = { ...DEFAULT_TERRAIN, verticalScale: 0.5, smoothM: 0, coastDepth: 0 };

  it("sea from the edges, land never below landMin", () => {
    // West third at −2 m (sea), the rest rising from 1 to 21 m.
    const real = new Float32Array(n);
    for (let r = 0; r < g.ny; r++) for (let c = 0; c < g.nx; c++) real[r * g.nx + c] = c < g.nx / 3 ? -2 : 1 + (20 * c) / g.nx;
    const t = composeTerrain(real, g, new Uint8Array(n), opts);
    expect(t.refHeight).toBe(0);
    expect(t.water[0]).toBe(WATER_SEA);
    expect(t.game[0]).toBe(-opts.seaDepth);
    for (let i = 0; i < n; i++) if (!t.water[i]) expect(t.game[i]).toBeGreaterThanOrEqual(opts.landMin);
    expect(t.minM).toBe(-opts.seaDepth);
  });

  it("inland: the river level becomes the water level, shallow at the shore, deep in the middle, gentle banks", () => {
    const real = new Float32Array(n).fill(1000);
    const osm = new Uint8Array(n);
    const mid = Math.floor(g.nx / 2);
    // A river 9 cells wide.
    for (let r = 0; r < g.ny; r++) {
      for (let c = mid - 4; c <= mid + 4; c++) {
        osm[r * g.nx + c] = WATER_RIVER;
        real[r * g.nx + c] = 160;
      }
    }
    // An unbounded bank zone, to check the slope cap exactly.
    const t = composeTerrain(real, g, osm, { ...opts, bankWidthM: 1e9 });
    expect(t.refHeight).toBe(160);
    // With the default bank zone, land further than bankWidthM from the river keeps its height.
    const far = composeTerrain(real, g, osm, opts);
    const away = Math.ceil(opts.bankWidthM / g.step) + 1;
    expect(far.game[mid + 4 + away]).toBeCloseTo((1000 - 160) * opts.verticalScale, 4);
    expect(far.game[mid + 5]).toBeLessThan((1000 - 160) * opts.verticalScale);
    // Water deepens from 0.5 m at the shore (no wall) to the river depth in the middle.
    expect(t.game[mid - 4]).toBeLessThanOrEqual(-0.5);
    expect(t.game[mid - 4]).toBeGreaterThan(-0.4 * opts.riverDepth);
    for (let c = mid - 3; c <= mid; c++) expect(t.game[c]).toBeLessThanOrEqual(t.game[c - 1]);
    expect(t.game[mid]).toBeCloseTo(-opts.riverDepth, 4);
    // Next to the river: low, smoothed across the waterline; further: the gentle river bank slope;
    // far away: (1000 − 160) × 0.5 = 420 m.
    expect(t.game[mid + 5]).toBeGreaterThanOrEqual(opts.landMin);
    expect(t.game[mid + 5]).toBeLessThanOrEqual(opts.landMin + opts.riverBankSlope * g.step);
    expect(t.game[0]).toBeCloseTo(Math.min(420, opts.landMin + opts.riverBankSlope * g.step * (mid - 4 - 0.5)), 4);
  });

  it("follows the real sea floor, capped, with a gentle slope from the shore", () => {
    // Sea (real height −2) in the west half, flat land at 10 m in the east.
    const real = new Float32Array(n);
    const floor = new Float32Array(n).fill(NaN);
    const half = Math.floor(g.nx / 2);
    for (let r = 0; r < g.ny; r++) {
      for (let c = 0; c < g.nx; c++) {
        const i = r * g.nx + c;
        real[i] = c < half ? -2 : 10;
        if (c < half) floor[i] = -200 + c; // deeper offshore
      }
    }
    const t = composeTerrain(real, g, new Uint8Array(n), opts, floor);
    const at = (c: number) => t.game[20 * g.nx + c];
    expect(at(half - 1)).toBeCloseTo(-0.5, 4); // shore
    expect(at(0)).toBeCloseTo(-opts.seaMaxDepth, 4); // 200 m × 0.5 capped at 40
    // Without data: the default depth.
    expect(composeTerrain(real, g, new Uint8Array(n), opts).game[20 * g.nx]).toBeCloseTo(-opts.seaDepth, 4);
    for (let c = 1; c < half; c++) expect(at(c)).toBeGreaterThanOrEqual(at(c - 1) - 1e-4);
    // A coast floor: shallow sea-floor data (−4 m real) still gives coastDepth off the shore ramp.
    const shallow = new Float32Array(n).fill(NaN);
    for (let r = 0; r < g.ny; r++) for (let c = 0; c < half; c++) shallow[r * g.nx + c] = -4;
    const coast = composeTerrain(real, g, new Uint8Array(n), { ...opts, coastDepth: 20 }, shallow);
    expect(coast.game[20 * g.nx]).toBeCloseTo(-20, 4);
    expect(coast.game[20 * g.nx + half - 1]).toBeCloseTo(-0.5, 4);
  });

  it("keeps a river high above the water level, in one piece, in a gentle valley", () => {
    // Sea in the west column, a river 800 m higher along row 10: the river must stay water.
    const real = new Float32Array(n).fill(1000);
    const osm = new Uint8Array(n);
    for (let r = 0; r < g.ny; r++) real[r * g.nx] = -2;
    const row = 10;
    for (let c = 1; c < g.nx; c++) {
      osm[row * g.nx + c] = WATER_RIVER;
      real[row * g.nx + c] = 800;
    }
    const t = composeTerrain(real, g, osm, opts);
    for (let c = 1; c < g.nx; c++) expect(t.water[row * g.nx + c]).toBe(WATER_RIVER);
    expect(countRiverPieces(t.water, g)).toBe(1);
    // The river must drop 800 × 0.5 = 400 m: its valley is lowered by about that much near it,
    // the plateau (500 m in game) keeps its 100 m above the river, and the lowering fades away.
    const col = g.nx - 2;
    const at = (r: number) => t.game[r * g.nx + col];
    expect(at(row + 8)).toBeLessThan(500 - 300);
    expect(at(row + 8)).toBeGreaterThan(opts.landMin);
    for (let r = row + 2; r < g.ny - 1; r++) expect(at(r + 1)).toBeGreaterThanOrEqual(at(r) - 1e-3);
  });

  it("leaves a river already at the water level and its hills alone", () => {
    // Sea in the west column, a river at sea level, a 300 m hill 1 km away.
    const real = new Float32Array(n).fill(20);
    const osm = new Uint8Array(n);
    for (let r = 0; r < g.ny; r++) real[r * g.nx] = -2;
    for (let c = 1; c < g.nx; c++) {
      osm[10 * g.nx + c] = WATER_RIVER;
      real[10 * g.nx + c] = 0.6;
    }
    const hill = 40 * g.nx + 30;
    real[hill] = 300;
    const t = composeTerrain(real, g, osm, opts);
    expect(t.game[hill]).toBeCloseTo(300 * opts.verticalScale, 4);
  });

  it("lakes high above the water level stay land", () => {
    const real = new Float32Array(n).fill(100);
    const osm = new Uint8Array(n);
    osm[5 * g.nx + 5] = WATER_LAKE;
    real[5 * g.nx + 5] = 900;
    const t = composeTerrain(real, g, osm, { ...opts, refHeight: 100 });
    expect(t.water[5 * g.nx + 5]).toBe(WATER_NONE);
  });

  it("rasterises OSM water: river polygons and lines are rivers, ponds are lakes", () => {
    const p = frameProjection(f);
    // Tiny map: 4 096 m across.
    const ring = [[-500, -500], [500, -500], [500, 500], [-500, 500], [-500, -500]].map(([x, y]) => p.toLonLat(x, y));
    const line = [[-1500, 1500], [1500, 1500]].map(([x, y]) => p.toLonLat(x, y));
    const w = rasterizeWater(f, g, [
      { kind: "polygon", tags: { natural: "water" }, rings: [ring] },
      { kind: "line", tags: { waterway: "river" }, pts: line },
    ]);
    const [cc, rc] = worldToCell(f, g, 0, 0).map(Math.round);
    const [cl, rl] = worldToCell(f, g, 0, 1500).map(Math.round);
    expect(w[rc * g.nx + cc]).toBe(WATER_LAKE);
    expect(w[rl * g.nx + cl]).toBe(WATER_RIVER);
  });

  it("widens rivers to the navigable width", () => {
    const p = frameProjection(f);
    const line = [[-1500, 0], [1500, 0]].map(([x, y]) => p.toLonLat(x, y));
    const shapes: OsmShape[] = [{ kind: "line", tags: { waterway: "river", width: "3" }, pts: line }];
    const across = (w: Uint8Array) => {
      const [c] = worldToCell(f, g, 0, 0).map(Math.round);
      let k = 0;
      for (let r = 0; r < g.ny; r++) if (w[r * g.nx + c] === WATER_RIVER) k++;
      return k * g.step;
    };
    const wide = across(rasterizeWater(f, g, shapes, 400));
    expect(wide).toBeGreaterThanOrEqual(400 - 2 * g.step);
    expect(across(rasterizeWater(f, g, shapes, 0))).toBeLessThan(wide);
  });

  it("drops small ponds and stray river bits, keeps ponds on a river", () => {
    const w = new Uint8Array(n);
    w[5 * g.nx + 5] = WATER_LAKE; // lone pond
    w[5 * g.nx + 15] = WATER_RIVER; // stray bit of river area
    w[19 * g.nx + 20] = WATER_LAKE; // pond on a river
    for (let c = 0; c < g.nx; c++) w[20 * g.nx + c] = WATER_RIVER; // the river
    for (let r = 30; r < 40; r++) for (let c = 30; c < 40; c++) w[r * g.nx + c] = WATER_LAKE; // 100-cell lake
    expect(dropSmallWater(w, g, 50)).toBe(2);
    expect(w[5 * g.nx + 5]).toBe(WATER_NONE);
    expect(w[5 * g.nx + 15]).toBe(WATER_NONE);
    expect(w[19 * g.nx + 20]).toBe(WATER_LAKE);
    expect(w[35 * g.nx + 35]).toBe(WATER_LAKE);
  });

  it("smooths bumps but keeps an even slope", () => {
    const real = new Float32Array(n);
    for (let r = 0; r < g.ny; r++) for (let c = 0; c < g.nx; c++) real[r * g.nx + c] = 2 * c;
    const spike = 25 * g.nx + 25;
    real[spike] += 30;
    const s = smoothHeights(real, g, 3 * g.step);
    expect(s[spike] - 50).toBeLessThan(3);
    expect(s[25 * g.nx + 10]).toBeCloseTo(20, 4);
    expect(smoothHeights(real, g, 0)[spike]).toBe(real[spike]);
  });
});

describe("raster helpers", () => {
  it("labels connected regions and closes small gaps", () => {
    // A 1-cell-wide line with a 2-cell gap.
    const nx = 20, ny = 5;
    const m = new Uint8Array(nx * ny);
    for (let c = 0; c < nx; c++) if (c !== 9 && c !== 10) m[2 * nx + c] = 1;
    expect(labelComponents(m, nx, ny).sizes).toEqual([9, 9]);
    const closed = closeMask(m, nx, ny, 1.5);
    expect(labelComponents(closed, nx, ny).sizes).toHaveLength(1);
    expect(closed[2 * nx + 9]).toBe(1);
  });

  it("blur ignores NaN cells", () => {
    const g = Float32Array.from([1, NaN, 3, 3, 3]);
    const b = blurGrid(g, 5, 1, 2);
    expect(Number.isNaN(b[1])).toBe(true);
    // The window around cell 0 skips the NaN and reaches the 3s.
    expect(b[0]).toBeGreaterThan(1);
    expect(b[0]).toBeLessThan(3);
  });
});

describe("biomes and preview", () => {
  it("writes biome indices like the game export", () => {
    expect([0, 1, 2, 3, 4].map(biomeByte)).toEqual([0, 63, 127, 191, 255]);
    const t = { game: new Float32Array(2), water: Uint8Array.from([WATER_SEA, 0]), refHeight: 0, minM: 0, maxM: 1, waterShare: 0.5, maxSlope: 0 };
    expect([...biomeImage(Uint8Array.from([0, COVER_FOREST]), t, DEFAULT_BIOMES)]).toEqual([0, 127]);
  });

  it("river test map: one channel per width and depth, heights −10…5", () => {
    const nx = 600, ny = 500;
    const h = riverTestPattern(nx, ny);
    expect(h.reduce((a, b) => Math.min(a, b))).toBe(-10);
    expect(h.reduce((a, b) => Math.max(a, b))).toBe(5);
    // Widest channel (64 m = 16 samples) in the last column, deepest band at the bottom.
    const row = Math.floor(ny * 0.9);
    const cc = Math.round(nx * (5.5 / 6));
    expect(h[row * nx + cc]).toBe(-10);
    let width = 0;
    for (let c = cc - 20; c < cc + 20; c++) if (h[row * nx + c] < 0) width++;
    expect(width).toBe(16);
  });

  it("renders water blue and land opaque", () => {
    const t = { game: Float32Array.from([-5, 10, 10, 10]), water: Uint8Array.from([WATER_SEA, 0, 0, 0]), refHeight: 0, minM: -5, maxM: 10, waterShare: 0.25, maxSlope: 0 };
    const img = renderPreview(t, new Uint8Array(4), { nx: 2, ny: 2, step: 4 });
    expect(img.width).toBe(2);
    expect(img.rgba[2]).toBeGreaterThan(img.rgba[0]);
    expect(img.rgba[7]).toBe(255);
  });
});

describe("heightmap", () => {
  it("normalises to the full 16-bit range like the game's export", () => {
    const n = normalize16(Float32Array.from([-5, 0, 95]));
    expect([...n.data]).toEqual([0, 3277, 65535]);
  });

  it("widens the range to whole metres, as the Map Editor takes them", () => {
    const n = normalize16(Float32Array.from([-9.6, 0, 438.2]));
    expect([n.minM, n.maxM]).toEqual([-10, 439]);
    // Typing −10 / 439 in the editor gives the heights back.
    for (const [i, z] of [[0, -9.6], [1, 0], [2, 438.2]] as const) expect(-10 + (n.data[i] / 65535) * 449).toBeCloseTo(z, 1);
  });

  it("writes a 16-bit grayscale PNG", () => {
    const data = Uint16Array.from([0, 1000, 40000, 65535]);
    const png = decode(encodeHeightmapPng(2, 2, data));
    expect(png.depth).toBe(16);
    expect(png.channels).toBe(1);
    expect([...png.data]).toEqual([...data]);
  });
});

describe("towns", () => {
  it("reads free-text populations", () => {
    expect(parsePopulation("12 345")).toBe(12345);
    expect(parsePopulation("513,275")).toBe(513275);
    expect(parsePopulation("unknown")).toBeUndefined();
  });

  it("turns population into a game capacity (FACT-016)", () => {
    // With the old reference (300 for 10 000), the numbers checked in game.
    const T300 = { ...DEFAULT_TOWNS, refCapacity: 300 };
    expect(DEFAULT_TOWNS.refCapacity).toBe(100);
    expect(targetCapacity(10_000, T300)).toBe(300);
    expect(targetCapacity(2_000, T300)).toBe(134);
    expect(targetCapacity(100_000, T300)).toBe(949);
    expect(targetCapacity(513_275, T300)).toBe(2149);
    expect(targetCapacity(5_000_000, T300)).toBe(DEFAULT_TOWNS.maxCapacity);
    expect(targetCapacity(10, T300)).toBe(DEFAULT_TOWNS.minCapacity);
    expect(targetCapacity(100_000, { ...T300, sizeExponent: 1 })).toBe(DEFAULT_TOWNS.maxCapacity);
    expect(targetCapacity(100_000, { ...T300, sizeExponent: 0 })).toBe(300);
  });

  it("builds the Overpass query", () => {
    expect(overpassTownsQuery({ west: 4, south: 45, east: 5, north: 46 }, ["city"])).toContain('node["place"="city"]["name"](45,4,46,5);');
  });

  it("selects places by population (FACT-014: a 6 800-inhabitant 'village')", () => {
    const pl = (name: string, place: PlaceKind, population?: number): OsmPlace => ({ name, lon: 0, lat: 0, place, population });
    const places = [pl("Cherbourg", "town", 77808), pl("Valognes", "village", 6791), pl("Hameau", "village", 120), pl("Sans", "village"), pl("Ville", "city")];
    const names = (r: RankedPlace[]) => r.map((p) => p.name);
    expect(names(selectTowns(places, { minPopulation: 2000, includeUnknown: true }))).toEqual(["Cherbourg", "Ville", "Valognes"]);
    expect(names(selectTowns(places, { minPopulation: 2000, includeUnknown: false }))).toEqual(["Cherbourg", "Valognes"]);
    expect(names(selectTowns(places, { minPopulation: 0, includeUnknown: true }))).toContain("Sans");
  });

  it("puts manual picks first and honours removals", () => {
    const pl = (name: string, population: number, lon = 0): OsmPlace => ({ name, lon, lat: 0, place: "village", population });
    const places = [pl("Grande", 50_000), pl("Moyenne", 8_000), pl("Hameau", 150, 0.01)];
    const picks = { [placeKey(places[2])]: true, [placeKey(places[0])]: false };
    const sel = selectTowns(places, { minPopulation: 2000, includeUnknown: true }, picks);
    expect(sel.map((p) => [p.name, p.forced])).toEqual([["Hameau", true], ["Moyenne", false]]);
    expect(placeKey(places[2])).toBe("Hameau|0.0100,0.0000");
  });

  // A flat land map whose west quarter is sea (game metres, grid of 4 m-ish cells).
  const f = makeFrame(area({ scale: 3, size: 0 }));
  const g = previewGrid(f, 256);
  const seaCols = Math.floor(g.nx / 4);
  const terrain = () => {
    const game = new Float32Array(g.nx * g.ny).fill(10);
    const water = new Uint8Array(g.nx * g.ny);
    for (let r = 0; r < g.ny; r++) for (let c = 0; c < seaCols; c++) {
      water[r * g.nx + c] = WATER_SEA;
      game[r * g.nx + c] = -8;
    }
    return { game, water };
  };
  const coastX = cellToWorld(f, g, seaCols, 0)[0];
  const ranked = (name: string, x: number, y: number, population: number, forced = false) => {
    const [lon, lat] = frameProjection(f).toLonLat(x, y);
    const place: OsmPlace = { name, lon, lat, place: "town", population };
    return selectTowns([place], { minPopulation: 0, includeUnknown: true }, forced ? { [placeKey(place)]: true } : {})[0];
  };
  const opts = { ...DEFAULT_TOWNS, edgeMarginM: 200, waterClearanceM: 400, maxShiftM: 1500, minSpacingM: 500 };

  it("keeps a town on good ground where it is", () => {
    const { towns } = placeTowns(f, g, terrain(), [ranked("Inland", 800, 0, 50_000)], opts);
    expect(towns).toHaveLength(1);
    expect(towns[0].shift).toBeLessThan(1);
    expect(towns[0].x).toBeCloseTo(800, 0);
  });

  it("moves a coastal town inland, beyond the water clearance", () => {
    const { towns } = placeTowns(f, g, terrain(), [ranked("Port", coastX + 100, 0, 50_000)], opts);
    expect(towns).toHaveLength(1);
    expect(towns[0].x - coastX).toBeGreaterThanOrEqual(opts.waterClearanceM - g.step);
    expect(towns[0].shift).toBeGreaterThan(200);
    expect(towns[0].ox).toBeCloseTo(coastX + 100, 0);
  });

  it("drops a town with no valid ground within reach, and enforces spacing after moving", () => {
    const deep = ranked("Large", cellToWorld(f, g, 2, 0)[0], 0, 50_000); // far out at sea
    const a = ranked("A", 1000, 0, 50_000);
    const b = ranked("B", 1200, 0, 1_000);
    // The coast is ~1 000 m from "Large": out of reach with an 800 m shift.
    const { towns, dropped } = placeTowns(f, g, terrain(), [deep, a, b], { ...opts, maxShiftM: 800 });
    expect(towns.map((t) => t.name)).toEqual(["A"]);
    expect(dropped.map((d) => d.name)).toEqual(["Large", "B"]);
    expect(dropped[1].reason).toEqual({ key: "why.nearTown", params: { town: "A" } });
  });

  it("writes town positions in game metres, size factors 1 and the target capacities", () => {
    const { towns } = placeTowns(f, g, terrain(), [ranked("Lyon", 1000, 500, 513_275)], opts);
    const data = parseUserdata(toUserdata(townsIndustriesData(towns))) as { towns: { position: { x: number; y: number }; sizeFactors: number[] }[] };
    expect(data.towns[0].position.x).toBeCloseTo(1000, 0);
    expect(data.towns[0].position.y).toBeCloseTo(500, 0);
    expect(data.towns[0].sizeFactors).toEqual([1, 1, 1]);
    const sizes = parseUserdata(toUserdata({ towns: townSizesData(towns) })) as { towns: { name: string; capacity: number }[] };
    expect(sizes.towns[0]).toMatchObject({ name: "Lyon", capacity: targetCapacity(513_275, opts) });
  });

  it("adds and removes towns without swapping others in, and reports every place", () => {
    const pl = (name: string, population: number, lon: number): OsmPlace => ({ name, lon, lat: 0, place: "town", population });
    const places = [pl("A", 50_000, 0.01), pl("B", 40_000, 0.02), pl("C", 30_000, 0.03), pl("D", 1_000, 0.04)];
    const filter = { minPopulation: 2000, includeUnknown: true };
    const names = (picks: TownPicks) => selectTowns(places, filter, picks, 2).map((p) => p.name).sort();
    expect(names({})).toEqual(["A", "B"]);
    // Adding D: one more town; removing A: one fewer (C is not swapped in).
    expect(names({ [placeKey(places[3])]: true })).toEqual(["A", "B", "D"]);
    expect(names({ [placeKey(places[0])]: false })).toEqual(["B"]);
    const sel = selectTowns(places, filter, { [placeKey(places[3])]: true }, 2);
    const list = townCandidates(places, { [placeKey(places[3])]: true }, [], [], sel);
    expect(list.find((x) => x.name === "C")!.status).toBe("off");
    expect(list.find((x) => x.name === "D")!.pick).toBe(true);
  });

  it("indicative town limit of the game (FACT-021)", () => {
    expect(gameTownLimit({ tilesX: 32, tilesY: 32 })).toBe(13);
    expect(gameTownLimit({ tilesX: 56, tilesY: 56 })).toBe(41);
  });
});

describe("preview data", () => {
  it("hover grid and base64 round trip", () => {
    const t = { game: Float32Array.from([1, 2, 3, 4]), water: Uint8Array.from([0, 1, 0, 0]), refHeight: 0, minM: 1, maxM: 4, waterShare: 0.25, maxSlope: 0 };
    const h = hoverGrid(t, Uint8Array.from([0, 0, 1, 3]), { nx: 2, ny: 2, step: 4 }, 256);
    expect(h.cell).toBe(4);
    expect([...b64ToFloats(floatsToB64(h.heights))]).toEqual([1, 2, 3, 4]);
    expect([...b64ToBytes(bytesToB64(h.cover))]).toEqual([0, 0, 1, 3]);
  });
});
