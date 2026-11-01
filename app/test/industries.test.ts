import { describe, expect, it } from "vitest";
import { frameProjection, makeFrame, type Area } from "../src/lib/core/area";
import { cellToWorld, previewGrid, worldToCell } from "../src/lib/core/grid";
import {
  classifySite, DEFAULT_INDUSTRIES, defaultIndustryCount, footprintM, industryName, INDUSTRIES, INDUSTRY_TIER, ECONOMIES, industriesData, industryNoteData, overpassIndustryQuery, parseIndustrySites, planIndustries,
  type IndustrySite,
} from "../src/lib/core/industries";
import { WC_CROP, WC_TREE } from "../src/lib/core/landcover";
import { WATER_SEA } from "../src/lib/core/terrain";

describe("OSM sites → game industries", () => {
  it("maps quarries by resource, wells, platforms and factories", () => {
    expect(classifySite({ landuse: "quarry", resource: "sand" })).toBe("sand_pit");
    expect(classifySite({ landuse: "quarry", resource: "clay" })).toBe("clay_pit");
    expect(classifySite({ landuse: "quarry", resource: "coal" })).toBe("coal_mine");
    expect(classifySite({ landuse: "quarry" })).toBe("quarry");
    expect(classifySite({ man_made: "petroleum_well" })).toBe("oil_well");
    expect(classifySite({ man_made: "offshore_platform" })).toBe("oil_platform");
    expect(classifySite({ industrial: "refinery" })).toBe("oil_refinery");
    expect(classifySite({ man_made: "works", product: "steel" })).toBe("steel_mill");
    expect(classifySite({ craft: "brewery" })).toBe("brewery");
    expect(classifySite({ industrial: "sawmill" })).toBe("saw_mill");
    expect(classifySite({ landuse: "port" })).toBe("port");
    expect(classifySite({ man_made: "works" })).toBeNull();
  });

  it("reads Overpass centres and builds a light query", () => {
    const sites = parseIndustrySites({
      elements: [
        { type: "way", center: { lat: 45.7, lon: 4.8 }, tags: { landuse: "quarry", resource: "gravel", name: "Carrière X" } },
        { type: "node", lat: 45.6, lon: 4.9, tags: { man_made: "works" } },
      ],
    });
    expect(sites).toEqual([{ tag: "sand_pit", lon: 4.8, lat: 45.7, name: "Carrière X", why: "landuse=quarry resource=gravel" }]);
    expect(overpassIndustryQuery({ west: 4, south: 45, east: 5, north: 46 })).toContain("out center tags;");
  });

  it("knows the temperate economy from the game files", () => {
    expect(ECONOMIES.temperate.exclude).toContain("cement_plant");
    expect(ECONOMIES.temperate.chains.steel).toEqual(["coal_mine", "iron_ore_mine", "steel_mill"]);
    expect(ECONOMIES.temperate.fallbacks.oil_platform).toBe("oil_well");
  });
});

