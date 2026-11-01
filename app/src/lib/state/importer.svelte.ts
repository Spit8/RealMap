/**
 * App state: the chosen area and options, the preview (shown on the area map), and the import run that writes the heightmap, biome maps, town list and a note into the TF3
 * userdata folder.
 */
import { frameBBox, frameProjection, makeFrame, type Area, type Frame } from "$lib/core/area";
import { floatsToB64, bytesToB64 } from "$lib/core/b64";
import {
  DEFAULT_BIOMES, RIVER_TEST_DEPTHS, RIVER_TEST_LAND, RIVER_TEST_WIDTHS, riverTestPattern, type BiomeMapping,
} from "$lib/core/biomes";
import { copernicusTilesFor, type DemRaster } from "$lib/core/dem";
import { fullGrid, previewGrid, type Grid } from "$lib/core/grid";
import { encodeGray8Png, encodeHeightmapPng, normalize16 } from "$lib/core/heightmap";
import { inIgnCoverage } from "$lib/core/ign";
import { toUserdata } from "$lib/core/luadata";
import {
  availableFormats, availableSizes, MAP_FORMATS, MAP_SIZES, mapTiles, nearestAvailable, parseExperimentalMapFeatures,
} from "$lib/core/mapsizes";
import {
  DEFAULT_INDUSTRIES, industryNoteData, overpassIndustryQuery, parseIndustrySites,
  INDUSTRIES, type CustomIndustry, type IndustriesOptions, type IndustryCandidate, type IndustryNaming, type IndustryPicks,
  type IndustrySite, type MapIndustry,
} from "$lib/core/industries";
import { worldcoverLevel, type CoverRaster } from "$lib/core/landcover";
import { overpassLandQuery, parseLandUse, type LandUse } from "$lib/core/landuse";
import {
  bboxAreaKm2, isWaterShape, LARGE_AREA_KM2, minWaterPerimeterM, overpassAreaQuery, parseOverpassShapes, roundBbox,
  type OsmShape,
} from "$lib/core/osm";
import { DEFAULT_TERRAIN, type TerrainOptions } from "$lib/core/terrain";
import {
  diagnoseNoAnswer, gameProgress, gameSteps, isAlive, parseAlive, parseGameStatus, requestData, shouldResend,
  type GameAlive, type GameStatus,
} from "$lib/core/gamelink";
import { DEFAULT_RAIL, type RailOptions } from "$lib/core/railway";
import {
  networkData, overpassNetworkQuery, parseNetwork, type CustomRail, type LinkPicks, type NetworkPlan, type NetworkWay,
} from "$lib/core/network";
import {
  DEFAULT_TOWNS, parseOverpassPlaces, townsIndustriesData, townSizesData,
  type DroppedTown, type MapTown, type OsmPlace, type PlaceFilter, type TownCandidate, type TownPicks, type TownsOptions,
} from "$lib/core/towns";
import { loadBathymetry, loadDemTile, loadIgnGrid, loadLandcover, overpass } from "$lib/platform/download";
import { getVersion } from "@tauri-apps/api/app";
import { buildWarning, parseGameBuild, testedBuildsText } from "$lib/core/gamebuild";
import { appCacheDir } from "@tauri-apps/api/path";
import { ensureDir, fileStat, joinPath, readText, writeBytes, writeText } from "$lib/platform/fsx";
import { allowDirs, detectUserdata, gamePaths, sharedFile } from "$lib/platform/paths";
import type { TerrainMessage, TerrainRequest, TerrainStats } from "$lib/workers/terrain.worker";
import { MsgError } from "$lib/core/msg";
import { fmtNum, i18n, t, tk, tm, type MessageKey } from "$lib/i18n/index.svelte";
import { TILE_M } from "$lib/core/area";

const LS_KEY = "importcity.settings";

/** The mod's realmap_alive.lua in a game folder, and its age by the file's date (null = missing). */
async function readAlive(userdata: string): Promise<{ alive: GameAlive | null; ageMs: number | null }> {
  const path = sharedFile(userdata, "alive");
  const [text, st] = await Promise.all([readText(path), fileStat(path)]);
  return { alive: parseAlive(text), ageMs: st ? Math.max(0, Date.now() - st.mtimeMs) : null };
}
/**
 * Saved settings older than this get the defaults that changed since (v0.7: land at 0.5 m by the
 * shore; v0.8: rivers 64 m, steeper underwater slope; v0.12: rivers 14 m; v0.13: rivers and marshes
 * 20 m, 100 of capacity for 10 000 inhabitants), unless set by hand.
 */
