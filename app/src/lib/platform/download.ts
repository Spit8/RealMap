/**
 * Network access through the Tauri http plugin (no CORS limits in the webview), with disk caches
 * under the app cache folder for DEM tiles, IGN blocks, WorldCover windows and Overpass answers.
 */
import { fetch } from "@tauri-apps/plugin-http";
import { appCacheDir } from "@tauri-apps/api/path";
import { fromArrayBuffer, fromCustomClient, type BaseClient } from "geotiff";
import type { Frame } from "../core/area";
import { emodnetUrl, etopoUrl, growBbox, inEmodnet, parseEtopoJson } from "../core/bathymetry";
import { copernicusTileUrl, type DemRaster } from "../core/dem";
import type { Grid } from "../core/grid";
import { decodeBil, ignBlocks, ignBlockUrl, ignRaster, pasteBlock, resampleToGrid } from "../core/ign";
import {
  coverRasterFor, worldcoverTilesFor, worldcoverTileUrl, worldcoverWindow, type CoverRaster,
} from "../core/landcover";
import { parseOverpassStatus, type Bbox, type OverpassStatus } from "../core/osm";
import { ensureDir, fileExists, fileStat, joinPath, readBytes, readText, writeBytes, writeText } from "./fsx";
import { t } from "../i18n/index.svelte";

/**
 * Public Overpass servers, tried in turn (FACT-012): the main instance, then VK Maps (up to date,
 * no per-user slots). kumi.systems and private.coffee timed out or served stale data: not used.
 */
const OVERPASS = [
  { name: "overpass-api.de", base: "https://overpass-api.de/api", slots: true },
  // No per-user slots (`Rate limit: 0`): its /status says nothing useful and can take 20 s.
  { name: "VK Maps", base: "https://maps.mail.ru/osm/tools/overpass/api", slots: false },
];
/** `/status` answers within this (s) or is ignored: a hung status page must not hold a query. */
const STATUS_TIMEOUT_S = 5;
/** Requests at once: overpass-api.de gives 2 slots per user (FACT-012). */
const OVERPASS_PARALLEL = 2;

/** overpass-api.de answers 406 to requests without an identifying User-Agent (FACT-008). */
export const USER_AGENT = "RealMap/0.9 (Transport Fever 3 map importer)";

const overpassCache = new Map<string, unknown>();
/** Answers older than this are fetched again. */
const OVERPASS_CACHE_MS = 30 * 24 * 3600 * 1000;
/** Rounds over all servers before giving up, and the pause after each failed round. */
const ROUND_WAIT_S = [30, 60];
/** A slot announced further away than this: try the other server instead of waiting. */
const MAX_SLOT_WAIT_S = 60;

export type OverpassWait = (seconds: number, reason: string) => void;

/** Where an answer came from, for the steps and the technical journal. */
export interface OverpassOrigin {
  /** "cache" (same or larger area, `ageMs` old) or the server's name. */
  source: string;
  ageMs: number;
  ms: number;
  bytes: number;
}

/** At most OVERPASS_PARALLEL requests at once (the others wait for a free place). */
let overpassRunning = 0;
const overpassWaiting: (() => void)[] = [];
async function overpassPlace(): Promise<() => void> {
  if (overpassRunning >= OVERPASS_PARALLEL) await new Promise<void>((r) => overpassWaiting.push(r));
  overpassRunning++;
  return () => {
    overpassRunning--;
    overpassWaiting.shift()?.();
  };
}

