# Durable Decisions

Record decisions that future work should preserve unless new evidence or an explicit user request justifies revisiting them.

## DECISION-001 — Open data sources
- Status: ACTIVE · Date: 2026-10-29
- Decision: **OpenStreetMap** (ODbL) for all vector data (roads, rails, water, forest/landuse, places + `population`); **Copernicus DEM GLO-30** for relief worldwide, **IGN RGE ALTI 1 m/5 m** as high-quality option for France. Overpass for prototyping, Geofabrik `.osm.pbf` later.
- Rationale: only free worldwide source covering every feature TF3 needs; GLO-30 is the cleanest free global DEM; IGN is close to the game's 4 m grid.
- Alternatives: SRTM (holes, <60°N), Overture Maps (no relief, nothing decisive).
- Revisit if: licence or availability changes.

## DECISION-002 — Tauri app + thin mod, HQminiMap stack
- Status: ACTIVE · Date: 2026-10-29 (user choice)
- Decision: external desktop app **Tauri 2 + SvelteKit SPA + Svelte 5 + TS + OpenLayers** (same as HQminiMap HQ-001/HQ-002), heavy processing in TS workers; the mod stays thin.
- Rationale: map UI to select the area, writes directly into `<UD>`, distributable; reuses proven code (`detect_paths`, Lua writers, fast-png workers).
- Alternatives: pure web (cannot write game folders), Python CLI (no map UI).

## DECISION-003 — Use the game's native import paths first
- Status: ACTIVE · Date: 2026-10-29
- Decision: the app writes `<UD>/heightmaps/<name>.png` and `<UD>/towns_industries/<name>.lua` (FACT-001/002) that the Map Editor imports natively. Mod code is only for what has no native import (streets via `StreetProposal`, trees/assets, verification).
- Projection: local UTM, map centred on 0 (FACT-003).

## DECISION-004 — Regional scale and water handling (v0.2)
- Status: ACTIVE · Date: 2026-10-29 (user feedback: "marchotte", sea level -4, regional scale wanted)
- Decision:
  - Map picked by the game's own size + format (`mapsizes.ts`), never "tiles".
  - Horizontal `scale` = real m per game m (default 1:3); vertical scale default 1/√scale (user choice), editable.
  - Relief: IGN RGE ALTI in France (DTM, exact grid), Copernicus elsewhere / to fill gaps, averaged over the sample footprint.
  - TF3 has one global water level (0): sea = no data or ≤ 0.5 m connected to the edge; OSM lakes / rivers carved to −depth; reference height (game 0) = sea level, else 5th percentile of the water's real height, else lowest point; land ≥ +1 m; banks limited to slope 0.4; lakes needing > 30 m of trench stay land. Water Level stays 0 in the Map Editor.
  - Preview: 2D hill-shaded image (user choice) overlaid on the OSM map, computed on a ≤ 640 px grid.
- Revisit if: in-game import shows the rivers mask or biome defaults behave differently (QUESTION-002/006).

## DECISION-005 — Towns by population, settled on the terrain; detachable preview (v0.3)
- Status: ACTIVE · Date: 2026-10-29 (user feedback: coastal towns missing in game, no towns around Cherbourg without "villages", wants a detachable live preview)
- Decision:
  - Places: all `city|town|village` fetched; kept if population ≥ min (default 2 000; unknown population estimated by kind, optional), most populous first, at most N (default 20).
  - Placement runs in the worker AFTER the terrain: `placeTowns` moves a town off invalid ground (water, < 400 m from sea / big lakes, < 100 m from rivers / ponds, < 500 m from the edge, slope ≥ 20 %) to the nearest valid cell within 3 000 m, else drops it; spacing applied after moving; the reason is reported.
  - Preview: « Carte » / « Aperçu » tabs; `PreviewView` (game-metre OpenLayers view, towns with moves, hover readout, legend, stats) shared with a detachable Tauri window (`preview`, route /preview, prerendered) fed by Tauri events (`preview:hello|request|data|status`). Updated on click only. Preview grid 1 024 px.

