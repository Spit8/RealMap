# Verified Facts and Reusable Findings

Use one entry per durable finding. Do not mark a claim VERIFIED until its evidence supports it.
`<UD>` = `C:\Users\Public\Documents\Steam\RUNE\3493540\local`. Game sources: `E:\Transport Fever 3\base\content\*.zip` (e.g. `gui.zip` → `gui/map_editor/map_editor.tl`).

## FACT-001 — Map Editor imports heightmaps from `<UD>/heightmaps/`
- Status: VERIFIED (source read)
- Scope/version: TF3, map editor only (`hasHeightMapImporter`, not consoles)
- Finding: "Import Heightmap" lists `app.getAllHeightmaps()` = files in `app.getUserDataFolder() .. "heightmaps"`. Grayscale image, mapped linearly to [`minH`, `maxH`] set in the UI (default min = `api.engine.mapgen.getMinMaxValidTerrainHeight()[1]`, max 500), plus `waterLevel` and `keepAssets`. Applied via `makeWorldReplaceTerrainCmd`. Export offers 8 or 16 bit grayscale + optional biome data.
- Evidence: `gui/map_editor/map_editor.tl` l.831-1130 (`ImportExportHeightmapSettings`, `ImportExportHeightmapMode`).
- Verification: source only, NOT TESTED in game
- Limitations: image size ↔ map size relation and accepted formats (PNG 16 bit?) unknown → OPEN_QUESTIONS Q-001.
- Last checked: 2026-10-29

## FACT-002 — Towns and industries import natively from `<UD>/towns_industries/<name>.lua`
- Status: VERIFIED (source read)
- Finding: Map Editor "Towns / Industries" → Import reads `app.loadUserdata("towns_industries", name)`:
  `{ towns = { {name, position={x,y}, sizeFactors={res,com,ind}, landUse2CargoNeedsCategories={res|com|ind = {{cat, n}}}} }, industries = { {position={x,y}, angle, onWater, fileName, tag} } }`.
  Positions outside `api.engine.terrain.isValidCoordinate` are skipped. Export writes the same shape with `saveUserdata`.
- Evidence: `gui/map_editor/map_editor.tl` l.1707-1800, 1915-1942.
- Consequence: towns need **no mod code** — the app writes this file.
- Last checked: 2026-10-29

## FACT-003 — Userdata file format and world coordinates
- Status: VERIFIED (existing files)
- Finding: userdata files are `function data()\nreturn { ... }\nend`. World coordinates are metres centred on 0: a 14 336 m map has bbox x/y = -7168…7168.
- Evidence: `<UD>/towns_industries/tf3map_meta.lua` (written by an earlier mod via `saveUserdata`).
- Last checked: 2026-10-29

## FACT-004 — Terrain grid
- Status: VERIFIED (API doc)
- Finding: tile = 256 m, `levels = 6` → 64 samples/tile, 4 m between height samples; heights in metres; `offsetZ -100`, `waterLevel 0` in base game.
- Evidence: `tf3-modding/references/api/api/type.md` (`GameMap`).
- Last checked: 2026-10-29

## FACT-005 — Lessons inherited from HQminiMap (`../HQminiMap/docs/agent-memory`)
- Status: VERIFIED there
- `saveUserdata` only writes tables; a large string comes back empty.
- `ug_require` caches modules until game reload; data reloaded hot must go through `app.loadUserdata`.
- TFUI GUI must be generated **with** the component catalog (else "Could not assign value to userdata 'content'"); random UUIDs; `catalogHash` + relative `modRoot`.
- `react.onStep` must be registered during the Window recipe render, every render.
- Last checked: 2026-10-29

## FACT-006 — Heightmap export format (16 bit)
- Status: VERIFIED (file exported by the user, `<UD>/heightmaps/Test.png`, 2026-10-29)
- Finding: PNG **grayscale 16 bit** (color type 0), no interlace, no metadata chunk. Size **3585 × 3585 = 56·64 + 1** for a 56×56-tile map (14 336 m) → one pixel per 4 m height sample, **samples on the grid nodes** (`numTiles·64 + 1`). Values are **stretched to the full range**: min 0, max 65535 (11 847 distinct values) → the export does not store metres; on import they come from the UI's Minimum/Maximum Height (FACT-001).
- Consequence for the app: write 16-bit grayscale PNG of `(nTiles·64+1)²`, normalise real heights to 0…65535, and show the user the real min/max (m) to type into the importer (also save them in a sidecar file).
- Limitations: whether the importer accepts other sizes (resampling) or 8-bit is NOT TESTED.

## FACT-007 — Biome export format (`<UD>/biomes/`)
- Status: VERIFIED (same export)
- Finding: three 8-bit grayscale PNGs at the same size as the heightmap (3585²): `<name>_biomes.png` with 5 values `0/63/127/191/255` (biome index × ~63.75; which biome is which is unknown), `<name>_mountains.png` and `<name>_rivers.png` as 0/255 masks. They match the import tree inputs `input_biomes` (`type="Biomes"`, `type="Layer"` with `layerKey="mountains"` / `"rivers"`) in `climates/temperate/temperate_import_gen.tree.lua`.
- Open: mapping of biome indices to biomes (forest/grassland/…) → QUESTION-002.

