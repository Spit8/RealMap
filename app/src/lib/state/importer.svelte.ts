/**
 * App state: the chosen area and options, the preview (shown on the area map), and the import run that writes the heightmap, biome maps, town list and a note into the TF3
 * userdata folder.
 */
import { frameBBox, frameProjection, makeFrame, type Area, type Frame } from "$lib/core/area";
import { floatsToB64, bytesToB64 } from "$lib/core/b64";
import {
  DEFAULT_BIOMES, RIVER_TEST_DEPTHS, RIVER_TEST_LAND, RIVER_TEST_WIDTHS, biomeTestPattern, riverTestPattern, type BiomeMapping,
} from "$lib/core/biomes";
import { copernicusTilesFor, type DemRaster } from "$lib/core/dem";
import { fullGrid, previewGrid, type Grid } from "$lib/core/grid";
import { encodeGray8Png, encodeHeightmapPng, normalize16 } from "$lib/core/heightmap";
import { inIgnCoverage } from "$lib/core/ign";
import { toUserdata } from "$lib/core/luadata";
import {
  availableFormats, availableSizes, mapSizeLabel, mapTiles, nearestAvailable, parseExperimentalMapFeatures,
} from "$lib/core/mapsizes";
import {
  DEFAULT_INDUSTRIES, industriesData, industryNamesData, overpassIndustryQuery, parseIndustrySites,
  type IndustriesOptions, type IndustryCandidate, type IndustryPicks, type IndustrySite, type MapIndustry,
} from "$lib/core/industries";
import { worldcoverLevel, type CoverRaster } from "$lib/core/landcover";
import {
  bboxAreaKm2, isWaterShape, LARGE_AREA_KM2, minWaterPerimeterM, overpassAreaQuery, parseOverpassShapes, roundBbox,
  type OsmShape,
} from "$lib/core/osm";
import { DEFAULT_TERRAIN, type TerrainOptions } from "$lib/core/terrain";
import {
  networkData, overpassNetworkQuery, parseNetwork, type LinkPicks, type NetworkPlan, type NetworkWay,
} from "$lib/core/network";
import {
  DEFAULT_TOWNS, parseOverpassPlaces, townsIndustriesData, townSizesData,
  type DroppedTown, type MapTown, type OsmPlace, type PlaceFilter, type TownCandidate, type TownPicks, type TownsOptions,
} from "$lib/core/towns";
import { loadBathymetry, loadDemTile, loadIgnGrid, loadLandcover, overpass } from "$lib/platform/download";
import { appCacheDir } from "@tauri-apps/api/path";
import { ensureDir, joinPath, readText, writeBytes, writeText } from "$lib/platform/fsx";
import { allowDirs, detectUserdata, gamePaths } from "$lib/platform/paths";
import type { TerrainMessage, TerrainRequest, TerrainStats } from "$lib/workers/terrain.worker";

const LS_KEY = "importcity.settings";
/**
 * Saved settings older than this get the defaults that changed since (v0.7: land at 0.5 m by the
 * shore; v0.8: rivers 64 m / 9 m like the game's, steeper underwater slope), unless set by hand.
 */
const SETTINGS_VERSION = 8;
/** Every place kind is fetched: in France the kind says little about size (FACT-014). */
const PLACE_KINDS = ["city", "town", "village"];

export type ReliefSource = "auto" | "ign" | "copernicus";

export interface Settings {
  version: number;
  name: string;
  area: Area;
  userdata: string;
  source: ReliefSource;
  terrain: Omit<TerrainOptions, "verticalScale">;
  useCover: boolean;
  biomes: BiomeMapping;
  places: PlaceFilter;
  towns: TownsOptions;
  /** Towns kept or removed by hand (by `placeKey`), on top of the population filter. */
  townPicks: TownPicks;
  industries: IndustriesOptions;
  /** Industries kept or removed by hand (by candidate key). */
  industryPicks: IndustryPicks;
  /** Road links and railway lines left out by hand (by link key). */
  linkPicks: LinkPicks;
}

const DEFAULTS: Settings = {
  version: SETTINGS_VERSION,
  name: "ImportCity",
  area: { lon: 4.8357, lat: 45.764, size: 3, format: 0, landscape: false, scale: 3, verticalScale: null },
  userdata: "",
  source: "auto",
  terrain: { ...DEFAULT_TERRAIN },
  useCover: true,
  biomes: structuredClone(DEFAULT_BIOMES),
  places: { minPopulation: 2000, includeUnknown: true },
  towns: { ...DEFAULT_TOWNS },
  townPicks: {},
  industries: { ...DEFAULT_INDUSTRIES },
  industryPicks: {},
  linkPicks: {},
};

