/**
 * Extraits OpenStreetMap de Geofabrik pour les très grandes zones (DECISION-040) : la doc d'Overpass
 * renvoie les extractions de la taille d'un pays vers ces fichiers. Ici, le choix des extraits qui
 * couvrent une zone, à partir de l'index `index-v1.json` (GeoJSON : id, parent, urls.pbf, polygone).
 *
 * Les extraits se chevauchent (Europe et Russie pour Kaliningrad, regroupements comme « dach ») :
 * chaque point d'échantillon de la zone revient au plus petit extrait qui le contient, puis on
 * descend dans les sous-régions (voïvodies, Länder…) quand elles couvrent ce point.
 */
import type { Bbox } from "./osm";

/** Au-delà (km²), les données OSM viennent des extraits Geofabrik et non d'Overpass. */
export const GEOFABRIK_KM2 = 20_000;
export const GEOFABRIK_INDEX_URL = "https://download.geofabrik.de/index-v1.json";

type Ring = [number, number][];

export interface Extract {
  id: string;
  parent: string | null;
  name: string;
  pbf: string;
  /** Anneaux (contours et trous, règle pair-impair). */
  rings: Ring[];
  box: Bbox;
  /** Surface approchée (degrés² corrigés de la latitude), pour préférer le plus petit. */
  area: number;
}

interface IndexJson {
  features?: {
    properties?: { id?: string; parent?: string; name?: string; urls?: { pbf?: string } };
    geometry?: { type: string; coordinates: unknown } | null;
  }[];
}

function ringArea(r: Ring): number {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] - r[i][0]) * (r[j][1] + r[i][1]);
  return Math.abs(a / 2);
}

/**
 * Nom d'extrait en texte simple : l'index contient du HTML pour 21 régions (voïvodies polonaises,
 * Norvège), ex. « Województwo mazowieckie<br />(Mazovian Voivodeship) ».
 */
