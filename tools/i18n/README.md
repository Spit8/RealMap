# Traductions de RealMap (app et mod)

Le français (`app/src/lib/i18n/fr.ts`, source des clés) et l'anglais (`en.ts`, table `en` du mod) sont
écrits à la main. L'allemand, l'italien, l'espagnol et le chinois simplifié (`de.ts`, `it.ts`, `es.ts`,
`zh.ts`, tables générées du mod ; les mêmes langues que HQminiMap) sont produits par `lowCost_Translator`
(`../lowCost_Translator`, Ollama + `translategemma:12b`) en **mode « unités »**, comme pour HQminiMap :
chaque chaîne part de l'**anglais** (le français est donné en référence), avec **le contexte de sa
section**, **son type d'élément** (bouton, titre, infobulle, phrase…) et **un glossaire tiré des
traductions officielles du jeu**. C'est ce qui évite les traductions littérales obtenues avec des
chaînes isolées, sans contexte ni glossaire (cas de TFUI).

| Fichier | Rôle |
|---|---|
| `context.json` | Écrit à la main : description de RealMap, une phrase par section (préfixe de clé : `tabs`, `data`, `advanced`, `menu`, `industry`…), type d'élément forcé pour certaines clés. **Toute nouvelle section de clés doit y avoir sa phrase** (sinon `export.mts` s'arrête). |
| `glossary_extract.py` | Brouillon de `glossary.json` à partir des catalogues du jeu (`<jeu>/base/strings/<lang>/LC_MESSAGES/base.mo`) : termes du jeu (ville, industrie, éditeur de cartes, carte de relief, biomes, économies, marchandises) et **noms officiels des industries** (`INDUSTRIES_<TYPE>_NAME`). Ne réécrit pas le glossaire relu sans `--force`. |
| `glossary.json` | **Relu à la main** : termes imposés, mots à garder tels quels (`keep`), registre et forme des boutons par langue (tutoiement comme le jeu, orthographe suisse en allemand…). |
| `overrides.json` | Corrections manuelles `{lang: {id: texte}}`, appliquées en dernier. |
| `export.mts` | `en.ts` / `fr.ts` + tables `en` / `fr` de `importcity_i18n.lua` → `units.json`. |
| `out/` | Sorties du traducteur : `<lang>.json` et `review_<lang>.csv` (à relire : colonne `flags`). |
| `import.mts` | `out/<lang>.json` → `app/src/lib/i18n/<lang>.ts` et tables générées du mod. Ajouter ensuite la langue dans `LOCALES` / `TAGS` (`app/src/lib/i18n/index.svelte.ts`). |

## Règles d'écriture des textes (fr et en)

- Une clé par texte affiché, préfixée par sa section (`menu.removeRoad`, pas `removeRoad`).
- Jamais de phrase construite par morceaux : un texte complet avec des `{params}` (app) ou des
  `%s` / `%d` (mod), dans le même ordre en fr et en.
- Les termes du jeu s'écrivent comme dans le jeu (nom des industries, marchandises, « Map Editor »).
- `app/test/i18n.test.ts` vérifie : mêmes clés fr / en, mêmes `{params}`, une section de contexte par
  clé, et côté mod mêmes clés et mêmes `%s` / `%d`.
- Le journal est traduit ; seuls ses détails techniques (`diag`) restent en français. Un message calculé dans
  le cœur ou le worker est un `Msg` (clé + paramètres, `core/msg.ts`), traduit à l'affichage par `tm`.
- Les signalements restants après relecture sont voulus : mots identiques dans la langue (« Tunnel »,
  « Format », « real »), « Fläche » / « area » pour une surface en hectares (le glossaire dit « zone »
  pour la zone de la carte). Les corrections faites à la main sont dans `overrides.json`.
- `app/test/i18n.test.ts` importe chaque langue générée : une nouvelle langue doit y être ajoutée
  (avec `LOCALES` / `TAGS`).

## Mettre à jour après un changement de textes

```bash
cd app && npx tsx ../tools/i18n/export.mts
```

```bash
cd ../lowCost_Translator && python translate_locales.py --units ../RealMap/tools/i18n/units.json --glossary ../RealMap/tools/i18n/glossary.json --overrides ../RealMap/tools/i18n/overrides.json --source en --langs de,it,es,zh --cache-dir ../RealMap/tools/i18n/.cache --output-dir ../RealMap/tools/i18n/out --back-translate
```

Relire `out/review_<lang>.csv` (lignes avec `flags`), corriger dans `overrides.json` (ou dans le
glossaire / le contexte, puis relancer : seules les chaînes concernées sont retraduites), puis :

```bash
cd app && npx tsx ../tools/i18n/import.mts de,it,es,zh && npm run check && npm test
```

Ne pas modifier à la main les fichiers `<lang>.ts` générés ni les tables générées du mod : ils sont
réécrits à chaque import.
