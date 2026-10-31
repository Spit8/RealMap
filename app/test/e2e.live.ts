// Manual end-to-end check against the real services (not part of `npm test`):
//   npx tsx test/e2e.live.ts <outDir> <lon> <lat> <scale> [size] [full|preview] [raw]
// Writes <outDir>/<tag>_preview.png (approximate view) and prints the terrain stats.
// `raw` turns smoothing, pond removal, canopy and the navigable width off (to compare).
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { encode } from "fast-png";
import { fromArrayBuffer, fromUrl } from "geotiff";
import { frameBBox, makeFrame, type Area } from "../src/lib/core/area";
import { COVER_FOREST, COVER_OPEN, COVER_ROCK, COVER_SCRUB, fallbackCover } from "../src/lib/core/biomes";
import { emodnetUrl, etopoUrl, growBbox, inEmodnet, parseEtopoJson } from "../src/lib/core/bathymetry";
import { copernicusTilesFor, copernicusTileUrl, type DemRaster } from "../src/lib/core/dem";
import { fullGrid, previewGrid } from "../src/lib/core/grid";
import { decodeBil, ignBlocks, ignBlockUrl, ignRaster, inIgnCoverage, pasteBlock, resampleToGrid } from "../src/lib/core/ign";
import {
  coverRasterFor, landcoverCodes, rasterizeLandcover, worldcoverLevel, worldcoverTilesFor, worldcoverTileUrl, worldcoverWindow, type CoverRaster,
} from "../src/lib/core/landcover";
import {
  bboxAreaKm2, isWaterShape, minWaterPerimeterM, overpassAreaQuery, parseOverpassShapes, parseOverpassStatus, roundBbox,
} from "../src/lib/core/osm";
import { renderPreview } from "../src/lib/core/preview";
import { buildTerrain, DEFAULT_TERRAIN } from "../src/lib/core/terrain";
import { DEFAULT_TOWNS, parseOverpassPlaces, placesInFrame, placeTowns, selectTowns } from "../src/lib/core/towns";
import { DEFAULT_INDUSTRIES, overpassIndustryQuery, parseIndustrySites, planIndustries } from "../src/lib/core/industries";
import { overpassNetworkQuery, parseNetwork, planNetwork } from "../src/lib/core/network";
import { distanceTo } from "../src/lib/core/raster";
import { WATER_RIVER } from "../src/lib/core/terrain";

const UA = "ImportCity/0.4 (Transport Fever 3 map importer)";
const [out = ".", lon = "4.8357", lat = "45.764", scale = "3", size = "3", mode = "preview", raw = ""] = process.argv.slice(2);
const area: Area = { lon: +lon, lat: +lat, size: +size, format: 0, landscape: false, scale: +scale, verticalScale: null };
const tag = `${lon}_${lat}_s${scale}${raw ? "_raw" : ""}`;
const f = makeFrame(area);
const g = mode === "full" ? fullGrid(f) : previewGrid(f);
const opts = raw
  ? { ...DEFAULT_TERRAIN, smoothM: 0, minLakeHa: 0, canopyM: 0, riverMinWidth: 0, repairRivers: false, valleySlope: DEFAULT_TERRAIN.bankSlope, riverBankSlope: DEFAULT_TERRAIN.bankSlope, underwaterSlope: 100, verticalScale: f.verticalScale }
  : { ...DEFAULT_TERRAIN, verticalScale: f.verticalScale };
console.log(`frame ${f.tilesX}x${f.tilesY} scale ${f.scale} v ${f.verticalScale.toFixed(2)} grid ${g.nx}x${g.ny} step ${g.step}`);

