/**
 * A map project on disk (`<name>.realmap`, DECISION-036): a zip archive with
 *  - `project.json`: format, version, the map settings and what was done (data key and summary, the
 *    key of the shown result, the last export);
 *  - `data/inputs.json` + `data/*.bin`: the phase-1 data cut to the area (relief, sea floor and land
 *    cover as raw typed arrays, OpenStreetMap already read), so a project reopens without network;
 *  - `preview.json`: the result shown on the map; `log.json`: the project's journal.
 * The full-resolution export data (IGN 4 m, fine WorldCover) is not kept: it goes through the shared
 * download cache. Plain TypeScript (no Svelte, no Tauri), so it runs in the tests.
 */
import { unzip, zip, type Unzipped, type Zippable } from "fflate";
import { cropDem, type DemRaster } from "../core/dem";
import type { CoverRaster } from "../core/landcover";
import type { LandUse } from "../core/landuse";
import type { IndustrySite } from "../core/industries";
import type { NetworkWay } from "../core/network";
import type { OsmShape } from "../core/osm";
import type { OsmPlace } from "../core/towns";
import { migrateSettings, type Settings } from "./settings";

export const PROJECT_FORMAT = "realmap-project";
export const PROJECT_VERSION = 1;
export const PROJECT_EXT = "realmap";

/** Phase-1 data of an area (what « Récupérer les données » gathers, at preview resolution). */
export interface Inputs {
  ign: Float32Array | null;
  rasters: DemRaster[];
  water: OsmShape[];
  cover: CoverRaster[] | null;
  /** Sea-floor heights and where they come from. */
  bathy: DemRaster[];
  bathySource: string;
  places: OsmPlace[];
  /** Real industrial sites (OSM). */
  sites: IndustrySite[];
  /** Real main roads and railways (OSM). */
  roads: NetworkWay[];
  /** Beaches and commercial / industrial areas (OSM). */
  land: LandUse;
  source: string;
}

/** Everything a project file holds. `preview`, `log`, `summary`, `result` are opaque JSON here. */
export interface ProjectData<P = unknown, L = unknown, S = unknown, R = unknown> {
  settings: Settings;
  /** The phase-1 data and the key it was fetched for (`dataKeyOf`), or null when never fetched. */
  data: { key: string; inputs: Inputs } | null;
  summary: S | null;
  /** The result on the map and the options key it was computed for. */
  preview: P | null;
  previewKey: string;
  /** Options + name of the last map sent to the game. */
  exportKey: string;
  result: R | null;
  log: L[];
}

/** Header of `project.json`. */
interface ProjectJson {
  format: string;
  version: number;
  app: string;
  savedAt: string;
  settings: Settings;
  dataKey: string | null;
  summary: unknown;
  previewKey: string;
  exportKey: string;
  result: unknown;
}

type Blob = { file: string; type: "f32" | "u8" };
type RasterJson<T> = Omit<T, "data"> & { data: Blob };
interface InputsJson extends Omit<Inputs, "ign" | "rasters" | "bathy" | "cover"> {
  ign: Blob | null;
  rasters: RasterJson<DemRaster>[];
  bathy: RasterJson<DemRaster>[];
  cover: RasterJson<CoverRaster>[] | null;
}

/** Au-delà (caractères), les données ne sont pas enregistrées dans le projet (bien sous la limite de V8). */
export const MAX_INPUTS_CHARS = 300 * 2 ** 20;

const enc = new TextEncoder();
const dec = new TextDecoder();

function bytesOf(a: Float32Array | Uint8Array): Uint8Array {
  return new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
}

/**
 * Pack a project. `crop`: the box (lon / lat) the DEM and sea-floor rasters are cut to (the area and
 * its sampling margin): whole 1° Copernicus tiles would weigh 50 MB each.
 */