async function sleep(seconds: number, reason: string, onWait?: OverpassWait): Promise<void> {
  for (let s = Math.ceil(seconds); s > 0; s--) {
    onWait?.(s, reason);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function overpassStatus(base: string): Promise<OverpassStatus | null> {
  try {
    const res = await fetch(`${base}/status`, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(STATUS_TIMEOUT_S * 1000) });
    if (!res.ok) return null;
    const st = parseOverpassStatus(await res.text());
    return st.slots > 0 ? st : null;
  } catch {
    return null;
  }
}

/**
 * Overpass query with a disk cache, following the servers' rules (FACT-012): wait for a slot
 * announced by `/api/status` before sending; on a 429 (rate limit) or 502/504 (server full) move
 * on to the next server, and pause 30 s then 60 s between rounds over all of them. Two requests run
 * at once (the two slots). With `bbox` (the one written in the query), an answer cached for the
 * same query over a larger area is reused: the parsers keep only what lies in the map.
 */
export async function overpass<T>(query: string, onWait?: OverpassWait, bbox?: Bbox, onOrigin?: (o: OverpassOrigin) => void): Promise<T> {
  const t0 = Date.now();
  const cached = await overpassCached<T>(query, bbox);
  if (cached) {
    onOrigin?.({ source: "cache", ageMs: cached.ageMs, ms: Date.now() - t0, bytes: cached.bytes });
    return cached.json;
  }
  const release = await overpassPlace();
  try {
    const got = await overpassNow<T>(query, onWait);
    if (bbox) await rememberArea(query, bbox, got.file);
    onOrigin?.({ source: got.server, ageMs: 0, ms: Date.now() - t0, bytes: got.bytes });
    return got.json;
  } finally {
    release();
  }
}

/** `[out:json][timeout:…][maxsize:…];` and the bbox taken out: what the answer depends on. */
function queryTemplate(query: string, b: Bbox): string {
  return query.replace(/\[timeout:\d+\]\[maxsize:\d+\]/, "").split(`${b.south},${b.west},${b.north},${b.east}`).join("{bbox}");
}

interface AreaEntry {
  template: string;
  bbox: Bbox;
  file: string;
}

async function areaIndexFile(): Promise<string> {
  return joinPath(await cacheDir("overpass"), "areas.json");
}

async function readAreaIndex(): Promise<AreaEntry[]> {
  try {
    const text = await readText(await areaIndexFile());
    return text ? (JSON.parse(text) as AreaEntry[]) : [];
  } catch {
    return [];
  }
}

async function rememberArea(query: string, bbox: Bbox, file: string): Promise<void> {
  const template = queryTemplate(query, bbox);
  const list = (await readAreaIndex()).filter((e) => e.file !== file);
  list.push({ template, bbox, file });
  await writeText(await areaIndexFile(), JSON.stringify(list.slice(-200)));
}

const contains = (o: Bbox, i: Bbox) => o.west <= i.west && o.south <= i.south && o.east >= i.east && o.north >= i.north;

/** The cached answer of this query, or of the same query over an area containing `bbox`. */
async function overpassCached<T>(query: string, bbox?: Bbox): Promise<{ json: T; ageMs: number; bytes: number } | null> {
  if (overpassCache.has(query)) return { json: overpassCache.get(query) as T, ageMs: 0, bytes: 0 };
  const files = [joinPath(await cacheDir("overpass"), `${hashKey(query)}.json`)];
  if (bbox) {
    const template = queryTemplate(query, bbox);
    for (const e of await readAreaIndex()) if (e.template === template && contains(e.bbox, bbox)) files.push(e.file);
  }
  for (const file of files) {
    const st = await fileStat(file);
    if (!st || Date.now() - st.mtimeMs >= OVERPASS_CACHE_MS) continue;
    const text = await readText(file);
    if (!text) continue;
    const json = JSON.parse(text) as T;
    overpassCache.set(query, json);
    return { json, ageMs: Date.now() - st.mtimeMs, bytes: text.length };
  }
  return null;
}

async function overpassNow<T>(query: string, onWait?: OverpassWait): Promise<{ json: T; server: string; file: string; bytes: number }> {
  const file = joinPath(await cacheDir("overpass"), `${hashKey(query)}.json`);
  // The server stops the query after its declared [timeout]; give the answer some time on top.
  const timeoutMs = (+(query.match(/\[timeout:(\d+)\]/)?.[1] ?? 180) + 60) * 1000;
  const failures: string[] = [];
  let refused = false;
  for (let round = 0; round <= ROUND_WAIT_S.length; round++) {
    for (const srv of OVERPASS) {
      const status = srv.slots ? await overpassStatus(srv.base) : null;
      if (status && status.free === 0 && status.waitS) {
        if (status.waitS > MAX_SLOT_WAIT_S) {
          failures.push(t("net.noSlot", { server: srv.name, s: status.waitS }));
          continue;
        }
        await sleep(status.waitS + 1, t("net.waitSlot", { server: srv.name }), onWait);
      }
      onWait?.(0, t("net.sent", { server: srv.name }));
      try {
        const res = await fetch(`${srv.base}/interpreter`, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Accept: "application/json",
            "User-Agent": USER_AGENT,
          },
          body: "data=" + encodeURIComponent(query),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (res.ok) {
          const text = await res.text();
          const json = JSON.parse(text) as T;
          overpassCache.set(query, json);
          await writeText(file, text);
          return { json, server: srv.name, file, bytes: text.length };
        }
        // 400 (query), 406 (User-Agent)…: the other server would refuse it too.
        if (res.status !== 429 && res.status < 500) {
          refused = true;
          throw new Error(t("net.refused", { status: res.status }));
        }
        failures.push(res.status === 429 ? t("net.rateLimit", { server: srv.name }) : t("net.busy", { server: srv.name, status: res.status }));
      } catch (e) {
        if (refused) throw e;
        failures.push(t("net.noAnswer", { server: srv.name }));
      }
    }
    if (round < ROUND_WAIT_S.length) await sleep(ROUND_WAIT_S[round], t("net.serversBusy"), onWait);
  }
  throw new Error(t("net.osmDown", { failures: failures.slice(-OVERPASS.length).join(" ; ") }));
}

async function cacheDir(sub: string): Promise<string> {
  const dir = joinPath(await appCacheDir(), sub);
  await ensureDir(dir);
  return dir;
}

/** Copernicus tile bytes, from the cache or downloaded; null when the tile does not exist (sea). */
async function demTileBytes(name: string): Promise<ArrayBuffer | null> {
  const dir = await cacheDir("dem");
  const file = joinPath(dir, `${name}.tif`);
  const missing = joinPath(dir, `${name}.missing`);
  if (await fileExists(missing)) return null;
  if (await fileExists(file)) return (await readBytes(file)).buffer;
  const res = await fetch(copernicusTileUrl(name));
  if (res.status === 404 || res.status === 403) {
    await writeBytes(missing, new Uint8Array());
    return null;
  }
  if (!res.ok) throw new Error(`Copernicus ${name}: HTTP ${res.status}`);
  const buf = await res.arrayBuffer();
  await writeBytes(file, new Uint8Array(buf));
  return buf;
}

export async function loadDemTile(name: string): Promise<DemRaster | null> {
  const buf = await demTileBytes(name);
  if (!buf) return null;
  const tiff = await fromArrayBuffer(buf);
  const img = await tiff.getImage();
  const [west, north] = img.getOrigin();
  const [resLon, resLat] = img.getResolution();
  const rasters = await img.readRasters({ samples: [0], interleave: true });
  const data = rasters instanceof Float32Array ? rasters : Float32Array.from(rasters as ArrayLike<number>);
  const nd = img.getGDALNoData();
  return {
    west,
    north,
    resLon: Math.abs(resLon),
    resLat: Math.abs(resLat),
    width: img.getWidth(),
    height: img.getHeight(),
    data,
    noData: nd ?? undefined,
  };
}

/**
 * geotiff range requests through the Tauri http plugin (the S3 bucket sends no CORS headers).
 * Duck-typed: geotiff's generated typings for BaseClient / BaseResponse do not allow overriding.
 */
function tauriRangeClient(url: string): BaseClient {
  const client = {
    url,
    async request({ headers, signal }: { headers?: Record<string, string>; signal?: AbortSignal } = {}) {
      const res = await fetch(url, { headers: { ...headers, "User-Agent": USER_AGENT }, signal });
      const data = await res.arrayBuffer();
      return { ok: res.ok, status: res.status, getHeader: (name: string) => res.headers.get(name) ?? "", getData: async () => data };
    },
  };
  return client as unknown as BaseClient;
}

/**
 * WorldCover class codes over a lon/lat box at the given overview level: only the window is read
 * (range requests), and cached on disk per tile window. Tiles that do not exist (open sea) are skipped.
 */
export async function loadLandcover(b: Bbox, level: number, onTile?: (done: number, total: number) => void): Promise<CoverRaster[]> {
  const dir = await cacheDir("worldcover");
  const tiles = worldcoverTilesFor(b);
  const out: CoverRaster[] = [];
  for (const [k, tile] of tiles.entries()) {
    const win = worldcoverWindow(tile, level, b);
    onTile?.(k, tiles.length);
    if (!win) continue;
    const url = worldcoverTileUrl(tile.name);
    const missing = joinPath(dir, `${tile.name}.missing`);
    if (await fileExists(missing)) continue;
    const file = joinPath(dir, `${hashKey(`${url}|${level}|${win.join(",")}`)}.bin`);
    let data: Uint8Array | null = (await fileExists(file)) ? await readBytes(file) : null;
    if (!data) {
      const head = await fetch(url, { method: "HEAD", headers: { "User-Agent": USER_AGENT } });
      if (head.status === 404 || head.status === 403) {
        await writeBytes(missing, new Uint8Array());
        continue;
      }
      if (!head.ok) throw new Error(`WorldCover ${tile.name}: HTTP ${head.status}`);
      const tiff = await fromCustomClient(tauriRangeClient(url));
      const img = await tiff.getImage(level);
      const r = await img.readRasters({ window: win, samples: [0], interleave: true });
      data = r instanceof Uint8Array ? r : Uint8Array.from(r as ArrayLike<number>);
      await writeBytes(file, data);
    }
    out.push(coverRasterFor(tile, level, win, data));
  }
  onTile?.(tiles.length, tiles.length);
  return out;
}

/** GeoTIFF bytes → raster (first band). */
async function tiffRaster(buf: ArrayBuffer): Promise<DemRaster> {
  const img = await (await fromArrayBuffer(buf)).getImage();
  const [west, north] = img.getOrigin();
  const [resLon, resLat] = img.getResolution();
  const r = await img.readRasters({ samples: [0], interleave: true });
  const data = r instanceof Float32Array ? r : Float32Array.from(r as ArrayLike<number>);
  const nd = img.getGDALNoData();
  return { west, north, resLon: Math.abs(resLon), resLat: Math.abs(resLat), width: img.getWidth(), height: img.getHeight(), data, noData: nd ?? undefined };
}

/** Bytes of a URL, from the disk cache or downloaded (only kept when `ok(bytes)`); null on failure. */
async function cachedBytes(sub: string, url: string, ok: (b: Uint8Array) => boolean): Promise<Uint8Array | null> {
  const file = joinPath(await cacheDir(sub), `${hashKey(url)}.bin`);
  if (await fileExists(file)) return readBytes(file);
  try {
    const res = await fetch(url, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(60_000) });
    if (!res.ok) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (!ok(bytes)) return null;
    await writeBytes(file, bytes);
    return bytes;
  } catch {
    return null;
  }
}