describe("industry plan", () => {
  const area = (patch: Partial<Area> = {}): Area => ({ lon: 4.8357, lat: 45.764, size: 1, format: 0, landscape: false, scale: 1, verticalScale: null, ...patch });
  const f = makeFrame(area());
  const g = previewGrid(f, 128);
  const n = g.nx * g.ny;
  const p = frameProjection(f);
  const site = (tag: string, x: number, y: number): IndustrySite => {
    const [lon, lat] = p.toLonLat(x, y);
    return { tag, lon, lat, why: "test" };
  };
  /** Flat land; optional sea in the west quarter (8 m deep). */
  const ground = (sea: boolean) => {
    const game = new Float32Array(n).fill(10);
    const water = new Uint8Array(n);
    if (sea) {
      for (let r = 0; r < g.ny; r++) for (let c = 0; c < g.nx / 4; c++) {
        water[r * g.nx + c] = WATER_SEA;
        game[r * g.nx + c] = -8;
      }
    }
    return { game, water };
  };
  const codes = (code: number) => new Uint8Array(n).fill(code);

  it("places an industry added by hand near its point, first", () => {
    const [lon, lat] = frameProjection(f).toLonLat(2000, -1500);
    const key = `user:brewery|${lon.toFixed(4)},${lat.toFixed(4)}`;
    const plan = planIndustries(f, g, ground(false), codes(WC_CROP), [], [], {}, { ...DEFAULT_INDUSTRIES, maxIndustries: 3 }, [], [], [{ key, tag: "brewery", lon, lat }]);
    const m = plan.industries.find((x) => x.key === key);
    expect(m?.origin).toBe("user");
    expect(Math.hypot(m!.x - 2000, m!.y + 1500)).toBeLessThan(600);
    expect(plan.candidates.find((c) => c.key === key)?.status).toBe("placed");
    // An industry the economy excludes is ignored.
    const no = planIndustries(f, g, ground(false), codes(WC_CROP), [], [], {}, DEFAULT_INDUSTRIES, [], [], [{ key: "user:tire_factory|0,0", tag: "tire_factory", lon, lat }]);
    expect(no.industries.some((x) => x.tag === "tire_factory")).toBe(false);
  });

  it("keeps a real brick works and adds its clay pit (chain completion)", () => {
    const plan = planIndustries(f, g, ground(false), codes(WC_TREE), [site("bricks_works", 0, 0)], [], {}, { ...DEFAULT_INDUSTRIES, maxIndustries: 6 });
    const tags = plan.industries.map((m) => m.tag);
    expect(tags).toContain("bricks_works");
    expect(tags).toContain("clay_pit");
    const works = plan.industries.find((m) => m.tag === "bricks_works")!;
    expect(Math.hypot(works.x, works.y)).toBeLessThan(DEFAULT_INDUSTRIES.minSpacingM);
    expect(plan.candidates.find((c) => c.tag === "clay_pit")!.origin).toBe("chain");
  });

  it("starts with tier 0 industries only, like a new game (DECISION-027)", () => {
    // A real steel mill (tier 1) is listed but not chosen; nor are its mines.
    const plan = planIndustries(f, g, ground(false), codes(WC_TREE), [site("steel_mill", 0, 0)], [], {}, { ...DEFAULT_INDUSTRIES, maxIndustries: 6 });
    expect(plan.industries.every((m) => INDUSTRY_TIER[m.tag] === 0)).toBe(true);
    const steel = plan.candidates.find((c) => c.tag === "steel_mill")!;
    expect(steel.status).toBe("off");
    // Added by the user, it is placed.
    const on = planIndustries(f, g, ground(false), codes(WC_TREE), [site("steel_mill", 0, 0)], [], { [steel.key]: true }, { ...DEFAULT_INDUSTRIES, maxIndustries: 6 });
    expect(on.industries.some((m) => m.tag === "steel_mill")).toBe(true);
  });

  it("an oil refinery inland gets an oil well (no water for a platform)", () => {
    const plan = planIndustries(f, g, ground(false), codes(WC_CROP), [site("oil_refinery", 0, 0)], [], {}, { ...DEFAULT_INDUSTRIES, maxIndustries: 4 });
    const tags = plan.industries.map((m) => m.tag);
    expect(tags).toContain("oil_well");
    expect(tags).not.toContain("oil_platform");
  });

  it("puts water industries on open water, land ones on land away from towns", () => {
    const gr = ground(true);
    const plan = planIndustries(f, g, gr, codes(WC_CROP), [site("oil_platform", -f.widthM * 0.4, 0), site("bricks_works", 1000, 1000)], [{ x: 1000, y: 1000 }], {}, { ...DEFAULT_INDUSTRIES, maxIndustries: 8 });
    const platform = plan.industries.find((m) => m.tag === "oil_platform")!;
    expect(platform.onWater).toBe(true);
    const [pc, pr] = worldToCell(f, g, platform.x, platform.y).map(Math.round);
    expect(gr.water[pr * g.nx + pc]).toBe(WATER_SEA);
    const works = plan.industries.find((m) => m.tag === "bricks_works")!;
    expect(Math.hypot(works.x - 1000, works.y - 1000)).toBeGreaterThanOrEqual(DEFAULT_INDUSTRIES.townClearanceM - g.step);
    expect(plan.industries.some((m) => m.tag === "farm")).toBe(true);
  });

  it("honours picks and writes the game's industry files", () => {
    const sites = [site("brewery", 0, 0)];
    const key = planIndustries(f, g, ground(false), codes(WC_CROP), sites, [], {}, DEFAULT_INDUSTRIES).candidates.find((c) => c.tag === "brewery")!.key;
    const off = planIndustries(f, g, ground(false), codes(WC_CROP), sites, [], { [key]: false }, DEFAULT_INDUSTRIES);
    expect(off.industries.some((m) => m.tag === "brewery")).toBe(false);
    expect(off.candidates.find((c) => c.key === key)!.status).toBe("off");
    const data = industriesData([{ key, tag: "brewery", label: "Brasserie", name: "Brasserie", x: 12.34, y: -5, onWater: false, origin: "osm" }]);
    expect(data[0]).toEqual({ position: { x: 12.3, y: -5 }, angle: 0, onWater: false, fileName: "::/industries/brewery/brewery.con", tag: "brewery" });
    // The note for the mod, which builds and names them (FACT-024).
    const note = industryNoteData([{ key, tag: "brewery", label: "Brasserie", name: "Brasserie Georges", x: 12.34, y: -5, onWater: false, origin: "osm" }]);
    expect(note[0]).toEqual({ tag: "brewery", x: 12.3, y: -5, angle: 0, onWater: false, fileName: "::/industries/brewery/brewery.con", name: "Brasserie Georges" });
  });

  it("with the automatic count, puts a base resource of every chain, like the game (DECISION-026)", () => {
    const big = makeFrame(area({ size: 3 }));
    const bg = previewGrid(big, 128);
    const m = bg.nx * bg.ny;
    const flat = { game: new Float32Array(m).fill(10), water: new Uint8Array(m) };
    // No real site, fields everywhere, no open water (platforms become wells, no fishing).
    const plan = planIndustries(big, bg, flat, new Uint8Array(m).fill(WC_CROP), [], [], {}, DEFAULT_INDUSTRIES);
    const tags = new Set(plan.industries.map((x) => x.tag));
    for (const t of ["farm", "forest", "clay_pit", "quarry", "oil_well"]) expect(tags, t).toContain(t);
    expect(tags.has("oil_platform") || tags.has("fishing_grounds")).toBe(false);
    expect([...tags].every((t) => INDUSTRY_TIER[t] === 0)).toBe(true);
    // Room left for more than the base resources (at least the game's count, 9 here).
    expect(plan.industries.length).toBeGreaterThanOrEqual(9);
    // A count set by hand stays the player's: no minimum added.
    expect(planIndustries(big, bg, flat, new Uint8Array(m).fill(WC_CROP), [], [], {}, { ...DEFAULT_INDUSTRIES, maxIndustries: 3 }).industries.length).toBeLessThanOrEqual(3);
  });

  it("uses the game's count for the density (FACT-021) and keeps whole chains", () => {
    expect(defaultIndustryCount(makeFrame(area({ size: 3 })), 2)).toBe(9);
    expect(defaultIndustryCount(makeFrame(area({ size: 3 })), 4)).toBe(13);
    expect(defaultIndustryCount(makeFrame(area({ size: 1 })), 0)).toBe(3);
    const sites = [site("oil_refinery", 0, 0), site("bricks_works", 2000, 0), site("quarry", -2000, 1500)];
    const plan = planIndustries(f, g, ground(false), codes(WC_CROP), sites, [], {}, { ...DEFAULT_INDUSTRIES, maxIndustries: 9 });
    expect(plan.industries.length).toBeLessThanOrEqual(9);
    const tags = new Set(plan.industries.map((m) => m.tag));
    for (const t of tags) {
      if (INDUSTRIES[t].primary) continue;
      expect(plan.candidates.find((c) => c.tag === t && c.status === "placed")!.missing).toBeUndefined();
    }
    // The real refinery wins over the fields everywhere: it comes with its oil well.
    expect(tags.has("oil_refinery") && tags.has("oil_well")).toBe(true);
  });

  it("removing an industry leaves a gap, adding one adds it (no swapping)", () => {
    const sites = [site("oil_refinery", 0, 0), site("bricks_works", 2000, 0)];
    const opts = { ...DEFAULT_INDUSTRIES, maxIndustries: 6 };
    const base = planIndustries(f, g, ground(false), codes(WC_CROP), sites, [], {}, opts);
    const clay = base.candidates.find((c) => c.tag === "clay_pit" && c.status === "placed")!;
    const off = planIndustries(f, g, ground(false), codes(WC_CROP), sites, [], { [clay.key]: false }, opts);
    expect(off.industries.length).toBe(base.industries.length - 1);
    expect(off.candidates.find((c) => c.key === clay.key)!.status).toBe("off");
    expect(off.candidates.find((c) => c.tag === "bricks_works")!.missing).toEqual(["clay_pit"]);
    const extra = base.candidates.find((c) => c.status === "off")!;
    const on = planIndustries(f, g, ground(false), codes(WC_CROP), sites, [], { [extra.key]: true }, opts);
    expect(on.industries.length).toBe(base.industries.length + 1);
  });

  it("keeps the whole footprint off rivers", () => {
    // A river (water, not open) 150 m east of the site: the old centre-only check (150 m) accepted it.
    const gr = ground(false);
    const riverX = 150;
    for (let r = 0; r < g.ny; r++) for (let c = 0; c < g.nx; c++) {
      const [x] = cellToWorld(f, g, c, r);
      if (Math.abs(x - riverX) < g.step) gr.water[r * g.nx + c] = 3;
    }
    const plan = planIndustries(f, g, gr, codes(WC_CROP), [site("quarry", 0, 0)], [], {}, { ...DEFAULT_INDUSTRIES, maxIndustries: 3 });
    const quarry = plan.industries.find((m) => m.tag === "quarry")!;
    expect(Math.abs(quarry.x - riverX)).toBeGreaterThanOrEqual(footprintM("quarry") + 30 - g.step);
  });

  it("names industries after the real site, else the nearest town", () => {
    expect(industryName("Ferme", "Bron")).toBe("Ferme de Bron");
    expect(industryName("Carrière", "Écully")).toBe("Carrière d'Écully");
    expect(industryName("Scierie", "Le Havre")).toBe("Scierie du Havre");
    expect(industryName("Brasserie", "Les Avenières")).toBe("Brasserie des Avenières");
    expect(industryName("Ferme", "Lens")).toBe("Ferme de Lens");
    // Other languages: their pattern and the game's industry name for the tag.
    const en = { pattern: "{town} {industry}", labels: { saw_mill: "Saw Mill" } };
    expect(industryName("Scierie", "Lyon", en, "saw_mill")).toBe("Lyon Saw Mill");
    expect(industryName("Scierie", "Lyon", { pattern: "{industry} di {town}", labels: { saw_mill: "Segheria" } }, "saw_mill")).toBe("Segheria di Lyon");
    const enPlan = planIndustries(
      f, g, ground(false), codes(WC_CROP), [], [{ x: 3000, y: 0, name: "Bron" }], {}, { ...DEFAULT_INDUSTRIES, maxIndustries: 4 }, [], [], [],
      { pattern: "{town} {industry}", labels: { farm: "Crop Farm" } },
    );
    expect(enPlan.industries.find((m) => m.tag === "farm")?.name).toBe("Bron Crop Farm");
    const named = { ...site("bricks_works", 0, 0), name: "Tuilerie Perrusson" };
    const plan = planIndustries(f, g, ground(false), codes(WC_CROP), [named], [{ x: 3000, y: 0, name: "Bron" }], {}, { ...DEFAULT_INDUSTRIES, maxIndustries: 4 });
    expect(plan.industries.find((m) => m.tag === "bricks_works")!.name).toBe("Tuilerie Perrusson");
    const farm = plan.industries.find((m) => m.tag === "farm")!;
    expect(farm.name).toBe("Ferme de Bron");
  });
});