export function plainName(name: string): string {
  return name
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/** L'index Geofabrik → extraits utilisables (ceux qui ont un .osm.pbf et un polygone). */
export function parseGeofabrikIndex(json: IndexJson): Extract[] {
  const out: Extract[] = [];
  for (const f of json.features ?? []) {
    const p = f.properties ?? {};
    const g = f.geometry;
    if (!p.id || !p.urls?.pbf || !g) continue;
    const polys = (g.type === "MultiPolygon" ? g.coordinates : g.type === "Polygon" ? [g.coordinates] : []) as Ring[][];
    const rings = polys.flat();
    if (!rings.length) continue;
    const box = { west: Infinity, south: Infinity, east: -Infinity, north: -Infinity };
    let area = 0;
    for (const r of rings) {
      for (const [lon, lat] of r) {
        box.west = Math.min(box.west, lon);
        box.east = Math.max(box.east, lon);
        box.south = Math.min(box.south, lat);
        box.north = Math.max(box.north, lat);
      }
    }
    const cos = Math.cos((((box.south + box.north) / 2) * Math.PI) / 180);
    for (const poly of polys) poly.forEach((r, k) => (area += (k === 0 ? 1 : -1) * ringArea(r) * cos));
    out.push({ id: p.id, parent: p.parent ?? null, name: plainName(p.name ?? p.id), pbf: p.urls.pbf, rings, box, area });
  }
  return out;
}

/** Point dans un multipolygone (pair-impair sur tous les anneaux). */
export function inExtract(e: Extract, lon: number, lat: number): boolean {
  if (lon < e.box.west || lon > e.box.east || lat < e.box.south || lat > e.box.north) return false;
  let inside = false;
  for (const r of e.rings) {
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const [xi, yi] = r[i];
      const [xj, yj] = r[j];
      if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

const touches = (a: Bbox, b: Bbox) => a.west <= b.east && a.east >= b.west && a.south <= b.north && a.north >= b.south;

/** Côté de la grille d'échantillons (64 × 64 points). */
const GRID = 64;

/** Grille de points dans la zone, plus les sommets des extraits candidats qui y tombent (petits pays). */
function samples(b: Bbox, candidates: Extract[], n = GRID): [number, number][] {
  const pts: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) pts.push([b.west + ((i + 0.5) * (b.east - b.west)) / n, b.south + ((j + 0.5) * (b.north - b.south)) / n]);
  }
  for (const e of candidates) {
    for (const r of e.rings) {
      for (const [lon, lat] of r) {
        // Un peu vers l'intérieur de la zone : le sommet lui-même est sur le bord de l'extrait.
        if (lon > b.west && lon < b.east && lat > b.south && lat < b.north) pts.push([lon, lat]);
      }
    }
  }
  return pts;
}

/**
 * Les extraits à télécharger pour couvrir `b`. Chaque point d'échantillon revient au plus petit
 * extrait **sans sous-région** qui le contient (voïvodie, Land, petit pays) ; à défaut au plus petit
 * extrait qui a un parent (un pays découpé en partie seulement) ; jamais à un continent : un point
 * en pleine mer n'est couvert que par « europe », il ne doit pas faire télécharger toute l'Europe.
 * Les hiérarchies distinctes (Kaliningrad sous « russia », pas sous « europe ») sont ainsi couvertes.
 */
export function pickExtracts(index: Extract[], b: Bbox): (Extract & { share: number })[] {
  const hasChildren = new Set(index.map((e) => e.parent).filter((p): p is string => !!p));
  const near = index.filter((e) => touches(e.box, b));
  const leaves = near.filter((e) => !hasChildren.has(e.id));
  const middles = near.filter((e) => hasChildren.has(e.id) && e.parent);
  const smallest = (list: Extract[], lon: number, lat: number) => {
    let best: Extract | null = null;
    for (const e of list) if ((!best || e.area < best.area) && inExtract(e, lon, lat)) best = e;
    return best;
  };
  const picked = new Map<string, Extract>();
  // Part de la zone (points de la grille seulement) revenue à chaque extrait.
  const gridHits = new Map<string, number>();
  // Repli sur un pays : points comptés, et points de ce pays déjà couverts par ses régions.
  const fallback = new Map<Extract, number>();
  const coveredIn = new Map<Extract, number>();
  for (const [k, [lon, lat]] of samples(b, near).entries()) {
    const onGrid = k < GRID * GRID;
    const leaf = smallest(leaves, lon, lat);
    if (leaf) {
      picked.set(leaf.id, leaf);
      if (onGrid) gridHits.set(leaf.id, (gridHits.get(leaf.id) ?? 0) + 1);
      for (const m of middles) if (inExtract(m, lon, lat)) coveredIn.set(m, (coveredIn.get(m) ?? 0) + 1);
      continue;
    }
    const m = smallest(middles, lon, lat);
    if (m) {
      fallback.set(m, (fallback.get(m) ?? 0) + 1);
      if (onGrid) gridHits.set(m.id, (gridHits.get(m.id) ?? 0) + 1);
    }
  }
  // Un pays dont les régions couvrent l'essentiel de ses points : le reste est la bande de mer de
  // son polygone, pas un trou de données (sinon toute la Pologne, 2 Go, viendrait en plus des voïvodies).
  for (const [m, own] of fallback) {
    const covered = coveredIn.get(m) ?? 0;
    if (covered < 0.9 * (covered + own)) picked.set(m.id, m);
  }
  return [...picked.values()]
    .map((e) => ({ ...e, share: (gridHits.get(e.id) ?? 0) / (GRID * GRID) }))
    .sort((x, y) => x.id.localeCompare(y.id));
}

/** Un extrait lourd pour une bande de la zone : ignoré (et dit à l'utilisateur), pas téléchargé. */
export const SLIVER_SHARE = 0.01;
export const SLIVER_BYTES = 100e6;
export function isSliver(share: number, bytes: number): boolean {
  return share < SLIVER_SHARE && bytes > SLIVER_BYTES;
}

/** Vitesses (octets / s) de téléchargement et de lecture, mesurées puis gardées par l'app. */
export interface Rates {
  download: number;
  read: number;
}
/** Avant toute mesure : 8 Mo/s de téléchargement, 60 Mo/s de lecture (mesuré : 55 Mo en 0,8 s). */
export const DEFAULT_RATES: Rates = { download: 8e6, read: 60e6 };

/** Une région de la liste : octets à télécharger (0 si en cache), octets à lire (0 si déjà lue). */
export interface RegionCost {
  download: number;
  read: number;
}

/** Secondes pour une région : téléchargement puis lecture. */
export function estimateSeconds(c: RegionCost, r: Rates): number {
  return c.download / r.download + c.read / r.read;
}

/**
 * Secondes pour toutes les régions, la lecture d'une région se faisant pendant le téléchargement de
 * la suivante : les régions déjà téléchargées sont lues d'abord, puis le pas le plus lent fixe le temps.
 */
export function totalSeconds(list: RegionCost[], r: Rates): number {
  let dl = 0; // fin du téléchargement en cours
  let rd = 0; // fin de la lecture en cours
  for (const c of [...list].sort((a, b) => a.download - b.download)) {
    dl += c.download / r.download;
    rd = Math.max(rd, dl) + c.read / r.read;
  }
  return Math.max(dl, rd);
}

/** Mise à jour d'une vitesse mesurée (moyenne glissante, mesures trop courtes ignorées). */
export function updateRate(old: number, bytes: number, seconds: number): number {
  if (bytes < 5e6 || seconds < 0.5) return old;
  return 0.5 * old + 0.5 * (bytes / seconds);
}
