import { describe, expect, it } from "vitest";
import { packProject, projectTitle, unpackProject, type Inputs, type ProjectData } from "../src/lib/state/projectfile";
import { dataKeyOf, defaultSettings, migrateSettings, optionsKeyOf, SETTINGS_VERSION } from "../src/lib/state/settings";

function inputs(): Inputs {
  const dem = new Float32Array(100 * 100).map((_, i) => i * 0.5);
  return {
    ign: new Float32Array([1.5, NaN, 3.25, -4]),
    // A 1° tile at 0.01° (100 × 100) around 4.5°E 45.5°N.
    rasters: [{ west: 4, north: 46, resLon: 0.01, resLat: 0.01, width: 100, height: 100, data: dem, noData: -9999 }],
    water: [{ kind: "line", tags: { waterway: "river", name: "Rhône" }, pts: [[4.8, 45.7], [4.9, 45.8]] }],
    cover: [{ west: 4.7, north: 45.9, res: 0.001, width: 3, height: 2, data: new Uint8Array([10, 20, 30, 40, 50, 60]) }],
    bathy: [],
    bathySource: "EMODnet",
    places: [{ id: 1, name: "Lyon", kind: "city", lon: 4.83, lat: 45.76, population: 500000 }] as unknown as Inputs["places"],
    sites: [],
    roads: [{ kind: "road", cls: "primary", nodes: [1, 2], pts: [[4.8, 45.7], [4.81, 45.71]], name: "D 7" }],
    land: { beaches: [], business: [] },
    source: "IGN RGE ALTI",
  };
}

describe("project files", () => {
  it("packs and reads back settings, data, result and log", async () => {
    const settings = { ...defaultSettings(), name: "Lyon_test" };
    settings.townPicks = { "place:1": true };
    const p: ProjectData = {
      settings,
      data: { key: dataKeyOf(settings), inputs: inputs() },
      summary: { relief: "IGN RGE ALTI", water: 1 },
      preview: { url: "data:image/png;base64,AAAA", towns: [{ name: "Lyon" }] },
      previewKey: optionsKeyOf(settings),
      exportKey: "",
      result: null,
      log: [{ time: "12:00", level: "info", text: "Données récupérées" }],
    };
    // Cut to the area: a box of 0.2° around the centre.
    const bytes = await packProject(p, "1.1.1", { west: 4.7, south: 45.6, east: 4.9, north: 45.8 });
    const back = await unpackProject(bytes);
    expect(back.app).toBe("1.1.1");
    expect(back.settings).toEqual(settings);
    expect(back.previewKey).toBe(p.previewKey);
    expect(back.preview).toEqual(p.preview);
    expect(back.log).toEqual(p.log);
    expect(back.summary).toEqual(p.summary);
    const i = back.data!.inputs;
    expect(back.data!.key).toBe(p.data!.key);
    expect(Array.from(i.ign!)).toEqual([1.5, NaN, 3.25, -4]);
    expect(i.ign).toBeInstanceOf(Float32Array);
    expect(Array.from(i.cover![0].data)).toEqual([10, 20, 30, 40, 50, 60]);
    expect(i.cover![0].data).toBeInstanceOf(Uint8Array);
    expect(i.water).toEqual(p.data!.inputs.water);
    expect(i.roads).toEqual(p.data!.inputs.roads);
    // The DEM tile is cut to the box (and its 2-cell pad), same values where kept.
    const r = i.rasters[0];
    expect(r.width).toBeLessThan(100);
    expect(r.height).toBeLessThan(100);
    expect(r.noData).toBe(-9999);
    const orig = p.data!.inputs.rasters[0];
    const col = Math.round((r.west - orig.west) / orig.resLon);
    const row = Math.round((orig.north - r.north) / orig.resLat);
    expect(r.data[0]).toBe(orig.data[row * orig.width + col]);
  });

  it("packs a project without data", async () => {
    const settings = defaultSettings();
    const back = await unpackProject(await packProject({ settings, data: null, summary: null, preview: null, previewKey: "", exportKey: "", result: null, log: [] }, "1.1.1", null));
    expect(back.data).toBeNull();
    expect(back.preview).toBeNull();
    expect(back.settings).toEqual(settings);
  });

  it("refuses a file that is not a project", async () => {
    await expect(unpackProject(new Uint8Array([1, 2, 3]))).rejects.toThrow();
  });

  it("brings old settings to the current version and drops the game folder", () => {
    const old = { version: 7, name: "Old", userdata: "C:/game", area: { lon: 1, lat: 49 }, terrain: { riverMinWidth: 32, riverDepth: 10 } };
    const s = migrateSettings(old as never);
    expect(s.version).toBe(SETTINGS_VERSION);
    expect(s.name).toBe("Old");
    expect(s.area.lon).toBe(1);
    expect(s.area.size).toBe(defaultSettings().area.size);
    expect(s.terrain.riverMinWidth).toBe(defaultSettings().terrain.riverMinWidth);
    expect("userdata" in s).toBe(false);
  });

  it("names a project after its file", () => {
    expect(projectTitle("C:\\Users\\me\\Documents\\RealMap\\Lyon 1-3.realmap")).toBe("Lyon 1-3");
    expect(projectTitle("/home/me/Cherbourg.REALMAP")).toBe("Cherbourg");
  });
});
