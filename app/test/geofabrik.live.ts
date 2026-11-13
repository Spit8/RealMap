/**
 * Oracle réel : la sortie de l'extracteur Rust (`osm_pbf.rs`, test `oracle`) comparée à la réponse
 * d'Overpass sur la même zone, toutes deux lues par les analyseurs de l'app.
 *   npx tsx test/geofabrik.live.ts <rust.json> <w,s,e,n> [scale]
 */
import { readFileSync } from "node:fs";
import { minWaterPerimeterM, overpassAreaQuery, parseOverpassShapes, isWaterShape, type Bbox } from "../src/lib/core/osm";
import { overpassTownsQuery, parseOverpassPlaces } from "../src/lib/core/towns";
import { overpassNetworkQuery, parseNetwork } from "../src/lib/core/network";
import { overpassIndustryQuery, parseIndustrySites } from "../src/lib/core/industries";
import { overpassLandQuery, parseLandUse } from "../src/lib/core/landuse";

const [file, box, scale = "3"] = process.argv.slice(2);
const [west, south, east, north] = box.split(",").map(Number);
const b: Bbox = { west, south, east, north };
const rust = JSON.parse(readFileSync(file, "utf8"));
const SERVERS = ["https://overpass-api.de/api/interpreter", "https://maps.mail.ru/osm/tools/overpass/api/interpreter"];

/** Les deux serveurs tour à tour, 30 s de pause entre deux tours (règle de la doc sur 429). */
async function ask(q: string): Promise<unknown> {
  for (let round = 0; round < 6; round++) {
    for (const url of SERVERS) {
      const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "RealMap/0.9 (Transport Fever 3 map importer)" }, body: "data=" + encodeURIComponent(q) });
      if (res.ok) return res.json();
      console.error(`${url}: HTTP ${res.status}`);
    }
    await new Promise((r) => setTimeout(r, 30_000));
  }
  throw new Error("Overpass indisponible");
}

const sets = <T>(a: T[], b: T[]) => {
  const A = new Set(a), B = new Set(b);
  return { both: [...A].filter((x) => B.has(x)).length, onlyA: [...A].filter((x) => !B.has(x)), onlyB: [...B].filter((x) => !A.has(x)) };
};
const show = (name: string, a: string[], o: string[]) => {
  const s = sets(a, o);
  console.log(`${name}: geofabrik ${a.length}, overpass ${o.length}, communs ${s.both}, seulement geofabrik ${s.onlyA.length} ${s.onlyA.slice(0, 3).join(" ; ")}, seulement overpass ${s.onlyB.length} ${s.onlyB.slice(0, 3).join(" ; ")}`);
};

const area = await ask(overpassAreaQuery(b, [], minWaterPerimeterM(+scale)));
const places = await ask(overpassTownsQuery(b, ["city", "town", "village"]));
const roads = await ask(overpassNetworkQuery(b));
const sites = await ask(overpassIndustryQuery(b));
const land = await ask(overpassLandQuery(b));

const water = (j: unknown) => parseOverpassShapes(j as never).filter(isWaterShape).map((s) => `${s.kind}:${s.tags.name ?? s.tags.natural ?? s.tags.waterway}`).sort();
show("eau", water(rust.area), water(area));
show("lieux", parseOverpassPlaces(rust.places).map((p) => p.name), parseOverpassPlaces(places as never).map((p) => p.name));
const net = (j: unknown) => parseNetwork(j as never).map((w) => `${w.kind}:${w.nodes[0]}-${w.nodes.at(-1)}`);
show("routes", net(rust.roads), net(roads));
show("sites", parseIndustrySites(rust.sites).map((s) => `${s.tag}:${s.name ?? ""}`), parseIndustrySites(sites as never).map((s) => `${s.tag}:${s.name ?? ""}`));
const lu = (j: unknown) => { const l = parseLandUse(j as never); return [...l.beaches.map((x) => `beach:${x.tags.natural}`), ...l.business.map((x) => `${x.kind}:${x.west.toFixed(4)}`)]; };
show("sol", lu(rust.land), lu(land));
