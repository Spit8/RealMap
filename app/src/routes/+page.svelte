<script lang="ts">
  import { onMount } from "svelte";
  import AreaMap from "$lib/ui/AreaMap.svelte";
  import LogPanel from "$lib/ui/LogPanel.svelte";
  import { errorText, importer, type ReliefSource } from "$lib/state/importer.svelte";
  import { defaultVerticalScale, type Area } from "$lib/core/area";
  import { MAP_FORMATS, MAP_SIZES, availableFormats, availableSizes, formatKm, mapSizeLabel } from "$lib/core/mapsizes";
  import { gameTownLimit } from "$lib/core/towns";
  import { foldName, industryColor, industryTitle, shownTownKeys, townTitle } from "$lib/ui/townMarkers";
  import { defaultIndustryCount, DENSITY_LABELS, ECONOMY_LABELS } from "$lib/core/industries";
  import { COVER_LABELS } from "$lib/core/biomes";

  type PanelTab = "data" | "transform" | "export";
  const TAB_KEY = "importcity.panelTab";
  const HIDE_KEY = "importcity.hideOff";
  function stored(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }
  function store(key: string, value: string): void {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* storage unavailable */
    }
  }

  let mapRef: ReturnType<typeof AreaMap> | undefined = $state();
  let mapView = $state<"real" | "game">("game");
  let panelTab = $state<PanelTab>((stored(TAB_KEY) as PanelTab | null) ?? "data");
  let hideOff = $state(stored(HIDE_KEY) === "1");
  $effect(() => store(TAB_KEY, panelTab));
  $effect(() => store(HIDE_KEY, hideOff ? "1" : "0"));
  let autoPreview = $state(true);
  // Phase 2 is cheap once the data is there: recompute the result shortly after each change.
  $effect(() => {
    const key = importer.optionsKey;
    if (!autoPreview || !importer.preview || importer.dataStale) return;
    const t = setTimeout(() => {
      if (importer.stale && !importer.running && key === importer.optionsKey) void importer.runPreview();
    }, 700);
    return () => clearTimeout(t);
  });
  let opacity = $state(0.85);

  onMount(() => {
    // Rendering errors and forgotten promises must not fail silently: show them in the log.
    const onError = (ev: ErrorEvent) => importer.report(ev.error ?? ev.message, "Affichage");
    const onRejection = (ev: PromiseRejectionEvent) => importer.report(ev.reason, "Tâche");
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    importer.detect();
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  });

  const s = $derived(importer.settings);
  const f = $derived(importer.frame);
  const pv = $derived(importer.preview);
  const realKm2 = $derived((f.widthM * f.scale * f.heightM * f.scale) / 1e6);
  const townLimit = $derived(gameTownLimit(f));
  const placedTowns = $derived((pv?.candidates ?? []).filter((c) => c.status === "placed").length);

  // Towns: the chosen ones and the 10 most populous others; the rest is reached through « Ajouter ».
  const listedTowns = $derived.by(() => {
    const all = pv?.candidates ?? [];
    const keys = shownTownKeys(all);
    return all.filter((c) => keys.has(c.key));
  });
  let townQuery = $state("");
  let townFocus = $state(false);
  const suggestions = $derived.by(() => {
    const all = pv?.candidates ?? [];
    const listed = new Set(listedTowns.map((c) => c.key));
    const rest = all.filter((c) => c.status === "off" && !listed.has(c.key));
    const q = foldName(townQuery.trim());
    return (q ? rest.filter((c) => foldName(c.name).includes(q)) : rest).slice(0, 30);
  });
  function addTown(key: string): void {
    importer.setPick(key, true);
    townQuery = "";
    townFocus = false;
  }

  const SCALES = [1, 2, 3, 4, 5, 6, 8];

  function setArea(patch: Partial<Area>): void {
    importer.settings.area = { ...importer.settings.area, ...patch };
    importer.save();
  }

  function num(v: string, fallback: number): number {
    const n = parseFloat(v.replace(",", "."));
    return Number.isFinite(n) ? n : fallback;
  }

  function toggleLink(key: string): void {
    const picks = { ...importer.settings.linkPicks };
    if (picks[key] === false) delete picks[key];
    else picks[key] = false;
    importer.settings.linkPicks = picks;
    importer.save();
  }

  const SOURCES: { id: ReliefSource; label: string }[] = [
    { id: "auto", label: "Auto (IGN en France, sinon Copernicus)" },
    { id: "ign", label: "IGN RGE ALTI (France)" },
    { id: "copernicus", label: "Copernicus GLO-30 (monde)" },
  ];
  const TABS: { id: PanelTab; label: string }[] = [
    { id: "data", label: "1. Zone et données" },
    { id: "transform", label: "2. Transformation" },
    { id: "export", label: "3. Export" },
  ];
  const STEP_ICONS = { wait: "○", run: "◔", done: "●", skip: "–", fail: "✕" };
  const ORIGIN_SHORT = { osm: "réel", landcover: "sol", chain: "chaîne" };
  const km = (m: number) => `${(m / 1000).toLocaleString("fr-FR", { maximumFractionDigits: 1 })} km`;
  const save = () => importer.save();
