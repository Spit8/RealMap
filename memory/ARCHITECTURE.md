# Architecture and Project Map

## Overview
- Purpose: import a real-world area into a Transport Fever 3 custom map.
- Main components: `app/` (Tauri desktop app, does all the work) and `importcity/` (TF3 mod skeleton, TFUI window "Import your Town"; no code yet — only needed later for streets/trees).
- External services: IGN Géoplateforme WMS and Copernicus DEM GLO-30 on AWS (relief), ESA WorldCover on AWS (land cover, FACT-015), Overpass API — overpass-api.de then VK Maps (water, places, FACT-012), OSM raster tiles (map background).
- Runtime: Tauri 2 + SvelteKit SPA + Svelte 5 + TS + OpenLayers (same stack as `../HQminiMap`).

## Flow (v0.2)
1. App: click the map → centre; pick the game size / format / orientation and the scale (1:1 … 1:8) → outline = covered real area.
2. Left panel, 3 tabs (v0.7): « Zone et données réelles » (fetch), « Transformation » (settings, auto re-run on the coarse ≤ 1 024 px grid, stats), « Export » (town / industry selection and lists, name, folder, « Générer »). The result is drawn on the area map only (no preview tab or window since v0.7).
3. « Générer la carte »: IGN blocks (cache `$APPCACHE/ign`) and/or Copernicus tiles (`$APPCACHE/dem`) + WorldCover windows (`$APPCACHE/worldcover`) + one Overpass query (places, water; `$APPCACHE/overpass`) → worker: real heights → water → game heights → biomes → PNGs. Writes `<UD>/heightmaps/<n>.png`, `<UD>/biomes/<n>_{biomes,mountains,rivers}.png`, `<UD>/towns_industries/<n>.lua`, note `<UD>/importcity/<n>.lua`.
4. Map Editor (by hand): new map of the shown size → Import Heightmap (Min/Max shown, Water Level 0) → Biomes → Towns/Industries.

## Entry points
| Area | File / symbol | Role |
|---|---|---|
| Frame / projection | `app/src/lib/core/area.ts` (`makeFrame`, `frameProjection`) | local transverse Mercator centred on the area (`f.proj`), x east / y north = true north (FACT-022); UTM zone kept for IGN only |
| DEM | `app/src/lib/core/dem.ts` (`copernicusTilesFor`, `sampleDem`) | tile names, bilinear sampling |
| Map sizes | `app/src/lib/core/mapsizes.ts` | game size/format table, standard vs experimental (FACT-010) |
| Grid | `app/src/lib/core/grid.ts` | full / preview grids, row 0 north |
| IGN | `app/src/lib/core/ign.ts` | UTM raster around the map (`ignRaster`), WMS blocks, BIL decoding (FACT-011), bilinear `resampleToGrid` |
| OSM | `app/src/lib/core/osm.ts` | combined Overpass query and its limits, `/api/status` parsing, ways / multipolygons |
| Land cover | `app/src/lib/core/landcover.ts` | WorldCover tiles, overview level, windows, class codes → cover |
| Sea floor | `app/src/lib/core/bathymetry.ts` | EMODnet / ETOPO URLs and parsing (FACT-018) |
| Rivers | `app/src/lib/core/rivers.ts` | network repair: joins, priority-flood routing, tapered sources |
| Industries | `app/src/lib/core/industries.ts` | OSM sites, economies, chains, land-cover primaries, placement (FACT-019) |
| Raster | `app/src/lib/core/raster.ts` | polygon fill, thick lines, edge flood, distance / nearest source, labels, closing, blur |
| Terrain | `app/src/lib/core/terrain.ts` (`buildTerrain` → `realHeights`, `flattenCanopy`, `smoothHeights`, `rasterizeWater`, `dropSmallWater`, `composeTerrain`) | relief cleanup, navigable rivers, water level, river valleys, banks |
| Biomes | `app/src/lib/core/biomes.ts` | cover → biome PNGs, test pattern |
| Preview | `app/src/lib/core/preview.ts` | hill-shaded RGBA |
| Heightmap | `app/src/lib/core/heightmap.ts` | 16-bit / 8-bit PNG encoding |
| Towns | `app/src/lib/core/towns.ts` (`selectTowns`, `placeTowns`, `townCandidates`, `targetCapacity`) | manual picks + population filter, settling on valid ground, towns_industries file, capacities for the mod (FACT-002, FACT-014, FACT-016) |
| Town markers | `app/src/lib/ui/townMarkers.ts` | green / orange / grey markers, hover titles, detail sheets (`townDetails`, `industryDetails`) |
| Mod | `importcity/mod/content/gui/main_gui.handlers.lua` | « Appliquer les tailles réelles » (reads `<UD>/importcity/latest.lua`) |
| Userdata files | `app/src/lib/core/luadata.ts` (copied from HQminiMap) | `toUserdata` / `parseUserdata` |
| IO | `app/src/lib/platform/{fsx,paths,download}.ts`, Rust `detect_paths` / `allow_dirs` | files, folders, http plugin |
| Run | `app/src/lib/state/importer.svelte.ts`, `app/src/lib/workers/terrain.worker.ts` | orchestration |
| UI | `app/src/routes/+page.svelte` (left panel, 3 tabs), `app/src/lib/ui/AreaMap.svelte`, `app/src/lib/ui/LogPanel.svelte` | map: Ctrl + click = centre (ghost while Ctrl held), click = sheet, right click = add / remove, links and railway, legend, height readout; log panel at the bottom of the panel |
| Network | `app/src/lib/core/network.ts` (`overpassNetworkQuery`, `parseNetwork`, `planNetwork`, `networkData`) | real roads / railways → town pairs, town–industry links, main railway points for the mod |

