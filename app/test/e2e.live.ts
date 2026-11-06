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
import { overpassNetworkQuery, parseNetwork, planNetwork, resample, roadNetworks } from "../src/lib/core/network";
import { alignHorizontal, corridorPath, DEFAULT_RAIL, designRail, gameGrade, sampler } from "../src/lib/core/railway";
import { worldToCell } from "../src/lib/core/grid";
import { distanceTo } from "../src/lib/core/raster";
import { WATER_RIVER } from "../src/lib/core/terrain";
import { builtAround, businessAround, clearBeaches, overpassLandQuery, parseLandUse, rasterizeBeaches, townLandRadiusM, townShares } from "../src/lib/core/landuse";
import { townNeeds } from "../src/lib/core/townneeds";
import { frameProjection } from "../src/lib/core/area";

const UA = "RealMap/0.9 (Transport Fever 3 map importer)";
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
// CROP="lon,lat,radiusM": the water mask around a point at grid resolution (river blue, lake cyan,
// sea navy, land grey by height), ×4, to look at a land strip across a river.
if (process.env.CROP) {
  const [clon, clat, rad] = process.env.CROP.split(",").map(Number);
  const [cx, cy] = frameProjection(f).toWorld(clon, clat);
  const [cc, cr] = worldToCell(f, g, cx, cy);
  const half = Math.round(rad / f.scale / g.step);
  const k = 4;
  const w = (2 * half + 1) * k;
  const rgba = new Uint8Array(w * w * 4);
  for (let y = 0; y < w; y++) for (let x = 0; x < w; x++) {
    const c = Math.round(cc) - half + Math.floor(x / k);
    const r = Math.round(cr) - half + Math.floor(y / k);
    const i = Math.min(g.ny - 1, Math.max(0, r)) * g.nx + Math.min(g.nx - 1, Math.max(0, c));
    const wt = terrain.water[i];
    const z = terrain.game[i];
    const col = wt === 3 ? [40, 110, 230] : wt === 2 ? [60, 200, 220] : wt === 1 ? [20, 40, 120] : [Math.min(255, 120 + z * 4), Math.min(255, 120 + z * 4), 110];
    rgba.set([...col, 255], (y * w + x) * 4);
  }
  writeFileSync(`${out}/${tag}_crop.png`, encode({ width: w, height: w, data: rgba, channels: 4, depth: 8 }));
  console.log(`crop written: ${out}/${tag}_crop.png (${2 * half + 1} cells of ${g.step} m)`);
}
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
  let sum = 0;
  let k = 0;
  for (let i = 0; i < terrain.water.length; i++) if (terrain.water[i] === WATER_RIVER) (sum -= terrain.game[i]), k++;
  console.log(`river mean depth over every river cell ${(sum / Math.max(1, k)).toFixed(1)} m (grid ${g.step} m)`);
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
// Land use: beaches (no coast trees) and the town shares / goods (DECISION-015).
const lq = overpassLandQuery(bbox);
const lFile = `${out}/osm_${createHash("sha1").update(lq).digest("hex").slice(0, 12)}.json`;
const lJson = existsSync(lFile) ? JSON.parse(readFileSync(lFile, "utf8")) : await overpass(lq);
if (!existsSync(lFile)) writeFileSync(lFile, JSON.stringify(lJson));
const land = parseLandUse(lJson);
const beachCells = clearBeaches(cov, codes, land.beaches.length ? rasterizeBeaches(f, g, land.beaches) : null, terrain.game, terrain.water, g);
console.log(`land use: ${land.beaches.length} beaches, ${land.business.length} business areas; ${beachCells} beach cells cleared`);
const projL = frameProjection(f);
const lands = towns.map((town) => {
  const [lon, lat] = projL.toLonLat(town.x, town.y);
  const radius = townLandRadiusM(town.population ?? 10_000);
  return { ...businessAround(lon, lat, radius, land.business), built: builtAround(codes, f, g, town.x, town.y, radius) };
});
townShares(lands).forEach((sh, i) => (towns[i].shares = sh));
const needs = townNeeds(towns, plan.industries, DEFAULT_INDUSTRIES.economy, `${lon},${lat}`);
towns.forEach((x, i) => (x.needs = needs[i]));
console.log("town shares / needs:", towns.slice(0, 12).map((x) => `${x.name} ${Math.round(x.shares!.com * 100)}/${Math.round(x.shares!.ind * 100)}%${x.shares!.real ? "" : "(def)"} [${x.needs!.com.join(",")} | ${x.needs!.ind.join(",")}]`).join(" ; "));
console.log(`  towns with goods: ${towns.filter((x) => x.needs!.com.length || x.needs!.ind.length).length} / ${towns.length}`);
console.log(`  from osm ${plan.industries.filter((m) => m.origin === "osm").length}, landcover ${plan.industries.filter((m) => m.origin === "landcover").length}, chains ${plan.industries.filter((m) => m.origin === "chain").length}; dropped ${plan.candidates.filter((c) => c.status === "dropped").length}`);
// Roads and railway: third Overpass query (cached), then the links the game should build.
const nq = overpassNetworkQuery(bbox);
const nFile = `${out}/osm_${createHash("sha1").update(nq).digest("hex").slice(0, 12)}.json`;
const nJson = existsSync(nFile) ? JSON.parse(readFileSync(nFile, "utf8")) : await overpass(nq);
if (!existsSync(nFile)) writeFileSync(nFile, JSON.stringify(nJson));
const ways = parseNetwork(nJson);
t = Date.now();
const landIndustries = plan.industries.filter((m) => !m.onWater).map((m) => ({ key: m.key, name: m.name, x: m.x, y: m.y }));
const net = planNetwork(f, ways, towns, {}, undefined, [], null, landIndustries);
console.log(`network: ${ways.filter((w) => w.kind === "road").length} roads, ${ways.filter((w) => w.kind === "rail").length} railways (${Date.now() - t} ms)`);
const townLinks = net.links.filter((l) => l.kind === "town");
console.log("  links:", townLinks.map((l) => `${l.a}–${l.b}${l.real ? "" : " (direct)"}`).join(", "));
console.log(`  ${roadNetworks(towns.map((x) => x.name), townLinks)} road networks for ${towns.length} towns; ${net.links.length - townLinks.length} / ${landIndustries.length} industries linked`);
const lone = towns.filter((x) => !net.links.some((l) => l.a === x.name || l.b === x.name)).map((x) => x.name);
console.log(`  lone towns: ${lone.length ? lone.join(", ") : "none"}`);
console.log("  guide rail:", net.rail.map((r) => `${r.pts.length} points`).join(", "));
// The designed alignment (DECISION-014), drawn on the preview: black track, blue bridge, grey tunnel.
t = Date.now();
type RailNodeXY = { x: number; y: number };
// RAIL_TOWNS="Lyon,Tassin-la-Demi-Lune,…": only these towns avoided (a user-sized selection).
const railOnly = process.env.RAIL_TOWNS?.split(",");
const railTowns = towns.filter((x) => !railOnly || railOnly.includes(x.name));
console.log(`  rail avoids ${railTowns.length} towns`);
// CORRIDOR=0: the real line as it is (before v0.16); default: the corridor around it.
const railOpts = { ...DEFAULT_RAIL, corridorM: Number(process.env.CORRIDOR ?? DEFAULT_RAIL.corridorM) };
const designs = net.rail.flatMap((r) => designRail(f, g, terrain, r.pts, railTowns.map((x) => ({ x: x.x, y: x.y, capacity: x.capacity })), railOpts));
{
  // Water crossings of the real line, of the corridor path, and after the town / curve smoothing.
  const smp = sampler(f, g, terrain);
  const runs = (pts: [number, number][]) => {
    let k = 0;
    let prev = false;
    for (const [x, y] of resample(pts, 25)) {
      const w = smp.wet(x, y);
      if (w && !prev) k++;
      prev = w;
    }
    return k;
  };
  const tw = railTowns.map((x) => ({ x: x.x, y: x.y, capacity: x.capacity }));
  for (const r of net.rail) {
    const cp = corridorPath(f, smp, r.pts, tw, railOpts, gameGrade(railOpts.maxGrade, f.scale, f.verticalScale));
    if (process.env.RAIL_DEBUG) {
      const rs = resample(cp, 25);
      let start = -1;
      rs.forEach(([x, y], i) => {
        const w = smp.wet(x, y);
        if (w && start < 0) start = i;
        if ((!w || i === rs.length - 1) && start >= 0) {
          const [mx, my] = rs[Math.floor((start + i) / 2)];
          console.log(`    wet run at ${Math.round(mx)},${Math.round(my)} length ${(i - start) * 25} m (station ${start})`);
          start = -1;
        }
      });
    }
    console.log(`  water crossings: real ${runs(r.pts)}, corridor ${runs(cp)}, aligned ${runs(alignHorizontal(cp, tw, railOpts))}, real aligned ${runs(alignHorizontal(r.pts, tw, railOpts))}`);
  }
}
for (const d of designs) {
  const guide = net.rail.flatMap((r) => r.pts);
  const dev = Math.max(...d.nodes.map((p) => Math.min(...guide.map(([x, y]) => Math.hypot(p.x - x, p.y - y)))));
  const wetAt = (x: number, y: number) => {
    const [fc, fr] = worldToCell(f, g, x, y);
    const c2 = Math.min(g.nx - 1, Math.max(0, Math.round(fc)));
    const r2 = Math.min(g.ny - 1, Math.max(0, Math.round(fr)));
    return terrain.water[r2 * g.nx + c2] !== 0;
  };
  let wetRuns = 0;
  let dryBridgeRuns = 0;
  for (let i = 0; i + 1 < d.nodes.length; i++) {
    const p = d.nodes[i];
    if (p.kind !== "b" || (i > 0 && d.nodes[i - 1].kind === "b")) continue;
    let j = i;
    let w = false;
    while (j < d.nodes.length && d.nodes[j].kind === "b") {
      if (wetAt(d.nodes[j].x, d.nodes[j].y) || (d.nodes[j + 1] && wetAt((d.nodes[j].x + d.nodes[j + 1].x) / 2, (d.nodes[j].y + d.nodes[j + 1].y) / 2))) w = true;
      j++;
    }
    if (w) wetRuns++;
    else dryBridgeRuns++;
  }
  console.log(`  bridges over water ${wetRuns}, over dry ground ${dryBridgeRuns}`);
  console.log(`  corridor ${railOpts.corridorM} m: ${d.nodes.filter((p) => p.kind === "b").length} bridge edges, ${d.nodes.filter((p) => p.kind === "t").length} tunnel edges, farthest from the real line ${Math.round(dev)} m`);
}
console.log(`rail design (${Date.now() - t} ms):`, designs.map((d) => `${(d.lengthM / 1000).toFixed(1)} km, min radius ${d.minRadiusM} m, max grade ${(d.maxGrade * 100).toFixed(1)} %, ${d.bridges} bridges (highest ${d.maxBridgeM} m), ${d.tunnels} tunnels, ${d.nodes.length} nodes`).join(" | "));
const nearestTown = Math.min(...designs.flatMap((d) => d.nodes.map((p) => Math.min(...towns.map((x) => Math.hypot(p.x - x.x, p.y - x.y))))));
console.log(`  closest node to a town centre: ${Math.round(nearestTown)} m`);
// A buildable line never crosses itself nor turns around: count crossings and the total turn.
for (const d of designs) {
  const q = d.nodes;
  let crossings = 0;
  const cross = (a: RailNodeXY, b: RailNodeXY, c: RailNodeXY, e: RailNodeXY) => {
    const o = (p: RailNodeXY, r: RailNodeXY, s2: RailNodeXY) => Math.sign((r.x - p.x) * (s2.y - p.y) - (r.y - p.y) * (s2.x - p.x));
    return o(a, b, c) * o(a, b, e) < 0 && o(c, e, a) * o(c, e, b) < 0;
  };
  for (let i = 0; i + 1 < q.length; i++) for (let j = i + 2; j + 1 < q.length; j++) if (cross(q[i], q[i + 1], q[j], q[j + 1])) crossings++;
  let turn = 0;
  for (let i = 1; i + 1 < q.length; i++) {
    const a1 = Math.atan2(q[i].y - q[i - 1].y, q[i].x - q[i - 1].x);
    const a2 = Math.atan2(q[i + 1].y - q[i].y, q[i + 1].x - q[i].x);
    turn += Math.abs(Math.atan2(Math.sin(a2 - a1), Math.cos(a2 - a1)));
  }
  console.log(`  self-crossings ${crossings}, total turn ${Math.round((turn * 180) / Math.PI)}°`);
  const turnOf = (q2: { x: number; y: number }[]) => {
    let tt = 0;
    const big: string[] = [];
    let run = 0;
    let at = "";
    for (let i = 1; i + 1 < q2.length; i++) {
      const b1 = Math.atan2(q2[i].y - q2[i - 1].y, q2[i].x - q2[i - 1].x);
      const b2 = Math.atan2(q2[i + 1].y - q2[i].y, q2[i + 1].x - q2[i].x);
      const dd = Math.atan2(Math.sin(b2 - b1), Math.cos(b2 - b1));
      tt += Math.abs(dd);
      run += dd;
      if (i % 20 === 0) {
        if (Math.abs(run) > 1.5) big.push(`${Math.round((run * 180) / Math.PI)}° near ${Math.round(q2[i].x)},${Math.round(q2[i].y)}`);
        run = 0;
      }
      at = "";
    }
    return `${Math.round((tt * 180) / Math.PI)}° ${big.join("; ")}${at}`;
  };
  console.log(`  design turn by stretch: ${turnOf(q)}`);
}
for (const r of net.rail) {
  const q3 = r.pts.map((p) => ({ x: p[0], y: p[1] }));
  let tt = 0;
  for (let i = 1; i + 1 < q3.length; i++) {
    const b1 = Math.atan2(q3[i].y - q3[i - 1].y, q3[i].x - q3[i - 1].x);
    const b2 = Math.atan2(q3[i + 1].y - q3[i].y, q3[i + 1].x - q3[i].x);
    tt += Math.abs(Math.atan2(Math.sin(b2 - b1), Math.cos(b2 - b1)));
  }
  console.log(`  guide ${r.pts.length} pts, total turn ${Math.round((tt * 180) / Math.PI)}°, ends ${r.pts[0].map(Math.round)} → ${r.pts[r.pts.length - 1].map(Math.round)}`);
}
const kx = pv.width / g.nx;
const ky = pv.height / g.ny;
for (const d of designs) {
  for (let i = 1; i < d.nodes.length; i++) {
    const a = d.nodes[i - 1];
    const b = d.nodes[i];
    const color = a.kind === "b" ? [30, 110, 200] : a.kind === "t" ? [120, 120, 120] : [10, 10, 10];
    for (let s2 = 0; s2 <= 40; s2++) {
      const [c, r] = worldToCell(f, g, a.x + ((b.x - a.x) * s2) / 40, a.y + ((b.y - a.y) * s2) / 40);
      for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
        const px = Math.round(c * kx) + dx;
        const py = Math.round(r * ky) + dy;
        if (px < 0 || py < 0 || px >= pv.width || py >= pv.height) continue;
        const o = (py * pv.width + px) * 4;
        pv.rgba[o] = color[0];
        pv.rgba[o + 1] = color[1];
        pv.rgba[o + 2] = color[2];
        pv.rgba[o + 3] = 255;
      }
    }
  }
}
console.log("  names:", plan.industries.map((m) => m.name).join(", "));
writeFileSync(`${out}/${tag}_preview.png`, encode({ width: pv.width, height: pv.height, data: new Uint8Array(pv.rgba.buffer), channels: 4, depth: 8 }));
