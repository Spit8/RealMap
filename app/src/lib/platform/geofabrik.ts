/**
 * Extraits Geofabrik des très grandes zones (DECISION-040) : index en cache, taille des fichiers à
 * télécharger (pour la confirmation), téléchargement et lecture par les commandes Rust
 * (`geofabrik_download`, `osm_extract`), résultat au format des réponses Overpass.
 */
import { Channel, invoke } from "@tauri-apps/api/core";
import { fetch } from "@tauri-apps/plugin-http";
import { DEFAULT_RATES, GEOFABRIK_INDEX_URL, parseGeofabrikIndex, type Extract, type Rates } from "../core/geofabrik";
import { INDUSTRIAL_RE, PRODUCT_RE } from "../core/industries";
import { ROAD_CLASSES } from "../core/network";
import { mergeOverpass, type Bbox } from "../core/osm";
import { cacheDir, hashKey, USER_AGENT } from "./download";
import { fileStat, joinPath, readText, removeFile, renamePath, writeText } from "./fsx";

/** L'index est relu au-delà de 7 jours, les extraits au-delà de 30 (comme le cache d'Overpass). */
const INDEX_MAX_AGE_MS = 7 * 24 * 3600 * 1000;
const PBF_MAX_AGE_MS = 30 * 24 * 3600 * 1000;

export async function loadGeofabrikIndex(): Promise<Extract[]> {
  const file = joinPath(await cacheDir("geofabrik"), "index-v1.json");
  const st = await fileStat(file);
  let text = st && Date.now() - st.mtimeMs < INDEX_MAX_AGE_MS ? await readText(file) : null;
  if (!text) {
    const res = await fetch(GEOFABRIK_INDEX_URL, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(120_000) });
    if (!res.ok) throw new Error(`Geofabrik index: HTTP ${res.status}`);
    text = await res.text();
    await writeText(`${file}.part`, text);
    await removeFile(file);
    await renamePath(`${file}.part`, file);
  }
  return parseGeofabrikIndex(JSON.parse(text));
}

export interface ExtractFile {
  extract: Extract;
  path: string;
  /** Déjà en cache et récent : rien à télécharger. */
  cached: boolean;
  /** Octets à télécharger (0 si en cache, NaN si inconnu). */
  bytes: number;
  /** Taille du fichier (en cache ou annoncée), pour estimer la lecture. */
  size: number;
}

/** Fichiers locaux des extraits, et taille de ceux à télécharger (requête HEAD). */
export async function extractFiles(list: Extract[]): Promise<ExtractFile[]> {
  const dir = await cacheDir("geofabrik");
  const out: ExtractFile[] = [];
  for (const extract of list) {
    const path = joinPath(dir, `${extract.id.replace(/[^a-z0-9-]/gi, "_")}.osm.pbf`);
    const st = await fileStat(path);
    if (st && Date.now() - st.mtimeMs < PBF_MAX_AGE_MS) {
      out.push({ extract, path, cached: true, bytes: 0, size: st.size });
      continue;
    }
    let bytes = NaN;
    try {
      const head = await fetch(extract.pbf, { method: "HEAD", headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(30_000) });
      bytes = Number(head.headers.get("content-length") ?? NaN);
    } catch {
      /* taille inconnue : le téléchargement le dira */
    }
    out.push({ extract, path, cached: false, bytes, size: bytes });
  }
  return out;
}

/** Télécharge un extrait (Rust, en continu, reprise après coupure). */
export async function downloadExtract(f: ExtractFile, onProgress: (received: number, total: number) => void): Promise<void> {
  const ch = new Channel<{ received: number; total: number }>();
  ch.onmessage = (p) => onProgress(p.received, p.total);
  await invoke("geofabrik_download", { url: f.extract.pbf, dest: f.path, onProgress: ch });
}

/** Les cinq réponses « Overpass » lues dans les extraits. */
export interface ExtractedOsm {
  area: { elements: unknown[] };
  places: { elements: unknown[] };
  roads: { elements: unknown[] };
  sites: { elements: unknown[] };
  land: { elements: unknown[] };
}

export interface ReadParams {
  bbox: Bbox;
  placeKinds: string[];
  minWaterPerimeterM: number;
  toleranceM: number;
}

function filtersOf(p: ReadParams) {
  return {
    placeKinds: p.placeKinds,
    roadClasses: ROAD_CLASSES,
    industrial: INDUSTRIAL_RE.split("|"),
    product: PRODUCT_RE.split("|"),
    minWaterPerimeterM: p.minWaterPerimeterM,
    toleranceM: p.toleranceM,
  };
}

/** Fichier du résultat d'une région pour ce cadre et ces filtres (la date du fichier en fait partie). */
async function regionOut(f: ExtractFile, p: ReadParams): Promise<string> {
  const stamp = (await fileStat(f.path))?.mtimeMs ?? 0;
  return joinPath(await cacheDir("geofabrik"), `read-${hashKey(JSON.stringify([f.extract.id, stamp, p.bbox, filtersOf(p)]))}.json`);
}

/** La région est-elle déjà lue pour ce cadre (rien à faire) ? */
export async function regionReady(f: ExtractFile, p: ReadParams): Promise<boolean> {
  return f.cached && !!(await fileStat(await regionOut(f, p)));
}

/**
 * Lit une région (Rust, trois passes multi-cœurs) : mêmes filtres que les requêtes Overpass, découpé
 * au cadre, géométries simplifiées. Gardé en cache par région : cocher ou décocher une autre région
 * ne relit pas celle-ci.
 */
export async function readRegion(f: ExtractFile, p: ReadParams, onPass: (pass: number) => void): Promise<{ osm: ExtractedOsm; cached: boolean }> {
  const out = await regionOut(f, p);
  let cached = true;
  if (!(await fileStat(out))) {
    cached = false;
    const ch = new Channel<{ pass: number }>();
    ch.onmessage = (m) => onPass(m.pass);
    await invoke("osm_extract", { file: f.path, bbox: p.bbox, filters: filtersOf(p), out, onProgress: ch });
  }
  const text = await readText(out);
  if (!text) throw new Error(`osm_extract: ${f.extract.id}: no output`);
  return { osm: JSON.parse(text) as ExtractedOsm, cached };
}

/** Les réponses de plusieurs régions réunies, sans doublon (voies présentes dans deux extraits). */
export function mergeRegions(list: ExtractedOsm[]): ExtractedOsm {
  const pick = (k: keyof ExtractedOsm) => mergeOverpass(list.map((x) => x[k])) as { elements: unknown[] };
  return { area: pick("area"), places: pick("places"), roads: pick("roads"), sites: pick("sites"), land: pick("land") };
}

/** Vitesses mesurées (octets / s), pour les temps estimés de la liste des régions. */
const RATES_KEY = "importcity.geofabrikRates";
export function loadRates(): Rates {
  try {
    const r = JSON.parse(localStorage.getItem(RATES_KEY) ?? "null") as Partial<Rates> | null;
    return { ...DEFAULT_RATES, ...(r ?? {}) };
  } catch {
    return { ...DEFAULT_RATES };
  }
}
export function saveRates(r: Rates): void {
  try {
    localStorage.setItem(RATES_KEY, JSON.stringify(r));
  } catch {
    /* storage unavailable */
  }
}
