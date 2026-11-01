/**
 * What each town asks for at the start (DECISION-015, -016, -017): like the game at level 0, one
 * commercial and one industrial good of tier 0 or 1 (FACT-030: the game adds the others as the town
 * grows), drawn at random among the final goods of the production chains actually on the map,
 * weighted towards goods made far away (the whole point of the game is to carry them) and spread
 * over the goods like the game does. Sent to the mod, which applies them with
 * `makeTownUpdateCargoNeedsCmd`.
 */
import { ECONOMIES, type EconomyId } from "./industries";

/** Goods a town's commercial / industrial land use can ask for (the game's categories). */
export const COMMERCIAL_CARGO = ["beverages", "books", "clothes", "fish", "meat", "tinned_food", "vegetables"];
export const INDUSTRIAL_CARGO = ["bricks", "cement", "fuel", "furniture", "machines", "planks", "tools", "vehicles"];

/** The industry making each town good (the last step of its chain). */
export const PRODUCER: Record<string, string> = {
  beverages: "brewery",
  books: "printing_press",
  clothes: "textile_factory",
  fish: "fishing_grounds",
  meat: "livestock_farm",
  tinned_food: "food_factory",
  vegetables: "farm",
  bricks: "bricks_works",
  cement: "cement_plant",
  fuel: "oil_refinery",
  furniture: "furniture_factory",
  machines: "machine_factory",
  planks: "saw_mill",
  tools: "tool_factory",
  vehicles: "vehicle_factory",
};

/** Tier of each town good (`placementparamsutil.lua`): 0 primary, 1 processed, 2 advanced. */
export const CARGO_TIER: Record<string, number> = {
  fish: 0,
  meat: 0,
  vegetables: 0,
  beverages: 1,
  books: 1,
  clothes: 1,
  tinned_food: 1,
  bricks: 0,
  cement: 0,
  fuel: 0,
  planks: 0,
  furniture: 1,
  machines: 1,
  tools: 1,
  vehicles: 2,
};

/** A town this close (game m) to the industry making a good only gets it when no other can. */
export const NEAR_PRODUCER_M = 2000;

export interface TownNeeds {
  com: string[];
  ind: string[];
}

export interface NeedTown {
  x: number;
  y: number;
  capacity: number;
}

export interface NeedIndustry {
  tag: string;
  x: number;
  y: number;
}

/** The town goods whose whole chain is on the map, with where they are made. */
export function availableGoods(industries: NeedIndustry[], economy: EconomyId, goods: string[]): { cargo: string; at: NeedIndustry[] }[] {
  const tags = new Set(industries.map((i) => i.tag));
  const chains = ECONOMIES[economy].chains;
  const out: { cargo: string; at: NeedIndustry[] }[] = [];
  for (const cargo of goods) {
    const chain = chains[cargo];
    if (!chain || !chain.every((t) => tags.has(t) || ECONOMIES[economy].fallbacks[t] && tags.has(ECONOMIES[economy].fallbacks[t]))) continue;
    const at = industries.filter((i) => i.tag === PRODUCER[cargo]);
    if (at.length) out.push({ cargo, at });
  }
  return out;
}

/** Small seeded random generator (mulberry32): the same map always gets the same needs. */
export function seededRandom(seed: string): () => number {
  let h = 1779033703;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 3432918353) ^ (h >>> 13);
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The goods a new town may start with (level 0): tiers 0 and 1, never 2. */
export function startGoods<T extends { cargo: string }>(goods: T[]): T[] {
  return goods.filter((g) => (CARGO_TIER[g.cargo] ?? 2) <= 1);
}

/**
 * One good per town for one land use, drawn at random like the game, with the game's balance
 * (a good already asked by many towns of the map weighs less: max count + 1 − its count) times
 * the distance to the nearest industry making it; a town closer than NEAR_PRODUCER_M to a good's
 * producer never gets that good, and a town near every producer gets none (the game draws its own).
 * Towns are visited in a random order.
 */
export function drawGoods(towns: NeedTown[], goods: { cargo: string; at: NeedIndustry[] }[], random: () => number): string[][] {
  const out: string[][] = towns.map(() => []);
  if (!goods.length || !towns.length) return out;
  const dist = goods.map((g) => towns.map((t) => Math.min(...g.at.map((i) => Math.hypot(i.x - t.x, i.y - t.y)))));
  const count = goods.map(() => 0);
  const order = towns.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  for (const t of order) {
    const most = Math.max(...count);
    const w = goods.map((_, k) => (dist[k][t] < NEAR_PRODUCER_M ? 0 : dist[k][t] * (most + 1 - count[k])));
    const sum = w.reduce((x, y) => x + y, 0);
    if (sum <= 0) continue;
    let r = random() * sum;
    let k = 0;
    while (k < w.length - 1 && (r -= w[k]) > 0) k++;
    while (w[k] === 0) k--;
    out[t].push(goods[k].cargo);
    count[k]++;
  }
  return out;
}

/**
 * Start goods per town: one commercial and one industrial, drawn among the goods made on the map
 * (`seed`: the same map always gets the same draw).
 */
export function townNeeds(towns: NeedTown[], industries: NeedIndustry[], economy: EconomyId, seed = ""): TownNeeds[] {
  const random = seededRandom(seed);
  const com = drawGoods(towns, startGoods(availableGoods(industries, economy, COMMERCIAL_CARGO)), random);
  const ind = drawGoods(towns, startGoods(availableGoods(industries, economy, INDUSTRIAL_CARGO)), random);
  return towns.map((_, i) => ({ com: com[i], ind: ind[i] }));
}
