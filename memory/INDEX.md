# Project Memory Index

> Purpose: a concise index of reusable knowledge for this project.
> Last reviewed: 2026-10-30

## Project identity
- Purpose: import a real-world area (relief, towns, roads…) as a Transport Fever 3 custom map.
- Main technologies: Tauri 2 + SvelteKit + Svelte 5 + TS + OpenLayers (app); TF3 Lua mod `importcity` (TFUI window "Import your Town" with « Appliquer les tailles réelles »; GUI regenerated with `cd ../TFUI && npx tsx ../HQminiMap/tools/tfui/generate.mts ../importCity/importcity/importcity.tfui.json`, generated files are read-only: clear the flag first).
- Key entry points: `importcity/mod/`, `importcity/importcity.tfui.json`; plan `C:\Users\wiwil\.claude\plans\je-voudrais-cr-er-un-curried-galaxy.md`.
- Current state: app v0.3 (towns by population settled away from the sea, Carte / Aperçu tabs with detachable preview window) on top of v0.2; checked on real data outside the game; detached window and in-game import of v0.3 NOT TESTED.
- 2026-10-30 (DECISION-006): Overpass client rewritten (rules, disk cache, VK Maps fallback), land cover from ESA WorldCover, map sizes limited to what the game offers. Unit tests + Node e2e pass; NOT TESTED inside the Tauri app.
- 2026-10-30 (DECISION-007, v0.5): town picking (list + map, two passes), real town sizes via the mod (FACT-016), continuous navigable rivers in lowered valleys, smoothing, ponds dropped (FACT-017). 58 unit tests, check, build, Node e2e (Lyon, Grenoble) pass; mod checked in a lupa mock only; NOTHING TESTED in the Tauri app or in game (QUESTION-005, QUESTION-009).
- 2026-10-30 (DECISION-008, v0.6): two phases (real data → game), sea floor (FACT-018), water profile + gentle banks, river network repair, automatic town sizes (mod pump), industries (FACT-019), error boundaries + journal (FACT-020). 71 unit tests, check, build, cargo check, Node e2e (Lyon, Grenoble, Cherbourg) and browser checks of the UI pass; mod pump checked in a lupa mock; NOT TESTED in the Tauri app or in game.
- 2026-10-30 (DECISION-009, v0.7): left panel in 3 tabs, result on the map only (preview tab / window removed), double click / sheet / right click on the map, local projection (FACT-022), river cross-section, mouths, channels, min width, marshes → lakes, additive town / industry selection, industry count from the game's density (FACT-021). 82 unit tests, check, build, cargo check, Node e2e and browser UI checks (injected result) pass; NOT TESTED in the Tauri app or in game.
- 2026-10-31 (DECISION-010, v0.8): panel without static text + log panel + phase-1 steps, Ctrl placement, symbols always visible, short town list + search, rivers 64 m / game cross-section (FACT-023), industry footprints and names, whole-metre heights, start road / rail network chosen from OSM (FACT-024, QUESTION-010; mod part in a separate session). 92 unit tests, check, build, cargo check, Node e2e Lyon and browser UI checks (injected result) pass; NOT TESTED in the Tauri app or in game.
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
