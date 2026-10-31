/// <reference lib="webworker" />
/**
 * Terrain build off the UI thread: land cover → relief (canopy, smoothing) → water (navigable
 * rivers, small ponds dropped) → game heights → biomes → chosen towns on valid ground →
 * industries → PNGs, preview image, hover grid and the town / industry lists. Tauri APIs are not available here: the page
 * downloads the data and writes files.
 */
import { frameProjection, makeFrame, type Area } from "../core/area";
import {
  biomeImage, COVER_FOREST, COVER_OPEN, COVER_ROCK, fallbackCover, mountainsImage, riversImage, type BiomeMapping,
} from "../core/biomes";
import type { DemRaster } from "../core/dem";
import { fullGrid, previewGrid } from "../core/grid";
import { encodeGray8Png, encodeHeightmapPng, normalize16 } from "../core/heightmap";
import {
  planIndustries, type IndustriesOptions, type IndustryCandidate, type IndustryPicks, type IndustrySite, type MapIndustry,
} from "../core/industries";
import { coverOfClass, landcoverCodes, WC_MANGROVE, WC_WETLAND, type CoverRaster } from "../core/landcover";
import type { OsmShape } from "../core/osm";
import { planNetwork, type LinkPicks, type NetworkPlan, type NetworkWay } from "../core/network";
import { hoverGrid, renderPreview, type HoverGrid } from "../core/preview";
import { buildTerrain, type TerrainOptions } from "../core/terrain";
import {
  placesInFrame, placeTowns, selectTowns, townCandidates,
  type DroppedTown, type MapTown, type OsmPlace, type PlaceFilter, type TownCandidate, type TownPicks, type TownsOptions,
} from "../core/towns";

export interface TerrainRequest {
  area: Area;
  /** "preview": coarse grid, no files; "full": heightmap grid + PNGs. */
  mode: "preview" | "full";
  /** IGN heights on the requested grid (NaN = no data), or null. */
  ign: Float32Array | null;
  rasters: DemRaster[];
  /** Sea-floor heights (EMODnet / ETOPO); empty = default sea depth. */
  bathy: DemRaster[];
  water: OsmShape[];
  /** WorldCover windows, or null without land cover (biomes from the relief only). */
  cover: CoverRaster[] | null;
  terrain: TerrainOptions;
  biomes: BiomeMapping;
  /** Every OSM place found; the worker keeps those in the map and picks the towns. */
  places: OsmPlace[];
  filter: PlaceFilter;
  picks: TownPicks;
  towns: TownsOptions;
  /** Real industrial sites (OSM) and the industry choices. */
  sites: IndustrySite[];
  industryPicks: IndustryPicks;
  industries: IndustriesOptions;
  /** Real main roads and railways, and the links left out by hand. */
  roads: NetworkWay[];
  linkPicks: LinkPicks;
}

export interface TerrainStats {
  refHeight: number;
  minM: number;
  maxM: number;
  waterShare: number;
  maxSlope: number;
  /** Real heights with no source at all (filled as sea or reference). */
  missingShare: number;
  /** Ponds turned into land, and separate river systems left (1 = all connected). */
  lakesDropped: number;
  riverPieces: number;
  /** River ends joined / routed to water, sources tapered (network repair). */
  riversJoined: number;
  riversRouted: number;
  sourcesTapered: number;
  /** River mouths opened into still water, channels joining water that almost touched, marshes made lakes. */
  riverMouths: number;
  waterBridged: number;
  marshLakes: number;
}

export type TerrainMessage =
  | { kind: "progress"; value: number; label: string }
  | {
      kind: "done";
      stats: TerrainStats;
      preview: { width: number; height: number; rgba: Uint8ClampedArray };
      hover: HoverGrid;
      towns: MapTown[];
      dropped: DroppedTown[];
      candidates: TownCandidate[];
      industries: MapIndustry[];
      industryCandidates: IndustryCandidate[];
      network: NetworkPlan;
      files: { heightmap: Uint8Array; biomes: Uint8Array; mountains: Uint8Array; rivers: Uint8Array } | null;
      width: number;
      height: number;
    }
  | { kind: "error"; message: string };