const SETTINGS_VERSION = 11;
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
  /** Road links and railway lines added (true) or left out (false) by hand (by link key). */
  linkPicks: LinkPicks;
  /**
   * null: town roads chosen automatically (each town linked). Once a town road is changed by hand,
   * the automatic links of that moment, kept as they are: no road is added for the user any more.
   */
  roadsFrozen: string[] | null;
  /** Railway alignment (`railway.ts`). */
  rail: RailOptions;
  /** Industries added by hand on the map (right click). */
  customIndustries: CustomIndustry[];
  /** Railway lines added by hand between two points (following the real tracks when there are some). */
  customRails: CustomRail[];
}

const DEFAULTS: Settings = {
  version: SETTINGS_VERSION,
  name: "RealMap",
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
  roadsFrozen: null,
  rail: { ...DEFAULT_RAIL },
  customIndustries: [],
  customRails: [],
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
    if (v < 9 && terrain.riverDepth === 9) terrain.riverDepth = d.terrain.riverDepth;
    const towns = { ...d.towns, ...saved.towns };
    if (v < 10) {
      if (terrain.riverDepth === 14) terrain.riverDepth = d.terrain.riverDepth;
      if (terrain.marshDepth === 4) terrain.marshDepth = d.terrain.marshDepth;
      if (towns.refCapacity === 300) towns.refCapacity = d.towns.refCapacity;
    }
    return {
      version: SETTINGS_VERSION,
      name: saved.name ?? d.name,
      area,
      userdata: saved.userdata ?? d.userdata,
      source: saved.source ?? d.source,
      terrain,
      useCover: saved.useCover ?? d.useCover,
      // The biome mapping is no longer offered: always the defaults.
      biomes: d.biomes,
      // v0.2 town settings (townKinds, townScale, townSpacingM) and v0.4 `towns.scale` are dropped.
      places: { ...d.places, ...saved.places },
      towns,
      townPicks: saved.townPicks ?? {},
      industries: { ...d.industries, ...saved.industries },
      industryPicks: saved.industryPicks ?? {},
      linkPicks: saved.linkPicks ?? {},
      roadsFrozen: saved.roadsFrozen ?? null,
      rail: { ...d.rail, ...saved.rail },
      customIndustries: saved.customIndustries ?? [],
      customRails: saved.customRails ?? [],
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
  return s.trim().replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "RealMap";
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
  /** Beaches and commercial / industrial areas (OSM). */
  land: LandUse;
  source: string;
}

function rgbaToDataUrl(w: number, h: number, rgba: Uint8ClampedArray): string {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  canvas.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(rgba), w, h), 0, 0);
  return canvas.toDataURL("image/png");
}

/** "Cherbourg-en-Cotentin moved by 650 m" lines for the log, in the current language. */
export function townReport(towns: MapTown[], dropped: DroppedTown[]): string[] {
  const lines: string[] = [];
  for (const x of towns) {
    if (x.shift > 1) lines.push(t("msg.townMoved", { town: x.name, m: Math.round(x.shift), reason: x.moveReason ? tm(x.moveReason) : t("sheet.movedDefault") }));
  }
  for (const d of dropped) lines.push(t("msg.townDropped", { town: d.name, reason: tm(d.reason) }));
  return lines;
}

/** « il y a 3 h », « 2 days ago » for a cache age. */
function ageText(ms: number): string {
  const h = ms / 3_600_000;
  return h < 1 ? t("msg.ageNow") : h < 48 ? t("msg.ageHours", { n: Math.round(h) }) : t("msg.ageDays", { n: Math.round(h / 24) });
}

/** « Large (1 : 1) — 14.3 × 14.3 km » in the current language. */
export function sizeText(size: number, format: number, landscape: boolean): string {
  const w = mapTiles(size, format, landscape);
  const km = (m: number) => fmtNum(m / 1000, 1);
  return t("size.label", { size: tk(`size.${MAP_SIZES[size].id}`), format: MAP_FORMATS[format].label, w: km(w.tilesX * TILE_M), h: km(w.tilesY * TILE_M) });
}

/** Names of the generated industries in the current language (French keeps its own rules). */
function industryNaming(): IndustryNaming | undefined {
  if (i18n.locale === "fr") return undefined;
  const labels: Record<string, string> = {};
  for (const tag of Object.keys(INDUSTRIES)) labels[tag] = tk(`industry.${tag}`);
  return { pattern: t("industry.nameOf"), labels };
}

