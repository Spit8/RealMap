# Developing RealMap

Technical folder and identifier names keep the project's first name, `importcity` (mod id, userdata
folder, Tauri identifier); the repository and its folder are named `RealMap`.

## Layout

| Folder | Content |
|---|---|
| `app/` | Desktop app: Tauri 2 + SvelteKit + Svelte 5 + TypeScript + OpenLayers. `src/lib/core/` computes the map (relief, water, towns, industries, network, railway), `src/lib/workers/` runs it off the UI thread, `src/lib/i18n/` holds the UI strings. |
| `importcity/` | Transport Fever 3 mod. Source in `mod/`; the button and window styles are generated from `importcity.tfui.json` (TFUI). |
| `tools/` | Icons, mod packaging, translation pipeline (`tools/i18n/`), TFUI generator wrapper. |
| `captures/` | Screenshots and slides used by the READMEs and the mod page. |
| `memory/` | Project notes: verified game formats, decisions, open questions. |

Files the app writes in the game's data folder (`<UD>` = `<Steam>/userdata/<SteamID>/3493540/local`):

| File | Content |
|---|---|
| `heightmaps/<name>.png` (16-bit) | relief |
| `biomes/<name>_biomes.png`, `_mountains.png`, `_rivers.png` | biomes and layers |
| `towns_industries/<name>.lua` | towns |
| `importcity/<name>.lua` | import settings, town sizes and goods, named industries, road links, railway |
| `importcity/request.lua`, `status.lua` | the app's request to the mod, and its answers |

## App

Requirements: Node.js, Rust and the [Tauri 2 prerequisites](https://v2.tauri.app/start/prerequisites/).

```bash
cd app
npm install
npm run tauri dev    # run the app (dev server on port 1430)
npm test             # unit tests (vitest)
npm run check        # type checking (svelte-check)
npm run tauri build  # Windows installer (NSIS) in src-tauri/target/release/bundle/nsis/
```

Real data without the app (downloads cached in the output folder):

```bash
npx tsx test/e2e.live.ts <outDir> <lon> <lat> <scale> [size] [preview|full]
```

## Mod

- The button, the window style and the plugin registration (`content/gui/main_gui.script.lua`,
  `main_gui.css.lua`, `main_gui_button.res.lua`) are **generated**: edit `importcity/importcity.tfui.json`
  (TFUI editor, or by hand) then regenerate with the TFUI repository next to this one:

  ```bash
  cd ../TFUI && npx tsx ../RealMap/tools/tfui/check.mts ../RealMap/importcity/importcity.tfui.json
  cd ../TFUI && npx tsx ../RealMap/tools/tfui/generate.mts ../RealMap/importcity/importcity.tfui.json
  ```

  The generated files may be read-only (TFUI marks them): clear the flag first. The handlers
  (`main_gui.handlers.lua`) and the other Lua files are written by hand.
- Button icon: `powershell -File tools/make_icons.ps1` turns `captures/icon_transparent.png` into
  `content/gui/icons/realmap.tga` (40 × 40) and `realmap@2x.tga` (80 × 80). The button sits in the
  game's mod button row with `order = 110` (HQminiMap uses 100): the game lays the buttons out side
  by side in that order, they never overlap.
- Offline check of the whole generation (Python + `lupa`): `python importcity/tools/sim_mod.py`.
- `importcity/mod/_content.json` lists every file of `content/` (the game loads only those):
  `node tools/content-list.mjs` after adding or removing a file (`--check` to verify).

## Translations

German, Italian, Spanish and Simplified Chinese are produced from the English and French texts with lowCost_Translator (local Ollama + TranslateGemma) in units mode (context per section and a
glossary drawn from the game's own catalogues). See [tools/i18n/README.md](../tools/i18n/README.md).

## Releasing

After a game update: generate a map in game, then add the build (`Starting up build version` in
`<UD>/crash_dump/stdout.txt`) to `TESTED_BUILDS` in `app/src/lib/core/gamebuild.ts`; the app shows a
discreet note for any other build. Since build 40423 mods may only use the `towns_industries`,
`heightmaps` and `mod_presets` userdata folders (FACT-034): the app ↔ mod files are
`towns_industries/realmap_*.lua`.

### Update key (once)
The automatic updates (`tauri-plugin-updater`) need signed packages. The public key is in
`app/src-tauri/tauri.conf.json` (`plugins.updater.pubkey`), the private key and its password in the
repository secrets. In PowerShell:

```powershell
npx tauri signer generate -w "$env:USERPROFILE\.tauri\realmap.key"   # choose a password
Get-Content "$env:USERPROFILE\.tauri\realmap.key" -Raw | gh secret set TAURI_SIGNING_PRIVATE_KEY --repo Spit8/RealMap
gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD --repo Spit8/RealMap   # paste the password
```

Copy the content of `~/.tauri/realmap.key.pub` into `pubkey`. **Keep the private key** (backup): a
lost key means no more automatic updates for the existing installs. A local `npm run tauri build`
needs the same two variables (`TAURI_SIGNING_PRIVATE_KEY`, `…_PASSWORD`).

The apps read `releases/latest/download/latest.json` (written by the release workflow): only
**published** releases count, and only while the repository is public (a private repository answers
404: the app says "no public release found").

Deliverables (as HQminiMap): Windows NSIS installer and MSI, Windows portable zip, Linux AppImage and
.deb, macOS universal .dmg, and the mod zip.

1. Version everywhere: `node tools/bump-version.mjs <x.y.z>` (`--check` verifies), release notes in
   `docs/release-notes/v<x.y.z>.md` (first line `title: …`).
2. Commit, then push a tag `v<x.y.z>`: `.github/workflows/release.yml` builds the installers of the
   three systems, the portable zip and the mod zip into a **draft** release titled from the notes;
   publish it by hand. `.github/workflows/ci.yml` checks types, tests, the build, the mod simulation,
   the versions and `_content.json` on every push.
3. Locally (Windows only): `npm run tauri build` (NSIS + MSI in
   `app/src-tauri/target/release/bundle/`), `powershell -File tools/pack-portable.ps1 -Version <x.y.z>`
   and `node tools/pack-mod.mjs` (both into `dist/`).
4. **mod.io**, from the game's Mod Manager
   ([guide](https://mod.io/g/transportfever3/r/creating-and-updating-mods-via-the-in-game-mod-manager)):
   - copy `importcity/mod/*` into `<Steam>/userdata/<SteamID>/3493540/local/staging_area/importcity/`
     (no second copy with the same mod id in `mods/`);
   - restart the game, Mod Manager › **My Mods** › RealMap;
   - **first upload**: the dialog must say "A new mod will be created on mod.io". The game then
     writes `_metadata/mod.io_fileid.txt`: **copy it into `importcity/mod/_metadata/` and commit it**;
   - **updates**: raise `revision` in `importcity/mod/mod.json`, check that `mod.io_fileid.txt` is in the
     staging copy, and upload only if the dialog says "The existing mod on mod.io will be updated"
     (otherwise the link is lost and a duplicate mod would be created).
   - The mod page uses `_metadata/modinfo.json` (name, summary, translated summaries, tags),
     `_metadata/description.html` and the images `_metadata/0.png` (logo) to `3.png` (1920 × 1080,
     exported from `captures/Concept.pptx`).
