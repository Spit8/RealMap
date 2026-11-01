/**
 * Industries (FACT-019). Phase 1: OSM industrial sites (quarries, mines, wells, refineries, works…)
 * as centre points. Phase 2: real sites mapped to the game's industries, primary industries
 * (farms, livestock, forests, fishing) from the land cover, production chains completed so every
 * factory has its suppliers, the whole capped to the game's own count for the chosen density
 * (FACT-021) and placed on valid ground (or water for water industries). Within that count the
 * industries are chosen by how present they are in reality (OSM sites, land cover), whole
 * production chains at a time, so every factory has its suppliers. Written into `towns_industries/<name>.lua` as
 * `{ position, angle, onWater, fileName = "::/industries/<tag>/<tag>.con", tag }` (FACT-002).
 */
import { frameProjection, type Frame } from "./area";
import { cellToWorld, worldToCell, type Grid } from "./grid";
import { WC_CROP, WC_GRASS, WC_TREE } from "./landcover";
import type { Bbox } from "./osm";
import { overpassLimits } from "./osm";
import { msg, type Msg } from "./msg";
import { distanceTo, strokePolyline } from "./raster";
import { WATER_LAKE, WATER_SEA } from "./terrain";
import { nearestValidCell, slopeAt } from "./towns";

/** The game's industries (folders of `base/content/industries`); labels are ours. */
export const INDUSTRIES: Record<string, { label: string; water?: boolean; primary?: boolean }> = {
  farm: { label: "Ferme", primary: true },
  livestock_farm: { label: "Élevage", primary: true },
  cotton_farm: { label: "Plantation de coton", primary: true },
  rubber_farm: { label: "Plantation d'hévéas", primary: true },
  forest: { label: "Exploitation forestière", primary: true },
  quarry: { label: "Carrière", primary: true },
  clay_pit: { label: "Carrière d'argile", primary: true },
  sand_pit: { label: "Sablière", primary: true },
  sand_excavator: { label: "Drague à sable", primary: true, water: true },
  coal_mine: { label: "Mine de charbon", primary: true },
  iron_ore_mine: { label: "Mine de fer", primary: true },
  oil_well: { label: "Puits de pétrole", primary: true },
  oil_platform: { label: "Plateforme pétrolière", primary: true, water: true },
  fishing_grounds: { label: "Zone de pêche", primary: true, water: true },
  oil_refinery: { label: "Raffinerie" },
  chemical_plant: { label: "Usine chimique" },
  steel_mill: { label: "Aciérie" },
  saw_mill: { label: "Scierie" },
  brewery: { label: "Brasserie" },
  bricks_works: { label: "Briqueterie" },
  glass_works: { label: "Verrerie" },
  food_factory: { label: "Usine agroalimentaire" },
  weaving_mill: { label: "Filature" },
  textile_factory: { label: "Usine textile" },
  furniture_factory: { label: "Fabrique de meubles" },
  machine_factory: { label: "Usine de machines" },
  tool_factory: { label: "Usine d'outils" },
  vehicle_factory: { label: "Usine de véhicules" },
  cement_plant: { label: "Cimenterie" },
  paper_mill: { label: "Papeterie" },
  printing_press: { label: "Imprimerie" },
  tire_factory: { label: "Usine de pneus" },
};

/**
 * The game's tier of each industry (`economy/placementparamsutil.lua`, like the goods' tiers): only
 * tier 0 exists when a map starts (DECISION-027); tiers 1 and 2 come as the towns grow.
 */
export const INDUSTRY_TIER: Record<string, number> = {
  bricks_works: 0, cement_plant: 0, clay_pit: 0, farm: 0, fishing_grounds: 0, forest: 0, livestock_farm: 0,
  oil_platform: 0, oil_refinery: 0, oil_well: 0, quarry: 0, saw_mill: 0,
  brewery: 1, chemical_plant: 1, coal_mine: 1, cotton_farm: 1, food_factory: 1, furniture_factory: 1, glass_works: 1,
  iron_ore_mine: 1, machine_factory: 1, paper_mill: 1, printing_press: 1, sand_excavator: 1, sand_pit: 1,
  steel_mill: 1, textile_factory: 1, tool_factory: 1, weaving_mill: 1,
  rubber_farm: 2, tire_factory: 2, vehicle_factory: 2,
};
/** The highest industry tier a new map starts with. */
export const START_TIER = 0;
export const atStart = (tag: string): boolean => (INDUSTRY_TIER[tag] ?? 2) <= START_TIER;

export type EconomyId = "temperate" | "dry" | "tropic" | "subarctic";

export const ECONOMY_LABELS: Record<EconomyId, string> = {
  temperate: "Tempéré",
  dry: "Aride",
  tropic: "Tropical",
  subarctic: "Subarctique",
};

interface Economy {
  exclude: string[];
  /** A water industry that cannot be placed on water becomes this land one. */
  fallbacks: Record<string, string>;
  /** Share of industries on water. */
  water: number;
  /** Industries a cargo needs (all of them), from `cargoRequiredIndustries`. */
  chains: Record<string, string[]>;
}