function loadSettings(): Settings {
  const d = structuredClone(DEFAULTS);
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return d;
    const saved = JSON.parse(raw) as Partial<Settings> & Record<string, unknown>;
    // v0.1 areas had tilesX / tilesY: keep only the centre.
    const old = saved.area as Partial<Area> | undefined;
    const area = old?.size !== undefined ? { ...d.area, ...old } : { ...d.area, lon: old?.lon ?? d.area.lon, lat: old?.lat ?? d.area.lat };
    const terrain = { ...d.terrain, ...saved.terrain };
    const v = saved.version ?? 0;
    if (v < 7) terrain.landMin = d.terrain.landMin;
    if (v < 8) {
      if (terrain.riverMinWidth === 32) terrain.riverMinWidth = d.terrain.riverMinWidth;
      if (terrain.riverDepth === 10) terrain.riverDepth = d.terrain.riverDepth;
      if (terrain.underwaterSlope === 0.35) terrain.underwaterSlope = d.terrain.underwaterSlope;
    }
    return {
      version: SETTINGS_VERSION,
      name: saved.name ?? d.name,
      area,
      userdata: saved.userdata ?? d.userdata,
      source: saved.source ?? d.source,
      terrain,
      useCover: saved.useCover ?? d.useCover,
      biomes: { ...d.biomes, ...saved.biomes },
      // v0.2 town settings (townKinds, townScale, townSpacingM) and v0.4 `towns.scale` are dropped.
      places: { ...d.places, ...saved.places },
      towns: { ...d.towns, ...saved.towns },
      townPicks: saved.townPicks ?? {},
      industries: { ...d.industries, ...saved.industries },
      industryPicks: saved.industryPicks ?? {},
      linkPicks: saved.linkPicks ?? {},
    };
  } catch {
    return d;
  }
}

export type LogLevel = "info" | "warn" | "error" | "debug";
export interface LogEvent {
  time: string;
  level: LogLevel;
  text: string;
}

/** One phase-1 download step and how it went. */
export interface DataStep {
  id: string;
  label: string;
  state: "wait" | "run" | "done" | "skip" | "fail";
  detail?: string;
}

/** Everything the map needs to show the game result, JSON-safe. */
export interface PreviewState {
  frame: Frame;
  /** PNG data URL of the preview image (north up). */
  url: string;
  stats: TerrainStats;
  towns: (MapTown & { lon: number; lat: number })[];
  dropped: DroppedTown[];
  hover: { width: number; height: number; cell: number; heights: string; water: string; cover: string };
  source: string;
  coverOk: boolean;
  /** Every place of the map with its fate (placed, dropped, over the limit, not chosen). */
  candidates: TownCandidate[];
  industries: (MapIndustry & { lon: number; lat: number })[];
  industryCandidates: IndustryCandidate[];
  /** Road links and railway lines to build, paths in lon/lat for the map. */
  network: NetworkPlan & { ll: Record<string, [number, number][]> };
}

export interface RunResult {
  name: string;
  sizeLabel: string;
  stats: TerrainStats;
  towns: MapTown[];
  dropped: DroppedTown[];
  /** Industries written with the towns. */
  industries: number;
  files: string[];
}

/** Map Editor file names: letters, digits, `_` and `-` only. */
export function safeName(s: string): string {
  return s.trim().replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "ImportCity";
}

interface Inputs {
  ign: Float32Array | null;
  rasters: DemRaster[];
  water: OsmShape[];
  cover: CoverRaster[] | null;
  /** Sea-floor heights and where they come from. */
  bathy: DemRaster[];
  bathySource: string;
  places: OsmPlace[];
  /** Real industrial sites (OSM). */
  sites: IndustrySite[];
  /** Real main roads and railways (OSM). */
  roads: NetworkWay[];
  source: string;
}

function rgbaToDataUrl(w: number, h: number, rgba: Uint8ClampedArray): string {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  canvas.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(rgba), w, h), 0, 0);
  return canvas.toDataURL("image/png");
}

/** "Cherbourg-en-Cotentin déplacée de 650 m" lines for the log. */
export function townReport(towns: MapTown[], dropped: DroppedTown[]): string[] {
  const lines: string[] = [];
  for (const t of towns) if (t.shift > 1) lines.push(`${t.name} déplacée de ${Math.round(t.shift)} m (${t.moveReason ?? "terrain non constructible"})`);
  for (const d of dropped) lines.push(`${d.name} écartée : ${d.reason}`);
  return lines;
}

/** A readable message for anything thrown (Tauri plugins throw strings; some errors have no message). */
export function errorText(e: unknown): string {
  if (e instanceof Error) return e.message || e.name || "erreur sans message";
  const s = typeof e === "string" ? e : JSON.stringify(e);
  return s && s !== "{}" ? s : "erreur inconnue";
}

