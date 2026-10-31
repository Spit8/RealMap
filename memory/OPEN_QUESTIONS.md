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

## QUESTION-010 — How do the game-built roads and railway behave on an imported map?
- Does `makeTownConnectWithIndustriesCmd` also connect every industry (the user wants 0–1 per town)? Do track proposals along the real line pass on the imported relief (slopes, rivers, bridges ≤ 250 m)? Do the industry renames find their industries (≤ 300 m match)?
- Next: import a v0.8 map in the Map Editor with the importcity mod and report.
- Status: OPEN · Date added: 2026-10-31
