# Open Questions and Verification Queue

Track unresolved issues so they do not get mistaken for facts.

## QUESTION-001 — Heightmap image format accepted by the importer
- Answered for export: 16-bit grayscale PNG, (nTiles·64+1)², values stretched 0…65535 → FACT-006.
- Still open: does the importer accept another size (resampled) or 8 bit? Test by importing an app-generated PNG on a map of a different size.
- Status: PARTIALLY ANSWERED · Date added: 2026-10-29

## QUESTION-002 — Biome index mapping
- Format known (FACT-007), altitude trend known (FACT-013). Open: what each biome looks like (forest? rock?).
- App defaults (`DEFAULT_BIOMES`): water 0, open land 1, forest 2, scrub/heath 3, rock 4 — editable in the app.
- Next: app button « Écrire une carte de test des biomes » → `ImportCity_test_biomes` (5 stripes, biome 0 west → 4 east, heights 5…25 m). Import it and describe each stripe.
- Status: OPEN · Date added: 2026-10-29

## QUESTION-003 — Large tables through `app.loadUserdata`
- Question: does a table with thousands of street segments load fine? Otherwise split into chunks.
- Status: OPEN · Date added: 2026-10-29

## QUESTION-004 — Heightmap row order in the game
- Question: does TF3 read image row 0 as the north edge (largest world y) and column 0 as west? The app assumes so (`ROW0_IS_NORTH` in `app/src/lib/core/heightmap.ts`); towns are placed with y = north.
- Next smallest useful verification: import an app-generated map (e.g. Lyon) and check that the Rhône/Saône layout and the towns sit where expected (Villeurbanne east of Lyon, Caluire north).
- Status: OPEN · Date added: 2026-10-29

## QUESTION-005 — Town sizes in game
- Answered in part (FACT-016): the import only multiplies the capacity the game draws; v0.5 writes sizeFactors {1,1,1} and the importcity mod sets exact capacities (`targetCapacity`: 300 at 10 000 inhabitants, exponent 0.5, 60…2 500).
- Still open: does `makeTownSetInitialLandUseCapacitiesCmd` + `makeTownUpdateSizeCmd(…, true)` work in the Map Editor and build the town right away? Is 2 000+ playable (Lyon 2 149)? Does the game cap the capacity?
- Next: install the importcity mod, import a map's towns, click « Appliquer les tailles réelles », read the town windows (capacity) and look at the towns.
- Status: PARTIALLY ANSWERED · Date added: 2026-10-29 · Updated: 2026-10-30

## QUESTION-009 — What water can ships use?
- The navigable-water grid is computed by the engine (layer « Navigable Waters »); no width / depth rule in the scripts, the API docs or the exe strings. The app widens rivers to 32 game m and digs them 6 m (defaults, guesses).
- Next: « Écrire une carte de test des rivières » (channels 8–64 m wide × 2–10 m deep, `riverTestPattern`), import it (Min −10, Max 5, Water Level 0), show « Navigable Waters », note which channels are coloured; then set `riverMinWidth` / `riverDepth` defaults.
- Status: OPEN · Date added: 2026-10-30

## QUESTION-006 — Does the import generator carve the rivers mask itself?
- The app carves rivers into the heightmap AND writes `<name>_rivers.png` (the import tree has a "Rivers Input"). If the generator also carves or reshapes along the mask, rivers could end up doubled or deeper.
- Next: import a map with and without the rivers mask, compare.
- Status: OPEN · Date added: 2026-10-29

## QUESTION-007 — Valid terrain height range
- The Map Editor clamps Minimum/Maximum Height to `api.engine.mapgen.getMinMaxValidTerrainHeight()` (values unknown; offsetZ is -100). Very high regions or large vertical scales could exceed it.
- Next: read the bounds shown by the Import Heightmap spin boxes. v0.6 seas go down to −40 m (`seaMaxDepth`): if the editor refuses the Minimum Height, lower the cap.
- Status: OPEN · Date added: 2026-10-29 · Updated: 2026-10-30