/**
 * Sea-floor heights over a lon/lat box (FACT-018): EMODnet in European seas, else (or if it
 * fails) ETOPO 1′. Empty when neither answers: the sea then gets its default depth.
 */
export async function loadBathymetry(b: Bbox): Promise<{ rasters: DemRaster[]; source: string }> {
  const box = growBbox(b, 0.02);
  if (inEmodnet(box)) {
    // A GeoTIFF starts with "II*" or "MM*"; an error comes back as XML.
    const bytes = await cachedBytes("bathymetry", emodnetUrl(box), (x) => x.length > 8 && (x[0] === 0x49 || x[0] === 0x4d));
    if (bytes) {
      try {
        return { rasters: [await tiffRaster(bytes.slice().buffer)], source: "EMODnet Bathymetry" };
      } catch {
        /* unreadable: try ETOPO */
      }
    }
  }
  const bytes = await cachedBytes("bathymetry", etopoUrl(box), (x) => x.length > 2 && x[0] === 0x7b);
  if (bytes) {
    const r = parseEtopoJson(JSON.parse(new TextDecoder().decode(bytes)));
    if (r) return { rasters: [r], source: "NOAA ETOPO 1′" };
  }
  return { rasters: [], source: t("net.noBathy") };
}

/** Short stable key for a cached request. */
function hashKey(s: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0;
  for (let i = 0; i < s.length; i++) {
    h1 = Math.imul(h1 ^ s.charCodeAt(i), 16777619);
    h2 = Math.imul(h2 + s.charCodeAt(i), 2654435761);
  }
  return (h1 >>> 0).toString(16) + (h2 >>> 0).toString(16);
}