self.onmessage = (ev: MessageEvent<TerrainRequest>) => {
  const post = (m: TerrainMessage, transfer: Transferable[] = []) => self.postMessage(m, transfer);
  try {
    const req = ev.data;
    const f = makeFrame(req.area);
    const g = req.mode === "full" ? fullGrid(f) : previewGrid(f);
    post({ kind: "progress", value: 0.05, label: "Occupation du sol" });
    const codes = req.cover ? landcoverCodes(f, g, req.cover) : null;
    const cover = codes ? codes.map(coverOfClass) : new Uint8Array(g.nx * g.ny);
    let forest: Uint8Array | null = null;
    let wetland: Uint8Array | null = null;
    if (codes) {
      forest = new Uint8Array(cover.length);
      wetland = new Uint8Array(cover.length);
      for (let i = 0; i < cover.length; i++) {
        forest[i] = cover[i] === COVER_FOREST ? 1 : 0;
        wetland[i] = codes[i] === WC_WETLAND || codes[i] === WC_MANGROVE ? 1 : 0;
      }
    }
    post({ kind: "progress", value: 0.15, label: "Relief et eau" });
    const built = buildTerrain(f, g, { ign: req.ign, rasters: req.rasters, bathy: req.bathy, forest, wetland, shapes: req.water }, req.terrain);
    const t = built.terrain;
    post({ kind: "progress", value: 0.55, label: "Biomes" });
    const steep = fallbackCover(t, g);
    for (let i = 0; i < cover.length; i++) if (cover[i] === COVER_OPEN && steep[i] === COVER_ROCK) cover[i] = COVER_ROCK;
    post({ kind: "progress", value: 0.65, label: "Villes" });
    const places = placesInFrame(f, req.places);
    const selected = selectTowns(places, req.filter, req.picks, req.towns.maxTowns);
    const { towns, dropped } = placeTowns(f, g, t, selected, req.towns);
    const candidates = townCandidates(places, req.picks, towns, dropped, selected);
    post({ kind: "progress", value: 0.7, label: "Industries" });
    const proj = frameProjection(f);
    const named = places.map((p) => {
      const [x, y] = proj.toWorld(p.lon, p.lat);
      return { x, y, name: p.name };
    });
    const ind = planIndustries(f, g, t, codes, req.sites ?? [], towns, req.industryPicks ?? {}, req.industries, named);
    post({ kind: "progress", value: 0.72, label: "Routes et voies ferrées" });
    const network = planNetwork(
      f,
      req.roads ?? [],
      towns.map((x) => ({ name: x.name, x: x.x, y: x.y })),
      ind.industries.map((m) => ({ key: m.key, tag: m.tag, name: m.name, x: m.x, y: m.y, onWater: m.onWater })),
      req.linkPicks ?? {},
    );
    const preview = renderPreview(t, cover, g);
    const hover = hoverGrid(t, cover, g);
    let files: Extract<TerrainMessage, { kind: "done" }>["files"] = null;
    if (req.mode === "full") {
      post({ kind: "progress", value: 0.75, label: "Fichiers" });
      const n = normalize16(t.game);
      files = {
        heightmap: encodeHeightmapPng(g.nx, g.ny, n.data),
        biomes: encodeGray8Png(g.nx, g.ny, biomeImage(cover, t, req.biomes)),
        mountains: encodeGray8Png(g.nx, g.ny, mountainsImage(t, g)),
        rivers: encodeGray8Png(g.nx, g.ny, riversImage(t)),
      };
    }
    const stats: TerrainStats = {
      refHeight: t.refHeight,
      // Whole metres, as the Map Editor takes them (the heightmap is stretched over this range).
      minM: Math.floor(t.minM),
      maxM: Math.max(Math.floor(t.minM) + 1, Math.ceil(t.maxM)),
      waterShare: t.waterShare,
      maxSlope: t.maxSlope,
      missingShare: built.missing / t.game.length,
      lakesDropped: built.lakesDropped,
      riverPieces: built.riverPieces,
      riversJoined: built.riversJoined,
      riversRouted: built.riversRouted,
      sourcesTapered: built.sourcesTapered,
      riverMouths: built.riverMouths,
      waterBridged: built.waterBridged,
      marshLakes: built.marshLakes,
    };
    const transfer: Transferable[] = [preview.rgba.buffer, hover.heights.buffer, hover.water.buffer, hover.cover.buffer];
    if (files) transfer.push(files.heightmap.buffer, files.biomes.buffer, files.mountains.buffer, files.rivers.buffer);
    post(
      { kind: "done", stats, preview, hover, towns, dropped, candidates, industries: ind.industries, industryCandidates: ind.candidates, network, files, width: g.nx, height: g.ny },
      transfer,
    );
  } catch (e) {
    post({ kind: "error", message: e instanceof Error ? e.message : String(e) });
  }
};