## QUESTION-008 — How far from the sea must a town centre be to appear in game?
- Observed by the user (v0.2): a town placed too close to the sea does not appear. Exact rule unknown.
- App (v0.3): town centres keep 400 m (game) from the sea and lakes ≥ 5 ha, 100 m from rivers / ponds, 500 m from the map edge, slope < 20 % (3×3); otherwise moved to the nearest valid cell within 3 000 m, or dropped. All editable under « Emplacement des villes ».
- Next: import Cherbourg 1:3 Large; if a listed town is missing, raise « Distance mer / lacs » and record the value that works.
- Status: OPEN · Date added: 2026-10-29

## QUESTION-011 — Does the automatic generation (DECISION-012) run in the game as in the simulation?
- To see in game: the pump runs in the Map Editor and answers within 15 s; `MapPreviewComp` computes in the mod's window (does it need to be visible / docked like the editor's preview?); `getAllHeightmaps` / `getAllBiomes` entries (with or without extension); the import generator's default params; town creation then sizing; `os.time()` available for the request age check (else every request is accepted).
- Status: OPEN · Date added: 2026-10-31

## QUESTION-010 — How do the game-built roads and railway behave on an imported map?
- ANSWERED from the source (FACT-024): the connection command links every existing industry → the mod builds the industries itself after the town roads (DECISION-011). Still to see in game: index base of the town pairs (0-based assumed, `importcity_build.lua` `indexBase`), whether calling the command again links the newly built industries to their nearest town, whether `createIndustryProposal` results are constructions the rename reaches, whether `makeMapFromGame(false, true, false, false)` lists the towns in the order the command expects. Do track proposals along the real line pass on the imported relief (slopes, rivers, bridges ≤ 250 m)? Do the industry renames find their industries (≤ 300 m match)?
- 2026-10-31: in game the roads were built; every railway segment was refused (missing edge fields, FACT-027, fixed in v0.10: to check in game, with the bridges over water).
- 2026-10-31 (v0.10 in game): segments built but the line was discontinuous, too tight, through towns → designed in the app (DECISION-014). To check in game: whole line laid without cuts, bridges / tunnels accepted with the app's heights and tangents, towns and roads built around the track.
- Next: generate a map with v0.11 and read the report's rail line.
- Status: OPEN · Date added: 2026-10-31

## QUESTION-012 — Do the town shares and goods hold in game (DECISION-015)?
- To see in game: `makeTownUpdateCargoNeedsCmd` accepted after `makeTownUpdateSizeCmd` (not reset by it), the town window shows the app's goods, the commercial / industrial districts grow with the shares; beaches without trees (biome 1 still gets plain / single trees: a tree-free biome index is QUESTION-002); the rail profile laid without the tall viaduct.
- Status: OPEN · Date added: 2026-10-31

## QUESTION-013 — Why do some town roads cross rivers on a land strip (Carentan)?
- Reproduced nothing in the app: at Carentan (1:3 and the user's 1:6 map, preview and full 4 m grid) the water mask is continuous at the pont-canal (`e2e.live.ts` with `CROP=lon,lat,radius`). Hypothesis: the game builds a road on a fill across very shallow water (we had 0.5 m at the bank) → river water now ≥ 2 m at the bank; named canals no longer dropped.
- To see in game: a land strip still there? Where exactly (screenshot / coordinates)?
- Status: OPEN · Date added: 2026-10-31

## QUESTION-014 — Which format does `api.util.getLanguage()` return in Transport Fever 3?
- The mod reads `code`, `locale`, `language`, `name` or `id` of a table, or a string, and logs it once (`[importcity] game language: …`): read that line in the game's log to confirm the French window.
- Status: OPEN · Date added: 2026-10-31

## QUESTION-015 — Do the mod's roads join the towns' streets in game? (CLOSED: the mod no longer lays roads, DECISION-019)
- `B.road` relies on `octree.findEntitiesInCircle(…, BASE_NODE)` returning street nodes and on `getNodeStreetSegments`; if it returns nothing, every road stops 400 m short of the towns and the town pairs fall back to the game's routing (the report says how many). Check the report line « Routes : x / y posée(s) selon la carte » and the game log lines `road A - B: … ends joined / free`, at Lyon (Givors, Microbrasserie Caribrew).
- Status: CLOSED · Date added: 2026-10-31