/** From `base/content/economy.zip`, `<climate>.eco.lua` (2026-10-30). */
export const ECONOMIES: Record<EconomyId, Economy> = {"temperate":{"exclude":["cement_plant","paper_mill","printing_press","rubber_farm","tire_factory"],"fallbacks":{"oil_platform":"oil_well","sand_excavator":"sand_pit"},"water":0.146,"chains":{"beverages":["brewery","farm","glass_works","sand_excavator"],"bricks":["bricks_works","clay_pit"],"chemicals":["oil_platform","oil_refinery"],"clay":["clay_pit"],"clothes":["chemical_plant","cotton_farm","farm","livestock_farm","oil_platform","oil_refinery","textile_factory","weaving_mill"],"coal":["coal_mine"],"crude_oil":["oil_platform"],"dyes":["chemical_plant","oil_platform","oil_refinery"],"fabric":["cotton_farm","farm","livestock_farm","weaving_mill"],"fish":["fishing_grounds"],"fuel":["oil_platform","oil_refinery"],"furniture":["forest","furniture_factory","glass_works","sand_excavator","saw_mill"],"glass":["glass_works","sand_excavator"],"logs":["forest"],"machines":["chemical_plant","coal_mine","iron_ore_mine","machine_factory","oil_platform","oil_refinery","steel_mill"],"meat":["farm","livestock_farm"],"planks":["forest","saw_mill"],"sheet_metal":["coal_mine","iron_ore_mine","steel_mill"],"steel":["coal_mine","iron_ore_mine","steel_mill"],"stone":["quarry"],"tinned_food":["coal_mine","farm","fishing_grounds","food_factory","iron_ore_mine","livestock_farm","steel_mill"],"tools":["chemical_plant","forest","oil_platform","oil_refinery","saw_mill","tool_factory"],"vegetables":["farm"],"vehicles":["chemical_plant","coal_mine","iron_ore_mine","machine_factory","oil_platform","oil_refinery","steel_mill","vehicle_factory"]}},"dry":{"exclude":["cement_plant","cotton_farm","fishing_grounds","paper_mill","printing_press","rubber_farm","sand_excavator","tire_factory"],"fallbacks":{},"water":0.051,"chains":{"beverages":["brewery","farm","glass_works","sand_pit"],"bricks":["bricks_works","clay_pit"],"chemicals":["oil_platform","oil_refinery","oil_well"],"clay":["clay_pit"],"clothes":["chemical_plant","farm","livestock_farm","oil_platform","oil_refinery","oil_well","textile_factory","weaving_mill"],"coal":["coal_mine"],"crude_oil":["oil_platform","oil_well"],"dyes":["chemical_plant","oil_platform","oil_refinery","oil_well"],"fabric":["farm","livestock_farm","weaving_mill"],"fuel":["oil_platform","oil_refinery","oil_well"],"furniture":["forest","furniture_factory","glass_works","sand_pit","saw_mill"],"glass":["glass_works","sand_pit"],"logs":["forest"],"machines":["chemical_plant","coal_mine","iron_ore_mine","machine_factory","oil_platform","oil_refinery","oil_well","steel_mill"],"meat":["farm","livestock_farm"],"planks":["forest","saw_mill"],"sheet_metal":["coal_mine","iron_ore_mine","steel_mill"],"steel":["coal_mine","iron_ore_mine","steel_mill"],"stone":["quarry"],"tinned_food":["coal_mine","farm","food_factory","iron_ore_mine","livestock_farm","steel_mill"],"tools":["chemical_plant","forest","oil_platform","oil_refinery","oil_well","saw_mill","tool_factory"],"vegetables":["farm"],"vehicles":["chemical_plant","coal_mine","iron_ore_mine","machine_factory","oil_platform","oil_refinery","oil_well","steel_mill","vehicle_factory"]}},"tropic":{"exclude":["brewery","bricks_works","cement_plant","clay_pit","paper_mill","printing_press"],"fallbacks":{"oil_platform":"oil_well","sand_excavator":"sand_pit"},"water":0.146,"chains":{"chemicals":["oil_platform","oil_refinery"],"clothes":["chemical_plant","cotton_farm","farm","livestock_farm","oil_platform","oil_refinery","textile_factory","weaving_mill"],"coal":["coal_mine"],"crude_oil":["oil_platform"],"dyes":["chemical_plant","oil_platform","oil_refinery"],"fabric":["cotton_farm","farm","livestock_farm","weaving_mill"],"fish":["fishing_grounds"],"fuel":["oil_platform","oil_refinery"],"furniture":["forest","furniture_factory","glass_works","sand_excavator","saw_mill"],"glass":["glass_works","sand_excavator"],"logs":["forest"],"machines":["chemical_plant","coal_mine","iron_ore_mine","machine_factory","oil_platform","oil_refinery","steel_mill"],"meat":["farm","livestock_farm"],"planks":["forest","saw_mill"],"sheet_metal":["coal_mine","iron_ore_mine","steel_mill"],"steel":["coal_mine","iron_ore_mine","steel_mill"],"stone":["quarry"],"tinned_food":["coal_mine","farm","fishing_grounds","food_factory","iron_ore_mine","livestock_farm","steel_mill"],"tools":["chemical_plant","forest","oil_platform","oil_refinery","saw_mill","tool_factory"],"vegetables":["farm"],"vehicles":["chemical_plant","coal_mine","iron_ore_mine","machine_factory","oil_platform","oil_refinery","rubber_farm","steel_mill","tire_factory","vehicle_factory"]}},"subarctic":{"exclude":["bricks_works","clay_pit","cotton_farm","rubber_farm","tire_factory"],"fallbacks":{"sand_excavator":"sand_pit"},"water":0.125,"chains":{"beverages":["brewery","farm","glass_works","sand_excavator"],"books":["chemical_plant","forest","oil_platform","oil_refinery","oil_well","paper_mill","printing_press","saw_mill"],"cement":["cement_plant","quarry"],"chemicals":["oil_platform","oil_refinery","oil_well"],"clothes":["chemical_plant","farm","livestock_farm","oil_platform","oil_refinery","oil_well","textile_factory","weaving_mill"],"coal":["coal_mine"],"crude_oil":["oil_platform","oil_well"],"dyes":["chemical_plant","oil_platform","oil_refinery","oil_well"],"fabric":["farm","livestock_farm","weaving_mill"],"fish":["fishing_grounds"],"fuel":["oil_platform","oil_refinery","oil_well"],"furniture":["forest","furniture_factory","glass_works","sand_excavator","saw_mill"],"glass":["glass_works","sand_excavator"],"logs":["forest"],"machines":["chemical_plant","coal_mine","iron_ore_mine","machine_factory","oil_platform","oil_refinery","oil_well","steel_mill"],"meat":["farm","livestock_farm"],"planks":["forest","saw_mill"],"sheet_metal":["coal_mine","iron_ore_mine","steel_mill"],"steel":["coal_mine","iron_ore_mine","steel_mill"],"stone":["quarry"],"tinned_food":["coal_mine","farm","fishing_grounds","food_factory","iron_ore_mine","livestock_farm","steel_mill"],"tools":["chemical_plant","forest","oil_platform","oil_refinery","oil_well","saw_mill","tool_factory"],"vehicles":["chemical_plant","coal_mine","iron_ore_mine","machine_factory","oil_platform","oil_refinery","oil_well","steel_mill","vehicle_factory"]}}};