/** A readable message for anything thrown (Tauri plugins throw strings; some errors have no message). */
export function errorText(e: unknown): string {
  if (e instanceof MsgError) return tm(e.msg);
  if (e instanceof Error) return e.message || e.name || t("msg.noMessage");
  const s = typeof e === "string" ? e : JSON.stringify(e);
  return s && s !== "{}" ? s : t("msg.unknownError");
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
    landcover: i.cover ? t("msg.coverWindows", { n: i.cover.length }) : t("msg.noCover"),
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
  return JSON.stringify([s.area, s.source, s.terrain, s.useCover, s.biomes, s.places, s.towns, s.townPicks, s.industries, s.industryPicks, s.linkPicks, s.roadsFrozen, s.rail, s.customIndustries, s.customRails]);
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
  /** The stages the importcity mod runs in the game, shown under « Générer la carte ». */
  gameSteps = $state<DataStep[]>([]);
  /** What « Générer la carte » does in the app before handing over to the game. */
  exportSteps = $state<DataStep[]>([]);
  error = $state<string | null>(null);
  preview = $state<PreviewState | null>(null);
  result = $state<RunResult | null>(null);
  /** `experimentalMapFeatures` in the game's settings.lua: more map sizes and formats. */
  experimentalMaps = $state(false);
  /** The game's build at its last launch (its log), null when unknown. */
  gameBuild = $state<number | null>(null);

  frame = $derived(makeFrame(this.settings.area));
  /** Options that change the map (not the file name or folder): the preview is stale when they differ. */
  optionsKey = $derived(optionsKeyOf(this.settings));
  private previewKey = $state("");
  stale = $derived(!!this.preview && this.previewKey !== this.optionsKey);
  /** Options and map name of the last map sent to the game: the export is out of date when they differ. */
  private exportKey = $state("");
  exported = $derived(!!this.exportKey && this.exportKey === this.optionsKey + "|" + this.settings.name);

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

  /**
   * Before the first change of a town road: the automatic links become the user's (DECISION-018), so
   * removing one never brings in another.
   */
  private freezeRoads(key: string): void {
    if (!key.startsWith("town:") || this.settings.roadsFrozen) return;
    const picks = this.settings.linkPicks;
    this.settings.roadsFrozen = (this.preview?.network.links ?? [])
      .filter((l) => picks[l.key] === undefined)
      .map((l) => l.key);
  }

  /** Town roads back to the automatic choice: the roads added, removed or kept by hand are forgotten. */
  resetRoads(): void {
    const picks = { ...this.settings.linkPicks };
    for (const k of Object.keys(picks)) if (k.startsWith("town:")) delete picks[k];
    this.settings.linkPicks = picks;
    this.settings.roadsFrozen = null;
    this.refresh();
  }

  /** A road link or railway line left out by hand, or back in (the map redraws; the result is stale). */
  toggleLink(key: string): void {
    this.freezeRoads(key);
    const picks = { ...this.settings.linkPicks };
    if (picks[key] === false) delete picks[key];
    else picks[key] = false;
    this.settings.linkPicks = picks;
    this.save();
  }

  /** Recompute the result after a change made on the map (when there is one and nothing runs). */
  private refresh(): void {
    this.save();
    if (this.preview && !this.running) void this.runPreview();
  }

  /** An industry of type `tag` added by hand at lon / lat (right click on the map). */
  addIndustry(tag: string, lon: number, lat: number): void {
    const key = `user:${tag}|${lon.toFixed(4)},${lat.toFixed(4)}`;
    if (this.settings.customIndustries.some((c) => c.key === key)) return;
    this.settings.customIndustries = [...this.settings.customIndustries, { key, tag, lon, lat }];
    this.refresh();
  }

  removeCustomIndustry(key: string): void {
    this.settings.customIndustries = this.settings.customIndustries.filter((c) => c.key !== key);
    this.refresh();
  }

  /** A road between two towns (names), added by hand. */
  addRoad(a: string, b: string): void {
    if (a === b) return;
    const key = `town:${[a, b].sort().join("|")}`;
    this.freezeRoads(key);
    this.settings.linkPicks = { ...this.settings.linkPicks, [key]: true };
    this.refresh();
  }

  /**
   * Right click « Supprimer » on a road link or railway line: one added by hand is deleted, any other
   * is left out (or put back when it already was).
   */
  removeOrRestoreLink(key: string): void {
    const base = key.replace(/\.\d+$/, "");
    if (this.settings.linkPicks[key] === true) this.removeRoad(key);
    else if (base.startsWith("rail:user:") && this.settings.linkPicks[key] !== false) this.removeCustomRail(base);
    else this.toggleLink(key);
  }

  /** A road added by hand dropped (its pick forgotten). */
  removeRoad(key: string): void {
    this.freezeRoads(key);
    const picks = { ...this.settings.linkPicks };
    delete picks[key];
    this.settings.linkPicks = picks;
    this.refresh();
  }

  /** A railway line between two points, along the real tracks when there are some. */
  addRail(from: [number, number], to: [number, number]): void {
    const key = `rail:user:${Date.now().toString(36)}`;
    this.settings.customRails = [...this.settings.customRails, { key, from, to }];
    this.refresh();
  }

  removeCustomRail(key: string): void {
    this.settings.customRails = this.settings.customRails.filter((c) => c.key !== key);
    const picks = { ...this.settings.linkPicks };
    for (const k of Object.keys(picks)) if (k === key || k.startsWith(key + ".")) delete picks[k];
    this.settings.linkPicks = picks;
    this.refresh();
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
    this.gameBuild = parseGameBuild(await readText(joinPath(ud, "crash_dump", "stdout.txt")));
    if (this.gameBuild !== null) this.diag(`jeu : build ${this.gameBuild}`);
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
    const time = new Date().toLocaleTimeString(i18n.tag);
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
    this.error = where ? t("msg.errorIn", { where, error: msg }) : msg;
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
    if (st && state === "run") this.step = tk(`step.data.${id}`);
  }

  private snapshot(): Settings {
    return $state.snapshot(this.settings) as Settings;
  }

  private terrainOptions(s: Settings, f: Frame): TerrainOptions {
    return { ...s.terrain, verticalScale: f.verticalScale };
  }

  private exportState(id: string, state: DataStep["state"], detail?: string): void {
    this.exportSteps = this.exportSteps.map((d) => (d.id === id ? { ...d, state, detail: detail ?? d.detail } : d));
    const st = this.exportSteps.find((d) => d.id === id);
    if (st && state === "run") this.step = tk(`step.export.${id}`);
  }

  /**
   * Inputs at the game's resolution for « Générer la carte »: the phase-1 data (fetched first if
   * needed) with only what depends on the resolution downloaded again: the IGN relief on the 4 m
   * grid and the WorldCover windows at their finer level. OSM water, places, industrial sites,
   * roads and railways, the sea floor and the Copernicus tiles are reused as they are.
   */
  private async fullInputs(s: Settings, f: Frame, base: number, span: number): Promise<Inputs> {
    const at = (x: number) => (this.progress = base + span * x);
    const phase1 = await this.realInputs(s, base, span * 0.2);
    const g = fullGrid(f);
    let ign: Float32Array | null = null;
    let source = "Copernicus GLO-30";
    this.exportState("relief", "run");
    if (s.source === "ign" || (s.source === "auto" && inIgnCoverage(s.area.lon, s.area.lat))) {
      ign = await loadIgnGrid(f, g, (d, n) => {
        at(0.2 + (0.5 * d) / n);
        this.exportState("relief", "run", t("msg.ignBlocks", { d, n }));
      });
      if (ign) source = "IGN RGE ALTI";
    }
    let rasters = phase1.rasters;
    if ((!ign || ign.some((z) => !Number.isFinite(z))) && !rasters.length) {
      // The preview had full IGN cover but the 4 m grid has holes: Copernicus fills them.
      rasters = [];
      for (const tile of copernicusTilesFor(frameBBox(f, 200))) {
        if (!this.demCache.has(tile)) this.demCache.set(tile, await loadDemTile(tile));
        const r = this.demCache.get(tile);
        if (r) rasters.push(r);
      }
    }
    if (ign && rasters.length) source = "IGN RGE ALTI + Copernicus";
    this.exportState("relief", "done", source);
    let cover = phase1.cover;
    if (s.useCover) {
      this.exportState("cover", "run");
      try {
        cover = await loadLandcover(roundBbox(frameBBox(f)), worldcoverLevel(g.step * f.scale), (d, n) => at(0.7 + (0.3 * d) / Math.max(1, n)));
        this.exportState("cover", "done", t("msg.windows", { n: cover.length }));
      } catch (e) {
        this.exportState("cover", "fail", errorText(e));
        this.warn(t("msg.coverFullFailed", { error: errorText(e) }));
      }
    }
    at(1);
    return { ...phase1, ign, rasters, cover, source };
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
      { id: "land", label: "Plages et zones d'activité (OpenStreetMap)" },
    ].map((d) => ({ ...d, state: "wait" as const }));
    // OpenStreetMap first and in the background (two requests at once, other servers than the
    // relief and land cover): its waits overlap the downloads below.
    const bbox = roundBbox(frameBBox(f));
    const km2 = bboxAreaKm2(bbox);
    if (km2 > LARGE_AREA_KM2) this.warn(t("msg.largeArea", { km2: fmtNum(km2) }));
    const origins: Record<string, string> = {};
    const osm = <T>(step: string, query: string): Promise<{ ok: true; json: T } | { ok: false; error: unknown }> => {
      this.stepState(step, "run", t("msg.queued"));
      return overpass<T>(
        query,
        (sec, reason) => this.stepState(step, "run", sec > 0 ? t("msg.retryIn", { reason, s: sec }) : reason),
        bbox,
        (o) => {
          origins[step] = o.source === "cache" ? t("msg.fromCache", { age: ageText(o.ageMs) }) : t("msg.fromServer", { server: o.source, s: Math.round(o.ms / 1000) });
          this.diag(`OSM ${step} : ${o.source}, ${Math.round(o.ms / 100) / 10} s, ${Math.round(o.bytes / 1024)} Ko`);
        },
      ).then(
        (json) => ({ ok: true as const, json }),
        (error: unknown) => ({ ok: false as const, error }),
      );
    };
    const areaQ = osm<Parameters<typeof parseOverpassShapes>[0] & Parameters<typeof parseOverpassPlaces>[0]>(
      "osm",
      overpassAreaQuery(bbox, PLACE_KINDS, minWaterPerimeterM(f.scale)),
    );
    const networkQ = osm<Parameters<typeof parseNetwork>[0]>("roads", overpassNetworkQuery(bbox));
    const sitesQ = osm<Parameters<typeof parseIndustrySites>[0]>("sites", overpassIndustryQuery(bbox));
    const landQ = osm<Parameters<typeof parseLandUse>[0]>("land", overpassLandQuery(bbox));
    const detail = (step: string, text: string) => (origins[step] ? `${text} · ${origins[step]}` : text);
    let ign: Float32Array | null = null;
    let source = "Copernicus GLO-30";
    if (wantIgn) {
      this.stepState("ign", "run");
      ign = await loadIgnGrid(f, g, (d, n) => {
        at((0.4 * d) / n);
        this.stepState("ign", "run", t("msg.blocks", { d, n }));
      });
      if (ign) {
        source = "IGN RGE ALTI";
        this.stepState("ign", "done");
      } else {
        this.stepState("ign", "fail", t("msg.ignNone"));
        this.warn(t("msg.ignNoneWarn"));
      }
    }
    const rasters: DemRaster[] = [];
    if (!ign || ign.some((z) => !Number.isFinite(z))) {
      if (ign) source = "IGN RGE ALTI + Copernicus";
      const tiles = copernicusTilesFor(frameBBox(f, 200));
      for (const [i, tile] of tiles.entries()) {
        this.stepState("dem", "run", t("msg.tiles", { d: i + 1, n: tiles.length }));
        if (!this.demCache.has(tile)) this.demCache.set(tile, await loadDemTile(tile));
        const r = this.demCache.get(tile);
        if (r) rasters.push(r);
        at(0.4 + (0.2 * (i + 1)) / tiles.length);
      }
      this.stepState("dem", "done", t("msg.tilesDone", { n: rasters.length }));
    } else this.stepState("dem", "skip", t("msg.demSkipped"));
    let cover: CoverRaster[] | null = null;
    if (s.useCover) {
      this.stepState("cover", "run");
      try {
        cover = await loadLandcover(bbox, worldcoverLevel(g.step * f.scale), (d, n) => at(0.6 + (0.1 * d) / Math.max(1, n)));
        this.stepState("cover", "done", t("msg.windows", { n: cover.length }));
      } catch (e) {
        this.stepState("cover", "fail", errorText(e));
        this.warn(t("msg.coverFailed", { error: errorText(e) }));
      }
    }
    this.stepState("bathy", "run");
    const { rasters: bathy, source: bathySource } = await loadBathymetry(bbox);
    this.stepState("bathy", bathy.length ? "done" : "skip", bathySource);
    const area = await areaQ;
    if (!area.ok) {
      this.stepState("osm", "fail", errorText(area.error));
      throw area.error;
    }
    const water = parseOverpassShapes(area.json).filter(isWaterShape);
    const places = parseOverpassPlaces(area.json);
    this.stepState("osm", "done", detail("osm", t("msg.waterPlaces", { water: water.length, places: places.length })));
    at(0.85);
    // Industrial sites, the road / rail network and land use: without them the industries come
    // from the land cover only, no road or railway is planned, towns keep the usual split.
    let sites: IndustrySite[] = [];
    const sitesA = await sitesQ;
    if (sitesA.ok) {
      sites = parseIndustrySites(sitesA.json);
      this.stepState("sites", "done", detail("sites", t("msg.sites", { n: sites.length })));
    } else {
      this.stepState("sites", "fail", errorText(sitesA.error));
      this.warn(t("msg.sitesFailed", { error: errorText(sitesA.error) }));
    }
    at(0.92);
    let roads: NetworkWay[] = [];
    const networkA = await networkQ;
    if (networkA.ok) {
      roads = parseNetwork(networkA.json);
      const rails = roads.filter((w) => w.kind === "rail").length;
      this.stepState("roads", "done", detail("roads", t("msg.roadsRails", { roads: roads.length - rails, rails })));
    } else {
      this.stepState("roads", "fail", errorText(networkA.error));
      this.warn(t("msg.roadsFailed", { error: errorText(networkA.error) }));
    }
    let land: LandUse = { beaches: [], business: [] };
    const landA = await landQ;
    if (landA.ok) {
      land = parseLandUse(landA.json);
      this.stepState("land", "done", detail("land", t("msg.landCounts", { beaches: land.beaches.length, business: land.business.length })));
    } else {
      this.stepState("land", "fail", errorText(landA.error));
      this.warn(t("msg.landFailed", { error: errorText(landA.error) }));
    }
    this.diag(
      `données : relief ${source} (IGN ${ign ? "oui" : "non"}, ${rasters.length} dalles Copernicus), ` +
        `WorldCover ${cover ? `${cover.length} fenêtres` : "non"}, fonds marins ${bathySource}, ` +
        `OSM ${water.length} eaux / ${places.length} lieux / ${sites.length} sites industriels / ${roads.length} routes et voies`,
    );
    at(1);
    return { ign, rasters, water, cover, bathy, bathySource, places, sites, roads, land, source };
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
      roadsFrozen: s.roadsFrozen,
      naming: industryNaming(),
      rail: s.rail,
      land: inputs.land,
      customIndustries: s.customIndustries,
      customRails: s.customRails,
    };
  }

  private runWorker(req: TerrainRequest, base: number, span: number): Promise<Extract<TerrainMessage, { kind: "done" }>> {
    return new Promise((resolve, reject) => {
      const w = new Worker(new URL("../workers/terrain.worker.ts", import.meta.url), { type: "module" });
      w.onmessage = (ev: MessageEvent<TerrainMessage>) => {
        const m = ev.data;
        if (m.kind === "progress") {
          this.progress = base + span * m.value;
          this.step = tk(m.label);
        } else {
          w.terminate();
          if (m.kind === "done") resolve(m);
          else reject(new Error(m.message));
        }
      };
      w.onerror = (e) => {
        w.terminate();
        reject(new Error(e.message || (e.filename ? t("msg.workerFailedAt", { file: e.filename, line: e.lineno }) : t("msg.workerFailed"))));
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
      towns: done.towns.map((town) => {
        const [lon, lat] = p.toLonLat(town.x, town.y);
        return { ...town, lon, lat };
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
      t("msg.resultTerrain", { ref: Math.round(st.refHeight), min: st.minM, max: st.maxM, water: pct(st.waterShare), slope: pct(st.maxSlope) }),
      t("msg.resultRivers", {
        networks: st.riverPieces <= 1 ? t("msg.resultRiversOne") : t("msg.resultRiversMany", { n: st.riverPieces }),
        joined: st.riversJoined,
        routed: st.riversRouted,
        channels: st.waterBridged ?? 0,
        marsh: st.marshLakes ?? 0,
        ponds: st.lakesDropped,
        beach: st.beachCells ?? 0,
      }),
      t("msg.resultCounts", { towns: done.towns.length, industries: done.industries.length, links: links.length, rails: done.network?.rail.length ?? 0 }),
      ...(done.network?.rail ?? [])
        .filter((r) => r.design)
        .map((r) => {
          const d = r.design!;
          return t("msg.resultRail", {
            km: fmtNum(d.lengthM / 1000, 1),
            radius: d.minRadiusM,
            grade: fmtNum(d.maxGrade * 100, 1),
            bridges: d.bridges,
            high: d.maxBridgeM ?? 0,
            tunnels: d.tunnels,
          });
        }),
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
    // The result follows at once: the map is ready to export as it is.
    if (this.dataSummary && !this.dataStale) await this.runPreview();
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
      t("msg.dataSummary", {
        relief: d.relief, sea: d.seaFloor, cover: d.landcover, water: d.water, places: d.places, sites: d.sites, roads: d.roads, rails: d.railways,
      }),
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
      if (!s.userdata) throw new Error(t("msg.noUserdata"));
      this.result = null;
      const name = safeName(s.name);
      const paths = gamePaths(s.userdata);
      await allowDirs([s.userdata]);
      const f = makeFrame(s.area);
      const sizeLabel = sizeText(s.area.size, s.area.format, s.area.landscape);
      this.say(t("msg.sizeScale", { size: sizeLabel, scale: f.scale }));
      this.gameSteps = [];
      this.exportSteps = [
        { id: "relief", label: "Relief pleine résolution" },
        ...(s.useCover ? [{ id: "cover", label: "Occupation du sol pleine résolution" }] : []),
        { id: "compute", label: "Calcul de la carte complète" },
        { id: "files", label: "Écriture des fichiers" },
      ].map((d) => ({ ...d, state: "wait" as const }));
      const inputs = await this.fullInputs(s, f, 0, 0.3);
      this.say(t("msg.relief", { source: inputs.source }));
      const req = this.request(s, f, inputs, "full", inputs.ign);
      this.exportState("compute", "run");
      const done = await this.runWorker(req, 0.3, 0.25);
      this.exportState("compute", "done", t("msg.points", { w: done.width, h: done.height }));
      this.exportState("files", "run");
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
      await write(paths.townsIndustries, `${name}.lua`, toUserdata(townsIndustriesData(done.towns)));
      const st = done.stats;
      const createdAt = Math.floor(Date.now() / 1000);
      await write(
        paths.townsIndustries,
        `realmap_note_${name}.lua`,
        toUserdata({
          name,
          area: { ...s.area, verticalScale: f.verticalScale },
          mapSize: sizeLabel,
          tiles: [f.tilesX, f.tilesY],
          projection: f.proj,
          // Whole metres, as the Map Editor takes them; the mod imports the heightmap with them.
          minHeight: st.minM,
          maxHeight: st.maxM,
          waterLevel: 0,
          heightmap: name,
          biomes: { biomes: `${name}_biomes`, mountains: `${name}_mountains`, rivers: `${name}_rivers` },
          economy: s.industries.economy,
          refHeight: Math.round(st.refHeight * 100) / 100,
          samples: [done.width, done.height],
          townOptions: { ...s.towns, ...s.places },
          // Real town sizes the mod applies (FACT-016).
          towns: townSizesData(done.towns),
          // Industries the mod builds and names (the towns_industries import has no names, FACT-024).
          industries: industryNoteData(done.industries),
          // Town pairs and railway points the mod has the game build (DECISION-012).
          ...networkData(done.network ?? { links: [], rail: [] }, s.linkPicks),
          sources: {
            relief: inputs.source,
            water: "OpenStreetMap (ODbL)",
            towns: "OpenStreetMap (ODbL)",
            landcover: inputs.cover ? "ESA WorldCover 2021 v200 (CC BY 4.0)" : "relief",
            seaFloor: inputs.bathySource,
          },
          createdAt,
        }),
      );
      await write(paths.townsIndustries, "realmap_latest.lua", toUserdata({ name }));
      this.exportState("files", "done", t("msg.files", { n: files.length }));
      this.setPreview(s, f, done, inputs);
      this.say(t("msg.written", { name, n: files.length, dir: s.userdata }));
      this.result = { name, sizeLabel, stats: st, towns: done.towns, dropped: done.dropped, industries: done.industries.length, files };
      // Last: the request the importcity mod picks up in the Map Editor (everything above is ready).
      const id = Date.now();
      await write(paths.townsIndustries, "realmap_request.lua", toUserdata(requestData(name, createdAt, id)));
      this.say(t("msg.sent"));
      const answer = await this.watchGame(s.userdata, { name, createdAt, id }, sizeLabel, 0.6, 0.4);
      for (const line of answer.report) this.say(line);
      this.say(t("msg.generated", { name }));
      this.exportKey = optionsKeyOf(s) + "|" + s.name;
      this.progress = 1;
    });
  }

  /**
   * Follow the importcity mod's answer (`status.lua`) to `request`: stages in `gameSteps`, the
   * progress bar, an explicit error when the mod reports one. The mod's sign of life (`alive.lua`,
   * DECISION-024) says why it does not answer: the request is sent again once when the mod found it
   * there at start (sent while the Map Editor was loading), else the error names the cause.
   */
  private async watchGame(
    userdata: string, request: { name: string; createdAt: number; id: number }, sizeLabel: string, base: number, span: number,
  ): Promise<GameStatus> {
    const ACK_MS = 15_000;
    const STALL_MS = 5 * 60_000;
    const requestPath = sharedFile(userdata, "request");
    const sendRequest = (cancelled = false) =>
      writeText(requestPath, toUserdata(requestData(request.name, request.createdAt, id, cancelled)));
    this.gameSteps = gameSteps(null);
    let id = request.id;
    let resent = false;
    let start = Date.now();
    let changed = start;
    let seen = "";
    for (;;) {
      await new Promise((r) => setTimeout(r, 1000));
      const st = parseGameStatus(await readText(sharedFile(userdata, "status")));
      if (st && st.id === id) {
        const key = JSON.stringify(st);
        if (key !== seen) {
          seen = key;
          changed = Date.now();
          this.gameSteps = gameSteps(st);
          this.progress = base + span * gameProgress(st);
          this.step = t("msg.gameStep", { message: st.message || st.stage });
          this.diag(`jeu : ${st.stage} ${st.message}`);
        }
        if (st.stage === "done") return st;
        if (st.stage === "error") {
          for (const line of st.report) this.say(line);
          // The error is shown as « <step> : <message> »: the step says it comes from the game.
          this.step = t("msg.game");
          throw new Error(st.message);
        }
      } else {
        const { alive, ageMs } = await readAlive(userdata);
        if (!resent && shouldResend(alive, ageMs, id)) {
          resent = true;
          this.diag(`jeu : requête ${id} trouvée au démarrage du mod, renvoyée`);
          id = Date.now();
          start = changed = Date.now();
          await sendRequest();
          this.say(t("msg.resent"));
        } else if (Date.now() - start > ACK_MS) {
          // Given up: the mod must not run it later, while nobody follows it.
          await sendRequest(true).catch(() => {});
          this.gameSteps = [];
          this.step = t("msg.game");
          throw new Error(this.withBuildNote(await this.noAnswerMessage(userdata, alive, ageMs, sizeLabel)));
        }
      }
      if (Date.now() - changed > STALL_MS) {
        this.step = t("msg.game");
        throw new Error(t("msg.stalled"));
      }
    }
  }

  /** `message`, plus a reminder when the game is a build RealMap was not tested with. */
  private withBuildNote(message: string): string {
    const w = buildWarning(this.gameBuild);
    if (!w || this.gameBuild === null) return message;
    return `${message} ${t(w === "newer" ? "export.buildNewer" : "export.buildOlder", { build: this.gameBuild, tested: testedBuildsText() })}`;
  }

  /** Why the game did not answer, from the mod's alive.lua (here, or in another game folder). */
  private async noAnswerMessage(userdata: string, alive: GameAlive | null, ageMs: number | null, size: string): Promise<string> {
    let appVersion: string | null = null;
    try {
      appVersion = await getVersion();
    } catch {
      /* not in Tauri (tests) */
    }
    const why = diagnoseNoAnswer(alive, ageMs, appVersion);
    this.diag(`jeu muet : ${why}, alive ${alive ? JSON.stringify(alive) : "absent"}, âge ${ageMs ?? "-"} ms`);
    const log = joinPath(userdata, "crash_dump", "stdout.txt");
    switch (why) {
      case "notEditor":
        return t("msg.noAnswerNotEditor", { size });
      case "busy":
        return t("msg.noAnswerBusy");
      case "oldMod":
        return t("msg.noAnswerOldMod", { mod: alive?.version ?? "?", app: appVersion ?? "?" });
      case "notTaken":
        return t("msg.noAnswerNotTaken", { log });
    }
    // Silent here: is the mod alive in another game folder (another Steam account, say)?
    const { candidates } = await detectUserdata();
    const others = candidates.filter((c) => c.replace(/[\\/]+$/, "").toLowerCase() !== userdata.replace(/[\\/]+$/, "").toLowerCase());
    await allowDirs(others);
    for (const dir of others) {
      const other = await readAlive(dir);
      if (isAlive(other.alive, other.ageMs)) return t("msg.noAnswerOtherDir", { dir });
    }
    return t("msg.noAnswer", { size, dir: userdata });
  }

  /** Flat test map with channels of growing width and depth, to find what ships can use (QUESTION-009). */
  async writeRiverTest(): Promise<void> {
    await this.guard("test", async () => {
      const s = this.snapshot();
      if (!s.userdata) throw new Error(t("msg.noUserdata"));
      await allowDirs([s.userdata]);
      const { tilesX, tilesY } = mapTiles(s.area.size, s.area.format, s.area.landscape);
      const nx = tilesX * 64 + 1;
      const ny = tilesY * 64 + 1;
      const name = "RealMap_test_rivieres";
      const paths = gamePaths(s.userdata);
      await ensureDir(paths.heightmaps);
      await writeBytes(joinPath(paths.heightmaps, `${name}.png`), encodeHeightmapPng(nx, ny, normalize16(riverTestPattern(nx, ny)).data));
      [
        t("msg.testWritten", { name, size: sizeText(s.area.size, s.area.format, s.area.landscape) }),
        t("msg.testImport", { min: -Math.max(...RIVER_TEST_DEPTHS), max: RIVER_TEST_LAND }),
        t("msg.testColumns", { list: RIVER_TEST_WIDTHS.join(", ") }),
        t("msg.testRows", { list: RIVER_TEST_DEPTHS.join(", ") }),
        t("msg.testLayer"),
      ].forEach((l) => this.say(l));
    });
  }
}

export const importer = new Importer();