## FACT-008 — Overpass needs an identifying User-Agent
- Status: VERIFIED (curl + node fetch, 2026-10-29)
- Finding: `overpass-api.de` answers **406 Not Acceptable** (nginx HTML) to the default curl/node User-Agent; with `User-Agent: ImportCity/0.1 (Transport Fever 3 map importer)` + `Accept: application/json` → 200. `overpass.kumi.systems` also works but its data was months old; `overpass.private.coffee` hung.
- Code: `app/src/lib/platform/download.ts` (`USER_AGENT`).

## FACT-009 — Copernicus GLO-30 tiles as served on AWS
- Status: VERIFIED (download 2026-10-29)
- Finding: `https://copernicus-dem-30m.s3.amazonaws.com/<name>/<name>.tif`, name `Copernicus_DSM_COG_10_N45_00_E004_00_DEM` (south-west corner). N45/E004: 43 MB, 3600×3600 float32, origin (4, 46), resolution 1/3600°, no GDAL nodata. Read with `geotiff` `fromArrayBuffer`.
- End-to-end (Lyon, 32×32 tiles, `app/test/e2e.live.ts`): heights 159.9…323.9 m (plausible), build 3.4 s + PNG 0.3 s in Node; the 8-bit preview shows Saône/Rhône/Fourvière with north up, east right.