export function industryFile(tag: string): string {
  return `::/industries/${tag}/${tag}.con`;
}

// ---------------------------------------------------------------------------------------------
// Phase 1: OSM sites

/** A real industrial site (OSM), already mapped to a game industry. */
export interface IndustrySite {
  tag: string;
  lon: number;
  lat: number;
  name?: string;
  /** The OSM tags that decided it, for the hover text ("landuse=quarry resource=sand"). */
  why: string;
}

const PRODUCT_RE = "steel|iron|oil|petroleum|chemical|beer|glass|brick|wood|timber|furniture|food|sugar|dairy|textile|machine|tool|vehicle|car|cement|paper";
const INDUSTRIAL_RE =
  "refinery|oil|steelmaker|steel|metal|chemical|brewery|sawmill|brickyard|brickworks|glassworks|glass|food|food_industry|dairy|sugar|textile|furniture|machinery|machine|tools|automotive|car|vehicle|cement|paper|printing|tyre|tire|mine|mining";

/** One light query (centres only): quarries, mines, wells, platforms, works, industrial sites, ports. */
export function overpassIndustryQuery(b: Bbox): string {
  const q = `${b.south},${b.west},${b.north},${b.east}`;
  const { timeout, maxsize } = overpassLimits(b);
  return (
    `[out:json][timeout:${timeout}][maxsize:${maxsize}];(` +
    `nwr["landuse"="quarry"](${q});` +
    `nwr["man_made"~"^(petroleum_well|offshore_platform|mineshaft|adit)$"](${q});` +
    `nwr["man_made"="works"](${q});` +
    `nwr["industrial"~"^(${INDUSTRIAL_RE})$"](${q});` +
    `nwr["craft"~"^(brewery|sawmill)$"](${q});` +
    `nwr["product"~"(${PRODUCT_RE})"](${q});` +
    `nwr["harbour"="yes"]["seamark:type"~"harbour"](${q});nwr["landuse"="port"](${q});` +
    `);out center tags;`
  );
}

/** Game industry for an OSM feature's tags, or null. Ports give "port" (fishing grounds nearby). */
export function classifySite(t: Record<string, string>): string | null {
  const all = `${t.industrial ?? ""} ${t.product ?? ""} ${t.craft ?? ""} ${t.resource ?? ""} ${t.name ?? ""}`.toLowerCase();
  const has = (re: RegExp) => re.test(all);
  if (t.man_made === "petroleum_well") return "oil_well";
  if (t.man_made === "offshore_platform") return "oil_platform";
  if (t.landuse === "port" || t.harbour === "yes") return "port";
  if (t.landuse === "quarry" || t.man_made === "mineshaft" || t.man_made === "adit" || /\b(mine|mining)\b/.test(t.industrial ?? "")) {
    const r = (t.resource ?? "").toLowerCase();
    if (/coal|lignite/.test(r)) return "coal_mine";
    if (/iron/.test(r)) return "iron_ore_mine";
    if (/clay|kaolin/.test(r)) return "clay_pit";
    if (/sand|gravel|aggregate/.test(r)) return "sand_pit";
    return t.landuse === "quarry" ? "quarry" : null;
  }
  if (has(/refiner|petroleum/) || t.industrial === "oil") return "oil_refinery";
  if (has(/steel|iron/)) return "steel_mill";
  if (has(/chemical/)) return "chemical_plant";
  if (has(/brewery|beer/)) return "brewery";
  if (has(/sawmill|timber|\bwood\b/)) return "saw_mill";
  if (has(/brick/)) return "bricks_works";
  if (has(/glass/)) return "glass_works";
  if (has(/food|dairy|sugar|cannery/)) return "food_factory";
  if (has(/textile|cloth/)) return "textile_factory";
  if (has(/furniture/)) return "furniture_factory";
  if (has(/automotive|vehicle|\bcar\b/)) return "vehicle_factory";
  if (has(/machine/)) return "machine_factory";
  if (has(/tool/)) return "tool_factory";
  if (has(/cement/)) return "cement_plant";
  if (has(/printing/)) return "printing_press";
  if (has(/paper/)) return "paper_mill";
  if (has(/tyre|tire/)) return "tire_factory";
  return null;
}

