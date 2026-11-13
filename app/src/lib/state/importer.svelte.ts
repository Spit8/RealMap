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
import { fullGrid, gridSamples, previewGrid, TESTED_MAX_SAMPLES, type Grid } from "$lib/core/grid";
import { encodeGray8Png, encodeHeightmapPng, normalize16 } from "$lib/core/heightmap";
import { inIgnCoverage } from "$lib/core/ign";
import { toUserdata } from "$lib/core/luadata";
import {
  isExperimental, MAP_FORMATS, MAP_SIZES, mapTiles, parseExperimentalMapFeatures,
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
import { DEFAULT_RAIL, gameGrade, type RailOptions } from "$lib/core/railway";
import {
  DEFAULT_NETWORK, networkData, overpassNetworkQuery, roadNetworks, parseNetwork, type CustomRail, type LinkPicks, type NetworkPlan, type NetworkWay,
} from "$lib/core/network";
import {
  DEFAULT_TOWNS, parseOverpassPlaces, townsIndustriesData, townSizesData,
  type DroppedTown, type MapTown, type OsmPlace, type PlaceFilter, type TownCandidate, type TownPicks, type TownsOptions,
} from "$lib/core/towns";
import { loadBathymetry, loadDemTile, loadIgnGrid, loadLandcover, overpass } from "$lib/platform/download";
import type { RetryNotice } from "$lib/platform/fetchbytes";
import { getVersion } from "@tauri-apps/api/app";
import { buildWarning, parseGameBuild, testedBuildsText } from "$lib/core/gamebuild";
import { appCacheDir } from "@tauri-apps/api/path";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { ensureDir, fileStat, joinPath, readBytes, readText, renamePath, writeBytes, writeText } from "$lib/platform/fsx";
import { allowDirs, detectUserdata, gamePaths, sharedFile } from "$lib/platform/paths";
import type { TerrainMessage, TerrainRequest, TerrainStats } from "$lib/workers/terrain.worker";
import { requestMessages } from "$lib/workers/transport";
import { MsgError } from "$lib/core/msg";
import { fmtNum, i18n, t, tk, tm, type MessageKey } from "$lib/i18n/index.svelte";
import { TILE_M } from "$lib/core/area";
import { dialog } from "./dialog.svelte";
import { Project } from "./project.svelte";
import { packProject, PROJECT_EXT, unpackProject, type Inputs } from "./projectfile";
import { dataKeyOf, defaultSettings, migrateSettings, optionsKeyOf, type Settings } from "./settings";
export type { ReliefSource, Settings } from "./settings";

/** Map settings before projects (read once, to open them as the first project). */
const LS_KEY = "importcity.settings";
/** App-wide settings, and the projects open when the app was closed. */
const APP_KEY = "importcity.app";
const SESSION_KEY = "importcity.session";

/** The folder of a file path. */
function dirName(path: string): string {
  return path.replace(/[\\/][^\\/]*$/, "");
}

/** Same file (Windows paths: case and separators do not matter). */
function samePath(a: string, b: string): boolean {
  const n = (p: string) => p.replace(/[\\/]+/g, "/").toLowerCase();
  return n(a) === n(b);
}

/** The mod's realmap_alive.lua in a game folder, and its age by the file's date (null = missing). */
async function readAlive(userdata: string): Promise<{ alive: GameAlive | null; ageMs: number | null }> {
  const path = sharedFile(userdata, "alive");
  const [text, st] = await Promise.all([readText(path), fileStat(path)]);
  return { alive: parseAlive(text), ageMs: st ? Math.max(0, Date.now() - st.mtimeMs) : null };
}
/** Every place kind is fetched: in France the kind says little about size (FACT-014). */
const PLACE_KINDS = ["city", "town", "village"];

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

/** App-wide settings (not part of a project): the game's userdata folder. */
interface AppSettings {
  userdata: string;
  /** Folder of the last project opened or saved: where the file dialogs open (none at first). */
  lastDir?: string;
}

/** One open project in the saved session: its file, and its settings when never saved or modified. */
interface SessionEntry {
  path?: string;
  draft?: Settings;
  untitled?: number;
  /** Changes not saved when the app was closed (the star comes back). */
  dirty?: boolean;
}
interface Session {
  open: SessionEntry[];
  active: number;
}

function readJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function loadAppSettings(): AppSettings {
  const app = readJson<Partial<AppSettings>>(APP_KEY);
  if (app) return { userdata: app.userdata ?? "", lastDir: app.lastDir };
  // Before projects the game folder was saved with the map settings.
  const old = readJson<{ userdata?: string }>(LS_KEY);
  return { userdata: old?.userdata ?? "" };
}

/** The open projects at start: the saved session, else the settings of the version before projects. */
function initialProjects(): { projects: Project[]; active: number; pending: Map<Project, SessionEntry> } {
  const pending = new Map<Project, SessionEntry>();
  const session = readJson<Session>(SESSION_KEY);
  const projects: Project[] = [];
  for (const e of session?.open ?? []) {
    const settings = e.draft ? migrateSettings(e.draft as Settings & Record<string, unknown>) : defaultSettings();
    const p = new Project(settings, e.untitled ?? 1);
    if (e.dirty) p.savedKey = "";
    if (e.path) {
      p.path = e.path;
      // Read from the file by `restoreSession` (the draft, if any, applied over it).
      p.loading = true;
      pending.set(p, e);
    }
    projects.push(p);
  }
  if (!projects.length) {
    const old = readJson<Partial<Settings> & Record<string, unknown>>(LS_KEY);
    projects.push(new Project(old ? migrateSettings(old) : defaultSettings()));
  }
  const active = Math.min(Math.max(0, session?.active ?? 0), projects.length - 1);
  return { projects, active, pending };
}

/** The frame of the area a data key was fetched for (`dataKeyOf`). */
function frameOfDataKey(key: string): Frame | null {
  try {
    const [lon, lat, size, format, landscape, scale, rotation] = JSON.parse(key) as [number, number, number, number, boolean, number, number];
    return makeFrame({ lon, lat, size, format, landscape, scale, rotation, verticalScale: null });
  } catch {
    return null;
  }
}

class Importer {
  /** App-wide settings. */
  app = $state<AppSettings>(loadAppSettings());
  /** The open projects, and the one the panel and the map show. */
  projects = $state<Project[]>([]);
  activeId = $state("");
  active = $derived(this.projects.find((p) => p.id === this.activeId) ?? this.projects[0]);
  /** Projects of the saved session still to read from their files. */
  private pending = new Map<Project, SessionEntry>();

  candidates = $state<string[]>([]);
  running = $state<null | "data" | "preview" | "full" | "test" | "project">(null);
  progress = $state(0);
  step = $state("");
  /** `experimentalMapFeatures` in the game's settings.lua: more map sizes and formats. */
  experimentalMaps = $state(false);
  /** The game's settings.lua was read (the flag above is known, not just assumed off). */
  gameSettingsRead = $state(false);
  /** `<UD>/settings.lua`, for « open the folder » next to the map size. */
  gameSettingsPath = $state("");
  /** The game's build at its last launch (its log), null when unknown. */
  gameBuild = $state<number | null>(null);

  constructor() {
    const init = initialProjects();
    this.projects = init.projects;
    this.activeId = init.projects[init.active].id;
    this.pending = init.pending;
  }

  // The active project's state, as the panel and the computations use it.
  get settings(): Settings {
    return this.active.settings;
  }
  set settings(v: Settings) {
    this.active.settings = v;
  }
  /** The log panel: what happened, warnings, errors, and (debug) the technical journal. */
  get events(): LogEvent[] {
    return this.active.events;
  }
  set events(v: LogEvent[]) {
    this.active.events = v;
  }
  /** Phase 1 steps, shown under « Récupérer les données ». */
  get dataSteps(): DataStep[] {
    return this.active.dataSteps;
  }
  set dataSteps(v: DataStep[]) {
    this.active.dataSteps = v;
  }
  /** The stages the importcity mod runs in the game, shown under « Générer la carte ». */
  get gameSteps(): DataStep[] {
    return this.active.gameSteps;
  }
  set gameSteps(v: DataStep[]) {
    this.active.gameSteps = v;
  }
  /** What « Générer la carte » does in the app before handing over to the game. */
  get exportSteps(): DataStep[] {
    return this.active.exportSteps;
  }
  set exportSteps(v: DataStep[]) {
    this.active.exportSteps = v;
  }
  get error(): string | null {
    return this.active.error;
  }
  set error(v: string | null) {
    this.active.error = v;
  }
  get preview(): PreviewState | null {
    return this.active.preview;
  }
  set preview(v: PreviewState | null) {
    this.active.preview = v;
  }
  get result(): RunResult | null {
    return this.active.result;
  }
  set result(v: RunResult | null) {
    this.active.result = v;
  }
  private get previewKey(): string {
    return this.active.previewKey;
  }
  private set previewKey(v: string) {
    this.active.previewKey = v;
  }
  private get exportKey(): string {
    return this.active.exportKey;
  }
  private set exportKey(v: string) {
    this.active.exportKey = v;
  }
  /** Phase 1 results: what was fetched (shown in the panel) and the raw layers (shown on the map). */
  get dataSummary(): DataSummary | null {
    return this.active.dataSummary;
  }
  set dataSummary(v: DataSummary | null) {
    this.active.dataSummary = v;
  }
  get realLayer(): RealLayer | null {
    return this.active.realLayer;
  }
  set realLayer(v: RealLayer | null) {
    this.active.realLayer = v;
  }
  private get dataKey(): string {
    return this.active.dataKey;
  }
  private set dataKey(v: string) {
    this.active.dataKey = v;
  }
  /** Inputs of the last preview, reused while only terrain / biome / town options change. */
  private get previewInputs(): { key: string; inputs: Inputs } | null {
    return this.active.previewInputs;
  }
  private set previewInputs(v: { key: string; inputs: Inputs } | null) {
    this.active.previewInputs = v;
  }
  private get lastReport(): string {
    return this.active.lastReport;
  }
  private set lastReport(v: string) {
    this.active.lastReport = v;
  }

  frame = $derived(makeFrame(this.settings.area));
  /** The chosen size or format is one the game lists only with experimental map features, which are off. */
  sizeLocked = $derived(this.gameSettingsRead && !this.experimentalMaps && isExperimental(this.settings.area.size, this.settings.area.format));
  /** Options that change the map (not the file name or folder): the preview is stale when they differ. */
  optionsKey = $derived(optionsKeyOf(this.settings));
  stale = $derived(!!this.preview && this.previewKey !== this.optionsKey);
  /** Options and map name of the last map sent to the game: the export is out of date when they differ. */
  exported = $derived(!!this.exportKey && this.exportKey === this.optionsKey + "|" + this.settings.name);

  private demCache = new Map<string, DemRaster | null>();
  /** The area or the sources changed since the data was fetched. */
  dataStale = $derived(!!this.dataSummary && this.dataKey !== dataKeyOf(this.settings));

  /** Remember the app settings and the open projects (every change goes through here). */
  save(): void {
    try {
      localStorage.setItem(APP_KEY, JSON.stringify(this.app));
      const session: Session = {
        open: this.projects.map((p) => {
          const draft = !p.path || p.dirty ? ($state.snapshot(p.settings) as Settings) : undefined;
          return p.path ? { path: p.path, draft } : { draft, untitled: p.untitled, dirty: p.dirty || undefined };
        }),
        active: Math.max(0, this.projects.findIndex((p) => p.id === this.activeId)),
      };
      localStorage.setItem(SESSION_KEY, JSON.stringify(session));
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
    const auto = (this.preview?.network.links ?? [])
      .filter((l) => l.kind === "town" && picks[l.key] === undefined)
      .map((l) => l.key);
    // Nothing to keep: stay automatic (an empty list would leave the map without any road).
    this.settings.roadsFrozen = auto.length ? auto : null;
  }

  /** Town roads back to the automatic choice: the roads added, removed or kept by hand are forgotten. */
  resetRoads(): void {
    this.forgetTownRoads();
    this.refresh();
  }

  /**
   * Forget the town roads changed by hand (railway picks kept). Also done when the area moves: those
   * roads belong to the old map, and kept they would leave the new one without any road.
   */
  forgetTownRoads(): void {
    const picks = { ...this.settings.linkPicks };
    for (const k of Object.keys(picks)) if (k.startsWith("town:")) delete picks[k];
    this.settings.linkPicks = picks;
    this.settings.roadsFrozen = null;
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
    if (!this.app.userdata && d.userdata) {
      this.app.userdata = d.userdata;
      this.save();
    }
    await this.readGameSettings();
  }

  /**
   * Whether the game lists the experimental map sizes and formats (`<UD>/settings.lua`). Read at
   * start and again when the window gets the focus back (the player may have just edited the file).
   * A project keeps its size even when the game would not offer it: the export is then blocked.
   */
  async readGameSettings(): Promise<void> {
    const ud = this.app.userdata;
    if (!ud) return;
    await allowDirs([ud]);
    const path = joinPath(ud, "settings.lua");
    const text = await readText(path);
    this.gameSettingsPath = path;
    this.gameSettingsRead = !!text;
    const experimental = text ? parseExperimentalMapFeatures(text) ?? false : false;
    if (experimental !== this.experimentalMaps) this.diag(`jeu : experimentalMapFeatures = ${experimental}`);
    this.experimentalMaps = experimental;
    const build = parseGameBuild(await readText(joinPath(ud, "crash_dump", "stdout.txt")));
    if (build !== null && build !== this.gameBuild) this.diag(`jeu : build ${build}`);
    this.gameBuild = build;
  }

  // ---------------------------------------------------------------------------------------------
  // Projects (DECISION-036): open, save, close; never while a computation runs.

  /** The project with this id (the active one by default). */
  private project(id?: string): Project {
    return (id && this.projects.find((p) => p.id === id)) || this.active;
  }

  /** A fresh « Sans titre N » number. */
  private nextUntitled(): number {
    const used = new Set(this.projects.filter((p) => !p.path).map((p) => p.untitled));
    let n = 1;
    while (used.has(n)) n++;
    return n;
  }

  /** The name shown for a project: its file's name, else « Sans titre N ». */
  projectName(p: Project): string {
    return p.path ? p.title : t("project.untitled", { n: p.untitled });
  }

  /** A project left as created: replaced by the next one opened. */
  private pristine(p: Project): boolean {
    return !p.path && !p.dirty && !p.preview && !p.dataSummary;
  }

  /** Show another project (its settings, data, result and journal). */
  activate(id: string): void {
    if (this.running || id === this.activeId) return;
    const prev = this.active;
    // A saved, unmodified project frees its phase-1 data: it is read back from the file when needed.
    if (prev.path && !prev.dirty && prev.previewInputs) {
      prev.previewInputs = null;
      prev.dataOnDisk = true;
    }
    this.activeId = id;
    this.save();
  }

  newProject(): void {
    if (this.running) return;
    const p = new Project(defaultSettings(), this.nextUntitled());
    this.projects = [...this.projects, p];
    this.activate(p.id);
  }

  /** Read a project's data and result from `bytes` into `p`. */
  private fill(p: Project, d: Awaited<ReturnType<typeof unpackProject>>): void {
    p.settings = d.settings;
    p.previewInputs = d.data;
    p.dataOnDisk = false;
    p.dataKey = d.data?.key ?? "";
    p.dataSummary = (d.summary as DataSummary | null) ?? null;
    p.realLayer = d.data ? { water: d.data.inputs.water, places: d.data.inputs.places, sites: d.data.inputs.sites, roads: d.data.inputs.roads } : null;
    p.preview = (d.preview as PreviewState | null) ?? null;
    p.previewKey = d.previewKey;
    p.exportKey = d.exportKey;
    p.result = (d.result as RunResult | null) ?? null;
    p.events = (d.log as LogEvent[]).slice(-400);
    p.lastReport = "";
    p.markSaved();
  }

  private async readProjectFile(path: string): Promise<Awaited<ReturnType<typeof unpackProject>>> {
    await allowDirs([dirName(path)]);
    const bytes = await readBytes(path);
    return unpackProject(bytes);
  }

  /** File > Ouvrir: a `.realmap` chosen in the system dialog (or `path`), or the project already open. */
  async openProject(path?: string): Promise<void> {
    if (this.running) return;
    let file = path;
    if (!file) {
      try {
        const picked = await openDialog({ multiple: false, directory: false, defaultPath: this.app.lastDir, filters: [{ name: "RealMap", extensions: [PROJECT_EXT] }] });
        file = typeof picked === "string" ? picked : undefined;
      } catch (e) {
        this.report(e, t("file.open"));
        return;
      }
    }
    if (!file) return;
    const same = this.projects.find((p) => p.path && samePath(p.path, file));
    if (same) return this.activate(same.id);
    this.running = "project";
    this.step = t("project.reading");
    try {
      const d = await this.readProjectFile(file);
      const p = new Project(d.settings);
      p.path = file;
      this.fill(p, d);
      const replace = this.pristine(this.active) ? this.active.id : null;
      this.projects = [...this.projects.filter((x) => x.id !== replace), p];
      this.activeId = p.id;
      this.app.lastDir = dirName(file);
      this.say(t("msg.projectOpened", { path: file }));
      this.save();
    } catch (e) {
      this.report(new Error(t("msg.projectBad", { path: file, error: errorText(e) })));
    } finally {
      this.running = null;
      this.step = "";
    }
  }

  /** Read the projects of the last session from their files (at start). */
  async restoreSession(): Promise<void> {
    for (const [p, e] of [...this.pending]) {
      this.pending.delete(p);
      try {
        this.fill(p, await this.readProjectFile(e.path!));
        // Changes not saved when the app was closed come back on top of the file.
        if (e.draft) p.settings = migrateSettings(e.draft as Settings & Record<string, unknown>);
      } catch (err) {
        this.projects = this.projects.filter((x) => x !== p);
        this.warn(t("msg.projectMissing", { path: e.path!, error: errorText(err) }));
      } finally {
        p.loading = false;
      }
    }
    if (!this.projects.length) this.projects = [new Project(defaultSettings())];
    if (!this.projects.some((p) => p.id === this.activeId)) this.activeId = this.projects[0].id;
    this.save();
  }

  /** Phase-1 data of a project left on disk, read back from its file. */
  private async loadProjectData(p: Project): Promise<void> {
    if (!p.dataOnDisk || !p.path) return;
    const d = await this.readProjectFile(p.path);
    if (d.data) p.previewInputs = d.data;
    p.dataOnDisk = false;
  }

  /** File > Enregistrer: true once written (false when cancelled or failed). */
  async saveProject(id?: string): Promise<boolean> {
    const p = this.project(id);
    if (!p.path) return this.saveProjectAs(p.id);
    if (this.running) return false;
    this.running = "project";
    this.step = t("project.writing");
    try {
      await this.loadProjectData(p);
      const s = $state.snapshot(p.settings) as Settings;
      const data = p.previewInputs;
      const f = data ? frameOfDataKey(data.key) : null;
      const crop = f ? frameBBox(f, 200 + previewGrid(f).step * f.scale) : null;
      let app = "";
      try {
        app = await getVersion();
      } catch {
        /* not in Tauri */
      }
      const bytes = await packProject(
        {
          settings: s,
          data,
          summary: $state.snapshot(p.dataSummary),
          preview: $state.snapshot(p.preview),
          previewKey: p.previewKey,
          exportKey: p.exportKey,
          result: $state.snapshot(p.result),
          log: $state.snapshot(p.events),
        },
        app,
        crop,
      );
      const path = p.path;
      await allowDirs([dirName(path)]);
      // Written next to it first: a failed write never leaves half a project.
      const part = `${path}.part`;
      await writeBytes(part, bytes);
      await renamePath(part, path);
      p.markSaved();
      this.app.lastDir = dirName(path);
      this.save();
      this.say(t("msg.projectSaved", { path, mb: fmtNum(bytes.byteLength / 2 ** 20, 1) }));
      return true;
    } catch (e) {
      this.report(e, t("file.save"));
      return false;
    } finally {
      this.running = null;
      this.step = "";
    }
  }

  /** File > Enregistrer sous…: a new file chosen in the system dialog. */
  async saveProjectAs(id?: string): Promise<boolean> {
    if (this.running) return false;
    const p = this.project(id);
    let file: string | null = null;
    try {
      // The project's folder, else the last one used; the user always picks the folder.
      const dir = p.path ? dirName(p.path) : this.app.lastDir;
      const stem = p.path ? p.title : safeName(p.settings.name);
      file = await saveDialog({ defaultPath: dir ? joinPath(dir, `${stem}.${PROJECT_EXT}`) : `${stem}.${PROJECT_EXT}`, filters: [{ name: "RealMap", extensions: [PROJECT_EXT] }] });
    } catch (e) {
      this.report(e, t("file.saveAs"));
      return false;
    }
    if (!file) return false;
    if (!file.toLowerCase().endsWith(`.${PROJECT_EXT}`)) file += `.${PROJECT_EXT}`;
    const old = p.path;
    p.path = file;
    const ok = await this.saveProject(p.id);
    if (!ok) p.path = old;
    return ok;
  }

  /** File > Fermer: asks to save a modified project first. The last one closed leaves a blank one. */
  async closeProject(id?: string): Promise<void> {
    if (this.running) return;
    const p = this.project(id);
    if (p.dirty) {
      const choice = await dialog.ask(t("project.closeAsk", { name: this.projectName(p) }), [
        { id: "save", label: t("project.save"), kind: "primary" },
        { id: "discard", label: t("project.discard"), kind: "danger" },
        { id: "cancel", label: t("project.cancel") },
      ]);
      if (choice === "cancel") return;
      if (choice === "save" && !(await this.saveProject(p.id))) return;
    }
    const at = this.projects.indexOf(p);
    const rest = this.projects.filter((x) => x !== p);
    if (!rest.length) rest.push(new Project(defaultSettings(), 1));
    this.projects = rest;
    if (this.activeId === p.id || !rest.some((x) => x.id === this.activeId)) this.activeId = rest[Math.min(at, rest.length - 1)].id;
    this.save();
  }

  /** Projects with changes not saved. */
  get unsaved(): Project[] {
    return this.projects.filter((p) => p.dirty);
  }

  /** Before the app closes: true when it may close (everything saved, or the user said so). */
  async confirmQuit(): Promise<boolean> {
    const list = this.unsaved;
    if (!list.length) return true;
    const choice = await dialog.ask(t("project.quitAsk", { n: list.length, names: list.map((p) => this.projectName(p)).join(", ") }), [
      { id: "save", label: t("project.saveAll"), kind: "primary" },
      { id: "discard", label: t("project.quitDiscard"), kind: "danger" },
      { id: "cancel", label: t("project.cancel") },
    ]);
    if (choice === "cancel") return false;
    if (choice === "save") {
      for (const p of list) {
        this.activate(p.id);
        if (!(await this.saveProject(p.id))) return false;
      }
    } else {
      // Quit without saving: a saved project comes back as its file, a never saved one is dropped.
      for (const p of list) if (p.path) p.markSaved();
      this.projects = this.projects.filter((p) => p.path || !list.includes(p));
      if (!this.projects.length) this.projects = [new Project(defaultSettings())];
      if (!this.projects.some((p) => p.id === this.activeId)) this.activeId = this.projects[0].id;
      this.save();
    }
    return true;
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

  /** Countdown before a new download try in a step's detail, and one journal line per new try. */
  private retryNotice(what: string, show: (detail: string) => void): RetryNotice {
    let prev = 0;
    return (s, reason) => {
      if (s > prev) this.diag(`téléchargement ${what} : ${reason}, nouvel essai dans ${s} s`);
      prev = s;
      show(t("msg.retryIn", { reason, s }));
    };
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
      ign = await loadIgnGrid(
        f,
        g,
        (d, n) => {
          at(0.2 + (0.5 * d) / n);
          this.exportState("relief", "run", t("msg.ignBlocks", { d, n }));
        },
        this.retryNotice("IGN", (x) => this.exportState("relief", "run", x)),
        (error) => this.warn(t("msg.ignGaveUp", { error })),
      );
      if (ign) source = "IGN RGE ALTI";
    }
    let rasters = phase1.rasters;
    if ((!ign || ign.some((z) => !Number.isFinite(z))) && !rasters.length) {
      // The preview had full IGN cover but the 4 m grid has holes: Copernicus fills them.
      rasters = [];
      for (const tile of copernicusTilesFor(frameBBox(f, 200))) {
        if (!this.demCache.has(tile)) this.demCache.set(tile, await loadDemTile(tile, this.retryNotice(tile, (x) => this.exportState("relief", "run", x))));
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
        cover = await loadLandcover(
          roundBbox(frameBBox(f)),
          worldcoverLevel(g.step * f.scale),
          (d, n) => at(0.7 + (0.3 * d) / Math.max(1, n)),
          this.retryNotice("WorldCover", (x) => this.exportState("cover", "run", x)),
        );
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
      ign = await loadIgnGrid(
        f,
        g,
        (d, n) => {
          at((0.4 * d) / n);
          this.stepState("ign", "run", t("msg.blocks", { d, n }));
        },
        this.retryNotice("IGN", (x) => this.stepState("ign", "run", x)),
        (error) => this.warn(t("msg.ignGaveUp", { error })),
      );
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
        if (!this.demCache.has(tile)) {
          const notice = this.retryNotice(tile, (x) => this.stepState("dem", "run", `${t("msg.tiles", { d: i + 1, n: tiles.length })} · ${x}`));
          this.demCache.set(tile, await loadDemTile(tile, notice));
        }
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
        cover = await loadLandcover(
          bbox,
          worldcoverLevel(g.step * f.scale),
          (d, n) => at(0.6 + (0.1 * d) / Math.max(1, n)),
          this.retryNotice("WorldCover", (x) => this.stepState("cover", "run", x)),
        );
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
      network: s.roads,
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
          else {
            // La pile d'appels du worker, sinon le journal n'indique que la ligne de la page.
            const err = new Error(m.message);
            if (m.stack) err.stack = m.stack;
            reject(err);
          }
        }
      };
      w.onerror = (e) => {
        w.terminate();
        reject(new Error(e.message || (e.filename ? t("msg.workerFailedAt", { file: e.filename, line: e.lineno }) : t("msg.workerFailed"))));
      };
      // In pieces (one message is capped near 1.8 GiB): each DEM tile cut to the frame and its
      // sampling margin, copied and transferred (the cache keeps the original), OSM in batches.
      const f = makeFrame(req.area);
      const g = req.mode === "full" ? fullGrid(f) : previewGrid(f);
      const crop = frameBBox(f, 200 + g.step * f.scale);
      const sent = { rasters: 0, cover: 0, osm: 0 };
      try {
        for (const { msg, transfer, bytes } of requestMessages(req, crop)) {
          if (msg.kind === "part") {
            const key = msg.field === "rasters" || msg.field === "bathy" ? "rasters" : msg.field === "cover" ? "cover" : "osm";
            sent[key] += bytes;
          }
          w.postMessage(msg, transfer);
        }
      } catch (e) {
        w.terminate();
        reject(e instanceof DOMException && e.name === "DataCloneError" ? new Error(t("msg.workerTooLarge")) : e);
        return;
      }
      const mib = (b: number) => Math.round(b / 2 ** 20);
      this.diag(`calcul : envoyé au worker ${mib(sent.rasters)} Mio de relief, ${mib(sent.cover)} Mio d'occupation du sol, ~${mib(sent.osm)} Mio d'OSM`);
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
  private reportResult(done: Extract<TerrainMessage, { kind: "done" }>): void {
    const st = done.stats;
    const pct = (x: number) => `${Math.round(x * 100)} %`;
    const links = (done.network?.links ?? []).filter((l) => l.kind === "town");
    const lines = [
      t("msg.resultTerrain", { ref: Math.round(st.refHeight), min: st.minM, max: st.maxM, water: pct(st.waterShare), slope: pct(st.maxSlope) }),
      this.settings.terrain.inlandWater === false ? t("msg.inlandWaterOff") : t("msg.resultRivers", {
        networks: st.riverPieces <= 1 ? t("msg.resultRiversOne") : t("msg.resultRiversMany", { n: st.riverPieces }),
        joined: st.riversJoined,
        routed: st.riversRouted,
        channels: st.waterBridged ?? 0,
        marsh: st.marshLakes ?? 0,
        ponds: st.lakesDropped,
        beach: st.beachCells ?? 0,
      }),
      t("msg.resultCounts", { towns: done.towns.length, industries: done.industries.length, links: links.length, rails: done.network?.rail.length ?? 0 }),
      t("msg.resultRoads", {
        networks: roadNetworks(done.towns.map((x) => x.name), links, this.settings.linkPicks),
        linked: (done.network?.links ?? []).filter((l) => l.kind === "industry").length,
        industries: done.industries.filter((m) => !m.onWater).length,
      }),
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
    if (!this.previewInputs && this.active.dataOnDisk) await this.loadProjectData(this.active);
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
      if (!this.app.userdata) throw new Error(t("msg.noUserdata"));
      if (this.sizeLocked) throw new Error(t("msg.sizeLocked"));
      this.result = null;
      const name = safeName(s.name);
      const paths = gamePaths(this.app.userdata);
      await allowDirs([this.app.userdata]);
      const f = makeFrame(s.area);
      const sizeLabel = sizeText(s.area.size, s.area.format, s.area.landscape);
      this.say(t("msg.sizeScale", { size: sizeLabel, scale: f.scale }));
      // Beyond the largest map tested in game (Très Grande): heavier, said before the long part.
      const samples = gridSamples(f);
      if (samples > TESTED_MAX_SAMPLES) this.warn(t("msg.bigMap", { mpx: fmtNum(samples / 1e6, 1) }));
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
      const biomesDir = joinPath(this.app.userdata, "biomes");
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
          ...networkData(done.network ?? { links: [], rail: [] }, s.linkPicks, gameGrade(s.rail.maxGrade, f.scale, f.verticalScale)),
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
      this.say(t("msg.written", { name, n: files.length, dir: this.app.userdata }));
      this.result = { name, sizeLabel, stats: st, towns: done.towns, dropped: done.dropped, industries: done.industries.length, files };
      // Last: the request the importcity mod picks up in the Map Editor (everything above is ready).
      const id = Date.now();
      await write(paths.townsIndustries, "realmap_request.lua", toUserdata(requestData(name, createdAt, id)));
      this.say(t("msg.sent"));
      const answer = await this.watchGame(this.app.userdata, { name, createdAt, id }, sizeLabel, 0.6, 0.4);
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
      if (!this.app.userdata) throw new Error(t("msg.noUserdata"));
      await allowDirs([this.app.userdata]);
      const { tilesX, tilesY } = mapTiles(s.area.size, s.area.format, s.area.landscape);
      const nx = tilesX * 64 + 1;
      const ny = tilesY * 64 + 1;
      const name = "RealMap_test_rivieres";
      const paths = gamePaths(this.app.userdata);
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
