/**
 * The imported area and its TF3 frame. TF3 maps are flat, in metres, centred on 0 (FACT-003),
 * made of 256 m tiles with a height sample every 4 m (FACT-004). The real area is projected with a
 * transverse Mercator centred on the chosen point (FACT-022: a UTM square is turned by the
 * meridian convergence, up to ~2.5° at the edge of a zone), then shrunk by `scale` (real metres
 * per game metre): at 1:4 a 14.3 km game map covers 57.3 km of real ground. The UTM zone is only
 * kept for services that need an EPSG code (IGN WMS).
 * World axes: x = east, y = north, in game metres.
 */
import proj4 from "proj4";
import { mapTiles } from "./mapsizes";

export const TILE_M = 256;
export const SAMPLES_PER_TILE = 64;
export const SAMPLE_M = TILE_M / SAMPLES_PER_TILE;

export interface Area {
  /** Centre of the map, WGS84 degrees. */
  lon: number;
  lat: number;
  /** Game map size and format indices (`core/mapsizes.ts`). */
  size: number;
  format: number;
  /** Long side east–west (only matters for non-square formats). */
  landscape: boolean;
  /** Real metres per game metre (1 = real scale, 4 = regional). */
  scale: number;
  /** Game metres per real metre of height; null = default 1/√scale. */
  verticalScale: number | null;
  /** Where the top of the game map points, degrees clockwise from north (0 = north up). */
  rotation?: number;
}

export interface Frame {
  area: Area;
  tilesX: number;
  tilesY: number;
  scale: number;
  verticalScale: number;
  /** Rotation of the game axes (radians, clockwise from north; 0 = north up). */
  rot: number;
  /** proj4 definition of the local projection (transverse Mercator centred on the area, real metres). */
  proj: string;
  /** UTM zone of the centre (proj4 definition, EPSG code), for the IGN WMS. */
  utm: string;
  epsg: number;
  zone: number;
  south: boolean;
  /** Game map size in game metres. */
  widthM: number;
  heightM: number;
  /** Heightmap size in samples: tiles·64 + 1 (samples on the grid nodes, FACT-006). */
  samplesX: number;
  samplesY: number;
}

export function utmZone(lon: number, lat: number): { zone: number; south: boolean } {
  const zone = Math.min(60, Math.max(1, Math.floor((lon + 180) / 6) + 1));
  return { zone, south: lat < 0 };
}

/** A rotation in degrees brought into [0, 360). */
export function normalizeRotation(deg: number | undefined): number {
  const d = Number.isFinite(deg) ? (deg as number) % 360 : 0;
  return d < 0 ? d + 360 : d;
}

/** A rotation in [0, 360) to the tenth of a degree (the precision offered). */
export function roundRotation(deg: number | undefined): number {
  return normalizeRotation(Math.round(normalizeRotation(deg) * 10) / 10);
}

export function defaultVerticalScale(scale: number): number {
  return 1 / Math.sqrt(Math.max(1, scale));
}

export function makeFrame(area: Area): Frame {
  const { tilesX, tilesY } = mapTiles(area.size, area.format, area.landscape);
  const { zone, south } = utmZone(area.lon, area.lat);
  const utm = `+proj=utm +zone=${zone}${south ? " +south" : ""} +datum=WGS84 +units=m +no_defs`;
  const proj = `+proj=tmerc +lat_0=${area.lat} +lon_0=${area.lon} +k=1 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs`;
  const scale = Math.max(0.25, area.scale || 1);
  return {
    area,
    tilesX,
    tilesY,
    scale,
    verticalScale: area.verticalScale ?? defaultVerticalScale(scale),
    rot: (normalizeRotation(area.rotation) * Math.PI) / 180,
    proj,
    utm,
    epsg: (south ? 32700 : 32600) + zone,
    zone,
    south,
    widthM: tilesX * TILE_M,
    heightM: tilesY * TILE_M,
    samplesX: tilesX * SAMPLES_PER_TILE + 1,
    samplesY: tilesY * SAMPLES_PER_TILE + 1,
  };
}

/**
 * Converters between game metres, the local projection (real metres) and WGS84 lon/lat. With a
 * rotation θ the game's y axis (top of the map) points θ clockwise from north:
 * east = x·cosθ + y·sinθ, north = −x·sinθ + y·cosθ (real metres = game metres × scale).
 */
export function frameProjection(f: Frame) {
  const conv = proj4("WGS84", f.proj);
  const rot = f.rot ?? 0;
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  const toLocal = (x: number, y: number): [number, number] =>
    rot ? [(x * c + y * s) * f.scale, (-x * s + y * c) * f.scale] : [x * f.scale, y * f.scale];
  return {
    toLocal,
    toLonLat(x: number, y: number): [number, number] {
      const [lon, lat] = conv.inverse(toLocal(x, y));
      return [lon, lat];
    },
    toWorld(lon: number, lat: number): [number, number] {
      const [e, n] = conv.forward([lon, lat]);
      return rot ? [(e * c - n * s) / f.scale, (e * s + n * c) / f.scale] : [e / f.scale, n / f.scale];
    },
  };
}

/** Outline of the covered real area in lon/lat (a UTM square is slightly curved in WGS84). */
export function frameOutline(f: Frame, perEdge = 16): [number, number][] {
  const p = frameProjection(f);
  const hx = f.widthM / 2;
  const hy = f.heightM / 2;
  const corners: [number, number][] = [[-hx, -hy], [hx, -hy], [hx, hy], [-hx, hy]];
  const out: [number, number][] = [];
  for (let c = 0; c < 4; c++) {
    const [ax, ay] = corners[c];
    const [bx, by] = corners[(c + 1) % 4];
    for (let k = 0; k < perEdge; k++) {
      const t = k / perEdge;
      out.push(p.toLonLat(ax + (bx - ax) * t, ay + (by - ay) * t));
    }
  }
  out.push(out[0]);
  return out;
}

/** Lon/lat bounding box of the covered area, grown by `marginM` real metres. */
export function frameBBox(f: Frame, marginM = 0): { west: number; south: number; east: number; north: number } {
  const p = frameProjection(f);
  const hx = f.widthM / 2 + marginM / f.scale;
  const hy = f.heightM / 2 + marginM / f.scale;
  let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
  const steps = 16;
  for (let k = 0; k <= steps; k++) {
    const t = -1 + (2 * k) / steps;
    for (const [x, y] of [[t * hx, -hy], [t * hx, hy], [-hx, t * hy], [hx, t * hy]] as const) {
      const [lon, lat] = p.toLonLat(x, y);
      west = Math.min(west, lon);
      east = Math.max(east, lon);
      south = Math.min(south, lat);
      north = Math.max(north, lat);
    }
  }
  return { west, south, east, north };
}