interface OverpassCenterElement {
  type: string;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

export function parseIndustrySites(json: { elements?: OverpassCenterElement[] }): IndustrySite[] {
  const out: IndustrySite[] = [];
  for (const e of json.elements ?? []) {
    const t = e.tags ?? {};
    const lat = e.lat ?? e.center?.lat;
    const lon = e.lon ?? e.center?.lon;
    if (lat === undefined || lon === undefined) continue;
    const tag = classifySite(t);
    if (!tag) continue;
    const why = ["landuse", "man_made", "industrial", "craft", "product", "resource", "harbour"]
      .filter((k) => t[k])
      .map((k) => `${k}=${t[k]}`)
      .join(" ");
    out.push({ tag, lon, lat, name: t.name, why });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Phase 2: the game's industries

/** The game's « Industry Density » setting: Rare, Dispersée, Moyenne, Dense, Très dense. */
export const DENSITY_LABELS = ["Rare", "Dispersée", "Moyenne", "Dense", "Très dense"];
/**
 * Industries the game creates on a Large map (56 × 56 tiles) for each density, with 20 towns
 * (FACT-021, read in game by the user; the count is computed by the engine, not the scripts).
 */
const INDUSTRIES_PER_LARGE_MAP = [8, 8, 9, 9, 13];

export interface IndustriesOptions {
  economy: EconomyId;
  /** The game's industry density (index of `DENSITY_LABELS`), which sets the automatic count. */
  density: number;
  /** Industries chosen automatically; 0 = the game's count for `density`. */
  maxIndustries: number;
  /** Game metres between two industries, and from an industry to a town centre. */
  minSpacingM: number;
  townClearanceM: number;
  edgeMarginM: number;
  /** How far (game m) an industry may move to find valid ground. */
  maxShiftM: number;
}

export const DEFAULT_INDUSTRIES: IndustriesOptions = {
  economy: "temperate",
  density: 2,
  maxIndustries: 0,
  minSpacingM: 1200,
  // Industrial suburbs sit close to town centres: a large clearance would push them all out.
  townClearanceM: 900,
  edgeMarginM: 600,
  maxShiftM: 4000,
};

/** Manual choices by candidate key: true = always, false = never. */
export type IndustryPicks = Record<string, boolean>;

export type IndustryOrigin = "osm" | "landcover" | "chain" | "user";

/** An industry added by hand on the map (right click), `key` = `user:<tag>|<lon>,<lat>`. */
export interface CustomIndustry {
  key: string;
  tag: string;
  lon: number;
  lat: number;
}
export type IndustryStatus = "placed" | "dropped" | "limit" | "off";

export interface IndustryCandidate {
  key: string;
  tag: string;
  label: string;
  name: string;
  origin: IndustryOrigin;
  /** OSM position (osm) or the centre of the land-cover block. */
  lon: number;
  lat: number;
  /** Why it is there: OSM tags (text), land cover share, the chain it completes, added by hand. */
  why: Msg | string;
  pick: boolean | null;
  status: IndustryStatus;
  reason?: Msg;
  /** How present this industry is in reality (OSM sites, land cover): the list is sorted by it. */
  relevance: number;
  /** For a placed factory: the suppliers of its chain that are not on the map (industry tags). */
  missing?: string[];
}

export interface MapIndustry {
  key: string;
  tag: string;
  label: string;
  /** Its name: the real site's, else « <industry> de <nearest town> ». */
  name: string;
  x: number;
  y: number;
  onWater: boolean;
  origin: IndustryOrigin;
}

export interface IndustryGround {
  game: Float32Array;
  water: Uint8Array;
}

/** The game's industry count for this map size and density (FACT-021), at least 3. */
export function defaultIndustryCount(f: Frame, density = 2): number {
  const base = INDUSTRIES_PER_LARGE_MAP[Math.max(0, Math.min(4, Math.round(density)))];
  return Math.max(3, Math.round((base * f.tilesX * f.tilesY) / 3136));
}

/** Land-cover blocks (game m) scanned for farms, pastures and forests. */
const BLOCK_M = 1024;
/** Same-type sites closer than this (game m) are one industry. */
const CLUSTER_M = 2000;
/** Directions sampled around an industry's anchor to check the ground under its footprint. */
const RING: [number, number][] = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [0.7, 0.7], [-0.7, 0.7], [0.7, -0.7], [-0.7, -0.7]];

interface Pick0 {
  key: string;
  tag: string;
  origin: IndustryOrigin;
  x: number;
  y: number;
  score: number;
  why: Msg | string;
  /** The real site's name (OSM). */
  name?: string;
}

/**
 * Footprint radius (game m) around the construction's anchor, from the `ground_face` of each
 * `industries/<tag>/<tag>.script.lua` (FACT-024); water industries: their collider. The whole
 * footprint must stay off water.
 */
const FOOTPRINT_M: Record<string, number> = {
  forest: 92, printing_press: 89, bricks_works: 95, furniture_factory: 99, cotton_farm: 100, livestock_farm: 101,
  rubber_farm: 103, brewery: 105, farm: 108, textile_factory: 111, tool_factory: 111, weaving_mill: 113,
  cement_plant: 116, food_factory: 117, quarry: 118, machine_factory: 121, paper_mill: 121, sand_pit: 129,
  glass_works: 131, vehicle_factory: 132, saw_mill: 134, tire_factory: 143, clay_pit: 143, steel_mill: 144,
  oil_well: 147, iron_ore_mine: 151, oil_refinery: 151, coal_mine: 167, chemical_plant: 174,
  oil_platform: 42, fishing_grounds: 51, sand_excavator: 81,
};
export const footprintM = (tag: string): number => FOOTPRINT_M[tag] ?? 180;

/**
 * Names of the generated industries in the app's language (they become the in-game names): the
 * industry names and a pattern with `{industry}` and `{town}` ("{town} {industry}" in English).
 * Without it, French: « Ferme de Bron ».
 */
export interface IndustryNaming {
  pattern: string;
  labels: Record<string, string>;
}

/**
 * « Ferme de Bron », « Carrière d'Écully », « Scierie du Havre », « Brasserie des Avenières »; with
 * `naming`, its pattern and industry name for the tag.
 */
export function industryName(label: string, town: string, naming?: IndustryNaming, tag?: string): string {
  if (naming) return naming.pattern.replaceAll("{industry}", (tag && naming.labels[tag]) || label).replaceAll("{town}", town);
  const le = /^(Les?)\s+(.+)$/.exec(town);
  if (le) return `${label} ${le[1] === "Le" ? "du" : "des"} ${le[2]}`;
  return /^[aeiouyhâàéèêëîïôöûüœ]/i.test(town) ? `${label} d'${town}` : `${label} de ${town}`;
}

/**
 * Choose and place the industries. `codes` = WorldCover codes on the grid (or null), `towns` =
 * placed town centres (game m).
 */
export function planIndustries(
  f: Frame,
  g: Grid,
  ground: IndustryGround,
  codes: Uint8Array | null,
  sites: IndustrySite[],
  towns: { x: number; y: number; name?: string }[],
  picks: IndustryPicks,
  o: IndustriesOptions,
  places: { x: number; y: number; name: string }[] = [],
  /** Railway alignments (game m points): industries keep their footprint off the track. */
  railways: [number, number][][] = [],
  /** Added by hand: placed first, near their point; removed by deleting them, not by a pick. */
  custom: CustomIndustry[] = [],
  /** Names in the app's language (French rules without it). */
  naming?: IndustryNaming,
): { industries: MapIndustry[]; candidates: IndustryCandidate[] } {
  const eco = ECONOMIES[o.economy] ?? ECONOMIES.temperate;
  const allowed = (tag: string) => tag in INDUSTRIES && !eco.exclude.includes(tag);
  const p = frameProjection(f);
  const hw = f.widthM / 2;
  const hh = f.heightM / 2;
  const n = g.nx * g.ny;
  const key4 = (tag: string, lon: number, lat: number) => `${tag}|${lon.toFixed(4)},${lat.toFixed(4)}`;

  // Water: open water (sea, big lakes) for water industries; distance to any water for land ones.
  const open = new Uint8Array(n);
  const wet = new Uint8Array(n);
  let anyOpen = false;
  for (let i = 0; i < n; i++) {
    wet[i] = ground.water[i] ? 1 : 0;
    if ((ground.water[i] === WATER_SEA || ground.water[i] === WATER_LAKE) && ground.game[i] <= -4) open[i] = 1;
  }
  const landDist = distanceTo(Uint8Array.from(wet, (w) => 1 - w), g.nx, g.ny); // in water: distance to land
  const waterDist = distanceTo(wet, g.nx, g.ny);
  // Distance to the railway, from its centre line drawn on the grid.
  let railDist: Float32Array | null = null;
  if (railways.length) {
    const line = new Uint8Array(n);
    for (const pts of railways) strokePolyline(line, g.nx, g.ny, pts.map(([x, y]) => worldToCell(f, g, x, y)), 0.5, 1);
    railDist = distanceTo(line, g.nx, g.ny);
  }
  // Water industries need open water far enough from the shore (as checked at placement).
  for (let i = 0; i < n && !anyOpen; i++) if (open[i] && landDist[i] * g.step >= 300) anyOpen = true;
  /** A water industry that cannot sit on water becomes its land counterpart (economy fallbacks). */
  const resolve = (tag: string): string | null => {
    if (!allowed(tag)) {
      if (tag === "sand_pit" && allowed("sand_excavator")) return anyOpen ? "sand_excavator" : null;
      return null;
    }
    if (INDUSTRIES[tag].water && !anyOpen) {
      const fb = eco.fallbacks[tag];
      return fb && allowed(fb) ? fb : null;
    }
    return tag;
  };

  // 1. Real sites, clustered per industry; ports become fishing grounds offshore.
  const real: Pick0[] = [];
  for (const s of sites) {
    const tag = s.tag === "port" ? (anyOpen && allowed("fishing_grounds") ? "fishing_grounds" : null) : resolve(s.tag);
    if (!tag) continue;
    const [x, y] = p.toWorld(s.lon, s.lat);
    if (Math.abs(x) > hw || Math.abs(y) > hh) continue;
    const near = real.find((r) => r.tag === tag && Math.hypot(r.x - x, r.y - y) < CLUSTER_M);
    if (near) {
      near.score++;
      continue;
    }
    real.push({ key: key4(tag, s.lon, s.lat), tag, origin: "osm", x, y, score: 1, why: s.why, name: s.name });
  }

  // 2. Land-cover blocks: farms (crops), livestock (grassland), forests (trees); fishing offshore.
  const blocks: Pick0[] = [];
  const kb = Math.max(1, Math.round(BLOCK_M / g.step));
  for (let br = 0; br * kb < g.ny; br++) {
    for (let bc = 0; bc * kb < g.nx; bc++) {
      let land = 0, crop = 0, grass = 0, tree = 0, sea = 0;
      for (let r = br * kb; r < Math.min(g.ny, (br + 1) * kb); r++) {
        for (let c = bc * kb; c < Math.min(g.nx, (bc + 1) * kb); c++) {
          const i = r * g.nx + c;
          if (ground.water[i]) {
            if (open[i] && landDist[i] * g.step > 600) sea++;
            continue;
          }
          land++;
          const code = codes ? codes[i] : 0;
          if (code === WC_CROP) crop++;
          else if (code === WC_GRASS) grass++;
          else if (code === WC_TREE) tree++;
        }
      }
      const total = kb * kb;
      const [x, y] = cellToWorld(f, g, Math.min(g.nx - 1, (bc + 0.5) * kb), Math.min(g.ny - 1, (br + 0.5) * kb));
      const [lon, lat] = p.toLonLat(x, y);
      const add = (tag: string, share: number, min: number, what: string) => {
        if (share >= min && allowed(tag)) {
          blocks.push({ key: key4(tag, lon, lat), tag, origin: "landcover", x, y, score: share, why: msg(what, { pct: Math.round(share * 100) }) });
        }
      };
      if (land > total * 0.5) {
        add("farm", crop / land, 0.5, "why.crops");
        add("livestock_farm", grass / land, 0.4, "why.grass");
        add("forest", tree / land, 0.6, "why.forest");
        add("cotton_farm", crop / land, 0.6, "why.crops");
      } else if (sea > total * 0.6) add("fishing_grounds", sea / total, 0.6, "why.sea");
    }
  }
  blocks.sort((a, b) => b.score - a.score);

  // 3. Selection. How present each industry is in reality: real sites (3 for a primary, 4 for a
  // factory, + 2 log2 of their number: rarer and more telling than land cover), land cover
  // (1 + 2 × the share of blocks where it qualifies).
  const evidence: Record<string, number> = {};
  const siteCount: Record<string, number> = {};
  for (const r of real) siteCount[r.tag] = (siteCount[r.tag] ?? 0) + r.score;
  for (const [tag, k] of Object.entries(siteCount)) evidence[tag] = (INDUSTRIES[tag].primary ? 3 : 4) + 2 * Math.log2(k);
  const blockCount: Record<string, number> = {};
  for (const b of blocks) blockCount[b.tag] = (blockCount[b.tag] ?? 0) + 1;
  const nBlocks = Math.max(1, Math.ceil(g.nx / kb) * Math.ceil(g.ny / kb));
  for (const [tag, k] of Object.entries(blockCount)) evidence[tag] = Math.max(evidence[tag] ?? 0, 1 + (2 * k) / nBlocks);
  const ev = (tag: string) => evidence[tag] ?? 0;

  // The automatic plan ignores the manual choices (like towns): removing an industry removes it,
  // adding one adds it, nothing is swapped in behind the user's back.
  // Whole chains (one per cargo the towns need), greedily: the chain bringing the industry most
  // present in reality, slightly penalised by the other industries it needs, as long as it fits.
  // Only the chains a new map can have: every industry of tier 0 (DECISION-027). Real sites of
  // later tiers stay in the list, for the user to add by hand.
  const chains = Object.values(eco.chains)
    .map((set) => set.map(resolve))
    .filter((set): set is string[] => set.every((t) => t !== null && atStart(t)))
    .map((set) => [...new Set(set)]);
  // The game's minimum, gameplay first (DECISION-026): with the automatic count, at least one base
  // resource of every chain, the fewest that do it (the one in most chains left first, ties to the
  // one most present in reality); the count grows to leave room for two more industries.
  const auto = o.maxIndustries <= 0;
  const base: string[] = [];
  if (auto) {
    const primaries = [...new Set(chains.flat().filter((t) => INDUSTRIES[t].primary))];
    const left = () => chains.filter((set) => set.some((t) => INDUSTRIES[t].primary) && !set.some((t) => base.includes(t)));
    for (let open = left(); open.length; open = left()) {
      const score = (t: string) => open.filter((set) => set.includes(t)).length + ev(t) / 100;
      base.push(primaries.filter((t) => !base.includes(t)).sort((a, b) => score(b) - score(a))[0]);
    }
  }
  const quota = auto ? Math.max(defaultIndustryCount(f, o.density), base.length + 2) : o.maxIndustries;
  const types: string[] = [...base];
  for (;;) {
    let best: { add: string[]; value: number } | null = null;
    for (const set of chains) {
      const add = set.filter((t) => !types.includes(t));
      if (!add.length || types.length + add.length > quota) continue;
      const value = Math.max(...add.map(ev)) - 0.25 * (add.length - 1);
      if (!best || value > best.value || (value === best.value && add.length < best.add.length)) best = { add, value };
    }
    if (!best) break;
    types.push(...best.add);
  }
  // Room left: a second site of the industries best attested in reality.
  const extra: string[] = [];
  while (types.length + extra.length < quota) {
    const next = types
      .filter((t) => ev(t) > 0 && !extra.includes(t))
      .sort((x, y) => ev(y) - ev(x))[0];
    if (!next) break;
    extra.push(next);
  }

  // Where each chosen industry goes: its biggest real site, else its best land-cover block, else
  // a generic spot (valid land far from the others, high ground for mines and quarries).
  const chosen: Pick0[] = [];
  /** A spot for an industry with no real site and no land-cover block. */
  const generic = (tag: string): Pick0 | null => {
    const want = INDUSTRIES[tag]?.water ? "water" : "land";
    let best: Pick0 | null = null;
    for (const b of blocks) {
      const onWaterBlock = b.tag === "fishing_grounds";
      if ((want === "water") !== onWaterBlock) continue;
      if (chosen.some((c) => Math.hypot(c.x - b.x, c.y - b.y) < CLUSTER_M)) continue;
      const [cc, rr] = worldToCell(f, g, b.x, b.y).map(Math.round);
      const z = ground.game[Math.min(g.ny - 1, Math.max(0, rr)) * g.nx + Math.min(g.nx - 1, Math.max(0, cc))];
      const score = /mine|quarry|pit/.test(tag) ? z : -Math.abs(z);
      if (!best || score > best.score) {
        const [lon, lat] = p.toLonLat(b.x, b.y);
        best = { key: key4(tag, lon, lat), tag, origin: "chain", x: b.x, y: b.y, score, why: "" };
      }
    }
    return best;
  };
  const sorted = [...real.sort((a2, b2) => b2.score - a2.score), ...blocks];
  const spot = (tag: string): Pick0 | null => {
    const own = sorted.find((c) => c.tag === tag && !chosen.includes(c) && !chosen.some((o2) => Math.hypot(o2.x - c.x, o2.y - c.y) < o.minSpacingM));
    if (own) return own;
    const g2 = generic(tag);
    return g2 && !chosen.some((c) => c.key === g2.key) ? g2 : null;
  };
  const users = (tag: string) => types.filter((t) => t !== tag && !INDUSTRIES[t].primary && chains.some((set) => set.includes(t) && set.includes(tag)));
  for (const tag of [...types, ...extra]) {
    // No spot at all (e.g. a water industry with no open water left): its land counterpart.
    const fb = eco.fallbacks[tag];
    const c = spot(tag) ?? (fb && allowed(fb) && !types.includes(fb) ? spot(fb) : null);
    if (!c) continue;
    if (c.origin === "chain") {
      const need = users(tag);
      c.why = need.length ? msg("why.supplies", { list: msg("@industries", { tags: need.join(",") }) }) : msg("why.chain");
    }
    chosen.push(c);
  }
  // Manual choices on top: removals leave a gap, additions come from the listed candidates.
  const autoChosen = [...chosen];
  for (let k = chosen.length - 1; k >= 0; k--) if (picks[chosen[k].key] === false) chosen.splice(k, 1);
  // Unchosen candidates worth offering: the removed ones, every real site, and the two best
  // land-cover blocks per industry.
  const offered: Pick0[] = [...autoChosen, ...real];
  const perTag: Record<string, number> = {};
  for (const b of blocks) {
    if ((perTag[b.tag] = (perTag[b.tag] ?? 0) + 1) <= 2) offered.push(b);
  }
  for (const c of offered) if (picks[c.key] === true && !chosen.some((x) => x.key === c.key)) chosen.push(c);
  const added: Pick0[] = custom
    .filter((c) => allowed(c.tag))
    .map((c) => {
      const [x, y] = p.toWorld(c.lon, c.lat);
      return { key: c.key, tag: c.tag, origin: "user" as const, x, y, score: Infinity, why: msg("origin.user") };
    });
  chosen.unshift(...added);

  // 4. Placement.
  /** The real name, else « <industry> de <nearest town> » (placed towns first, then any place). */
  const nameOf = (c: Pick0, x: number, y: number): string => {
    if (c.name) return c.name;
    const pool = towns.some((t) => t.name) ? towns : places;
    let best: { name?: string } | null = null;
    let bestD = Infinity;
    for (const t of pool) {
      const d = Math.hypot(t.x - x, t.y - y);
      if (t.name && d < bestD) {
        bestD = d;
        best = t;
      }
    }
    const label = naming?.labels[c.tag] ?? INDUSTRIES[c.tag].label;
    return best?.name ? industryName(INDUSTRIES[c.tag].label, best.name, naming, c.tag) : label;
  };
  const placed: MapIndustry[] = [];
  const lost = new Map<string, Msg>();
  for (const c of chosen) {
    const water = !!INDUSTRIES[c.tag].water;
    const radius = footprintM(c.tag);
    const okCell = (cc: number, rr: number): boolean => {
      if (cc < 0 || rr < 0 || cc >= g.nx || rr >= g.ny) return false;
      const [x, y] = cellToWorld(f, g, cc, rr);
      if (Math.abs(x) > hw - o.edgeMarginM || Math.abs(y) > hh - o.edgeMarginM) return false;
      const i = rr * g.nx + cc;
      if (water) {
        if (!open[i] || landDist[i] * g.step < radius + 200) return false;
      } else {
        // The whole footprint off water (rivers included) and on gentle ground.
        if (ground.water[i] || waterDist[i] * g.step < radius + 30) return false;
        if (railDist && railDist[i] * g.step < radius + 50) return false;
        for (const [dx, dy] of RING) {
          const c2 = Math.round(cc + (dx * radius * 0.7) / g.step);
          const r2 = Math.round(rr + (dy * radius * 0.7) / g.step);
          if (c2 < 0 || r2 < 0 || c2 >= g.nx || r2 >= g.ny) return false;
          if (slopeAt(ground.game, g.nx, g.ny, g.step, c2, r2) > 0.25) return false;
        }
        if (towns.some((t) => Math.hypot(t.x - x, t.y - y) < o.townClearanceM)) return false;
      }
      return !placed.some((m) => Math.hypot(m.x - x, m.y - y) < o.minSpacingM);
    };
    const [c0, r0] = worldToCell(f, g, c.x, c.y).map(Math.round);
    const found = okCell(c0, r0) ? [c0, r0] : nearestValidCell(c0, r0, Math.ceil(o.maxShiftM / g.step), okCell);
    if (!found) {
      lost.set(c.key, msg(water ? "why.noOpenWater" : "why.noFreeLand"));
      continue;
    }
    const [x, y] = cellToWorld(f, g, found[0], found[1]);
    placed.push({ key: c.key, tag: c.tag, label: INDUSTRIES[c.tag].label, name: nameOf(c, x, y), x, y, onWater: water, origin: c.origin });
  }

  // 5. Every candidate with its fate, for the list and the map; factories missing a supplier.
  const chosenKeys = new Set(chosen.map((c) => c.key));
  const placedKeys = new Set(placed.map((m) => m.key));
  const placedTags = new Set(placed.map((m) => m.tag));
  const placedByKey = new Map(placed.map((m) => [m.key, m]));
  const seen = new Set<string>();
  const listed = [...chosen, ...offered.filter((c) => !chosenKeys.has(c.key))].filter((c) => !seen.has(c.key) && seen.add(c.key));
  const smallestChain = (tag: string): string[] | null => {
    let best: string[] | null = null;
    for (const set of chains) if (set.includes(tag) && (!best || set.length < best.length)) best = set;
    return best;
  };
  const candidates: IndustryCandidate[] = listed.map((c) => {
    const [lon, lat] = p.toLonLat(c.x, c.y);
    const status: IndustryStatus = placedKeys.has(c.key) ? "placed" : lost.has(c.key) ? "dropped" : chosenKeys.has(c.key) ? "limit" : "off";
    const missing =
      status === "placed" && !INDUSTRIES[c.tag].primary
        ? (smallestChain(c.tag) ?? []).filter((t) => !placedTags.has(t))
        : [];
    return {
      key: c.key,
      tag: c.tag,
      label: INDUSTRIES[c.tag].label,
      name: placedByKey.get(c.key)?.name ?? nameOf(c, c.x, c.y),
      origin: c.origin,
      lon,
      lat,
      why: c.why,
      pick: picks[c.key] ?? null,
      status,
      reason: lost.get(c.key),
      relevance: Math.round(ev(c.tag) * 10) / 10,
      missing: missing.length ? missing : undefined,
    };
  });
  const rank: Record<IndustryStatus, number> = { placed: 0, dropped: 1, limit: 1, off: 2 };
  candidates.sort((a2, b2) => rank[a2.status] - rank[b2.status] || b2.relevance - a2.relevance || a2.label.localeCompare(b2.label));
  return { industries: placed, candidates };
}

/** `industries` of `<UD>/towns_industries/<name>.lua` (FACT-002). */
/**
 * `industries` of the note `<UD>/towns_industries/realmap_note_<name>.lua`. The game's town-connection command links
 * every industry that exists (FACT-024), so the industries are not in the towns_industries import:
 * the importcity mod builds them after the roads between towns, gives them their name, and links
 * only those of `industryLinks`.
 */
export function industryNoteData(list: MapIndustry[]): {
  tag: string; x: number; y: number; angle: number; onWater: boolean; fileName: string; name: string;
}[] {
  return list.map((m) => ({
    tag: m.tag,
    x: Math.round(m.x * 10) / 10,
    y: Math.round(m.y * 10) / 10,
    angle: 0,
    onWater: m.onWater,
    fileName: industryFile(m.tag),
    name: m.name,
  }));
}

export function industriesData(list: MapIndustry[]): { position: { x: number; y: number }; angle: number; onWater: boolean; fileName: string; tag: string }[] {
  return list.map((m) => ({
    position: { x: Math.round(m.x * 10) / 10, y: Math.round(m.y * 10) / 10 },
    angle: 0,
    onWater: m.onWater,
    fileName: industryFile(m.tag),
    tag: m.tag,
  }));
}
