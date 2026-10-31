# ImportCity

Importe une zone réelle dans une carte personnalisée de **Transport Fever 3** : relief, mer et rivières, biomes, villes à leur taille réelle, industries, et les liaisons routières et ferroviaires de début de partie.

L'application de bureau prépare les fichiers que le Map Editor du jeu importe nativement. Un petit mod termine dans l'éditeur ce que l'import natif ne sait pas faire.

## Fonctionnement

1. **Zone et données** : choisis la taille de carte du jeu, l'échelle et le centre (Ctrl + clic sur la carte). L'app récupère le relief, l'occupation du sol, les fonds marins, l'eau, les lieux, les sites industriels et le réseau routier et ferré. Tout est gardé en cache.
2. **Transformation** : relief lissé, rivières continues et navigables, berges et vallées adoucies, marais en lacs. Le résultat s'affiche sur la carte et se recalcule à chaque réglage.
3. **Export** : choix des villes, des industries (selon la densité du jeu et leur présence réelle) et des liaisons. Génère ensuite :

| Fichier (dans le dossier userdata du jeu) | Utilisé par |
|---|---|
| `heightmaps/<nom>.png` (16 bits) | Map Editor → Import Heightmap |
| `biomes/<nom>_biomes.png`, `_mountains.png`, `_rivers.png` | Map Editor → Biomes |
| `towns_industries/<nom>.lua` | Map Editor → Towns / Industries → Import |
| `importcity/<nom>.lua` | mod `importcity` : tailles des villes, noms des industries, routes et rail |

## Structure

- `app/` : application Tauri 2 + SvelteKit + Svelte 5 + TypeScript + OpenLayers. Voir [app/README.md](app/README.md).
- `importcity/` : mod Transport Fever 3. Source dans `mod/` ; l'interface est générée depuis `importcity.tfui.json`.
- `memory/` : notes du projet : formats du jeu vérifiés, décisions, questions ouvertes.

## Développement

Prérequis : Node.js, Rust et les [prérequis Tauri 2](https://v2.tauri.app/start/prerequisites/).

```bash
cd app
npm install
npm run tauri dev    # lancer l'application
npm test             # tests unitaires (vitest)
npm run check        # vérification des types (svelte-check)
npm run tauri build  # paquet distribuable
```

Pour tester sur données réelles sans l'application :

```bash
npx tsx test/e2e.live.ts <dossier> <lon> <lat> <échelle> [taille] [preview|full]
```

## État

Le projet est en développement. Le pipeline est testé hors du jeu. L'import dans le jeu et la construction des routes et du rail par le mod restent à valider (voir `memory/OPEN_QUESTIONS.md`).

## Données et licences

- Relief : IGN RGE ALTI® (Licence Ouverte), Copernicus DEM GLO-30 © DLR / Airbus, ESA.
- Fonds marins : EMODnet Bathymetry, NOAA ETOPO.
- Occupation du sol : © ESA WorldCover project 2021 (CC BY 4.0).
- Eau, lieux, sites industriels, routes et voies ferrées : © contributeurs OpenStreetMap (ODbL), via l'API Overpass.

Code sous licence GPL-3.0 (`app/package.json`). Transport Fever 3 est une marque d'Urban Games ; ce projet n'y est pas affilié.