## Réglages (explications retirées de l'interface en v0.8)
- Échelle : 1 m de jeu = n m réels ; échelle verticale vide = 1/√échelle ; niveau de l'eau vide = auto (mer, sinon bas des eaux, sinon point le plus bas).
- Lissage : efface bosses et bruit (0 = brut) ; aplanir forêts : mètres retirés aux forêts mesurées par Copernicus (surface des arbres).
- Eau : largeur min. appliquée partout (rivières du jeu 110–165 m, FACT-023) ; le milieu atteint la profondeur ; raccord eaux proches = chenal entre plans d'eau ≥ étangs min. dont l'un porte une rivière ; étangs plus petits comblés sauf sur une rivière ; marais WorldCover → lacs ; réparer le réseau = chaque rivière finit dans l'eau ou au bord ; biseau des sources ; pente des vallées (rivières hautes) ; berges ; lacs / mer descendent depuis 0,5 m ; creusement max. : lac sans rivière trop haut reste en terre.
- Villes : capacité d'une ville de 10 000 hab. (partie normale 240–820), contraste (1 = proportionnel, 0 = égales), tailles appliquées par le mod ; une ville trop près de l'eau / du bord est déplacée ou écartée ; limite indicative du jeu (FACT-021).
- Industries : économie = climat de la carte ; nombre = densité du jeu ; choisies par chaînes, par présence réelle ; emprise hors de l'eau.
- Routes et rail : liaisons d'après le réseau réel, construites par le jeu via le mod (QUESTION-010).

## Validation workflow
- `cd app && npm test` (vitest, 92 tests in core / rivers / water / industries / network / ui), `npm run check`, `npm run build`, `cargo build` in `src-tauri`.
- Browser (`npm run dev`, launch config `importcity-dev`): the UI renders, but « Récupérer les données » fails outside Tauri (fs plugin cache, `invoke`); test map interactions with an injected `importer.preview`.
- Real data: `npx tsx test/e2e.live.ts <outDir> <lon> <lat> <scale> [size] [full|preview] [raw]` → preview PNG + stats, Overpass answer cached in `<outDir>`; `raw` = v0.4 relief for comparison (checked: Lyon 1:3, Grenoble 1:3, La Rochelle 1:3, Cherbourg 1:3).
- Mod handlers: lupa simulation with a mocked `api` / `app` (as HQminiMap `tools/sim_mod.py`).
- In game: Map Editor import (see QUESTION-004/005).

## Risks and constraints
- Overpass needs a User-Agent (FACT-008), rate-limits per IP and is often saturated (FACT-012): one query at a time, cached, with a fallback server.
- Large maps: 128×128 tiles = 8193² samples (~67 M) — memory/time not measured yet.
