/**
 * Réduction des données OSM d'une très grande zone (un pays entier), avant le calcul :
 *  - `cropToFrame` : seuls les éléments qui touchent le cadre de la carte (une réponse en cache
 *    pour une zone plus grande, réutilisée pour une petite carte, ne transporte plus tout le pays) ;
 *  - `simplifyInputs` : géométries simplifiées (Douglas-Peucker itératif) quand le pas réel de la
 *    grille complète dépasse SIMPLIFY_MIN_TOL_M × 2 ; les cartes habituelles ne changent pas.
 * Les routes gardent `nodes` et `pts` alignés, avec leurs extrémités et leurs carrefours.
 */
import type { IndustrySite } from "./industries";
import type { BusinessArea, LandUse } from "./landuse";
import type { NetworkWay } from "./network";
import type { Bbox, LonLat, OsmShape } from "./osm";
import type { OsmPlace } from "./towns";

/** En dessous de cette tolérance (m réels), rien n'est simplifié. */
export const SIMPLIFY_MIN_TOL_M = 20;

/** Tolérance de simplification (m réels) pour un pas de grille complète donné, 0 si inutile. */
export function simplifyTolerance(fullStepRealM: number): number {
  const tol = fullStepRealM / 2;
  return tol > SIMPLIFY_MIN_TOL_M ? tol : 0;
}

type Box = { west: number; south: number; east: number; north: number };

function boxOfPts(pts: LonLat[], b: Box): void {
  for (const [lon, lat] of pts) {
    if (lon < b.west) b.west = lon;
    if (lon > b.east) b.east = lon;
    if (lat < b.south) b.south = lat;
    if (lat > b.north) b.north = lat;
  }
}

/** Boîte lon/lat d'un élément OSM (forme, voie, lieu, site, zone d'activité). */
export function itemBox(item: unknown): Box {
  const o = item as { rings?: LonLat[][]; pts?: LonLat[]; lon?: number; lat?: number } & Partial<Box>;
  if (Array.isArray(o.rings) || Array.isArray(o.pts)) {
    const b = { west: Infinity, south: Infinity, east: -Infinity, north: -Infinity };
    for (const ring of o.rings ?? []) boxOfPts(ring, b);
    boxOfPts(o.pts ?? [], b);
    return b;
  }
  if (typeof o.lon === "number" && typeof o.lat === "number") return { west: o.lon, south: o.lat, east: o.lon, north: o.lat };
  return { west: o.west ?? Infinity, south: o.south ?? Infinity, east: o.east ?? -Infinity, north: o.north ?? -Infinity };
}

const touches = (a: Box, b: Box) => a.west <= b.east && a.east >= b.west && a.south <= b.north && a.north >= b.south;

/** Les éléments qui touchent `frame` (gardés entiers, même à cheval sur le bord). */
export function cropToFrame<T>(items: T[], frame: Bbox): T[] {
  return items.filter((it) => touches(itemBox(it), frame));
}

/**
 * Douglas-Peucker itératif (pile explicite : pas de dépassement de pile sur 1 M de points).
 * `keep[i]` déjà vrai = point imposé (extrémité, carrefour) ; les autres sont gardés si nécessaires.
 * Coordonnées en mètres locaux (projection équirectangulaire autour de `lat0`).
 */
export function douglasPeucker(pts: LonLat[], tolM: number, keep: Uint8Array): Uint8Array {
  const n = pts.length;
  if (n < 3) {
    keep.fill(1);
    return keep;
  }
  const lat0 = (pts[0][1] * Math.PI) / 180;
  const kx = 111_320 * Math.cos(lat0);
  const ky = 110_574;
  const x = (i: number) => pts[i][0] * kx;
  const y = (i: number) => pts[i][1] * ky;
  keep[0] = 1;
  keep[n - 1] = 1;
  // Segments entre deux points imposés consécutifs.
  const stack: number[] = [];
  let prev = 0;
  for (let i = 1; i < n; i++) {
    if (keep[i]) {
      if (i - prev > 1) stack.push(prev, i);
      prev = i;
    }
  }
  const tol2 = tolM * tolM;
  while (stack.length) {
    const b = stack.pop()!;
    const a = stack.pop()!;
    const ax = x(a), ay = y(a), bx = x(b), by = y(b);
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let worst = -1;
    let worstD = tol2;
    for (let i = a + 1; i < b; i++) {
      const px = x(i) - ax, py = y(i) - ay;
      let d2: number;
      if (len2 === 0) d2 = px * px + py * py;
      else {
        const t = Math.max(0, Math.min(1, (px * dx + py * dy) / len2));
        const ex = px - t * dx, ey = py - t * dy;
        d2 = ex * ex + ey * ey;
      }
      if (d2 > worstD) {
        worstD = d2;
        worst = i;
      }
    }
    if (worst >= 0) {
      keep[worst] = 1;
      if (worst - a > 1) stack.push(a, worst);
      if (b - worst > 1) stack.push(worst, b);
    }
  }
  return keep;
}

