/**
 * OpenStreetMap shapes from Overpass `out geom` answers: closed ways and multipolygon relations
 * become polygons (rings in lon/lat), open ways become lines. Used for water (land cover comes
 * from WorldCover, `landcover.ts`). Also the Overpass request limits and `/api/status` parsing.
 */

export type LonLat = [number, number];

export type OsmShape =
  | { kind: "polygon"; tags: Record<string, string>; rings: LonLat[][] }
  | { kind: "line"; tags: Record<string, string>; pts: LonLat[] };

export type Bbox = { west: number; south: number; east: number; north: number };

const bb = (b: Bbox) => `${b.south},${b.west},${b.north},${b.east}`;

/** Grid the bbox is grown to (degrees), so a slightly moved area hits the same cached answer. */
export const BBOX_ROUND_DEG = 0.01;

export function roundBbox(b: Bbox, step = BBOX_ROUND_DEG): Bbox {
  const down = (v: number) => Math.round(Math.floor(v / step) * step * 1e6) / 1e6;
  const up = (v: number) => Math.round(Math.ceil(v / step) * step * 1e6) / 1e6;
  return { west: down(b.west), south: down(b.south), east: up(b.east), north: up(b.north) };
}

/** Area of a lon/lat box in km² (small boxes: flat-earth approximation). */
export function bboxAreaKm2(b: Bbox): number {
  const lat = ((b.south + b.north) / 2) * (Math.PI / 180);
  return (b.east - b.west) * 111.32 * Math.cos(lat) * (b.north - b.south) * 110.574;
}

/** Above this area the water query gets slow and may be refused when the server is busy. */
export const LARGE_AREA_KM2 = 2500;

/**
 * Declared `[timeout]` (s) and `[maxsize]` (bytes) for an area. Overpass admits a query only if
 * both fit in half of its free resources (FACT-012): declaring more than needed gets the query
 * refused first under load (504), so they grow with the area instead of the 180 s / 512 MiB default.
 */
export function overpassLimits(b: Bbox): { timeout: number; maxsize: number } {
  const km2 = bboxAreaKm2(b);
  const timeout = Math.round(Math.max(60, Math.min(180, 60 + km2 / 50)));
  const mib = Math.max(64, Math.min(256, 64 * Math.ceil(km2 / 1000)));
  return { timeout, maxsize: mib * 1024 * 1024 };
}

/**
 * Shortest outline (real m) of a pond worth fetching: below about two heightmap samples
 * (4 game m each) across it would not show. Around Lyon at 1:3 (75 m) this drops about a quarter
 * of the water areas for under 1 % of the water surface.
 */
export function minWaterPerimeterM(scale: number): number {
  return Math.round(Math.max(60, 25 * scale));
}

/**
 * Everything the import needs from OSM in one request (Overpass rate-limits back-to-back
 * queries, FACT-012): named places (nodes), lakes / reservoirs / river areas whose outline is
 * longer than `minPerimeterM`, river and canal lines.
 */
export function overpassAreaQuery(b: Bbox, placeKinds: string[], minPerimeterM = 0): string {
  const q = bb(b);
  const { timeout, maxsize } = overpassLimits(b);
  const big = minPerimeterM > 0 ? `(if:length()>${minPerimeterM})` : "";
  return (
    `[out:json][timeout:${timeout}][maxsize:${maxsize}];(` +
    placeKinds.map((k) => `node["place"="${k}"]["name"](${q});`).join("") +
    `way["natural"="water"]${big}(${q});relation["natural"="water"]${big}(${q});` +
    `way["waterway"="riverbank"]${big}(${q});relation["waterway"="riverbank"]${big}(${q});` +
    `way["landuse"="reservoir"]${big}(${q});relation["landuse"="reservoir"]${big}(${q});` +
    `way["waterway"~"^(river|canal)$"](${q});` +
    `);out geom;`
  );
}