// Same servers and order as the app (download.ts): next server on 429 / 5xx, pause between rounds.
const SERVERS = ["https://overpass-api.de/api", "https://maps.mail.ru/osm/tools/overpass/api"];
const overpass = async (q: string) => {
  for (const wait of [0, 30, 60]) {
    await new Promise((r) => setTimeout(r, wait * 1000));
    for (const base of SERVERS) {
      const st = await fetch(`${base}/status`, { headers: { "User-Agent": UA } }).then((r) => r.text()).then(parseOverpassStatus, () => null);
      console.log(base, "status", JSON.stringify(st));
      if (st && st.free === 0 && st.waitS && st.waitS <= 60) await new Promise((r) => setTimeout(r, (st.waitS! + 1) * 1000));
      const t0 = Date.now();
      const res = await fetch(`${base}/interpreter`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json", "User-Agent": UA },
        body: "data=" + encodeURIComponent(q),
      }).catch(() => null);
      console.log(base, res?.status ?? "no answer", Date.now() - t0, "ms");
      if (res?.ok) return res.json();
    }
  }
  throw new Error("overpass failed");
};

let t = Date.now();
let ign: Float32Array | null = null;
if (inIgnCoverage(area.lon, area.lat)) {
  const ir = ignRaster(f, g);
  const raster = new Float32Array(ir.w * ir.h).fill(NaN);
  for (const b of ignBlocks(ir)) {
    const res = await fetch(ignBlockUrl(f, b), { headers: { "User-Agent": UA } });
    const data = decodeBil(new Uint8Array(await res.arrayBuffer()), b.w, b.h);
    console.log("ign block", b.w, b.h, res.status, data ? "ok" : "BAD");
    if (data) pasteBlock(raster, ir, b, data);
  }
  ign = resampleToGrid(f, g, ir, raster);
}
const rasters: DemRaster[] = [];
if (!ign || ign.some((z) => !Number.isFinite(z))) {
  for (const name of copernicusTilesFor(frameBBox(f, 200))) {
    const res = await fetch(copernicusTileUrl(name));
    if (!res.ok) { console.log(name, res.status); continue; }
    const img = await (await fromArrayBuffer(await res.arrayBuffer())).getImage();
    const [west, north] = img.getOrigin();
    const [rx, ry] = img.getResolution();
    rasters.push({ west, north, resLon: Math.abs(rx), resLat: Math.abs(ry), width: img.getWidth(), height: img.getHeight(), data: (await img.readRasters({ samples: [0], interleave: true })) as unknown as Float32Array });
    console.log(name, "ok");
  }
}
console.log("relief ms", Date.now() - t);
t = Date.now();
const bbox = roundBbox(frameBBox(f));
const level = worldcoverLevel(g.step * f.scale);
const cover: CoverRaster[] = [];
for (const tile of worldcoverTilesFor(bbox)) {
  const win = worldcoverWindow(tile, level, bbox);
  if (!win) continue;
  const img = await (await fromUrl(worldcoverTileUrl(tile.name))).getImage(level);
  const data = (await img.readRasters({ window: win, samples: [0], interleave: true })) as unknown as Uint8Array;
  cover.push(coverRasterFor(tile, level, win, data));
  console.log(tile.name, "level", level, "window", win.join(","));
}
console.log("worldcover ms", Date.now() - t);
t = Date.now();
// Sea floor: EMODnet in Europe, else ETOPO (same choice as download.ts loadBathymetry).
const bbox2 = growBbox(bbox, 0.02);
const bathy: DemRaster[] = [];
if (inEmodnet(bbox2)) {
  const res = await fetch(emodnetUrl(bbox2), { headers: { "User-Agent": UA } });
  if (res.ok) {
    const img = await (await fromArrayBuffer(await res.arrayBuffer())).getImage();
    const [west, north] = img.getOrigin();
    const [rx, ry] = img.getResolution();
    bathy.push({ west, north, resLon: Math.abs(rx), resLat: Math.abs(ry), width: img.getWidth(), height: img.getHeight(), data: (await img.readRasters({ samples: [0], interleave: true })) as unknown as Float32Array });
  }
}
if (!bathy.length) {
  const r = parseEtopoJson(await (await fetch(etopoUrl(bbox2), { headers: { "User-Agent": UA } })).json());
  if (r) bathy.push(r);
}
const deepest = bathy.length ? bathy[0].data.reduce((a, z) => (Number.isFinite(z) ? Math.min(a, z) : a), 0) : NaN;
console.log(`bathymetry ms ${Date.now() - t}: ${bathy.length ? `${bathy[0].width}x${bathy[0].height}, deepest ${deepest.toFixed(1)} m` : "none"}`);
t = Date.now();
const query = overpassAreaQuery(bbox, ["city", "town", "village"], minWaterPerimeterM(f.scale));
console.log(`bbox ${Math.round(bboxAreaKm2(bbox))} km² · ${query.slice(0, 50)}`);
// Answers are kept in the output folder, so comparing options does not query Overpass again.
const cacheFile = `${out}/osm_${createHash("sha1").update(query).digest("hex").slice(0, 12)}.json`;
const json = existsSync(cacheFile) ? JSON.parse(readFileSync(cacheFile, "utf8")) : await overpass(query);
if (!existsSync(cacheFile)) writeFileSync(cacheFile, JSON.stringify(json));
const bytes = JSON.stringify(json).length;
const shapes = parseOverpassShapes(json);
const water = shapes.filter(isWaterShape);
const places = parseOverpassPlaces(json);
console.log(`osm ms ${Date.now() - t}: ${(bytes / 1e6).toFixed(2)} MB, water ${water.length} places ${places.length}`);
t = Date.now();
const cov = rasterizeLandcover(f, g, cover);
const share = (k: number) => `${((cov.filter((c) => c === k).length / cov.length) * 100).toFixed(0)} %`;
console.log(`cover forest ${share(COVER_FOREST)} scrub ${share(COVER_SCRUB)} rock ${share(COVER_ROCK)} open ${share(COVER_OPEN)}`);
const forest = Uint8Array.from(cov, (c) => (c === COVER_FOREST ? 1 : 0));
const codes = landcoverCodes(f, g, cover);
const wetland = Uint8Array.from(codes, (c) => (c === 90 || c === 95 ? 1 : 0));
const built = buildTerrain(f, g, { ign, rasters, bathy, forest, wetland, shapes: water }, opts);
const terrain = built.terrain;
const steep = fallbackCover(terrain, g);
for (let i = 0; i < cov.length; i++) if (cov[i] === COVER_OPEN && steep[i] === COVER_ROCK) cov[i] = COVER_ROCK;
const pv = renderPreview(terrain, cov, g, 1024);
console.log("terrain ms", Date.now() - t);
console.log(`ref ${terrain.refHeight.toFixed(1)} game ${terrain.minM.toFixed(1)}..${terrain.maxM.toFixed(1)} water ${(terrain.waterShare * 100).toFixed(1)}% maxSlope ${(terrain.maxSlope * 100).toFixed(0)}% missing ${built.missing}`);
// Rivers as the game makes them (FACT-023: 108 / 132 / 164 m wide, 8.6 m deep in the middle).
{
  const notRiver = Uint8Array.from(terrain.water, (w) => (w === WATER_RIVER ? 0 : 1));
  const d = distanceTo(notRiver, g.nx, g.ny);
  const widths: number[] = [];
  const depths: number[] = [];
  for (let r = 1; r < g.ny - 1; r += 2) for (let c = 1; c < g.nx - 1; c += 2) {
    const i = r * g.nx + c;
    if (notRiver[i]) continue;
    if ([i - 1, i + 1, i - g.nx, i + g.nx].some((j) => d[j] > d[i])) continue;
    widths.push((2 * d[i] - 1) * g.step);
    depths.push(-terrain.game[i]);
  }
  const q = (a: number[], k: number) => a.sort((x, y) => x - y)[Math.floor(k * (a.length - 1))]?.toFixed(1);
  console.log(`river widths p10 ${q(widths, 0.1)} / med ${q(widths, 0.5)} / p90 ${q(widths, 0.9)} m · centre depth p10 ${q(depths, 0.1)} / med ${q(depths, 0.5)} m`);
}
console.log(`river systems ${built.riverPieces} · ponds dropped ${built.lakesDropped} · ends joined ${built.riversJoined} routed ${built.riversRouted} · sources tapered ${built.sourcesTapered} · mouths ${built.riverMouths} · channels ${built.waterBridged} · marsh lakes ${built.marshLakes}`);
const selected = selectTowns(placesInFrame(f, places), { minPopulation: 2000, includeUnknown: true });
const { towns, dropped } = placeTowns(f, g, terrain, selected, DEFAULT_TOWNS);
console.log(`places ${places.length} selected ${selected.length} towns ${towns.length}`);
console.log("towns", towns.map((x) => `${x.name}:${x.capacity}${x.shift > 1 ? ` (moved ${Math.round(x.shift)} m: ${x.moveReason})` : ""}`).join(", "));
console.log("dropped", dropped.map((d) => `${d.name}: ${d.reason}`).join(" | "));
// Industries: second Overpass query (cached like the first), then the plan.
const iq = overpassIndustryQuery(bbox);
const iFile = `${out}/osm_${createHash("sha1").update(iq).digest("hex").slice(0, 12)}.json`;
const iJson = existsSync(iFile) ? JSON.parse(readFileSync(iFile, "utf8")) : await overpass(iq);
if (!existsSync(iFile)) writeFileSync(iFile, JSON.stringify(iJson));
const sites = parseIndustrySites(iJson);
const plan = planIndustries(f, g, terrain, codes, sites, towns, {}, DEFAULT_INDUSTRIES);
const byTag = (list: { tag: string }[]) => Object.entries(list.reduce<Record<string, number>>((a, m) => ((a[m.tag] = (a[m.tag] ?? 0) + 1), a), {})).map(([k, v]) => `${k}:${v}`).join(" ");
console.log(`industry sites ${sites.length} (${byTag(sites)})`);
console.log(`industries ${plan.industries.length}: ${byTag(plan.industries)}`);
console.log("  dropped:", plan.candidates.filter((c) => c.status === "dropped").map((c) => `${c.tag} (${c.origin}): ${c.reason}`).join(" | "));
console.log(`  from osm ${plan.industries.filter((m) => m.origin === "osm").length}, landcover ${plan.industries.filter((m) => m.origin === "landcover").length}, chains ${plan.industries.filter((m) => m.origin === "chain").length}; dropped ${plan.candidates.filter((c) => c.status === "dropped").length}`);
// Roads and railway: third Overpass query (cached), then the links the game should build.
const nq = overpassNetworkQuery(bbox);
const nFile = `${out}/osm_${createHash("sha1").update(nq).digest("hex").slice(0, 12)}.json`;
const nJson = existsSync(nFile) ? JSON.parse(readFileSync(nFile, "utf8")) : await overpass(nq);
if (!existsSync(nFile)) writeFileSync(nFile, JSON.stringify(nJson));
const ways = parseNetwork(nJson);
t = Date.now();
const net = planNetwork(f, ways, towns, plan.industries);
console.log(`network: ${ways.filter((w) => w.kind === "road").length} roads, ${ways.filter((w) => w.kind === "rail").length} railways (${Date.now() - t} ms)`);
console.log("  links:", net.links.map((l) => `${l.a}–${l.b}${l.real ? "" : " (direct)"}`).join(", "));
console.log("  rail:", net.rail.map((r) => `${r.pts.length} points`).join(", "));
console.log("  names:", plan.industries.map((m) => m.name).join(", "));
writeFileSync(`${out}/${tag}_preview.png`, encode({ width: pv.width, height: pv.height, data: new Uint8Array(pv.rgba.buffer), channels: 4, depth: 8 }));