function simplifyLine(pts: LonLat[], tolM: number): LonLat[] {
  const keep = douglasPeucker(pts, tolM, new Uint8Array(pts.length));
  return pts.filter((_, i) => keep[i]);
}

/** Un anneau fermé : au moins 4 points ; un anneau plus petit que la tolérance disparaît. */
function simplifyRing(ring: LonLat[], tolM: number): LonLat[] | null {
  if (ring.length <= 4) return ring;
  const out = simplifyLine(ring, tolM);
  if (out.length >= 4) return out;
  const b = { west: Infinity, south: Infinity, east: -Infinity, north: -Infinity };
  boxOfPts(ring, b);
  const lat0 = ((b.south + b.north) / 2) * (Math.PI / 180);
  const extentM = Math.max((b.east - b.west) * 111_320 * Math.cos(lat0), (b.north - b.south) * 110_574);
  return extentM < tolM ? null : ring;
}

export function simplifyShape(s: OsmShape, tolM: number): OsmShape | null {
  if (s.kind === "line") return { ...s, pts: simplifyLine(s.pts, tolM) };
  const rings: LonLat[][] = [];
  for (const [k, ring] of s.rings.entries()) {
    const r = simplifyRing(ring, tolM);
    if (r) rings.push(r);
    else if (k === 0) return null; // contour extérieur trop petit : la forme entière
  }
  return rings.length ? { ...s, rings } : null;
}

/** Voies simplifiées, `nodes` et `pts` ensemble ; extrémités et nœuds partagés toujours gardés. */
export function simplifyWays(ways: NetworkWay[], tolM: number): NetworkWay[] {
  const uses = new Map<number, number>();
  for (const w of ways) for (const id of w.nodes) uses.set(id, (uses.get(id) ?? 0) + 1);
  return ways.map((w) => {
    if (w.pts.length < 3) return w;
    const keep = new Uint8Array(w.pts.length);
    // Un nœud vu deux fois (carrefour, ou boucle sur la même voie) reste un sommet du graphe.
    w.nodes.forEach((id, i) => {
      if ((uses.get(id) ?? 0) > 1) keep[i] = 1;
    });
    douglasPeucker(w.pts, tolM, keep);
    const nodes: number[] = [];
    const pts: [number, number][] = [];
    for (let i = 0; i < w.pts.length; i++) {
      if (!keep[i]) continue;
      nodes.push(w.nodes[i]);
      pts.push(w.pts[i]);
    }
    return { ...w, nodes, pts };
  });
}

export interface OsmLists {
  water: OsmShape[];
  places: OsmPlace[];
  sites: IndustrySite[];
  roads: NetworkWay[];
  land: LandUse;
}

/** Points de géométrie (pour le journal). */
export function pointCount(l: Pick<OsmLists, "water" | "roads" | "land">): number {
  const shape = (s: OsmShape) => (s.kind === "line" ? s.pts.length : s.rings.reduce((n, r) => n + r.length, 0));
  return (
    l.water.reduce((n, s) => n + shape(s), 0) +
    l.land.beaches.reduce((n, s) => n + shape(s), 0) +
    l.roads.reduce((n, w) => n + w.pts.length, 0)
  );
}

/** Les listes OSM coupées au cadre puis, si `tolM` > 0, simplifiées. */
export function reduceOsm(l: OsmLists, frame: Bbox, tolM: number): OsmLists {
  const water = cropToFrame(l.water, frame);
  const beaches = cropToFrame(l.land.beaches, frame);
  const business: BusinessArea[] = cropToFrame(l.land.business, frame);
  const roads = cropToFrame(l.roads, frame);
  const out: OsmLists = {
    water,
    places: cropToFrame(l.places, frame),
    sites: cropToFrame(l.sites, frame),
    roads,
    land: { beaches, business },
  };
  if (tolM <= 0) return out;
  const shapes = (list: OsmShape[]) => list.map((s) => simplifyShape(s, tolM)).filter((s): s is OsmShape => s !== null);
  return { ...out, water: shapes(water), roads: simplifyWays(roads, tolM), land: { beaches: shapes(beaches), business } };
}