async function appendJournal(line: string): Promise<void> {
  try {
    const file = joinPath(await appCacheDir(), "importcity.log");
    const old = (await readText(file)) ?? "";
    await writeText(file, (old.length > 200_000 ? old.slice(-100_000) : old) + line + "\n");
  } catch {
    /* not in Tauri (browser preview, tests) */
  }
}

/** What the real data depends on (phase 1): the area and the sources. */
function dataKeyOf(s: Settings): string {
  const a = s.area;
  return JSON.stringify([a.lon, a.lat, a.size, a.format, a.landscape, a.scale, s.source, s.useCover]);
}

/** Phase 1 summary for the panel. */
export interface DataSummary {
  relief: string;
  seaFloor: string;
  landcover: string;
  water: number;
  places: number;
  sites: number;
  /** Real industrial sites per game industry. */
  sitesByTag: Record<string, number>;
  roads: number;
  railways: number;
}

/** Phase 1 layers drawn on the area map (« Données réelles »). */
export interface RealLayer {
  water: OsmShape[];
  places: OsmPlace[];
  sites: IndustrySite[];
  roads: NetworkWay[];
}

function summarize(i: Inputs): DataSummary {
  const sitesByTag: Record<string, number> = {};
  for (const s of i.sites) sitesByTag[s.tag] = (sitesByTag[s.tag] ?? 0) + 1;
  return {
    relief: i.source,
    seaFloor: i.bathySource,
    landcover: i.cover ? `ESA WorldCover (${i.cover.length} fenêtre${i.cover.length > 1 ? "s" : ""})` : "non (biomes déduits du relief)",
    water: i.water.length,
    places: i.places.length,
    sites: i.sites.length,
    sitesByTag,
    roads: i.roads.filter((w) => w.kind === "road").length,
    railways: i.roads.filter((w) => w.kind === "rail").length,
  };
}

/** Options that change the map (not the file name or folder): the preview is stale when they differ. */
function optionsKeyOf(s: Settings): string {
  return JSON.stringify([s.area, s.source, s.terrain, s.useCover, s.biomes, s.places, s.towns, s.townPicks, s.industries, s.industryPicks, s.linkPicks]);
}

class Importer {
  settings = $state<Settings>(loadSettings());
  candidates = $state<string[]>([]);
  running = $state<null | "data" | "preview" | "full" | "test">(null);
  progress = $state(0);
  step = $state("");
  /** The log panel: what happened, warnings, errors, and (debug) the technical journal. */
  events = $state<LogEvent[]>([]);
  /** Phase 1 steps, shown under « Récupérer les données ». */
  dataSteps = $state<DataStep[]>([]);
  error = $state<string | null>(null);
  preview = $state<PreviewState | null>(null);
  result = $state<RunResult | null>(null);
  /** `experimentalMapFeatures` in the game's settings.lua: more map sizes and formats. */
  experimentalMaps = $state(false);

  frame = $derived(makeFrame(this.settings.area));
  /** Options that change the map (not the file name or folder): the preview is stale when they differ. */
  optionsKey = $derived(optionsKeyOf(this.settings));
  private previewKey = $state("");
  stale = $derived(!!this.preview && this.previewKey !== this.optionsKey);

  private demCache = new Map<string, DemRaster | null>();
  /** Inputs of the last preview, reused while only terrain / biome / town options change. */
  private previewInputs: { key: string; inputs: Inputs } | null = null;
  /** Phase 1 results: what was fetched (shown in the panel) and the raw layers (shown on the map). */
  dataSummary = $state<DataSummary | null>(null);
  realLayer = $state.raw<RealLayer | null>(null);
  private dataKey = $state("");
  /** The area or the sources changed since the data was fetched. */
  dataStale = $derived(!!this.dataSummary && this.dataKey !== dataKeyOf(this.settings));

