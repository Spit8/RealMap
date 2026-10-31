# ImportCity — app

Desktop app (Tauri 2 + SvelteKit + Svelte 5 + OpenLayers) that turns a real-world area into files
the Transport Fever 3 Map Editor imports natively:

| Output | Read by |
|---|---|
| `<UD>/heightmaps/<name>.png` — 16-bit grayscale, (tiles·64+1)² | Map Editor → Import Heightmap |
| `<UD>/towns_industries/<name>.lua` — towns from OpenStreetMap | Map Editor → Towns / Industries → Import |
| `<UD>/importcity/<name>.lua` — real min/max heights, area, sources | the user (values to type in the importer) |

`<UD>` is the TF3 userdata folder (auto-detected, editable in the app).

Sources: IGN RGE ALTI / Copernicus DEM GLO-30 (relief), ESA WorldCover 10 m (forests, scrub,
rock), OpenStreetMap via Overpass (water, towns; overpass-api.de then VK Maps). Everything is cached
in the app cache folder. See `../memory/` for the verified game formats and service rules.

## Develop

```
npm install
npm run tauri dev      # app
npm test               # unit tests
npm run check          # svelte-check
npx tsx test/e2e.live.ts <outDir>   # real download + heightmap + towns, outside Tauri
```