## FACT-010 — Game map sizes and formats
- Status: VERIFIED (source read: `gui/menu/new_game_or_map_settings_page.tl` `getNumTiles`, `new_game_react_util.tl` `getFilterTags`, `E:\Transport Fever 3\base\mod.json` params `map.size` / `map.format`; 2026-10-30)
- Finding: 8 sizes (tiny, small, medium, large, veryLarge, huge, megalomaniac, gigantomaniac) × 5 formats give tiles X×Y, e.g. large: 56×56, 40×80, 32×96, 28×112, 24×126; gigantomaniac 1:1 = 112×112. Full table in `app/src/lib/core/mapsizes.ts`. New maps: `levels 6`, `resolution (4,4,0.05)`, `offsetZ -100`, `waterLevel 0`, biome map `tiles·64` (not +1) but the exported biome PNG is `tiles·64+1`.
- **What the game offers:** `mod.json` declares `map.size` / `map.format` several times with tags. PC (tag `desktop`): Small, Medium, Large, Very Large (`numbers` 2–5 → indices 1–4) and formats 1:1, 1:2, 1:3. Tag `experimentalMapFeatures` (PC): all 8 sizes and 1:4, 1:5. Console: Small, Medium, Large only. The tag is added when `api.util.getAppConfig().experimentalMapFeatures` is true = `experimentalMapFeatures = true` in `<UD>/settings.lua` (user's file: `false`). No GUI toggle found: the GUI sources only read it. Loading such a save on PC shows « La taille / le format de carte est expérimental(e) » (`savegame_react_util.tl`). The map editor's new-map page uses the same filter.
- The heightmap import replaces the terrain of the map currently open in the editor (`makeWorldReplaceTerrainCmd`): the map must be created with the same size and format first.
- French labels (base.mo, context `map-size`): Minuscule, Petite, Moyenne, Grande, Très Grande, Énorme, Mégalomane, Gigantomane. Formats are written "1 : 1" … "1 : 5".

## FACT-011 — IGN RGE ALTI through the Géoplateforme WMS
- Status: VERIFIED (requests 2026-10-29, no key)
- Finding: `https://data.geopf.fr/wms-r/wms?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&LAYERS=ELEVATION.ELEVATIONGRIDCOVERAGE.HIGHRES&STYLES=&CRS=EPSG:326zz&BBOX=minE,minN,maxE,maxN&WIDTH=w&HEIGHT=h&FORMAT=image/x-bil;bits=32` → raw little-endian float32, row 0 north, pixel centres on the requested grid (BBOX grown by half a pixel). Bare-earth DTM (no buildings / trees). Works up to 4096² per request (app uses 2048). Lyon 1:3 Large (3585²): 4 blocks in ~31 s.
- No data: values < -1000 (sea / outside France) → filled from Copernicus.

## FACT-012 — Overpass rules, load and servers
- Status: VERIFIED (docs dev.overpass-api.de « commons » + OSM wiki « Overpass_API », requests 2026-10-30)
- Rules (doc): per IP, `Rate limit: 2` slots; a slot stays busy for the run time plus a cool-down proportional to it; `/api/status` gives free slots and « Slot available after: …, in N seconds ». 429 = no slot (wiki: wait ≥ 30 s). 504 = refused for resources: a query is admitted only if its declared `[timeout]` (default 180 s) and `[maxsize]` (default 512 MiB) fit in half of the free resources → declaring more than needed gets refused first. Fair use: < 10 000 queries and < 1 GB per day, no parallel scripts, cache answers.
- Observed 2026-10-30: `overpass-api.de` answered **502 « server is currently at capacity… request queue is full »**, even on `/api/status` (global overload, not our rate limit); the same tiny query took 40 s there, 12 s on **VK Maps** `https://maps.mail.ru/osm/tools/overpass/api` (data minutes old, `Rate limit: 0`). `overpass.kumi.systems` and `overpass.private.coffee` timed out at 90 s.
- Old app behaviour (cause of « OpenStreetMap occupé »): `[timeout:240][maxsize:512 MiB]`, retries after 10 s / 30 s on the same server without `/api/status`, the 20 MB forest part, then an immediate second query without forests, in-memory cache only.
- Now (`download.ts` `overpass`, `osm.ts`): one query at a time; disk cache 30 days (`<appcache>/overpass/`); bbox rounded out to 0.01°; limits grow with the area (`overpassLimits`: 60–180 s, 64–256 MiB); ponds with an outline under `minWaterPerimeterM` (max(60, 25·scale) m) dropped server-side with `(if:length()>N)`; wait for an announced slot (≤ 60 s) else next server; 429/5xx/no answer → next server; 30 s then 60 s between rounds.
- Lyon 1:3 Large (2 007 km²) without forests: 6.5 MB, 2 749 water shapes, 206 places, 40 s on overpass-api.de (before the length filter: 7.4–10 MB, 43–93 s). Clipping with `out geom(bbox)` is NOT usable: members outside come back with empty geometry and crossing ones with `null` points, so polygon rings no longer close.
- Marshes: `waterway=canal` lines are mostly drainage ditches (Marais Poitevin): canals narrower than one 4 m sample in game are dropped.

## FACT-013 — Biome indices vs altitude in a game export
- Status: OBSERVED (`Test` export, 2026-10-29)
- Finding: biome 0 (16 % of the map) = water / lowest land; biome 1 = 52 % (plains); biomes 2, 3, 4 rise in altitude (medians 16 949 / 21 817 / 24 098 of 65 535) and overlap the mountains mask more and more (23 / 31 / 45 %). The import tree derives "Biome0 from heightmap (anything below water level)".

## FACT-014 — OSM place kinds vs population in France
- Status: VERIFIED (Overpass, Cotentin 49.45–49.75 N / 1.95–1.35 W, 2026-10-29)
- Finding: 105 places = 104 `village` + 1 `town` (Cherbourg-en-Cotentin, 77 808); Beaumont-Hague (11 223) and Valognes (6 791) are "villages". 97 / 105 nodes carry `population`. → Towns are selected by population (`selectPlaces`), not by kind; all of city/town/village are fetched.
- Cotentin 1:3 Large: 115 places, 9 above 2 000 inhabitants, all placed; Cherbourg moved 306 m inland (sea clearance 400 m).

## FACT-015 — ESA WorldCover 10 m for land cover
- Status: VERIFIED in Node (`geotiff` `fromUrl`, `app/test/e2e.live.ts`, 2026-10-30); the Tauri range client (`download.ts` `tauriRangeClient`) is NOT TESTED in the app.
- Finding: `https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/ESA_WorldCover_10m_2021_v200_N45E003_Map.tif` (3°×3° tiles named after the SW corner, multiples of 3); 102 MB each, `Accept-Ranges: bytes`, no CORS header (→ http plugin). COG: 36000² uint8 at 1/12000°, overviews 18000…562 (20, 40, 80… m), origin (3, 48), nodata 0. Classes: 10 tree, 20 shrub, 30 grass, 40 crop, 50 built-up, 60 bare, 70 snow/ice, 80 water, 90 wetland, 95 mangrove, 100 moss.
- Lyon 1:3 Large window at level 2 (40 m): ~1.5 MB read, 0.4–0.7 s; forest 32 % of the map, matches the relief (Monts d'Or, Monts du Lyonnais, Dombes woods). Replaces the OSM forest query (20 MB, 50 s, FACT-012). Licence CC BY 4.0 (« © ESA WorldCover project 2021 »).

## FACT-016 — How the game sizes imported towns
- Status: VERIFIED (source read 2026-10-30: `gui/map_editor/map_editor.tl` l.1720-1760 and `makeTowns`, `gui/entity_window/town/town_eow.script.tl` l.1000-1020; game data `<UD>/hqminimap/live_towns.lua`); the commands are NOT TESTED in game.
- Finding: « Towns / Industries → Import » reads only name, position, `sizeFactors` (default {1,1,1}) and cargo needs; the starting capacity is drawn by `api.engine.mapgen.createTowns(seed, towns)`. The capacity shown in the town window = `initialLandUseCapacities[i] × sizeFactors[i]` (residential, commercial, industrial). A normal game (user's save): town « size » (sum of initial capacities) 241…817.
- Exact sizes from a mod: `api.cmd.makeTownSetInitialLandUseCapacitiesCmd(town, {res, com, ind})`, then `api.cmd.makeTownUpdateSizeCmd(town, sizeFactors, true)` (rebuilds the buildings to the target). Implemented in `importcity/mod/content/gui/main_gui.handlers.lua` (`onApplySizes`; reads `<UD>/importcity/latest.lua` → `<UD>/importcity/<name>.lua` `towns`), checked in a lupa simulation with a mocked API only.

## FACT-017 — Relief and water pipeline v0.5 on real data
- Status: OBSERVED (`app/test/e2e.live.ts`, 2026-10-30)
- Old behaviour cut rivers: `maxCarve` turned every river cell more than 30 game m above the reference into land (Lyon: Yzeron, Garon, Azergues, Brévenne missing; Grenoble raw: 819 separate river pieces at preview resolution).
- First try FAILED: capping land at `landMin + distance × 0.12` around every river flattened the Alps (Grenoble max 1 287 → 391 game m). Kept instead: subtract the height the river must drop, fading out (smoothstep) over `need / riverBankSlope` (≤ 4 km) — Grenoble max 1 268 m, Isère / Drac / Romanche continuous.
- Tiny OSM `water=river` areas and ponds become isolated water pieces at full resolution (Lyon full grid: 235 river systems vs 31 in the preview). Dropping every inland water piece < `minLakeHa` (2 game ha): Lyon 4 river systems (preview and full), Grenoble 9; 1 163 (preview) / 3 601 (full) pieces removed around Lyon.
- Lyon 1:3 Large full grid (3 585²): terrain + biomes + towns 15.5 s in Node.

## FACT-018 — Sea-floor data (bathymetry)
- Status: VERIFIED (requests 2026-10-30, no key; Node e2e Cherbourg / Lyon)
- EMODnet WCS: `https://ows.emodnet-bathymetry.eu/wcs?service=WCS&version=2.0.1&request=GetCoverage&coverageId=emodnet__mean&subset=Lat(s,n)&subset=Long(w,e)&format=image/tiff` → GeoTIFF float32 at 1/960° (~115 m), land included, no nodata; Cherbourg area 634×422 px, down to −105.6 m, ~0.9 s. European seas only.
- Elsewhere: NOAA ERDDAP `https://coastwatch.pfeg.noaa.gov/erddap/griddap/etopo180.json?altitude[(lat0):1:(lat1)][(lon0):1:(lon1)]` (ETOPO 1′ ≈ 1.8 km, JSON table `[lat, lon, altitude]`), ~1.3 s.
- App: `core/bathymetry.ts`, `download.ts` `loadBathymetry` (disk cache `<appcache>/bathymetry`), sea depth = −floor × verticalScale capped at `seaMaxDepth` (40), water deepening from 1 m at the shore by `underwaterSlope`.

## FACT-019 — Game industries, economies and the import file
- Status: VERIFIED (source read 2026-10-30: `E:\Transport Fever 3\base\content\industries\*.zip`, `economy.zip` `<climate>.eco.lua`; a real save's `<UD>/hqminimap/live_industries.lua`); import of the app's industries NOT TESTED in game.
- Industry = folder name = tag; file `::/industries/<tag>/<tag>.con`. The towns_industries import takes `industries = {{position, angle, onWater, fileName, tag}}` (FACT-002).
- Each economy (temperate, dry, tropic, subarctic) removes some industries (temperate: cement_plant, paper_mill, printing_press, rubber_farm, tire_factory), gives `cargoRequiredIndustries` (the industries a cargo needs, e.g. steel = coal_mine + iron_ore_mine + steel_mill), `industryPlacementFallbacks` (oil_platform → oil_well, sand_excavator → sand_pit on land) and `waterIndustryFraction` (temperate 6/41). Table copied into `core/industries.ts` `ECONOMIES`.
- French industry names are not in base.mo's plain msgids (only « Mine de fer », « Plateforme pétrolière », « Aciérie », « Usine de machines » found): the app's labels are ours.
- Lyon 1:3 Large: 120 OSM sites (48 quarries, 15 breweries, 12 machine works, 9 refineries, 9 chemical…) → 74–76 industries (≈ 43 real, 23 land cover, 10 chain completion).

## FACT-021 — How many towns and industries the game puts on a map
- Status: OBSERVED by the user in the game's new-map screen (2026-10-30); the counts are computed by the engine: `base/mod.json` only declares `locations.towns.frequency` and `locations.industry.initialIndustryDensity` (5 levels each), no formula in the scripts (`climates.zip`, `game_mechanics.zip` searched).
- Large map (56 × 56 tiles, 14.3 km): towns 1…41; industries for 20 [30 / 5] towns: Rare 8 [8/8], Dispersée 8 [8/8], Moyenne 9 [9/8], Dense 9 [11/9], Très dense 13 [12/11]. Small map (32 × 32): at most 13 towns → both scale with the area (41 × 1024 / 3136 ≈ 13.4).
- App: `defaultIndustryCount(f, density)` = round(base × tiles / 3136), base 8/8/9/9/13; `gameTownLimit(f)` = round(41 × tiles / 3136), shown as indicative (can be exceeded).

## FACT-022 — Why the area square looked turned
- Status: VERIFIED (code + unit test, 2026-10-30)
- The frame was a square in the UTM zone; away from the zone's central meridian UTM north differs from true north by the meridian convergence ≈ (lon − lon0)·sin(lat) — 1.3° at Lyon (zone 31, lon0 3° E), up to ~2.5° at a zone edge in France — so the square showed turned on the north-up web map. Since v0.7 the frame uses a transverse Mercator centred on the area (`+proj=tmerc +lat_0 +lon_0 +k=1`): no convergence at the centre; the north edge follows a parallel to < 0.01°.

## FACT-020 — River mask, banks and the broken preview (v0.5 feedback)
- Status: VERIFIED (source read + browser reproduction, 2026-10-30)
- The import tree (`climates/temperate/temperate_import_gen.tree.lua`) uses the rivers mask only for river trees: depth and banks come from the heightmap alone. v0.5 water was flat (−6 / −4 / −8) next to land at +1 m: a 7 m wall at the shore = the « steep banks » and « 1 m deep » impressions.
- An unbounded bank-slope cap (land ≤ landMin + d × slope around every river) flattens hills near rivers (Lyon max 444 → 360 m at slope 0.15): the cap now applies within `bankWidthM` (200) and fades out.
- Preview « charge puis rien » : in the browser the preview works with real OSM data; a preview without `candidates` (worker from before a hot reload) made the map and the town list crash silently (no error boundary, empty-message errors not shown). Fixed by boundaries, a global error handler and the technical journal (`<appcache>/importcity.log`). The exact cause in the user's Tauri session is NOT CONFIRMED.

## FACT-023 — Rivers and shores in game-made maps
- Status: MEASURED on the game's own export `<UD>/heightmaps/Test.png` + `<UD>/biomes/Test_rivers.png` (2026-10-31), metres assuming the export spans −100…+500 m (base `offsetZ -100`, importer default max 500; fits: sea flat at −97…−100 m, mask edge at 0.07 m).
- Width p10 108 m, median 132 m, p90 164 m. Centre depth 7.8 / 8.6 / 9.5 m (p10 / median / p90). Cross-section: 0 m at 4 m inside the bank, −3.8 m at 20 m, −6.3 m at 32 m, flat bed −8…−8.4 m from ~48 m. Banks: +1 m at 4 m outside, +5.9 m at 40 m, +14.6 m at 100 m.
- Generator: `climates.zip` `climates/gen/mapgenutil.tl` l.130-134 (half width `12·(5 − order/1.5) + rand·22`, depth `depthScale·(3+rand)·1.5`, `depthScale = 1.5` in `gui/node_editor/layer_nodes.script.tl` l.255), width factor 0.8–1.3 in `temperate_gen.tree.lua`.
- Beaches: temperate has no sand material; `temperate_clima.tree.lua` textures the shore (scree / gravel) from the distance to water level; the import tree has no beach input → nothing to write.
- ImportCity v0.8 on Lyon 1:3 (preview grid, 16 m): widths p10 48 / med 61 / p90 93 m (grid-quantised); centre depth median 6.3 m with the game's 48 m profile, 8.7 m (p10 7.1) once full depth is reached at 32 m from the bank and the middle always at full depth.

## FACT-024 — Roads, railways, industry names and footprints (source read 2026-10-31)
- The connection command ALWAYS links every existing industry: the map editor's own source says so (« not yet implemented on C++ (it always connects industries) » above its commented-out « Connect Industries » option, `map_editor.tl` ~l.2595). The Towns / Industries import builds towns (`makeTowns`) and industries (`makeIndustries` = `api.engine.mapgen.createIndustries(seed, industries)` then `api.engine.util.proposal.createIndustryProposal` + `makeWorldBuildProposalCmd(…, context, true, false)` per result, l.1557-1590) in one go.
- Map editor: « Propose Default Connections » = `api.engine.mapgen.getDefaultTownConnections(towns)`, « Generate » = `api.cmd.makeTownConnectWithIndustriesCmd(townEntities, conns, keep)` with `conns` = `{i, j}` town index pairs (`gui.zip` `gui/map_editor/map_editor.tl` l.2483-2632); `townConnectionMaxBridgeLength = 250` (`base/mod.script.tl` l.113).
- Free roads / tracks: `api.type.SimpleProposal` (`streetProposal.nodesToAdd` / `edgesToAdd`, `SegmentAndEntity` type 0 street / 1 track) + `api.cmd.makeWorldBuildProposalCmd(proposal, nil, true, false)`; example `mission.zip` `mission/tasks/auto_builder/electrify.tl` l.10-38. Templates: `country_old_small|medium|large` (years 0–1940, dirt), `ind_country_old_small` (hidden), `country_new_*` (1940), track `simple` (always), `standard` (1930), `high_speed` (1980).
- Names: `api.cmd.makeEntitySetNameCmd(entity, name)`; the towns_industries import has no industry name (`map_editor.tl` l.1771-1784).
- Footprints (`industries/<tag>.zip` `<tag>.script.lua` `ground_face`): 89–108 m radius (forest, farms, brewery), 111–134 m (factories, quarry, sand pit), 143–174 m (mines, steel, refinery, chemical); water industries' colliders 42–81 m.

## FACT-025 — How the Map Editor imports a heightmap, biomes and towns (source read 2026-10-31)
- `gui.zip` → `gui/map_editor/map_editor.tl`. The imported map is NOT computed in Lua: each import tab builds a mode and the C++ GUI component `builtin.MapPreviewComp{ mapColoring, mode, inputMap, economy, params, seed, locationsConfig, onReady = function(map, feedback) }` (l.2644-2700) calls `onReady` with the ready map; the tab only shows it one step after mounting (« invisibleComponentHACK »). The tab then applies it: `api.gui.map.reloadMaterialIndexManagerPipeline()` and `api.cmd.makeWorldReplaceTerrainCmd(readyMap, api.res.getBaseConfig().terrain, "", api.engine.util.getWorld(), keepAssets)`.
- Heightmap (l.831-1020): `api.type.ImportExportHeightmapMode` (`import = true`, `minH`, `maxH`, `generateAssets = not keepAssets`, `fileName` = an entry of `app.getAllHeightmaps()`), input `api.engine.terrain.makeMapFromGame(true, false, false, keepAssets)` with `waterLevel`.
- Biomes (l.1155-1330): `api.type.ImportBiomesMode` (`terrainGenerator` = the climate's generator with `isImportGenerator` via `app.res.terrainGeneratorRep`, its params defaulted by `script_param_util.getScriptParamDefaultValueIndex`; `biomeMap` and `layerMaps[layer.key]` = entries of `app.getAllBiomes()`, layers from `climate.dataMaps.layers`), applied with `keepAssets = false`.
- Towns (l.1620-1640, 1745-1770): `api.type.Map.Town` (`pos`, `name`, `sizeFactors`, `landUse2CargoNeeds`) → `api.engine.mapgen.createTowns(seed, towns)` → `makeTownCreateCmd(result.toAdd)` (and `makeTownDestroyCmd` for `toRemove`).
- The new-game screen never offers import generators (`gui/menu/new_game_react_util.tl` l.212 filters `editorOnly` / `isImportGenerator`); it starts games with `app.startGame2(map, seed, date, …, isMapEditor, mods, configDict, modParams)`.

## FACT-026 — TFUI only requires the handlers module when a prop is a handler
- Status: VERIFIED (in game 2026-10-31, `crash_dump/stdout.txt`: « attempt to index global 'handlers' (a nil value) » in `main_gui.script.lua` line 66, the game's UI crashed; TFUI source `src/codegen/genScript.ts` l.363: `local handlers = ug_require …` is emitted only if `handlerList.length > 0`, i.e. a prop of kind "handler").
- Removing the last buttons (v0.9) left the `lua` text expressions `handlers.statusText(status)` / `handlers.pump(react)` on an undefined global. Fix: the expressions load the module themselves (`ug_require("importcity::/gui/main_gui.handlers.lua").pump(react)`); `importcity_auto.lua` registers its window recipe lazily (first generation, from the pump's step) since the module is now first loaded during a render. `importcity/tools/sim_mod.py` checks the generated script for this.
- Game logs: `<UD>/crash_dump/stdout.txt` (+ `error.json`).
- `api.engine.terrain.makeMapFromGame(false, …)` (without the heightmap) reports `numTilesX = numTilesY = 0` (seen in game 2026-10-31, the size check refused a Large map as « 0 × 0 »). The mod reads the size from `api.engine.terrain.getBoundingBox()` (metres / 256), else `makeMapFromGame(true, …)`.

## FACT-027 — What a new track segment needs (source read + in game, 2026-10-31)
- In game, every segment of our railway proposals was refused « Construction impossible » (`crash_dump/stdout.txt`: « ProposalData error: Construction impossible », even one segment alone): the edges lacked fields the game's own builder sets.
- `mission.zip` → `mission/tasks/auto_builder/track_builder.tl` `buildRailFn`: nodes `api.type.NodeAndEntity` (negative `entity`, `comp.position`), edge `api.type.SegmentAndEntity` with `entity` negative, `type = 1` (rail), `comp.node0/node1`, `comp.tangent0/tangent1`, **`comp.type = api.type["enum"].BaseEdgeType.NORMAL` (or TUNNEL), `comp.typeIndex = 1`, `comp.position0/position1`, `comp.roadType = api.type["enum"].RoadType.TRACK`**, `laneConfigs` / `roadTemplate` / `roadStyle` from `api.res.streetTemplateRep`; sent with `makeWorldBuildProposalCmd(proposal, nil, false, false)`; the created nodes are read back from `res.proposal.proposal.addedSegments[i].comp.node0/node1`.
- Bridges: `BaseEdgeType.BRIDGE` with `typeIndex = api.res.bridgeTypeRep.find("::/infrastructure/bridge/stone.bridge")` (types in `infrastructure/bridge.zip`: cable, concrete, steel, stone, suspension). The mod retries a refused single segment over water once as a stone bridge. NOT yet seen in game.

## FACT-028 — Track limits, bridge and tunnel types (game files, 2026-10-31)
- Status: VERIFIED (source: `infrastructure/track.zip` → `track/standard/standard.street_template.lua`; `infrastructure/bridge.zip`; `infrastructure/tunnel.zip`).
- Standard track: `maxSlopeBuild = 0.085`, `minCurveRadiusBuild = 55` m, curve speed `speedCoeffs = {0.85, 30, 0.6}`.
- Rail bridges: stone (from year 0), steel (1940). Rail tunnels: `tunnel_a` (0), `tunnel_b` (1970), found with `api.res.tunnelTypeRep.find("::/infrastructure/tunnel/<name>.tunnel")`.
- Real-data check (Node e2e Lyon, 2026-10-31): designed line 21.1 km, tightest curve 304 m, steepest 2.5 %, 11 bridges, 2 tunnels, 223 nodes, 26 ms. NOT TESTED in game.

## FACT-029 — Town goods and the cargo-needs command (game files, 2026-10-31)
- Status: VERIFIED from the source (not yet seen in game).
- `economy.zip` → `economy/placementparamsutil.lua` l.506-614: COMMERCIAL = beverages, books, clothes, fish, meat, tinned_food, vegetables; INDUSTRIAL = bricks, cement, fuel, furniture, machines, planks, tools, vehicles. Town levels add one good per land use on level-up (`game_mechanics/towns/town_growth.script.tl`).
- `api.cmd.makeTownUpdateCargoNeedsCmd(townEntity, {{res ids}, {com ids}, {ind ids}}, true)` (`mission/tasks/utility/mission_town_util.tl`, `gui/entity_window/town/town_eow.script.tl`: at most 3 per land use). Ids: `api.res.cargoTypeRep.find("::/cargos/<name>/<name>.cargo")`. The town component's `cargoNeeds[k]` is a list of `{cargoTypeId, factor}`.
- The Map Editor import file takes `landUse2CargoNeedsCategories` (categories, `map_editor.tl` l.1723-1762), not goods: the app does not write it.
- The temperate import generator grows coast trees on biomes 3 / 4 within ~130 m of water (`climates/temperate/temperate_import_gen.tree.lua` l.2458-2570); WorldCover sand / dunes are 60 / 20 / 100 (rock / scrub).

## FACT-030 — Town good tiers and what a new town asks for (game files, 2026-10-31)
- Status: VERIFIED from the source.
- `economy/placementparamsutil.lua` l.506-660: tier 0 = fish, meat, vegetables (commercial), bricks, cement, fuel, planks (industrial); tier 1 = beverages, books, clothes, tinned_food, furniture, machines, tools; tier 2 = vehicles. Town levels: level 0 one commercial + one industrial (tier ≤ 1), a second at levels 5 / 7, a third (tier ≤ 2) at 9 / 11.
- `game_mechanics/towns/town_growth.script.tl`: needs are added on level-up only, after the first delivery; the most-asked goods of the map are avoided. Starting level from residential capacity (`town_cargo_util.tl`): > 200 → 4, so a new town never starts with more than 1 + 1.

## FACT-031 — Railway gaps and Overpass timings (2026-10-31)
- Status: VERIFIED (cached Overpass answers, small read-only queries).
- With `usage~main|branch` only, crossovers, junction links and short untagged pieces were missing: Lyon gaps of 48–231 m (filled by untagged `railway=rail` ways and a crossover), the Lison–Lamballe branch cut from Paris–Cherbourg, the two tracks of Paris–Cherbourg never joined; plus OSM pieces 3–11 m apart that share no node. Node ids were present and nothing was truncated. Lyon with the new filter: 2 061 rail ways instead of 1 828.
- Overpass (Normandy, ~7 600 km²): 4 sequential queries took 3 min 40 – 5 min 50, waits dominating (a 30 KB answer took over a minute); `/status` of overpass-api.de hung > 25 s once, VK Maps' took 18.5 s (and has no slots); overpass-api.de serves gzip (9.5 MB → 1.5 MB).
- Game catalogues (`base/strings/<lang>/LC_MESSAGES/base.mo`) hold the official industry names (`INDUSTRIES_<TYPE>_NAME`, e.g. en « Crop Farm », fr « Exploitation agricole ») and the goods (msgid = English, e.g. « Planks »).

## FACT-032 — Finding street nodes; road templates, bridges and tunnels (game files, 2026-10-31)
- Status: VERIFIED from the source (not yet seen in game).
- `api.engine.util.octree.findEntitiesInCircle(api.type.Vec2f.new(x, y), radius, api.type.ComponentType.<TYPE>)` lists entities in a circle (`mission/name_util.tl` l.143, `mission/tasks/create_line/stop_config.tl` l.32, with STATION_GROUP / TOWN…); `api.engine.util.octree.findTransportNetworkNodesInCircle(Vec2f, r)` (`mission/tasks/build_path/build_path.tl` l.19); `api.engine.system.streetSystem.getNodeStreetSegments(node)` / `getNodeTrackSegments(node)` (`gui/entity_window/view_manager_util.tl` l.8-35).
- Country roads (`infrastructure/street.zip` → `street/country/`): `country_old_small|medium|large` (until 1940), `country_new_small|medium|large` (`yearFrom = 1940`), `roadType = "STREET"`, plus `ind_country_*` and `entrance_*` templates for industries.
- Bridges (`bridge.zip`): stone (0), steel (1940), suspension (1940), concrete (1970), cable (2000), tarch (2010) carry RAIL and ROAD; trestle = rail only, trestle_s = road only. Tunnels (`tunnel.zip`): `tunnel_a` / `tunnel_b` / `tunnel_c` = rail only; `tunnel_a_car` (1900) / `tunnel_b_car` (1970) = road only.

## FACT-033 — The Mod Manager crashes on unknown HTML in description.html (2026-11-01)
- Status: VERIFIED (in game 2026-11-01, opening RealMap's page in the Mod Manager: « Assertion `false && "Unbound UI transformation for tag name"' failed » in `RichTextBuilder.cpp:429`, under `ModDetails` / `RichTextView`, fatal error).
- Cause: `_metadata/description.html` used `<code>`, `<i>` and the entities `&lt;` / `&gt;`. The game renders only a subset of HTML; HQminiMap's page (working) uses `<p> <b> <h2> <ul> <ol> <li> <a>` and no entity. `app/test/modpage.test.ts` now allows only those.

## FACT-034 — Since build 40420/40423, mods may only read / write three userdata folders
- Status: VERIFIED (game build 40423, 2026-11-01)
- Finding: `app.loadUserdata(dir, name)` / `app.saveUserdata(dir, name, tbl)` throw « The directory you trying to access is not available or invalid » for any `dir` other than **`towns_industries`, `heightmaps`, `mod_presets`** (the list sits right before that message in `TransportFever3.exe`, `app_script_util.cpp`). File names are checked too (« Forbidden file name ({}) detected, another valid version could be "{}" »): keep to letters, digits, `_`. Build 40408 accepted any folder (`importcity/` worked).
- Evidence: local stdout.txt after updating to 40423: `[importcity] alive.lua not saved: … The directory you trying to access is not available or invalid` (mod 1.0.1 logs); a Steam player on 40425 saw the mod load but never read `importcity/request.lua`.
- Consequence: the files shared by the app and the mod live in `towns_industries`, named `realmap_*` (DECISION-024). They also show in the Map Editor's Towns / Industries import list (as TF3 Minimap's `tf3map_*` do).

## FACT-035 — Rebuilding a street edge: read-only components, per-lane data, template years
- Status: VERIFIED (game build 40423, 2026-11-02; a player's crash on 40425, reproduced and fixed in game)
- `api.engine.getComponent(edge, BASE_EDGE)` is **read-only** in game: writing a member throws « cannot write to read only member 'laneConfigs' » (the sim used to hand back a plain table and hid it).
- A copy of an old edge's component sent with another template (`seg.comp = old` then new `laneConfigs`, as `electrify.tl` does between two tracks of the same lanes) makes the engine abort with a fatal, uncatchable assertion « lc.segment0 not found » (`StreetShapeFactory.cpp`, inside `makeWorldBuildProposalCmd`) when the lane count changes (country `*_small` 4 lanes, `*_medium` 6): `BaseEdge` also carries per-lane `laneConfig` and `edgeDecorations` (`api/tealdef/api/engine.d.tl`). Fix: fill the new `SegmentAndEntity.comp` field by field from the old geometry (`node0/1`, `position0/1`, `tangent0/1`, `type`, `typeIndex`, `roadType`) and the new template's `laneConfigs` / `roadTemplate` / `roadStyle`, like a new edge.
- `makeTownConnectWithIndustriesCmd(townEntities, connections, keep)` takes no road type (`api/tealdef/api/cmd.d.tl` l.819; the Map Editor calls it the same way, `gui/map_editor/map_editor.tl` l.2632); the engine picks among the `simBuildable` country templates of the year (old_* until 1940, new_* from 1940). `country_old_*` no longer exist from 1940.