  save(): void {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(this.settings));
    } catch {
      /* storage unavailable */
    }
  }

  /**
   * Keep (true), remove (false) or hand back to the filter (null) one town, then refresh the
   * preview: the downloads are cached, only the terrain worker runs again.
   */
  setPick(key: string, pick: boolean | null): void {
    const picks = { ...this.settings.townPicks };
    if (pick === null) delete picks[key];
    else picks[key] = pick;
    this.settings.townPicks = picks;
    this.save();
    if (this.preview && !this.running) void this.runPreview();
  }

  /** A click on a town (map, preview or list): a chosen town is removed, any other is added. */
  toggleTown(key: string): void {
    const c = this.preview?.candidates.find((x) => x.key === key);
    if (c) this.setPick(key, c.status === "off");
  }

  /** Same for industries: keep (true), remove (false) or hand back to the automatic choice (null). */
  setIndustryPick(key: string, pick: boolean | null): void {
    const picks = { ...this.settings.industryPicks };
    if (pick === null) delete picks[key];
    else picks[key] = pick;
    this.settings.industryPicks = picks;
    this.save();
    if (this.preview && !this.running) void this.runPreview();
  }

  toggleIndustry(key: string): void {
    const c = this.preview?.industryCandidates?.find((x) => x.key === key);
    if (c) this.setIndustryPick(key, c.status === "off");
  }

  resetIndustryPicks(): void {
    this.settings.industryPicks = {};
    this.save();
    if (this.preview && !this.running) void this.runPreview();
  }

  /** All towns back to the filter (`auto`), or none at all (every place of the preview removed). */
  resetPicks(mode: "auto" | "none"): void {
    const picks: TownPicks = {};
    if (mode === "none") for (const c of this.preview?.candidates ?? []) picks[c.key] = false;
    this.settings.townPicks = picks;
    this.save();
    if (this.preview && !this.running) void this.runPreview();
  }

  async detect(): Promise<void> {
    const d = await detectUserdata();
    this.candidates = d.candidates;
    if (!this.settings.userdata && d.userdata) {
      this.settings.userdata = d.userdata;
      this.save();
    }
    await this.readGameSettings();
  }

  /**
   * Whether the game lists the experimental map sizes and formats (`<UD>/settings.lua`); a saved
   * choice the game would not offer moves to the nearest one it does.
   */
  async readGameSettings(): Promise<void> {
    const ud = this.settings.userdata;
    if (!ud) return;
    await allowDirs([ud]);
    const text = await readText(joinPath(ud, "settings.lua"));
    this.experimentalMaps = text ? parseExperimentalMapFeatures(text) ?? false : false;
    const a = this.settings.area;
    const size = nearestAvailable(a.size, availableSizes(this.experimentalMaps));
    const format = nearestAvailable(a.format, availableFormats(this.experimentalMaps));
    if (size !== a.size || format !== a.format) {
      this.settings.area = { ...a, size, format, landscape: format > 0 && a.landscape };
      this.save();
    }
  }

  /** One line in the log panel (and `<appcache>/importcity.log`). */
  private push(level: LogLevel, text: string): void {
    const time = new Date().toLocaleTimeString("fr-FR");
    this.events = [...this.events.slice(-399), { time, level, text }];
    void appendJournal(`${time} ${level} ${text}`);
  }

  private say(line: string): void {
    this.push("info", line);
  }

  private warn(line: string): void {
    this.push("warn", line);
  }

  /** Technical journal line (shown with « Détails » in the log panel). */
  diag(line: string): void {
    this.push("debug", line);
  }

  /** Report an error from anywhere (computation, rendering, unhandled promise) in the log. */
  report(e: unknown, where = ""): void {
    const msg = errorText(e);
    this.error = where ? `${where} : ${msg}` : msg;
    this.push("error", this.error);
    if (e instanceof Error && e.stack) this.diag(e.stack);
    console.error(e);
  }

  clearLog(): void {
    this.events = [];
  }

  /** Phase 1 step tracking: state and detail of one step. */
  private stepState(id: string, state: DataStep["state"], detail?: string): void {
    this.dataSteps = this.dataSteps.map((d) => (d.id === id ? { ...d, state, detail: detail ?? d.detail } : d));
    const st = this.dataSteps.find((d) => d.id === id);
    if (st && state === "run") this.step = st.label;
  }

  private snapshot(): Settings {
    return $state.snapshot(this.settings) as Settings;
  }

  private terrainOptions(s: Settings, f: Frame): TerrainOptions {
    return { ...s.terrain, verticalScale: f.verticalScale };
  }

  private async gather(s: Settings, f: Frame, g: Grid, base: number, span: number): Promise<Inputs> {
    const at = (x: number) => (this.progress = base + span * x);
    const wantIgn = s.source === "ign" || (s.source === "auto" && inIgnCoverage(s.area.lon, s.area.lat));
    this.dataSteps = [
      ...(wantIgn ? [{ id: "ign", label: "Relief IGN RGE ALTI" }] : []),
      { id: "dem", label: "Relief Copernicus GLO-30" },
      ...(s.useCover ? [{ id: "cover", label: "Occupation du sol (ESA WorldCover)" }] : []),
      { id: "bathy", label: "Fonds marins (EMODnet / ETOPO)" },
      { id: "osm", label: "Eau et lieux (OpenStreetMap)" },
      { id: "sites", label: "Sites industriels (OpenStreetMap)" },
      { id: "roads", label: "Routes et voies ferrées (OpenStreetMap)" },
    ].map((d) => ({ ...d, state: "wait" as const }));
    let ign: Float32Array | null = null;
    let source = "Copernicus GLO-30";
    if (wantIgn) {
      this.stepState("ign", "run");
      ign = await loadIgnGrid(f, g, (d, n) => {
        at((0.4 * d) / n);
        this.stepState("ign", "run", `${d}/${n} blocs`);
      });
      if (ign) {
        source = "IGN RGE ALTI";
        this.stepState("ign", "done");
      } else {
        this.stepState("ign", "fail", "pas de données ici : Copernicus");
        this.warn("IGN : pas de données ici, repli sur Copernicus.");
      }
    }
    const rasters: DemRaster[] = [];
    if (!ign || ign.some((z) => !Number.isFinite(z))) {
      if (ign) source = "IGN RGE ALTI + Copernicus";
      const tiles = copernicusTilesFor(frameBBox(f, 200));
      for (const [i, t] of tiles.entries()) {
        this.stepState("dem", "run", `${i + 1}/${tiles.length} tuiles`);
        if (!this.demCache.has(t)) this.demCache.set(t, await loadDemTile(t));
        const r = this.demCache.get(t);
        if (r) rasters.push(r);
        at(0.4 + (0.2 * (i + 1)) / tiles.length);
      }
      this.stepState("dem", "done", `${rasters.length} tuile${rasters.length > 1 ? "s" : ""}`);
    } else this.stepState("dem", "skip", "inutile (IGN complet)");
    const bbox = roundBbox(frameBBox(f));
    let cover: CoverRaster[] | null = null;
    if (s.useCover) {
      this.stepState("cover", "run");
      try {
        cover = await loadLandcover(bbox, worldcoverLevel(g.step * f.scale), (d, n) => at(0.6 + (0.1 * d) / Math.max(1, n)));
        this.stepState("cover", "done", `${cover.length} fenêtre${cover.length > 1 ? "s" : ""}`);
      } catch (e) {
        this.stepState("cover", "fail", errorText(e));
        this.warn(`Occupation du sol indisponible (${errorText(e)}) : biomes déduits du relief.`);
      }
    }
    this.stepState("bathy", "run");
    const { rasters: bathy, source: bathySource } = await loadBathymetry(bbox);
    this.stepState("bathy", bathy.length ? "done" : "skip", bathySource);
    const km2 = bboxAreaKm2(bbox);
    if (km2 > LARGE_AREA_KM2) this.warn(`Zone de ${Math.round(km2).toLocaleString("fr-FR")} km² : les requêtes OpenStreetMap peuvent être lentes.`);
    let osmStep = "osm";
    const wait = (sec: number, reason: string) =>
      this.stepState(osmStep, "run", sec > 0 ? `${reason}, nouvel essai dans ${sec} s` : reason);
    this.stepState("osm", "run");
    const json = await overpass<Parameters<typeof parseOverpassShapes>[0] & Parameters<typeof parseOverpassPlaces>[0]>(
      overpassAreaQuery(bbox, PLACE_KINDS, minWaterPerimeterM(f.scale)),
      wait,
    );
    const water = parseOverpassShapes(json).filter(isWaterShape);
    const places = parseOverpassPlaces(json);
    this.stepState("osm", "done", `${water.length} eaux, ${places.length} lieux`);
    at(0.85);
    // Industrial sites and the road / rail network: lighter queries of their own. Without them the
    // industries come from the land cover only, and no road or railway is planned.
    osmStep = "sites";
    this.stepState("sites", "run");
    let sites: IndustrySite[] = [];
    try {
      sites = parseIndustrySites(await overpass(overpassIndustryQuery(bbox), wait));
      this.stepState("sites", "done", `${sites.length} sites`);
    } catch (e) {
      this.stepState("sites", "fail", errorText(e));
      this.warn(`Sites industriels indisponibles (${errorText(e)}) : industries déduites de l'occupation du sol.`);
    }
    at(0.92);
    osmStep = "roads";
    this.stepState("roads", "run");
    let roads: NetworkWay[] = [];
    try {
      roads = parseNetwork(await overpass(overpassNetworkQuery(bbox), wait));
      const rails = roads.filter((w) => w.kind === "rail").length;
      this.stepState("roads", "done", `${roads.length - rails} routes, ${rails} voies ferrées`);
    } catch (e) {
      this.stepState("roads", "fail", errorText(e));
      this.warn(`Routes et voies ferrées indisponibles (${errorText(e)}) : aucune liaison prévue.`);
    }
    this.diag(
      `données : relief ${source} (IGN ${ign ? "oui" : "non"}, ${rasters.length} dalles Copernicus), ` +
        `WorldCover ${cover ? `${cover.length} fenêtres` : "non"}, fonds marins ${bathySource}, ` +
        `OSM ${water.length} eaux / ${places.length} lieux / ${sites.length} sites industriels / ${roads.length} routes et voies`,
    );
    at(1);
    return { ign, rasters, water, cover, bathy, bathySource, places, sites, roads, source };
  }

  private request(s: Settings, f: Frame, inputs: Inputs, mode: "preview" | "full", ign: Float32Array | null): TerrainRequest {
    return {
      area: s.area,
      mode,
      ign,
      rasters: inputs.rasters,
      bathy: inputs.bathy,
      water: inputs.water,
      cover: inputs.cover,
      terrain: this.terrainOptions(s, f),
      biomes: s.biomes,
      places: inputs.places,
      filter: s.places,
      picks: s.townPicks,
      towns: s.towns,
      sites: inputs.sites,
      industryPicks: s.industryPicks,
      industries: s.industries,
      roads: inputs.roads,
      linkPicks: s.linkPicks,
    };
  }

  private runWorker(req: TerrainRequest, base: number, span: number): Promise<Extract<TerrainMessage, { kind: "done" }>> {
    return new Promise((resolve, reject) => {
      const w = new Worker(new URL("../workers/terrain.worker.ts", import.meta.url), { type: "module" });
      w.onmessage = (ev: MessageEvent<TerrainMessage>) => {
        const m = ev.data;
        if (m.kind === "progress") {
          this.progress = base + span * m.value;
          this.step = m.label;
        } else {
          w.terminate();
          if (m.kind === "done") resolve(m);
          else reject(new Error(m.message));
        }
      };
      w.onerror = (e) => {
        w.terminate();
        reject(new Error(e.message || `le calcul (worker) a échoué${e.filename ? ` dans ${e.filename}:${e.lineno}` : ""}`));
      };
      // The IGN grid is used once; DEM rasters stay cached here (copied, not transferred).
      w.postMessage(req, req.ign ? [req.ign.buffer] : []);
    });
  }

  private setPreview(s: Settings, f: Frame, done: Extract<TerrainMessage, { kind: "done" }>, inputs: Inputs): void {
    this.previewKey = optionsKeyOf(s);
    const p = frameProjection(f);
    const h = done.hover;
    this.preview = {
      frame: f,
      url: rgbaToDataUrl(done.preview.width, done.preview.height, done.preview.rgba),
      stats: done.stats,
      towns: done.towns.map((t) => {
        const [lon, lat] = p.toLonLat(t.x, t.y);
        return { ...t, lon, lat };
      }),
      dropped: done.dropped,
      hover: { width: h.width, height: h.height, cell: h.cell, heights: floatsToB64(h.heights), water: bytesToB64(h.water), cover: bytesToB64(h.cover) },
      source: inputs.source,
      coverOk: inputs.cover !== null,
      // A worker from an older build (hot reload) sends no list: never leave it undefined.
      candidates: done.candidates ?? [],
      industries: (done.industries ?? []).map((m) => {
        const [lon, lat] = p.toLonLat(m.x, m.y);
        return { ...m, lon, lat };
      }),
      industryCandidates: done.industryCandidates ?? [],
      network: {
        ...(done.network ?? { links: [], rail: [] }),
        ll: Object.fromEntries(
          [...(done.network?.links ?? []), ...(done.network?.rail ?? [])].map((l) => [l.key, l.pts.map(([x, y]) => p.toLonLat(x, y))]),
        ),
      },
    };
    this.reportResult(done);
  }

  /** What the last computation gave, in the log (once per change). */
  private lastReport = "";
  private reportResult(done: Extract<TerrainMessage, { kind: "done" }>): void {
    const st = done.stats;
    const pct = (x: number) => `${Math.round(x * 100)} %`;
    const links = done.network?.links ?? [];
    const lines = [
      `Résultat : niveau de l'eau = ${Math.round(st.refHeight)} m réels, hauteurs ${st.minM} → ${st.maxM} m, eau ${pct(st.waterShare)}, pentes fortes ${pct(st.maxSlope)}.`,
      `Rivières : ${st.riverPieces <= 1 ? "un seul réseau" : `${st.riverPieces} réseaux séparés`}, ${st.riversJoined} jonctions, ${st.riversRouted} tracés jusqu'à l'eau, ${st.waterBridged ?? 0} chenaux, ${st.marshLakes ?? 0} marais en lacs, ${st.lakesDropped} étangs comblés.`,
      `${done.towns.length} villes, ${done.industries.length} industries, ${links.filter((l) => l.kind === "town").length} liaisons entre villes, ${links.filter((l) => l.kind === "industry").length} vers des industries, ${done.network?.rail.length ?? 0} voie(s) ferrée(s).`,
    ];
    const report = townReport(done.towns, done.dropped);
    const key = JSON.stringify([lines, report]);
    if (key === this.lastReport) return;
    this.lastReport = key;
    for (const l of lines) this.say(l);
    for (const l of report) this.warn(l);
  }

  private async guard(kind: "data" | "preview" | "full" | "test", fn: () => Promise<void>): Promise<void> {
    if (this.running) return;
    this.running = kind;
    this.error = null;
    this.progress = 0;
    this.diag(`début : ${kind}`);
    try {
      await fn();
      this.diag(`fin : ${kind}`);
    } catch (e) {
      this.report(e, this.step || kind);
    } finally {
      this.running = null;
      this.step = "";
    }
  }

  /** Quick look on a coarse grid; downloads are cached, so re-running after a tweak is fast. */
  /** Phase 1: download (or take from the caches) the real data of the area, at preview resolution. */
  async fetchData(): Promise<void> {
    await this.guard("data", async () => {
      await this.realInputs(this.snapshot(), 0, 1);
    });
  }

  /** Real data for the current area (phase 1), downloaded only when the area or sources changed. */
  private async realInputs(s: Settings, base: number, span: number): Promise<Inputs> {
    const f = makeFrame(s.area);
    const key = dataKeyOf(s);
    if (this.previewInputs?.key === key) return this.previewInputs.inputs;
    const inputs = await this.gather(s, f, previewGrid(f), base, span);
    this.previewInputs = { key, inputs };
    this.dataKey = key;
    this.realLayer = { water: inputs.water, places: inputs.places, sites: inputs.sites, roads: inputs.roads };
    this.dataSummary = summarize(inputs);
    const d = this.dataSummary;
    this.say(
      `Données : relief ${d.relief}, fonds marins ${d.seaFloor}, ${d.landcover}, ${d.water} eaux, ${d.places} lieux, ` +
        `${d.sites} sites industriels, ${d.roads} routes, ${d.railways} voies ferrées.`,
    );
    return inputs;
  }

  /** Phase 2: turn the real data into the game map (coarse grid); fetches the data first if needed. */
  async runPreview(): Promise<void> {
    await this.guard("preview", async () => {
      const s = this.snapshot();
      const f = makeFrame(s.area);
      const inputs = await this.realInputs(s, 0, 0.7);
      const req = this.request(s, f, inputs, "preview", inputs.ign ? Float32Array.from(inputs.ign) : null);
      const done = await this.runWorker(req, 0.7, 0.3);
      this.setPreview(s, f, done, inputs);
      this.diag(`aperçu : ${done.towns.length} villes, ${done.candidates.length} lieux`);
    });
  }

  /** Full resolution: writes every file the Map Editor imports. */
  async run(): Promise<void> {
    await this.guard("full", async () => {
      const s = this.snapshot();
      if (!s.userdata) throw new Error("Dossier userdata de TF3 introuvable : renseigne-le dans les réglages.");
      this.result = null;
      const name = safeName(s.name);
      const paths = gamePaths(s.userdata);
      await allowDirs([s.userdata]);
      const f = makeFrame(s.area);
      const sizeLabel = mapSizeLabel(s.area.size, s.area.format, s.area.landscape);
      this.say(`${sizeLabel} · échelle 1:${f.scale}`);
      const inputs = await this.gather(s, f, fullGrid(f), 0, 0.5);
      this.say(`Relief : ${inputs.source}`);
      const req = this.request(s, f, inputs, "full", inputs.ign);
      const done = await this.runWorker(req, 0.5, 0.45);
      const files: string[] = [];
      const write = async (dir: string, file: string, data: Uint8Array | string) => {
        await ensureDir(dir);
        const path = joinPath(dir, file);
        if (typeof data === "string") await writeText(path, data);
        else await writeBytes(path, data);
        files.push(path);
      };
      const biomesDir = joinPath(s.userdata, "biomes");
      await write(paths.heightmaps, `${name}.png`, done.files!.heightmap);
      await write(biomesDir, `${name}_biomes.png`, done.files!.biomes);
      await write(biomesDir, `${name}_mountains.png`, done.files!.mountains);
      await write(biomesDir, `${name}_rivers.png`, done.files!.rivers);
      await write(paths.townsIndustries, `${name}.lua`, toUserdata(townsIndustriesData(done.towns, industriesData(done.industries))));
      const st = done.stats;
      await write(
        paths.notes,
        `${name}.lua`,
        toUserdata({
          name,
          area: { ...s.area, verticalScale: f.verticalScale },
          mapSize: sizeLabel,
          tiles: [f.tilesX, f.tilesY],
          projection: f.proj,
          minHeight: Math.round(st.minM * 100) / 100,
          maxHeight: Math.round(st.maxM * 100) / 100,
          waterLevel: 0,
          refHeight: Math.round(st.refHeight * 100) / 100,
          samples: [done.width, done.height],
          townOptions: { ...s.towns, ...s.places },
          // Read by the importcity mod (« Appliquer les tailles réelles », FACT-016).
          towns: townSizesData(done.towns),
          // Names the mod gives the industries after their import (the import file has no name, FACT-024).
          industries: industryNamesData(done.industries),
          // Roads (town pairs, one industry per town) and railway points the mod has the game build.
          ...networkData(done.network ?? { links: [], rail: [] }, s.linkPicks),
          sources: {
            relief: inputs.source,
            water: "OpenStreetMap (ODbL)",
            towns: "OpenStreetMap (ODbL)",
            landcover: inputs.cover ? "ESA WorldCover 2021 v200 (CC BY 4.0)" : "relief",
            seaFloor: inputs.bathySource,
          },
          createdAt: Math.floor(Date.now() / 1000),
        }),
      );
      // The importcity mod applies the sizes of the last map written (« Appliquer les tailles réelles »).
      await write(paths.notes, "latest.lua", toUserdata({ name }));
      this.setPreview(s, f, done, inputs);
      this.say(`Carte « ${name} » écrite : ${files.length} fichiers dans ${s.userdata}.`);
      this.progress = 1;
      this.result = { name, sizeLabel, stats: st, towns: done.towns, dropped: done.dropped, industries: done.industries.length, files };
    });
  }

  /** Flat test map with the five biomes as west→east stripes (QUESTION-002). */
  async writeBiomeTest(): Promise<void> {
    await this.guard("test", async () => {
      const s = this.snapshot();
      if (!s.userdata) throw new Error("Dossier userdata de TF3 introuvable.");
      await allowDirs([s.userdata]);
      const { tilesX, tilesY } = mapTiles(s.area.size, s.area.format, s.area.landscape);
      const nx = tilesX * 64 + 1;
      const ny = tilesY * 64 + 1;
      const { heights, biomes } = biomeTestPattern(nx, ny);
      const name = "ImportCity_test_biomes";
      const paths = gamePaths(s.userdata);
      const biomesDir = joinPath(s.userdata, "biomes");
      await ensureDir(paths.heightmaps);
      await ensureDir(biomesDir);
      await writeBytes(joinPath(paths.heightmaps, `${name}.png`), encodeHeightmapPng(nx, ny, normalize16(heights).data));
      await writeBytes(joinPath(biomesDir, `${name}_biomes.png`), encodeGray8Png(nx, ny, biomes));
      const empty = new Uint8Array(nx * ny);
      await writeBytes(joinPath(biomesDir, `${name}_mountains.png`), encodeGray8Png(nx, ny, empty));
      await writeBytes(joinPath(biomesDir, `${name}_rivers.png`), encodeGray8Png(nx, ny, empty));
      [
        `Carte de test écrite : ${name} (${mapSizeLabel(s.area.size, s.area.format, s.area.landscape)}).`,
        "Import Heightmap → Minimum 5, Maximum 25, Water Level 0 ; puis Biomes → " + name + ".",
        "Les bandes vont de l'ouest (biome 0) à l'est (biome 4) : décris ce que tu vois dans chacune.",
      ].forEach((l) => this.say(l));
    });
  }

  /** Flat test map with channels of growing width and depth, to find what ships can use (QUESTION-009). */
  async writeRiverTest(): Promise<void> {
    await this.guard("test", async () => {
      const s = this.snapshot();
      if (!s.userdata) throw new Error("Dossier userdata de TF3 introuvable.");
      await allowDirs([s.userdata]);
      const { tilesX, tilesY } = mapTiles(s.area.size, s.area.format, s.area.landscape);
      const nx = tilesX * 64 + 1;
      const ny = tilesY * 64 + 1;
      const name = "ImportCity_test_rivieres";
      const paths = gamePaths(s.userdata);
      await ensureDir(paths.heightmaps);
      await writeBytes(joinPath(paths.heightmaps, `${name}.png`), encodeHeightmapPng(nx, ny, normalize16(riverTestPattern(nx, ny)).data));
      [
        `Carte de test écrite : ${name} (${mapSizeLabel(s.area.size, s.area.format, s.area.landscape)}).`,
        `Import Heightmap → Minimum ${-Math.max(...RIVER_TEST_DEPTHS)}, Maximum ${RIVER_TEST_LAND}, Water Level 0.`,
        `Colonnes (ouest → est) : chenaux de ${RIVER_TEST_WIDTHS.join(", ")} m de large.`,
        `Bandes (nord → sud) : ${RIVER_TEST_DEPTHS.join(", ")} m de profondeur.`,
        "Affiche le calque « Navigable Waters » (eaux navigables) et note les chenaux colorés.",
      ].forEach((l) => this.say(l));
    });
  }
}

export const importer = new Importer();