</script>

<main>
  <aside>
    <header>
      <h1>ImportCity</h1>
      <nav class="tabs">
        {#each TABS as t (t.id)}
          <button class:active={panelTab === t.id} onclick={() => (panelTab = t.id)}>
            {t.label}{t.id === "transform" && importer.stale ? " •" : ""}
          </button>
        {/each}
      </nav>
      {#if importer.running}
        <progress max="1" value={importer.progress}></progress>
        <p class="step">{importer.step}</p>
      {/if}
    </header>

    <div class="body">
      {#if panelTab === "data"}
        <fieldset>
          <legend>Carte du jeu</legend>
          <div class="row">
            <label>Taille
              <select value={s.area.size} onchange={(e) => setArea({ size: +e.currentTarget.value })}>
                {#each availableSizes(importer.experimentalMaps) as i (i)}
                  <option value={i}>{MAP_SIZES[i].label}{MAP_SIZES[i].experimental ? " (expérimental)" : ""}</option>
                {/each}
              </select>
            </label>
            <label>Format
              <select value={s.area.format} onchange={(e) => setArea({ format: +e.currentTarget.value })}>
                {#each availableFormats(importer.experimentalMaps) as i (i)}
                  <option value={i}>{MAP_FORMATS[i].label}{MAP_FORMATS[i].experimental ? " (expérimental)" : ""}</option>
                {/each}
              </select>
            </label>
          </div>
          {#if s.area.format > 0}
            <label class="check"><input type="checkbox" checked={s.area.landscape} onchange={(e) => setArea({ landscape: e.currentTarget.checked })} /> Côté long est–ouest</label>
          {/if}
          <label title="1 m dans le jeu = … m réels">Échelle
            <div class="row tight">
              <select value={SCALES.includes(s.area.scale) ? s.area.scale : 0} onchange={(e) => +e.currentTarget.value && setArea({ scale: +e.currentTarget.value })}>
                {#each SCALES as k (k)}<option value={k}>1:{k}{k === 1 ? " (réelle)" : ""}</option>{/each}
                <option value={0}>Autre…</option>
              </select>
              <input type="number" min="0.25" step="0.25" value={s.area.scale} onchange={(e) => setArea({ scale: Math.max(0.25, num(e.currentTarget.value, 1)) })} />
            </div>
          </label>
          <p class="facts">{mapSizeLabel(s.area.size, s.area.format, s.area.landscape)} · {formatKm(f.widthM * f.scale)} × {formatKm(f.heightM * f.scale)} km réels · {Math.round(realKm2).toLocaleString("fr-FR")} km²</p>
        </fieldset>

        <fieldset>
          <legend>Sources</legend>
          <label>Relief
            <select bind:value={importer.settings.source} onchange={save}>
              {#each SOURCES as so (so.id)}<option value={so.id}>{so.label}</option>{/each}
            </select>
          </label>
          <label class="check" title="Forêts, cultures, roches et marais d'après ESA WorldCover"><input type="checkbox" bind:checked={importer.settings.useCover} onchange={save} /> Occupation du sol (WorldCover)</label>
          <button class="secondary wide" disabled={!!importer.running} onclick={() => importer.fetchData()}>
            {importer.running === "data" ? `Récupération… ${Math.round(importer.progress * 100)} %` : importer.dataSummary && !importer.dataStale ? "Données à jour" : "Récupérer les données"}
          </button>
          {#if importer.dataSteps.length}
            <ul class="steps" class:stale={importer.dataStale}>
              {#each importer.dataSteps as st (st.id)}
                <li class={st.state}><span class="ico">{STEP_ICONS[st.state]}</span>{st.label}{#if st.detail}<span class="detail"> · {st.detail}</span>{/if}</li>
              {/each}
            </ul>
          {/if}
        </fieldset>
      {:else if panelTab === "transform"}
        <div class="row tight update">
          <label class="check"><input type="checkbox" bind:checked={autoPreview} /> Recalcul auto</label>
          <button class="secondary" disabled={!!importer.running} onclick={() => importer.runPreview()}>
            {importer.running === "preview" ? `Calcul… ${Math.round(importer.progress * 100)} %` : "Mettre à jour"}
          </button>
        </div>

        <fieldset>
          <legend>Relief</legend>
          <div class="row">
            <label title="Hauteurs du jeu = hauteurs réelles × ce facteur (vide = 1/√échelle)">Échelle verticale
              <input type="number" step="0.05" min="0.05" placeholder={defaultVerticalScale(f.scale).toFixed(2)}
                value={s.area.verticalScale ?? ""}
                onchange={(e) => setArea({ verticalScale: e.currentTarget.value === "" ? null : Math.max(0.05, num(e.currentTarget.value, 1)) })} />
            </label>
            <label title="Altitude réelle qui devient le niveau de l'eau du jeu (vide = auto)">Niveau de l'eau (m)
              <input type="number" step="1" placeholder="auto"
                value={s.terrain.refHeight ?? ""}
                onchange={(e) => { importer.settings.terrain.refHeight = e.currentTarget.value === "" ? null : num(e.currentTarget.value, 0); save(); }} />
            </label>
          </div>
          <div class="row">
            <label title="Efface les bosses (arbres, bruit) ; 0 = relief brut">Lissage (m) <input type="number" step="4" min="0" bind:value={importer.settings.terrain.smoothM} onchange={save} /></label>
            <label title="Mètres retirés aux forêts mesurées par Copernicus (dessus des arbres)">Aplanir forêts (m) <input type="number" step="1" min="0" bind:value={importer.settings.terrain.canopyM} onchange={save} /></label>
          </div>
        </fieldset>

        <fieldset>
          <legend>Eau</legend>
          <div class="row">
            <label title="Partout, sources et raccords compris (rivières du jeu : 110–165 m)">Largeur min. rivières (m) <input type="number" step="8" min="0" bind:value={importer.settings.terrain.riverMinWidth} onchange={save} /></label>
            <label title="Profondeur du lit (rivières du jeu : ~8,5 m)">Profondeur rivières (m) <input type="number" min="1" bind:value={importer.settings.terrain.riverDepth} onchange={save} /></label>
          </div>
          <div class="row">
            <label title="Une rivière à moins de cette distance d'une autre eau y est reliée par un chenal">Raccord eaux proches (m) <input type="number" step="8" min="0" bind:value={importer.settings.terrain.waterJoinM} onchange={save} /></label>
            <label title="Plans d'eau plus petits comblés, sauf sur une rivière">Étangs min. (ha) <input type="number" step="0.5" min="0" bind:value={importer.settings.terrain.minLakeHa} onchange={save} /></label>
          </div>
          <label class="check"><input type="checkbox" bind:checked={importer.settings.terrain.wetlandLakes} onchange={save} /> Marais → lacs</label>
          {#if s.terrain.wetlandLakes}
            <div class="row">
              <label>Surface min. (ha) <input type="number" step="1" min="0" bind:value={importer.settings.terrain.wetlandMinHa} onchange={save} /></label>
              <label>Profondeur (m) <input type="number" step="1" min="1" bind:value={importer.settings.terrain.marshDepth} onchange={save} /></label>
            </div>
          {/if}
          <details>
            <summary>Réseau, berges et profondeurs</summary>
            <label class="check" title="Chaque rivière finit dans l'eau ou au bord de la carte"><input type="checkbox" bind:checked={importer.settings.terrain.repairRivers} onchange={save} /> Réparer le réseau</label>
            <div class="row">
              <label title="Extrémités reliées en ligne droite à l'eau proche">Raccord extrémités (m) <input type="number" step="25" min="0" bind:value={importer.settings.terrain.riverJoinM} onchange={save} /></label>
              <label title="Les sources s'élargissent sur cette longueur">Biseau sources (m) <input type="number" step="100" min="0" bind:value={importer.settings.terrain.sourceTaperM} onchange={save} /></label>
            </div>
            <div class="row">
              <label title="Pente de la vallée creusée autour d'une rivière haute">Pente vallées <input type="number" step="0.02" min="0.02" bind:value={importer.settings.terrain.valleySlope} onchange={save} /></label>
              <label>Pente berges rivières <input type="number" step="0.05" min="0.02" bind:value={importer.settings.terrain.riverBankSlope} onchange={save} /></label>
            </div>
            <div class="row">
              <label>Pente berges mer, lacs <input type="number" step="0.05" min="0.05" bind:value={importer.settings.terrain.bankSlope} onchange={save} /></label>
              <label>Largeur berges (m) <input type="number" step="50" min="0" bind:value={importer.settings.terrain.bankWidthM} onchange={save} /></label>
            </div>
            <div class="row">
              <label>Profondeur lacs (m) <input type="number" min="1" bind:value={importer.settings.terrain.lakeDepth} onchange={save} /></label>
              <label title="Mètres de profondeur gagnés par mètre depuis le rivage">Approfondissement <input type="number" step="0.05" min="0.05" bind:value={importer.settings.terrain.underwaterSlope} onchange={save} /></label>
            </div>
            <div class="row">
              <label>Mer sans données (m) <input type="number" min="1" bind:value={importer.settings.terrain.seaDepth} onchange={save} /></label>
              <label>Mer max. (m) <input type="number" min="1" bind:value={importer.settings.terrain.seaMaxDepth} onchange={save} /></label>
            </div>
            <label title="Un lac sans rivière plus haut que ça au-dessus du niveau de l'eau reste en terre">Creusement max. lacs (m) <input type="number" min="0" bind:value={importer.settings.terrain.maxCarve} onchange={save} /></label>
            <button class="small" disabled={!!importer.running} onclick={() => importer.writeRiverTest()}>Carte de test des rivières</button>
          </details>
        </fieldset>

        <fieldset>
          <legend>Biomes</legend>
          <details>
            <summary>Correspondance avec les biomes du jeu</summary>
            {#each COVER_LABELS as label, i (label)}
              <label class="inline">{label}
                <select value={s.biomes.cover[i]} onchange={(e) => { importer.settings.biomes.cover[i] = +e.currentTarget.value; save(); }}>
                  {#each [0, 1, 2, 3, 4] as b (b)}<option value={b}>Biome {b}</option>{/each}
                </select>
              </label>
            {/each}
            <button class="small" disabled={!!importer.running} onclick={() => importer.writeBiomeTest()}>Carte de test des biomes</button>
          </details>
        </fieldset>

        <fieldset>
          <legend>Villes</legend>
          <div class="row">
            <label title="Capacité en jeu d'une ville de 10 000 habitants (partie normale : 240–820)">Taille 10 000 hab. <input type="number" step="25" min="10" bind:value={importer.settings.towns.refCapacity} onchange={save} /></label>
            <label title="1 = proportionnel à la population, 0 = toutes pareilles">Contraste tailles <input type="number" step="0.05" min="0" max="1" bind:value={importer.settings.towns.sizeExponent} onchange={save} /></label>
          </div>
          <label>Écart min. entre villes (m) <input type="number" step="100" min="0" bind:value={importer.settings.towns.minSpacingM} onchange={save} /></label>
          <details>
            <summary>Emplacement</summary>
            <div class="row">
              <label>Distance mer / lacs (m) <input type="number" step="50" min="0" bind:value={importer.settings.towns.waterClearanceM} onchange={save} /></label>
              <label>Distance rivières (m) <input type="number" step="25" min="0" bind:value={importer.settings.towns.riverClearanceM} onchange={save} /></label>
            </div>
            <div class="row">
              <label>Marge au bord (m) <input type="number" step="100" min="0" bind:value={importer.settings.towns.edgeMarginM} onchange={save} /></label>
              <label>Déplacement max. (m) <input type="number" step="500" min="0" bind:value={importer.settings.towns.maxShiftM} onchange={save} /></label>
            </div>
          </details>
        </fieldset>

        <fieldset>
          <legend>Industries</legend>
          <div class="row">
            <label>Écart entre industries (m) <input type="number" step="100" min="0" bind:value={importer.settings.industries.minSpacingM} onchange={save} /></label>
            <label>Distance aux villes (m) <input type="number" step="100" min="0" bind:value={importer.settings.industries.townClearanceM} onchange={save} /></label>
          </div>
          <div class="row">
            <label>Marge au bord (m) <input type="number" step="100" min="0" bind:value={importer.settings.industries.edgeMarginM} onchange={save} /></label>
            <label>Déplacement max. (m) <input type="number" step="500" min="0" bind:value={importer.settings.industries.maxShiftM} onchange={save} /></label>
          </div>
        </fieldset>
      {:else}
        <fieldset>
          <legend>Villes {pv ? `· ${placedTowns} placées` : ""}</legend>
          <div class="row">
            <label>Population min. <input type="number" step="500" min="0" bind:value={importer.settings.places.minPopulation} onchange={save} /></label>
            <label title={`Le jeu met jusqu'à ~${townLimit} villes sur une carte de cette taille (indicatif)`}>Nombre auto <input type="number" step="1" min="0" bind:value={importer.settings.towns.maxTowns} onchange={save} /></label>
          </div>
          <label class="check"><input type="checkbox" bind:checked={importer.settings.places.includeUnknown} onchange={save} /> Population inconnue estimée</label>
          {#if placedTowns > townLimit}<p class="warn">Plus que les ~{townLimit} villes du jeu pour cette taille.</p>{/if}
          <svelte:boundary onerror={(e) => importer.report(e, "Liste des villes")}>
            {#if pv}
              <div class="add">
                <input type="search" placeholder="Ajouter une ville…" bind:value={townQuery}
                  onfocus={() => (townFocus = true)}
                  onblur={() => setTimeout(() => (townFocus = false), 150)}
                  onkeydown={(e) => { if (e.key === "Enter" && suggestions[0]) addTown(suggestions[0].key); }} />
                {#if townFocus && suggestions.length}
                  <ul class="suggest">
                    {#each suggestions as c (c.key)}
                      <li><button onmousedown={() => addTown(c.key)}>{c.name} <span class="pop">{c.estimated ? "≈ " : ""}{c.rank.toLocaleString("fr-FR")}</span></button></li>
                    {/each}
                  </ul>
                {/if}
                <button class="small" disabled={!!importer.running} onclick={() => importer.resetPicks("auto")} title="Rendre toutes les villes au choix par population">Tout auto</button>
                <button class="small" disabled={!!importer.running} onclick={() => importer.resetPicks("none")}>Aucune</button>
              </div>
              <ul class="towns">
                {#each listedTowns as c (c.key)}
                  <li class={c.status} title={townTitle(c)}>
                    <input type="checkbox" checked={c.status !== "off"} disabled={!!importer.running} onchange={() => importer.toggleTown(c.key)} />
                    <span class="name">{c.name}</span>
                    <span class="pop">{c.estimated ? "≈ " : ""}{c.rank.toLocaleString("fr-FR")}</span>
                    <span class="state">
                      {c.status === "placed" ? c.capacity : c.status === "off" ? "" : "non placée"}
                      {#if c.pick !== null}<button class="link" title="Rendre au choix automatique" onclick={() => importer.setPick(c.key, null)}>auto</button>{/if}
                    </span>
                  </li>
                {/each}
              </ul>
            {/if}
            {#snippet failed(error, reset)}
              <p class="error">Liste des villes : {errorText(error)} <button class="link" onclick={reset}>réessayer</button></p>
            {/snippet}
          </svelte:boundary>
        </fieldset>

        <fieldset>
          <legend>Industries {pv ? `· ${(pv.industries ?? []).length} placées` : ""}</legend>
          <div class="row">
            <label title="Même économie que le climat de la carte dans l'éditeur">Économie
              <select bind:value={importer.settings.industries.economy} onchange={save}>
                {#each Object.entries(ECONOMY_LABELS) as [id, label] (id)}<option value={id}>{label}</option>{/each}
              </select>
            </label>
            <label>Densité du jeu
              <select bind:value={importer.settings.industries.density} onchange={save}>
                {#each DENSITY_LABELS as label, i (label)}<option value={i}>{label}</option>{/each}
              </select>
            </label>
          </div>
          <label title={`0 = nombre du jeu pour cette densité (${defaultIndustryCount(f, s.industries.density)})`}>Nombre (0 = jeu : {defaultIndustryCount(f, s.industries.density)}) <input type="number" step="1" min="0" bind:value={importer.settings.industries.maxIndustries} onchange={save} /></label>
          <svelte:boundary onerror={(e) => importer.report(e, "Liste des industries")}>
            {#if pv}
              {@const inds = pv.industryCandidates ?? []}
              <div class="row tight towns-head">
                <span></span>
                <button class="small" disabled={!!importer.running} onclick={() => importer.resetIndustryPicks()}>Tout auto</button>
              </div>
              <ul class="towns">
                {#each inds as c (c.key)}
                  <li class={c.status} title={industryTitle(c)}>
                    <input type="checkbox" checked={c.status !== "off"} disabled={!!importer.running} onchange={() => importer.toggleIndustry(c.key)} />
                    <i class="sq" style:background={industryColor(c.tag)}></i>
                    <span class="name">{c.name}{#if c.missing}<span class="warn"> · il manque : {c.missing.join(", ")}</span>{/if}</span>
                    <span class="pop" title="Présence réelle (sites OSM, occupation du sol)">{ORIGIN_SHORT[c.origin]} {c.relevance ? c.relevance.toLocaleString("fr-FR") : ""}</span>
                    <span class="state">
                      {c.status === "placed" || c.status === "off" ? "" : "non placée"}
                      {#if c.pick !== null}<button class="link" title="Rendre au choix automatique" onclick={() => importer.setIndustryPick(c.key, null)}>auto</button>{/if}
                    </span>
                  </li>
                {/each}
              </ul>
            {/if}
            {#snippet failed(error, reset)}
              <p class="error">Liste des industries : {errorText(error)} <button class="link" onclick={reset}>réessayer</button></p>
            {/snippet}
          </svelte:boundary>
        </fieldset>

        {#if pv}
          {@const net = pv.network}
          <fieldset>
            <legend>Routes et rail</legend>
            <ul class="towns">
              {#each net.links as l (l.key)}
                <li class={s.linkPicks[l.key] === false ? "off" : "placed"} title={l.real ? "Le long des routes réelles" : "Pas de route réelle : ligne directe"}>
                  <input type="checkbox" checked={s.linkPicks[l.key] !== false} disabled={!!importer.running} onchange={() => toggleLink(l.key)} />
                  <span class="name">{l.a} – {l.b}</span>
                  <span class="pop">{l.kind === "industry" ? "industrie" : "ville"} · {km(l.lengthM)}</span>
                </li>
              {/each}
              {#each net.rail as r (r.key)}
                <li class={s.linkPicks[r.key] === false ? "off" : "rail"}>
                  <input type="checkbox" checked={s.linkPicks[r.key] !== false} disabled={!!importer.running} onchange={() => toggleLink(r.key)} />
                  <span class="name">Voie ferrée principale</span>
                  <span class="pop">{km(r.pts.length * 250)}</span>
                </li>
              {/each}
            </ul>
          </fieldset>
        {/if}

        <fieldset>
          <legend>Jeu</legend>
          <label>Nom de la carte <input bind:value={importer.settings.name} onchange={save} /></label>
          <label>Dossier userdata de TF3
            <input bind:value={importer.settings.userdata} onchange={() => { save(); importer.readGameSettings(); }} placeholder="…\3493540\local" />
          </label>
        </fieldset>

        <div class="actions">
          <button class="go" disabled={!!importer.running} onclick={() => importer.run()}>
            {importer.running === "full" ? `Génération… ${Math.round(importer.progress * 100)} %` : "Générer la carte"}
          </button>
        </div>

        {#if importer.result}
          {@const r = importer.result}
          <div class="result">
            <h2>Dans le Map Editor</h2>
            <ol>
              <li>Nouvelle carte <b>{r.sizeLabel}</b>.</li>
              <li>Import Heightmap → <b>{r.name}</b> : Minimum <b>{r.stats.minM}</b>, Maximum <b>{r.stats.maxM}</b>, Water Level <b>0</b>.</li>
              <li>Biomes → <b>{r.name}_biomes</b>.</li>
              <li>Towns / Industries → Import → <b>{r.name}</b>.</li>
              <li>Mod <b>importcity</b> : tailles, noms, routes et rail.</li>
            </ol>
          </div>
        {/if}
      {/if}
      <p class="credits">IGN RGE ALTI® · Copernicus DEM © DLR / Airbus, ESA · © ESA WorldCover 2021 (CC BY 4.0) · © contributeurs OpenStreetMap (ODbL)</p>
    </div>

    <LogPanel />
  </aside>

  <section class="map-pane">
    <svelte:boundary onerror={(e) => importer.report(e, "Carte")}>
      <AreaMap
        bind:this={mapRef}
        frame={f}
        preview={pv}
        real={importer.realLayer}
        view={mapView}
        {opacity}
        {hideOff}
        linkPicks={s.linkPicks}
        onPick={(lon, lat) => setArea({ lon, lat })}
        onToggleTown={(k) => importer.toggleTown(k)}
        onToggleIndustry={(k) => importer.toggleIndustry(k)}
      />
      {#snippet failed(error, reset)}
        <div class="crashed"><p>La carte a planté : {errorText(error)}</p><button onclick={reset}>Réessayer</button></div>
      {/snippet}
    </svelte:boundary>
    <div class="map-tools">
      <button onclick={() => mapRef?.fit()}>Recadrer</button>
      <span class="seg">
        <button class:active={mapView === "real"} disabled={!importer.realLayer} onclick={() => (mapView = "real")}>Données réelles</button>
        <button class:active={mapView === "game"} onclick={() => (mapView = "game")}>Résultat jeu</button>
      </span>
      {#if pv && mapView === "game"}
        <label class="inline">Opacité <input type="range" min="0" max="1" step="0.05" bind:value={opacity} /></label>
        <label class="check"><input type="checkbox" bind:checked={hideOff} /> Masquer les lieux non retenus</label>
      {/if}
    </div>
  </section>
</main>

<style>
  :global(html, body) {
    margin: 0;
    height: 100%;
    font-family: system-ui, sans-serif;
    font-size: 14px;
    color: #1d2329;
    background: #f4f5f7;
  }
  main {
    display: grid;
    grid-template-columns: 420px 1fr;
    height: 100vh;
  }
  aside {
    display: flex;
    flex-direction: column;
    min-height: 0;
    border-right: 1px solid #d5d9de;
    background: #fff;
  }
  header {
    padding: 10px 14px 0;
    border-bottom: 1px solid #d5d9de;
  }
  header progress {
    margin-top: 6px;
  }
  .step {
    margin: 2px 0 6px;
    font-size: 12px;
    color: #5b6670;
  }
  .body {
    flex: 1;
    overflow-y: auto;
    padding: 8px 14px 12px;
  }
  .tabs {
    display: flex;
    gap: 2px;
    margin-top: 6px;
  }
  .tabs button {
    flex: 1;
    padding: 6px 4px;
    border: 1px solid transparent;
    border-bottom: none;
    border-radius: 6px 6px 0 0;
    background: #e9ecef;
    cursor: pointer;
    font: inherit;
    font-size: 12px;
    color: #3d4851;
  }
  .tabs button.active {
    background: #fff;
    border-color: #d5d9de;
    color: #e4572e;
    font-weight: 600;
  }
  .map-pane {
    position: relative;
    min-width: 0;
  }
  .crashed {
    display: grid;
    place-content: center;
    justify-items: center;
    height: 100%;
    color: #5b6670;
  }
  .map-tools {
    position: absolute;
    top: 10px;
    right: 10px;
    display: flex;
    gap: 8px;
    align-items: center;
    background: rgba(255, 255, 255, 0.9);
    padding: 4px 8px;
    border-radius: 6px;
  }
  h1 {
    margin: 0;
    font-size: 20px;
  }
  h2 {
    font-size: 14px;
    margin: 0 0 6px;
  }
  fieldset {
    border: 1px solid #d5d9de;
    border-radius: 6px;
    margin: 10px 0;
    padding: 8px 10px;
  }
  legend {
    font-weight: 600;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin: 4px 0;
  }
  label[title] {
    cursor: help;
  }
  label.check,
  label.inline {
    flex-direction: row;
    align-items: center;
    gap: 6px;
  }
  label.inline {
    justify-content: space-between;
  }
  .row {
    display: flex;
    gap: 10px;
  }
  .row > label {
    flex: 1;
  }
  .row.tight {
    gap: 6px;
  }
  .row.tight > * {
    flex: 1;
  }
  .update {
    align-items: center;
  }
  input:not([type="checkbox"]):not([type="range"]),
  select {
    padding: 4px 6px;
    border: 1px solid #c3c9d0;
    border-radius: 4px;
    min-width: 0;
    font: inherit;
  }
  details {
    margin-top: 6px;
  }
  summary {
    cursor: pointer;
    color: #3d4851;
  }
  .facts {
    color: #5b6670;
    font-size: 12px;
    margin: 2px 0;
  }
  .warn {
    color: #9a5b00;
    font-size: 12px;
    margin: 2px 0;
  }
  .steps {
    list-style: none;
    margin: 6px 0 0;
    padding: 0;
    font-size: 12px;
  }
  .steps.stale {
    opacity: 0.55;
  }
  .steps .ico {
    display: inline-block;
    width: 16px;
  }
  .steps .detail {
    color: #6b747c;
  }
  .steps .run {
    color: #e4572e;
  }
  .steps .done .ico {
    color: #2e9d4a;
  }
  .steps .fail {
    color: #b00020;
  }
  .steps .wait,
  .steps .skip {
    color: #8a949d;
  }
  .actions {
    display: flex;
    gap: 8px;
  }
  .actions button {
    flex: 1;
    padding: 10px;
    font-size: 15px;
    font-weight: 600;
    border-radius: 6px;
    cursor: pointer;
  }
  .go {
    background: #e4572e;
    color: #fff;
    border: none;
  }
  .secondary {
    background: #fff;
    color: #e4572e;
    border: 2px solid #e4572e;
    border-radius: 6px;
    padding: 6px 10px;
    font-weight: 600;
    cursor: pointer;
  }
  button:disabled {
    opacity: 0.6;
    cursor: default;
  }
  button.small {
    margin-top: 6px;
  }
  progress {
    width: 100%;
  }
  .error {
    color: #b00020;
  }
  .result {
    margin-top: 10px;
    padding: 8px 10px;
    border-radius: 6px;
    background: #eef7ee;
    border: 1px solid #b8dcb8;
  }
  .result ol {
    padding-left: 18px;
    margin: 0;
  }
  .credits {
    font-size: 10px;
    color: #8a949d;
  }
  .add {
    position: relative;
    display: flex;
    gap: 6px;
    align-items: center;
    margin-top: 6px;
  }
  .add input {
    flex: 1;
  }
  .add button.small {
    margin-top: 0;
    flex: none;
  }
  .suggest {
    position: absolute;
    top: 100%;
    left: 0;
    right: 0;
    z-index: 5;
    max-height: 220px;
    overflow-y: auto;
    margin: 2px 0 0;
    padding: 0;
    list-style: none;
    background: #fff;
    border: 1px solid #c3c9d0;
    border-radius: 4px;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
    font-size: 12px;
  }
  .suggest button {
    width: 100%;
    display: flex;
    justify-content: space-between;
    border: none;
    background: none;
    padding: 4px 8px;
    cursor: pointer;
    font: inherit;
    text-align: left;
  }
  .suggest button:hover {
    background: #f1f5fb;
  }
  .towns-head {
    margin-top: 8px;
    align-items: center;
  }
  .towns-head button.small {
    margin-top: 0;
    flex: none;
  }
  .towns {
    list-style: none;
    margin: 4px 0 0;
    padding: 0;
    max-height: 300px;
    overflow-y: auto;
    border: 1px solid #d5d9de;
    border-radius: 4px;
    font-size: 12px;
  }
  .towns li {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 2px 6px;
    border-left: 4px solid #e8912d;
  }
  .towns li.placed {
    border-left-color: #2e9d4a;
  }
  .towns li.rail {
    border-left-color: #1d2329;
  }
  .towns li.dropped,
  .towns li.limit {
    border-left-color: #8c949c;
    color: #6b747c;
  }
  .towns li.off {
    color: #6b747c;
  }
  .towns .name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .towns .pop,
  .towns .state,
  .suggest .pop {
    color: #6b747c;
    font-variant-numeric: tabular-nums;
  }
  button.wide {
    width: 100%;
    margin-top: 6px;
  }
  .seg {
    display: inline-flex;
    margin-left: 6px;
  }
  .seg button {
    border-radius: 0;
  }
  .seg button:first-child {
    border-radius: 6px 0 0 6px;
  }
  .seg button:last-child {
    border-radius: 0 6px 6px 0;
    margin-left: -1px;
  }
  .seg button.active {
    background: #e4572e;
    color: #fff;
    border-color: #e4572e;
  }
  .towns i.sq {
    display: inline-block;
    width: 8px;
    height: 8px;
    transform: rotate(45deg);
    flex: none;
  }
  button.link {
    border: none;
    background: none;
    padding: 0 2px;
    color: #2a6fdb;
    cursor: pointer;
    font-size: 11px;
    text-decoration: underline;
  }
</style>