export async function packProject(
  p: ProjectData,
  app: string,
  crop: { west: number; south: number; east: number; north: number } | null,
  onDataSkipped?: (reason: string) => void,
): Promise<Uint8Array> {
  const files: Zippable = {};
  const json = (name: string, value: unknown) => (files[name] = [enc.encode(JSON.stringify(value)), { level: 6 }]);
  const bin = (name: string, a: Float32Array | Uint8Array): Blob => {
    files[name] = [bytesOf(a), { level: 1 }];
    return { file: name, type: a instanceof Float32Array ? "f32" : "u8" };
  };
  // Les données d'abord : trop grosses pour une chaîne JSON (limite de V8, très grande zone), le
  // projet est enregistré sans elles et les retélécharge (depuis le cache) à l'ouverture.
  let dataKey = p.data?.key ?? null;
  if (p.data) {
    const i = p.data.inputs;
    const dem = (list: DemRaster[], prefix: string) =>
      list.flatMap((r, k) => {
        const c = crop ? cropDem(r, crop) : r;
        return c ? [{ ...c, data: bin(`data/${prefix}_${k}.bin`, c.data) }] : [];
      });
    const inputs: InputsJson = {
      ...i,
      ign: i.ign ? bin("data/ign.bin", i.ign) : null,
      rasters: dem(i.rasters, "dem"),
      bathy: dem(i.bathy, "bathy"),
      cover: i.cover ? i.cover.map((r, k) => ({ ...r, data: bin(`data/cover_${k}.bin`, r.data) })) : null,
    };
    let text: string | null = null;
    let reason = "";
    try {
      text = JSON.stringify(inputs);
      if (text.length > MAX_INPUTS_CHARS) {
        reason = `${Math.round(text.length / 2 ** 20)} M caractères`;
        text = null;
      }
    } catch (e) {
      reason = e instanceof Error ? e.message : String(e);
    }
    if (text !== null) files["data/inputs.json"] = [enc.encode(text), { level: 6 }];
    else {
      for (const name of Object.keys(files)) if (name.startsWith("data/")) delete files[name];
      dataKey = null;
      onDataSkipped?.(reason);
    }
  }
  const header: ProjectJson = {
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    app,
    savedAt: new Date().toISOString(),
    settings: p.settings,
    dataKey,
    summary: p.summary,
    previewKey: p.previewKey,
    exportKey: p.exportKey,
    result: p.result,
  };
  json("project.json", header);
  if (p.preview) json("preview.json", p.preview);
  json("log.json", p.log);
  return new Promise((resolve, reject) => zip(files, (err, out) => (err ? reject(err) : resolve(out))));
}

/** A project file read back; throws on anything that is not a RealMap project. */
export async function unpackProject(bytes: Uint8Array): Promise<ProjectData & { app: string; savedAt: string }> {
  const files: Unzipped = await new Promise((resolve, reject) => unzip(bytes, (err, out) => (err ? reject(err) : resolve(out))));
  const read = <T>(name: string): T | null => (files[name] ? (JSON.parse(dec.decode(files[name])) as T) : null);
  const head = read<ProjectJson>("project.json");
  if (!head || head.format !== PROJECT_FORMAT) throw new Error("not a RealMap project");
  if (head.version > PROJECT_VERSION) throw new Error(`project version ${head.version} (newer app needed)`);
  const blob = (b: Blob): Float32Array | Uint8Array => {
    const raw = files[b.file];
    if (!raw) throw new Error(`missing ${b.file}`);
    // A copy: a Float32Array needs its own aligned buffer.
    const own = raw.slice();
    return b.type === "f32" ? new Float32Array(own.buffer, 0, own.byteLength / 4) : own;
  };
  let data: ProjectData["data"] = null;
  const ij = read<InputsJson>("data/inputs.json");
  if (ij && head.dataKey) {
    const dem = (list: RasterJson<DemRaster>[]) => list.map((r) => ({ ...r, data: blob(r.data) as Float32Array }));
    data = {
      key: head.dataKey,
      inputs: {
        ...ij,
        ign: ij.ign ? (blob(ij.ign) as Float32Array) : null,
        rasters: dem(ij.rasters),
        bathy: dem(ij.bathy),
        cover: ij.cover ? ij.cover.map((r) => ({ ...r, data: blob(r.data) as Uint8Array })) : null,
      },
    };
  }
  return {
    app: head.app,
    savedAt: head.savedAt,
    settings: migrateSettings(head.settings as unknown as Settings & Record<string, unknown>),
    data,
    summary: head.summary ?? null,
    preview: read("preview.json"),
    previewKey: head.previewKey ?? "",
    exportKey: head.exportKey ?? "",
    result: head.result ?? null,
    log: read<unknown[]>("log.json") ?? [],
  };
}

/** `C:\…\Lyon.realmap` → `Lyon`. */
export function projectTitle(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path;
  return base.replace(new RegExp(`\\.${PROJECT_EXT}$`, "i"), "");
}