export interface OverpassStatus {
  /** Slots per user ("Rate limit: N"); 0 when the text is not a status page. */
  slots: number;
  /** Slots free right now. */
  free: number;
  /** Seconds until the next slot frees up (0 when one is free, null when unknown). */
  waitS: number | null;
}

/**
 * Plain-text `/api/status`: "Rate limit: 2", then "2 slots available now." and/or one
 * "Slot available after: <time>, in N seconds." line per busy slot.
 */
export function parseOverpassStatus(text: string): OverpassStatus {
  const slots = +(text.match(/Rate limit:\s*(\d+)/)?.[1] ?? 0);
  const free = +(text.match(/(\d+)\s+slots?\s+available now/)?.[1] ?? 0);
  const waits = [...text.matchAll(/in\s+(-?\d+)\s+seconds?/g)].map((m) => Math.max(0, +m[1]));
  const waitS = free > 0 ? 0 : waits.length ? Math.min(...waits) : null;
  return { slots, free, waitS };
}

export function isWaterShape(s: OsmShape): boolean {
  const t = s.tags;
  return t.natural === "water" || t.landuse === "reservoir" || !!t.waterway;
}

interface GeomPoint {
  lat: number;
  lon: number;
}
interface OverpassGeomElement {
  type: string;
  tags?: Record<string, string>;
  geometry?: (GeomPoint | null)[];
  members?: { type: string; role: string; geometry?: (GeomPoint | null)[] }[];
}

function toPts(geom: (GeomPoint | null)[] | undefined): LonLat[] {
  const out: LonLat[] = [];
  for (const p of geom ?? []) if (p) out.push([p.lon, p.lat]);
  return out;
}

const same = (a: LonLat, b: LonLat) => a[0] === b[0] && a[1] === b[1];

/** Join way pieces end to end into closed rings; pieces that never close are dropped. */
export function assembleRings(parts: LonLat[][]): LonLat[][] {
  const rings: LonLat[][] = [];
  const open: LonLat[][] = [];
  for (const p of parts) {
    if (p.length < 2) continue;
    if (p.length >= 4 && same(p[0], p[p.length - 1])) rings.push(p);
    else open.push(p);
  }
  while (open.length) {
    let cur = open.pop()!;
    let grown = true;
    while (grown && !same(cur[0], cur[cur.length - 1])) {
      grown = false;
      for (let i = 0; i < open.length; i++) {
        const p = open[i];
        const end = cur[cur.length - 1];
        if (same(end, p[0])) cur = cur.concat(p.slice(1));
        else if (same(end, p[p.length - 1])) cur = cur.concat(p.slice(0, -1).reverse());
        else if (same(cur[0], p[p.length - 1])) cur = p.slice(0, -1).concat(cur);
        else if (same(cur[0], p[0])) cur = p.slice(1).reverse().concat(cur);
        else continue;
        open.splice(i, 1);
        grown = true;
        break;
      }
    }
    if (cur.length >= 4 && same(cur[0], cur[cur.length - 1])) rings.push(cur);
  }
  return rings;
}

export function parseOverpassShapes(json: { elements?: OverpassGeomElement[] }): OsmShape[] {
  const out: OsmShape[] = [];
  for (const e of json.elements ?? []) {
    const tags = e.tags ?? {};
    if (e.type === "way") {
      const pts = toPts(e.geometry);
      if (pts.length < 2) continue;
      const closed = pts.length >= 4 && same(pts[0], pts[pts.length - 1]);
      if (closed && !tags.waterway?.match(/^(river|canal)$/)) out.push({ kind: "polygon", tags, rings: [pts] });
      else out.push({ kind: "line", tags, pts });
    } else if (e.type === "relation") {
      const parts = (e.members ?? [])
        .filter((m) => m.type === "way" && (m.role === "outer" || m.role === "inner" || m.role === ""))
        .map((m) => toPts(m.geometry));
      const rings = assembleRings(parts);
      if (rings.length) out.push({ kind: "polygon", tags, rings });
    }
  }
  return out;
}
