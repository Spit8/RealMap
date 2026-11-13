# Project Memory Index

> Purpose: a concise index of reusable knowledge for this project.
> Last reviewed: 2026-10-31

## Project identity
- Purpose: import a real-world area (relief, towns, roads…) as a Transport Fever 3 custom map.
- Main technologies: Tauri 2 + SvelteKit + Svelte 5 + TS + OpenLayers (app); TF3 Lua mod `importcity` (TFUI window "Import your Town" with « Appliquer les tailles réelles »; GUI regenerated with `cd ../TFUI && npx tsx ../HQminiMap/tools/tfui/generate.mts ../RealMap/importcity/importcity.tfui.json`, generated files are read-only: clear the flag first).
- Key entry points: `importcity/mod/`, `importcity/importcity.tfui.json`.
- Current state: app v0.3 (towns by population settled away from the sea, Carte / Aperçu tabs with detachable preview window) on top of v0.2; checked on real data outside the game; detached window and in-game import of v0.3 NOT TESTED.
- 2026-10-30 (DECISION-006): Overpass client rewritten (rules, disk cache, VK Maps fallback), land cover from ESA WorldCover, map sizes limited to what the game offers. Unit tests + Node e2e pass; NOT TESTED inside the Tauri app.
- 2026-10-30 (DECISION-007, v0.5): town picking (list + map, two passes), real town sizes via the mod (FACT-016), continuous navigable rivers in lowered valleys, smoothing, ponds dropped (FACT-017). 58 unit tests, check, build, Node e2e (Lyon, Grenoble) pass; mod checked in a lupa mock only; NOTHING TESTED in the Tauri app or in game (QUESTION-005, QUESTION-009).
- 2026-10-30 (DECISION-008, v0.6): two phases (real data → game), sea floor (FACT-018), water profile + gentle banks, river network repair, automatic town sizes (mod pump), industries (FACT-019), error boundaries + journal (FACT-020). 71 unit tests, check, build, cargo check, Node e2e (Lyon, Grenoble, Cherbourg) and browser checks of the UI pass; mod pump checked in a lupa mock; NOT TESTED in the Tauri app or in game.
- 2026-10-30 (DECISION-009, v0.7): left panel in 3 tabs, result on the map only (preview tab / window removed), double click / sheet / right click on the map, local projection (FACT-022), river cross-section, mouths, channels, min width, marshes → lakes, additive town / industry selection, industry count from the game's density (FACT-021). 82 unit tests, check, build, cargo check, Node e2e and browser UI checks (injected result) pass; NOT TESTED in the Tauri app or in game.
- 2026-10-31 (DECISION-010, v0.8): panel without static text + log panel + phase-1 steps, Ctrl placement, symbols always visible, short town list + search, rivers 64 m / game cross-section (FACT-023), industry footprints and names, whole-metre heights, start road / rail network chosen from OSM (FACT-024, QUESTION-010; mod part in a separate session). 92 unit tests, check, build, cargo check, Node e2e Lyon and browser UI checks (injected result) pass; NOT TESTED in the Tauri app or in game.
- 2026-10-31 (DECISION-011): the mod builds roads (game routing) before any industry, then the industries (named, only the chosen ones linked by calling the command again) and the main railway; towns_industries import = towns only. Lupa simulation passes (`importcity/tools/sim_mod.py`); NOT TESTED in game (QUESTION-010).
- 2026-10-31 (DECISION-012, v0.9): generation fully automatic in the Map Editor, launched by the app (request / status files), order heightmap > biomes > towns > industries > roads > rail, mod window without buttons, FACT-025. 95 unit tests, check, build, lupa simulation pass; mod deployed to staging_area; NOT TESTED in game (QUESTION-011).
- 2026-10-31 (DECISION-013, FACT-027, v0.10): railway segments filled like the game's track builder (+ stone bridges over water), one mod window of fixed size, displayed name « RealMap » (technical ids kept). 95 unit tests, check, build, cargo check, lupa simulation pass; mod deployed; NOT TESTED in game.
- 2026-10-31 (DECISION-014, FACT-028, v0.11): railway designed in the app (town zones, min radius, max grade, bridges, tunnels, continuous tangents) and laid right after the terrain; export reuses phase-1 data. 100 unit tests, check, build, cargo check, Node e2e Lyon, lupa simulation pass; mod deployed; NOT TESTED in game.
- 2026-10-31 (DECISION-015, FACT-029, v0.12): rail profile by cost (no tall one-way viaduct, real grade), rivers 14 m with a wider flat bed, beaches without coast trees, town districts from OSM land use and goods from the placed chains (mod sends the cargo needs), folding sections + lists panel over the map. 107 unit tests, check, build, Node e2e Lyon, lupa simulation, browser UI pass; mod deployed; NOT TESTED in the Tauri app or in game (QUESTION-012).
- 2026-10-31 (DECISION-016, FACT-030, v0.13): defaults 20 m (rivers, marshes, new coast depth), 100 capacity / 10 000 inh.; panel by steps (Options avancées, Journal tab, bottom action bars green / orange); right-click menu adds industries, town roads, railway lines along real tracks; start needs 1 + 1 primary goods; river bank ≥ 2 m, named canals kept. 110 unit tests, check, build, e2e, browser pass; NOT TESTED in the Tauri app or in game (QUESTION-012, QUESTION-013).
- 2026-10-31 (DECISION-017, FACT-031, v0.14): right-click delete road / railway, complete railways (all running lines, ends joined within 25 m), random start needs far from producers, readable bridges / tunnels, Overpass 2 at once + cache by containing area + gzip, dev port 1430, translation system fr / en (app + mod) with `tools/i18n` for lowCost_Translator. 114 unit tests, check, build, cargo check, e2e, browser pass; NOT TESTED in the Tauri app or in game (QUESTION-014).
- 2026-10-31 (DECISION-018, FACT-032, v0.15): roads in manual mode once changed by hand (« Appliquer les paramètres par défaut » with confirmation), industry roads, the mod lays the drawn roads (joined to the game's streets, game routing as fallback), orange #FD9401. 117 unit tests, check, build, sim, e2e Lyon, browser pass; NOT TESTED in the Tauri app or in game (QUESTION-015).
- 2026-10-31 (DECISION-019, v0.16): roads back to the game's routing (planned links drawn straight, manual mode kept), « Map » in orange, railway corridor on the game relief (Lyon bridge edges 30 → 13, Cotentin water bridges 14 → 7), Options › Voie ferrée layout fixed. 117 unit tests, check, build, sim, e2e, browser pass; NOT TESTED in the Tauri app or in game.
- 2026-11-01 (DECISION-020, v0.17): German, Italian, Spanish, Simplified Chinese (app + mod) through lowCost_Translator units mode, glossary « railway » fix and overrides. 119 unit tests, check, build, sim, browser pass; NOT TESTED in the Tauri app or in game.
- 2026-11-01 (DECISION-021, v1.0.0): slides 1920 × 1080, icon button (order 110), mod ready for mod.io (`_content.json`, modinfo, description, images), READMEs EN / FR, docs/DEVELOPMENT.md, LICENSE, clean .gitignore. Not yet uploaded or seen in game.
- 2026-11-01 (DECISION-024, v1.0.1): mod logs every decision (pump, requests, saves), no clock check, window pump as fallback, alive.lua heartbeat; the app resends a request found at the mod's start and names why the game does not answer.
- 2026-11-01 (DECISION-022): whole UI translated (log, step details, reasons through `Msg` + `tm`, industry names per language), Export hint names the RealMap mod, deliverables as HQminiMap (NSIS, MSI, portable zip, AppImage, deb, dmg, mod zip; CI and release workflows).
- 2026-11-01 (DECISION-023, FACT-033): automatic app updates as HQminiMap (signed latest.json, portable marker, Export › Mises à jour); Mod Manager crash fixed (description.html limited to the tags the game renders).
- 2026-11-13 (DECISION-040, FACT-038/039, v1.3.0): country-sized areas from Geofabrik extracts (Rust `osmpbf`, confirmed size, resume), Overpass within its documented rules (places on their own, modest limits, 429 pause, runtime errors split and never cached), relief at COG overview level, OSM simplified and cropped. NOT TESTED on a whole country in the app.
- Sister project: `../HQminiMap` (same stack, memory in `docs/agent-memory`).

## Read first
- `ARCHITECTURE.md` — project structure and execution flows.
- `VERIFIED_FACTS.md` — evidence-backed technical facts.
- `FAILED_APPROACHES.md` — approaches that failed and their observed outcomes.
- `DECISIONS.md` — durable decisions and rationale.
- `OPEN_QUESTIONS.md` — unresolved issues and verification plans.

## Memory rules
- Current code and reproducible tests outrank stale notes.
- Label facts as VERIFIED, OBSERVED, HYPOTHESIS, FAILED, NOT TESTED, or STALE.
- Never infer a root cause from a failed attempt alone.
- Keep entries concise and link to evidence.