## DECISION-006 — Lighter OSM, land cover from WorldCover, the game's real map sizes (v0.4)
- Status: ACTIVE · Date: 2026-10-30 (user feedback: frequent « OpenStreetMap occupé »; map size/format choices the game does not offer)
- Decision:
  - Overpass only for places + water, following its rules and with a fallback server (FACT-012). Forests / scrub / rock from ESA WorldCover windows (FACT-015), not OSM; the « Forêts et roches » checkbox now means WorldCover.
  - Map sizes/formats: only the game's PC list (Petite…Très Grande, 1 : 1…1 : 3) unless `<UD>/settings.lua` has `experimentalMapFeatures = true`; a saved out-of-list choice moves to the nearest offered one (FACT-010). The UI shows the real area in km² and warns above 2 500 km².

## DECISION-007 — Town choice, real town sizes, continuous navigable rivers, playable relief (v0.5)
- Status: ACTIVE · Date: 2026-10-30 (user: pick the towns on a list / the map in two passes; town sizes like the real ones; rivers cut and too narrow for ships; bumpy terrain and ponds hurt gameplay. User choices: sizes through the importcity mod; rivers all at the water level, valleys lowered locally with a gentle slope, only where the relief requires it)
- Decision:
  - Towns: every OSM place in the map is a candidate; manual picks (`settings.townPicks`, by `placeKey` name|lon,lat) override the population filter; picked towns always tried, the filter fills up to `maxTowns`. Preview = pass 1 (green placed / orange not chosen / grey not placed, on the map, the preview and a list); a click or checkbox re-runs only the worker; « Générer » = pass 2.
  - Sizes: `targetCapacity` (300 at 10 000 inhabitants, exponent 0.5, 60…2 500) written to the note; import file sizeFactors {1,1,1}; the mod button applies them (FACT-016).
  - Relief / water (`buildTerrain`): Copernicus canopy −10 m on WorldCover forest, blur 16 game m, rivers at least 32 game m wide and 6 m deep, river gaps ≤ ~24 m closed, inland water pieces < 2 ha dropped, rivers never removed, valleys lowered by the river's drop over drop / 0.12 (FACT-017), bank cap 0.4 kept for all water. All are settings.
  - River test map to measure the navigable threshold (QUESTION-009).

