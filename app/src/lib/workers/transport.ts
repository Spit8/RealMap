/**
 * Sending a terrain request to the worker in pieces. Chromium (WebView2) serializes one message
 * into a single buffer of about 1.8 GiB at most ("Data cannot be cloned, out of memory"): a large
 * area's DEM tiles and OSM data together go past it. So the page sends the small settings first,
 * then each raster on its own (a copy, transferred) and the OSM lists in batches, then "run".
 */
import { cropDem, type DemRaster } from "../core/dem";
import type { CoverRaster } from "../core/landcover";
import type { TerrainRequest } from "./terrain.worker";

type Bbox = { west: number; south: number; east: number; north: number };

/** The request's lists sent in pieces. */
export type PartField = "rasters" | "bathy" | "cover" | "water" | "places" | "sites" | "roads" | "land.beaches" | "land.business";

export type WorkerInput =
  | { kind: "begin"; req: TerrainRequest }
  | { kind: "part"; field: PartField; items: unknown[] }
  | { kind: "ign"; ign: Float32Array }
  | { kind: "run" };

export interface OutMessage {
  msg: WorkerInput;
  transfer: Transferable[];
  /** Bytes of pixels or OSM points in it, for the log. */
  bytes: number;
}

/** About 200 000 points (≈ 4 Mio once serialized) per OSM message. */
export const MAX_POINTS_PER_MESSAGE = 200_000;

/** Points in an OSM item (shapes, ways); 1 for a point-like item. */
export function pointsOf(item: unknown): number {
  const o = item as { rings?: unknown[][]; pts?: unknown[] };
  if (Array.isArray(o?.rings)) return o.rings.reduce((n, ring) => n + ring.length, 0);
  if (Array.isArray(o?.pts)) return o.pts.length;
  return 1;
}

/** Consecutive batches of at most `maxWeight` (an item heavier than that goes alone). */
export function chunkItems<T>(items: T[], weight: (item: T) => number, maxWeight: number): T[][] {
  const out: T[][] = [];
  let cur: T[] = [];
  let w = 0;
  for (const item of items) {
    const iw = Math.max(1, weight(item));
    if (cur.length && w + iw > maxWeight) {
      out.push(cur);
      cur = [];
      w = 0;
    }
    cur.push(item);
    w += iw;
  }
  if (cur.length) out.push(cur);
  return out;
}

/** The request with its large lists emptied (they follow as parts). */
export function requestHead(req: TerrainRequest): TerrainRequest {
  return {
    ...req,
    ign: null,
    rasters: [],
    bathy: [],
    cover: req.cover ? [] : null,
    water: [],
    places: [],
    sites: [],
    roads: [],
    land: req.land ? { beaches: [], business: [] } : undefined,
  };
}

/** Puts a part back into the request being rebuilt (worker side). */
export function addPart(req: TerrainRequest, field: PartField, items: unknown[]): void {
  if (field === "land.beaches" || field === "land.business") {
    req.land ??= { beaches: [], business: [] };
    const list = (field === "land.beaches" ? req.land.beaches : req.land.business) as unknown[];
    list.push(...items);
    return;
  }
  if (field === "cover") req.cover ??= [];
  (req[field] as unknown[]).push(...items);
}

/** A raster with its own pixels, so its buffer can be transferred (the page's cache keeps the original). */
function ownDem(r: DemRaster, crop: Bbox | null): DemRaster | null {
  const c = crop ? cropDem(r, crop) : r;
  if (!c) return null;
  return c === r ? { ...r, data: r.data.slice() } : c;
}

function ownCover(r: CoverRaster): CoverRaster {
  return { ...r, data: r.data.slice() };
}

/**
 * The messages for one request, made one at a time (the raster copies exist one message at a
 * time). `crop`: the box the DEM tiles are cut to (the frame and its sampling margin).
 */
export function* requestMessages(req: TerrainRequest, crop: Bbox | null): Generator<OutMessage> {
  yield { msg: { kind: "begin", req: requestHead(req) }, transfer: [], bytes: 0 };
  for (const field of ["rasters", "bathy"] as const) {
    for (const r of req[field]) {
      const own = field === "rasters" ? ownDem(r, crop) : ownDem(r, null);
      if (own) yield { msg: { kind: "part", field, items: [own] }, transfer: [own.data.buffer], bytes: own.data.byteLength };
    }
  }
  for (const r of req.cover ?? []) {
    const own = ownCover(r);
    yield { msg: { kind: "part", field: "cover", items: [own] }, transfer: [own.data.buffer], bytes: own.data.byteLength };
  }
  const lists: [PartField, unknown[]][] = [
    ["water", req.water],
    ["places", req.places],
    ["sites", req.sites],
    ["roads", req.roads],
    ["land.beaches", req.land?.beaches ?? []],
    ["land.business", req.land?.business ?? []],
  ];
  for (const [field, items] of lists) {
    for (const batch of chunkItems(items, pointsOf, MAX_POINTS_PER_MESSAGE)) {
      const pts = batch.reduce((n: number, it) => n + pointsOf(it), 0);
      yield { msg: { kind: "part", field, items: batch }, transfer: [], bytes: pts * 16 };
    }
  }
  if (req.ign) yield { msg: { kind: "ign", ign: req.ign }, transfer: [req.ign.buffer], bytes: req.ign.byteLength };
  yield { msg: { kind: "run" }, transfer: [], bytes: 0 };
}
