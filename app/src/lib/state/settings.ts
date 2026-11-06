/**
 * The settings of one map project (DECISION-036): area, sources and every option that shapes the map.
 * App-wide settings (the game folder, language, updates) are not here. Plain TypeScript (no Svelte),
 * shared by the app state and the project files.
 */
import type { Area } from "../core/area";
import { DEFAULT_BIOMES, type BiomeMapping } from "../core/biomes";
import { DEFAULT_INDUSTRIES, type CustomIndustry, type IndustriesOptions, type IndustryPicks } from "../core/industries";
import { DEFAULT_NETWORK, type CustomRail, type LinkPicks } from "../core/network";
import { DEFAULT_RAIL, type RailOptions } from "../core/railway";
import { DEFAULT_TERRAIN, type TerrainOptions } from "../core/terrain";
import { DEFAULT_TOWNS, type PlaceFilter, type TownPicks, type TownsOptions } from "../core/towns";

/**
 * Saved settings older than this get the defaults that changed since (v0.7: land at 0.5 m by the
 * shore; v0.8: rivers 64 m, steeper underwater slope; v0.12: rivers 14 m; v0.13: rivers and marshes
 * 20 m, 100 of capacity for 10 000 inhabitants), unless set by hand.
 */
export const SETTINGS_VERSION = 11;

export type ReliefSource = "auto" | "ign" | "copernicus";

export interface Settings {
  version: number;
  name: string;
  area: Area;
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
  /** Start road networks: most towns in one network (`network.ts`). */
  roads: { maxNetworkTowns: number };
  /** Railway alignment (`railway.ts`). */
  rail: RailOptions;
  /** Industries added by hand on the map (right click). */
  customIndustries: CustomIndustry[];
  /** Railway lines added by hand between two points (following the real tracks when there are some). */
  customRails: CustomRail[];
}

export function defaultSettings(): Settings {
  return {
    version: SETTINGS_VERSION,
    name: "RealMap",
    area: { lon: 4.8357, lat: 45.764, size: 3, format: 0, landscape: false, scale: 3, verticalScale: null, rotation: 0 },
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
    roads: { maxNetworkTowns: DEFAULT_NETWORK.maxNetworkTowns },
    rail: { ...DEFAULT_RAIL },
    customIndustries: [],
    customRails: [],
  };
}

/**
 * Settings as saved by any version (local storage before projects, a project file), completed with
 * the defaults and brought to SETTINGS_VERSION. A field `userdata` (before projects) is ignored here.
 */
export function migrateSettings(saved: Partial<Settings> & Record<string, unknown>): Settings {
  const d = defaultSettings();
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
    roads: { ...d.roads, ...saved.roads },
    rail: { ...d.rail, ...saved.rail },
    customIndustries: saved.customIndustries ?? [],
    customRails: saved.customRails ?? [],
  };
}

/** What the real data depends on (phase 1): the area and the sources. */
export function dataKeyOf(s: Settings): string {
  const a = s.area;
  return JSON.stringify([a.lon, a.lat, a.size, a.format, a.landscape, a.scale, a.rotation ?? 0, s.source, s.useCover]);
}

/** Options that change the map (not the file name or folder): the preview is stale when they differ. */
export function optionsKeyOf(s: Settings): string {
  return JSON.stringify([s.area, s.source, s.terrain, s.useCover, s.biomes, s.places, s.towns, s.townPicks, s.industries, s.industryPicks, s.linkPicks, s.roadsFrozen, s.roads, s.rail, s.customIndustries, s.customRails]);
}