/**
 * IGN RGE ALTI heights on the grid (NaN = no data), block by block with a disk cache.
 * Returns null when the service gives nothing usable (outside France, service down).
 */
export async function loadIgnGrid(f: Frame, g: Grid, onBlock?: (done: number, total: number) => void): Promise<Float32Array | null> {
  const dir = await cacheDir("ign");
  const r = ignRaster(f, g);
  const raster = new Float32Array(r.w * r.h).fill(NaN);
  const blocks = ignBlocks(r);
  let any = false;
  for (const [k, b] of blocks.entries()) {
    const url = ignBlockUrl(f, b);
    const file = joinPath(dir, `${hashKey(url)}.bil`);
    let bytes: Uint8Array | null = null;
    if (await fileExists(file)) bytes = await readBytes(file);
    else {
      const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
      if (res.ok) {
        bytes = new Uint8Array(await res.arrayBuffer());
        if (decodeBil(bytes, b.w, b.h)) await writeBytes(file, bytes);
      }
    }
    const data = bytes ? decodeBil(bytes, b.w, b.h) : null;
    if (data) {
      pasteBlock(raster, r, b, data);
      any ||= data.some((z) => Number.isFinite(z));
    }
    onBlock?.(k + 1, blocks.length);
  }
  return any ? resampleToGrid(f, g, r, raster) : null;
}