## DECISION-008 — Two phases, realistic water, repaired river network, automatic sizes, industries (v0.6)
- Status: ACTIVE · Date: 2026-10-30 (user feedback after testing v0.5 in game: shallow rivers, flat sea, steep banks, preview broken, rivers ending nowhere, sizes should apply without a click, add industries; « voir l'application en 2 phases »)
- Decision:
  - Phase 1 « Données réelles » (`fetchData`, cached per area: relief, sea floor, WorldCover, OSM water / places / industrial sites, summary in the panel, raw layers on the map) and phase 2 « Transformation » (worker, re-run automatically ~0.7 s after a setting changes), then « Export ».
  - Water: depth profile from the shore (1 m + 0.35 m per m, rivers 10 m, lakes 8 m), sea from EMODnet / ETOPO capped at 40 m (FACT-018), gentle river banks 0.15 within 200 m (sea / lakes 0.4), valley lowering renamed `valleySlope`.
  - River network (`rivers.ts`): dangling mouths joined to water within 100 game m, else routed downhill (priority-flood on a ≤ 768 grid) to water or the map edge; sources kept but tapered over 500 m. OSM direction = flow, overridden when the start is ≥ 5 m lower.
  - Sizes: the mod's mod-area button pump applies them in the Map Editor (once per import, only when ≥ half the towns match by name); the button stays as a fallback. The editor's own import is kept (user's choice).
  - Industries (`industries.ts`, FACT-019): real OSM sites first (clustered 2 km, ≤ quota/10 per type), land-cover primaries (farm ≥ 50 % crops, livestock ≥ 40 % grass, forest ≥ 60 % trees, fishing offshore), production chains completed from the economy, quota ≈ tiles / 40, placed on valid ground (900 m from towns, 1 200 m apart) or open water; manual picks like towns. (Selection and quota superseded by DECISION-009.)

## DECISION-009 — Left panel in 3 tabs, map-only result, finished rivers, game quotas (v0.7)
- Status: ACTIVE · Date: 2026-10-30 (user feedback on v0.6; user choices: selection settings live with the lists in « Export », the detached preview window is removed)
- Decision:
  - UI: panel on the left, tabs « Zone et données réelles » / « Transformation » / « Export »; the « Aperçu » tab, `PreviewView` and the detached window are gone (legend and height readout moved onto `AreaMap`). Map: double click moves the centre, click opens a sheet, right click adds / removes, option to hide what is not chosen.
  - Projection: local transverse Mercator centred on the area (FACT-022); IGN requested in UTM and resampled.
  - Water: river cross-section scaled to the local width (middle always `riverDepth`), shore 0.5 m / land 0.5 m with easing across the waterline, mouths carried into still water and the sea dug to river depth near them, channels between water pieces ≤ `waterJoinM` (64 game m) apart when one holds a river and both are ≥ `minLakeHa` (first try without the size rule meshed the Marais Poitevin ditches: 686 channels → 1), `riverMinWidth` enforced everywhere (tapers, thin OSM areas), WorldCover wetland ≥ 5 ha → lakes 4 m deep. Settings version 7 resets `landMin` to 0.5.
  - Towns and industries: additive selection — the automatic choice ignores manual picks, so adding one adds one and removing one leaves a gap. Towns: indicative game limit ≈ 41 per 3 136 tiles. Industries: count from the game's density (FACT-021), chosen by whole chains, each chain scored by its industry most present in reality (OSM sites 3–4 + 2·log2 n, land cover 1–3) minus 0.25 per extra industry; list sorted by that presence, broken chains flagged. Water industries only with open water ≥ 300 m from the shore (Lyon's lakes made a sand excavator / oil platform get chosen then silently dropped), else the economy's land fallback.

## DECISION-010 — Leaner UI with a log, Ctrl placement, game-like rivers, names, start network (v0.8)
- Status: ACTIVE · Date: 2026-10-31 (user feedback on v0.7; user choices: minimum river width 64 m, roads = town pairs chosen from the real network but routed by the game)
- Decision:
  - UI: no static explanation text in the panel (field tooltips only; the explanations live in `ARCHITECTURE.md` « Réglages »). Statistics, data summary, town report and the technical journal go to one log panel at the bottom of the left panel (`LogPanel.svelte`, `importer.events`, levels info / warn / error / debug, « Détails » shows debug). Phase 1 shows its steps with state and detail (`importer.dataSteps`).
  - Map: Ctrl held shows a ghost of the area under the mouse, Ctrl + click moves it; double click zooms again. Symbols never decluttered (`declutterMode: "none"`), only names. Towns listed and drawn: chosen + not placed + the 10 most populous others (`shownTownKeys`); others are added through a search field (accent-insensitive).
  - Rivers: `riverMinWidth` 64, `riverDepth` 9, the game's cross-section (`riverDepth·(d/48 m)^0.8`, FACT-023) with a 70 % floor in the middle of narrow rivers; shore easing on the first water row only; `underwaterSlope` 0.5, mouths dug over 300 m. Settings version 8 migrates the old defaults. No beach output (FACT-023).
  - Industries: whole footprint off water (radius per type + 30 m, slope checked under it, FACT-024); names = OSM name, else « <industrie> de/d'/du/des <ville la plus proche> »; written in the note for the mod (`industries = {{tag, x, y, name}}`).
  - Heights: Minimum / Maximum are whole metres (floor / ceil) and the heightmap is stretched over that range.
  - Network (`core/network.ts`): third Overpass query (motorway…secondary, railway main / branch, `out body geom`); graph by shared OSM nodes; each town linked to 1–2 others by cheapest real road not passing within 600 m of a third town (a lone town gets its cheapest link), each town to ≤ 1 industry within 6 km of road, links removed by hand never replaced; railway = longest main-line path resampled every 250 m inside the map (a 2nd only if it serves ≥ 3 towns). Note fields `connections`, `industryLinks`, `rail.lines` for the mod, which has the game build them (mod part in its own session).
