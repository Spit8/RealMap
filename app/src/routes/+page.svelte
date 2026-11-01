<script lang="ts">
  import { onMount } from "svelte";
  import AreaMap from "$lib/ui/AreaMap.svelte";
  import LogPanel from "$lib/ui/LogPanel.svelte";
  import ListsPanel from "$lib/ui/ListsPanel.svelte";
  import Section from "$lib/ui/Section.svelte";
  import ResetRoads from "$lib/ui/ResetRoads.svelte";
  import UpdatesPanel from "$lib/ui/UpdatesPanel.svelte";
  import { updates } from "$lib/state/updates.svelte";
  import { errorText, importer, type ReliefSource } from "$lib/state/importer.svelte";
  import { defaultVerticalScale, TILE_M, type Area } from "$lib/core/area";
  import { MAP_FORMATS, MAP_SIZES, availableFormats, availableSizes, mapTiles } from "$lib/core/mapsizes";
  import { gameTownLimit } from "$lib/core/towns";
  import { defaultIndustryCount, ECONOMIES, ECONOMY_LABELS, INDUSTRIES } from "$lib/core/industries";
  import { fmtNum, i18n, LOCALES, t, tk, type Locale, type MessageKey } from "$lib/i18n/index.svelte";

  type PanelTab = "data" | "advanced" | "export" | "log";
  const TAB_KEY = "importcity.panelTab";
  const HIDE_KEY = "importcity.hideOff";
  const LISTS_KEY = "importcity.listsOpen";
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

  const TABS: { id: PanelTab; label: MessageKey }[] = [
    { id: "data", label: "tabs.data" },
    { id: "advanced", label: "tabs.advanced" },
    { id: "export", label: "tabs.export" },
    { id: "log", label: "tabs.log" },
  ];
  const DENSITIES = [0, 1, 2, 3, 4];
  let mapRef: ReturnType<typeof AreaMap> | undefined = $state();
  let mapView = $state<"real" | "game">("game");
  const savedTab = stored(TAB_KEY);
  let panelTab = $state<PanelTab>(TABS.some((x) => x.id === savedTab) ? (savedTab as PanelTab) : "data");
  let hideOff = $state(stored(HIDE_KEY) === "1");
  let listsOpen = $state(stored(LISTS_KEY) === "1");
  $effect(() => store(LISTS_KEY, listsOpen ? "1" : "0"));
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
    const onError = (ev: ErrorEvent) => importer.report(ev.error ?? ev.message, "UI");
    const onRejection = (ev: PromiseRejectionEvent) => importer.report(ev.reason, "Task");
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    importer.detect();
    const stopUpdates = updates.start();
    return () => {
      stopUpdates();
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  });

  /** Header badge: the Export tab with the updates section open. */
  function showUpdates(): void {
    try {
      localStorage.setItem("importcity.section.export.updates", "1");
    } catch {
      /* storage unavailable */
    }
    panelTab = "export";
  }

  const s = $derived(importer.settings);
  const f = $derived(importer.frame);
  const pv = $derived(importer.preview);
  const realKm2 = $derived((f.widthM * f.scale * f.heightM * f.scale) / 1e6);
  const townLimit = $derived(gameTownLimit(f));
  const placedTowns = $derived((pv?.candidates ?? []).filter((c) => c.status === "placed").length);
  const errors = $derived(importer.events.filter((e) => e.level === "error").length);
  // Each step's button: green when done and up to date, orange when something is left to apply.
  const dataOk = $derived(!!importer.dataSummary && !importer.dataStale);
  const resultOk = $derived(!!pv && !importer.stale && !importer.dataStale);
  /** Industry types of the chosen economy, for « Ajouter une industrie » on the map. */
  const industryTypes = $derived(
    Object.entries(INDUSTRIES)
      .filter(([tag]) => !ECONOMIES[s.industries.economy].exclude.includes(tag))
      .map(([tag]) => ({ tag, label: tk(`industry.${tag}`) }))
      .sort((a, b) => a.label.localeCompare(b.label, i18n.tag)),
  );
  const townName = (key: string) => pv?.towns.find((x) => x.key === key)?.name;
  const km = (m: number) => fmtNum(m / 1000, 1);
  /** « Large (1 : 1) — 14.3 × 14.3 km » in the current language. */
  const sizeText = (size: number, format: number, landscape: boolean) => {
    const w = mapTiles(size, format, landscape);
    return t("size.label", { size: tk(`size.${MAP_SIZES[size].id}`), format: MAP_FORMATS[format].label, w: km(w.tilesX * TILE_M), h: km(w.tilesY * TILE_M) });
  };

  const SCALES = [1, 2, 3, 4, 5, 6, 8];

  function setArea(patch: Partial<Area>): void {
    importer.settings.area = { ...importer.settings.area, ...patch };
    importer.save();
  }

  function num(v: string, fallback: number): number {
    const n = parseFloat(v.replace(",", "."));
    return Number.isFinite(n) ? n : fallback;
  }

  const SOURCES: ReliefSource[] = ["auto", "ign", "copernicus"];
  const STEP_ICONS = { wait: "○", run: "◔", done: "●", skip: "–", fail: "✕" };
  const save = () => importer.save();
  const pct = () => `${Math.round(importer.progress * 100)} %`;
  /** A step's label in the current language (its French label when there is no key for it). */
  const stepLabel = (kind: "data" | "export" | "game", st: { id: string; label: string }) => {
    const key = `step.${kind}.${st.id}`;
    const l = tk(key);
    return l === key ? st.label : l;
  };
</script>

{#snippet progress()}
  {#if importer.running}
    <progress max="1" value={importer.progress}></progress>
    <p class="step">{importer.step}</p>
  {:else if importer.error}
    <p class="error">{importer.error} <button class="link" onclick={() => (panelTab = "log")}>{t("status.seeLog")}</button></p>
  {/if}
{/snippet}

<main>
  <aside>
    <header>
      <div class="title">
        <h1>Real<span class="accent">Map</span></h1>
        {#if updates.badge}
          <button class="update-badge" title={t("updates.title")} onclick={showUpdates}>⬆ {t("updates.badge", { version: updates.available!.version })}</button>
        {/if}
        <label class="lang" title={t("app.language")}>
          <select value={i18n.locale} onchange={(e) => i18n.set(e.currentTarget.value as Locale)}>
            {#each Object.entries(LOCALES) as [id, dict] (id)}<option value={id}>{dict["lang.name"]}</option>{/each}
          </select>
        </label>
      </div>
      <nav class="tabs">
        {#each TABS as tab (tab.id)}
          <button class:active={panelTab === tab.id} class:log={tab.id === "log"} onclick={() => (panelTab = tab.id)}>
            {t(tab.label)}{tab.id === "advanced" && importer.stale ? " •" : ""}{#if tab.id === "log" && errors}<span class="badge" title={t("tabs.errors", { n: errors })}>{errors}</span>{/if}
          </button>
        {/each}
      </nav>
    </header>

    {#if panelTab === "log"}
      <LogPanel />
    {:else}
    <div class="body">
      {#if panelTab === "data"}
        <Section id="data.map" title={t("data.map")} open>
          <div class="row">
            <label>{t("data.size")}
              <select value={s.area.size} onchange={(e) => setArea({ size: +e.currentTarget.value })}>
                {#each availableSizes(importer.experimentalMaps) as i (i)}
                  <option value={i}>{tk(`size.${MAP_SIZES[i].id}`)}{MAP_SIZES[i].experimental ? ` ${t("data.experimental")}` : ""}</option>
                {/each}
              </select>
            </label>
            <label>{t("data.format")}
              <select value={s.area.format} onchange={(e) => setArea({ format: +e.currentTarget.value })}>
                {#each availableFormats(importer.experimentalMaps) as i (i)}
                  <option value={i}>{MAP_FORMATS[i].label}{MAP_FORMATS[i].experimental ? ` ${t("data.experimental")}` : ""}</option>
                {/each}
              </select>
            </label>
          </div>
          {#if s.area.format > 0}
            <label class="check"><input type="checkbox" checked={s.area.landscape} onchange={(e) => setArea({ landscape: e.currentTarget.checked })} /> {t("data.landscape")}</label>
          {/if}
          <label title={t("data.scaleTitle")}>{t("data.scale")}
            <div class="row tight">
              <select value={SCALES.includes(s.area.scale) ? s.area.scale : 0} onchange={(e) => +e.currentTarget.value && setArea({ scale: +e.currentTarget.value })}>
                {#each SCALES as k (k)}<option value={k}>1:{k}{k === 1 ? ` ${t("data.scaleReal")}` : ""}</option>{/each}
                <option value={0}>{t("data.scaleOther")}</option>
              </select>
              <input type="number" min="0.25" step="0.25" value={s.area.scale} onchange={(e) => setArea({ scale: Math.max(0.25, num(e.currentTarget.value, 1)) })} />
            </div>
          </label>
          <p class="facts">{t("data.facts", { size: sizeText(s.area.size, s.area.format, s.area.landscape), w: km(f.widthM * f.scale), h: km(f.heightM * f.scale), km2: fmtNum(Math.round(realKm2)) })}</p>
          <p class="hint">{t("data.ctrlHint")}</p>
        </Section>

        <Section id="data.sources" title={t("data.sources")} open>
          <label>{t("data.relief")}
            <select bind:value={importer.settings.source} onchange={save}>
              {#each SOURCES as so (so)}<option value={so}>{tk(`data.source.${so}`)}</option>{/each}
            </select>
          </label>
          <label class="check" title={t("data.coverTitle")}><input type="checkbox" bind:checked={importer.settings.useCover} onchange={save} /> {t("data.cover")}</label>
          {#if importer.dataSteps.length}
            <ul class="steps" class:stale={importer.dataStale}>
              {#each importer.dataSteps as st (st.id)}
                <li class={st.state}><span class="ico">{STEP_ICONS[st.state]}</span>{stepLabel("data", st)}{#if st.detail}<span class="detail"> · {st.detail}</span>{/if}</li>
              {/each}
            </ul>
          {/if}
        </Section>
      {:else if panelTab === "advanced"}
        <Section id="transform.relief" title={t("advanced.relief")} open>
          <div class="row">
            <label title={t("advanced.verticalScaleTitle")}>{t("advanced.verticalScale")}
              <input type="number" step="0.05" min="0.05" placeholder={defaultVerticalScale(f.scale).toFixed(2)}
                value={s.area.verticalScale ?? ""}
                onchange={(e) => setArea({ verticalScale: e.currentTarget.value === "" ? null : Math.max(0.05, num(e.currentTarget.value, 1)) })} />
            </label>
            <label title={t("advanced.waterLevelTitle")}>{t("advanced.waterLevel")}
              <input type="number" step="1" placeholder={t("advanced.auto")}
                value={s.terrain.refHeight ?? ""}
                onchange={(e) => { importer.settings.terrain.refHeight = e.currentTarget.value === "" ? null : num(e.currentTarget.value, 0); save(); }} />
            </label>
          </div>
          <div class="row">
            <label title={t("advanced.smoothTitle")}>{t("advanced.smooth")} <input type="number" step="4" min="0" bind:value={importer.settings.terrain.smoothM} onchange={save} /></label>
            <label title={t("advanced.canopyTitle")}>{t("advanced.canopy")} <input type="number" step="1" min="0" bind:value={importer.settings.terrain.canopyM} onchange={save} /></label>
          </div>
        </Section>

        <Section id="transform.water" title={t("advanced.water")} open>
          <div class="row">
            <label title={t("advanced.riverWidthTitle")}>{t("advanced.riverWidth")} <input type="number" step="8" min="0" bind:value={importer.settings.terrain.riverMinWidth} onchange={save} /></label>
            <label title={t("advanced.riverDepthTitle")}>{t("advanced.riverDepth")} <input type="number" min="1" bind:value={importer.settings.terrain.riverDepth} onchange={save} /></label>
          </div>
          <div class="row">
            <label title={t("advanced.coastDepthTitle")}>{t("advanced.coastDepth")} <input type="number" min="1" bind:value={importer.settings.terrain.coastDepth} onchange={save} /></label>
            <label title={t("advanced.minPondTitle")}>{t("advanced.minPond")} <input type="number" step="0.5" min="0" bind:value={importer.settings.terrain.minLakeHa} onchange={save} /></label>
          </div>
          <label title={t("advanced.waterJoinTitle")}>{t("advanced.waterJoin")} <input type="number" step="8" min="0" bind:value={importer.settings.terrain.waterJoinM} onchange={save} /></label>
          <label class="check"><input type="checkbox" bind:checked={importer.settings.terrain.wetlandLakes} onchange={save} /> {t("advanced.marshLakes")}</label>
          {#if s.terrain.wetlandLakes}
            <div class="row">
              <label>{t("advanced.marshArea")} <input type="number" step="1" min="0" bind:value={importer.settings.terrain.wetlandMinHa} onchange={save} /></label>
              <label>{t("advanced.marshDepth")} <input type="number" step="1" min="1" bind:value={importer.settings.terrain.marshDepth} onchange={save} /></label>
            </div>
          {/if}
          <details>
            <summary>{t("advanced.network")}</summary>
            <label class="check" title={t("advanced.repairTitle")}><input type="checkbox" bind:checked={importer.settings.terrain.repairRivers} onchange={save} /> {t("advanced.repair")}</label>
            <div class="row">
              <label title={t("advanced.endJoinTitle")}>{t("advanced.endJoin")} <input type="number" step="25" min="0" bind:value={importer.settings.terrain.riverJoinM} onchange={save} /></label>
              <label title={t("advanced.taperTitle")}>{t("advanced.taper")} <input type="number" step="100" min="0" bind:value={importer.settings.terrain.sourceTaperM} onchange={save} /></label>
            </div>
            <div class="row">
              <label title={t("advanced.valleySlopeTitle")}>{t("advanced.valleySlope")} <input type="number" step="0.02" min="0.02" bind:value={importer.settings.terrain.valleySlope} onchange={save} /></label>
              <label>{t("advanced.riverBank")} <input type="number" step="0.05" min="0.02" bind:value={importer.settings.terrain.riverBankSlope} onchange={save} /></label>
            </div>
            <div class="row">
              <label>{t("advanced.seaBank")} <input type="number" step="0.05" min="0.05" bind:value={importer.settings.terrain.bankSlope} onchange={save} /></label>
              <label>{t("advanced.bankWidth")} <input type="number" step="50" min="0" bind:value={importer.settings.terrain.bankWidthM} onchange={save} /></label>
            </div>
            <div class="row">
              <label>{t("advanced.lakeDepth")} <input type="number" min="1" bind:value={importer.settings.terrain.lakeDepth} onchange={save} /></label>
              <label title={t("advanced.underwaterTitle")}>{t("advanced.underwater")} <input type="number" step="0.05" min="0.05" bind:value={importer.settings.terrain.underwaterSlope} onchange={save} /></label>
            </div>
            <div class="row">
              <label>{t("advanced.seaDepth")} <input type="number" min="1" bind:value={importer.settings.terrain.seaDepth} onchange={save} /></label>
              <label>{t("advanced.seaMax")} <input type="number" min="1" bind:value={importer.settings.terrain.seaMaxDepth} onchange={save} /></label>
            </div>
            <label title={t("advanced.maxCarveTitle")}>{t("advanced.maxCarve")} <input type="number" min="0" bind:value={importer.settings.terrain.maxCarve} onchange={save} /></label>
            <button class="small" disabled={!!importer.running} onclick={() => importer.writeRiverTest()}>{t("advanced.riverTest")}</button>
          </details>
        </Section>

        <Section id="transform.towns" title={t("advanced.towns")}>
          <div class="row">
            <label>{t("advanced.minPop")} <input type="number" step="500" min="0" bind:value={importer.settings.places.minPopulation} onchange={save} /></label>
            <label title={t("advanced.autoCountTitle", { n: townLimit })}>{t("advanced.autoCount")} <input type="number" step="1" min="0" bind:value={importer.settings.towns.maxTowns} onchange={save} /></label>
          </div>
          <label class="check"><input type="checkbox" bind:checked={importer.settings.places.includeUnknown} onchange={save} /> {t("advanced.unknownPop")}</label>
          {#if placedTowns > townLimit}<p class="warn">{t("advanced.tooMany", { n: townLimit })}</p>{/if}
          <div class="row">
            <label title={t("advanced.refCapacityTitle")}>{t("advanced.refCapacity")} <input type="number" step="25" min="10" bind:value={importer.settings.towns.refCapacity} onchange={save} /></label>
            <label title={t("advanced.contrastTitle")}>{t("advanced.contrast")} <input type="number" step="0.05" min="0" max="1" bind:value={importer.settings.towns.sizeExponent} onchange={save} /></label>
          </div>
          <label>{t("advanced.townSpacing")} <input type="number" step="100" min="0" bind:value={importer.settings.towns.minSpacingM} onchange={save} /></label>
          <details>
            <summary>{t("advanced.placement")}</summary>
            <div class="row">
              <label>{t("advanced.seaDistance")} <input type="number" step="50" min="0" bind:value={importer.settings.towns.waterClearanceM} onchange={save} /></label>
              <label>{t("advanced.riverDistance")} <input type="number" step="25" min="0" bind:value={importer.settings.towns.riverClearanceM} onchange={save} /></label>
            </div>
            <div class="row">
              <label>{t("advanced.edgeMargin")} <input type="number" step="100" min="0" bind:value={importer.settings.towns.edgeMarginM} onchange={save} /></label>
              <label>{t("advanced.maxShift")} <input type="number" step="500" min="0" bind:value={importer.settings.towns.maxShiftM} onchange={save} /></label>
            </div>
          </details>
        </Section>

        <Section id="transform.industries" title={t("advanced.industries")}>
          <div class="row">
            <label title={t("advanced.economyTitle")}>{t("advanced.economy")}
              <select bind:value={importer.settings.industries.economy} onchange={save}>
                {#each Object.keys(ECONOMY_LABELS) as id (id)}<option value={id}>{tk(`economy.${id}`)}</option>{/each}
              </select>
            </label>
            <label>{t("advanced.density")}
              <select bind:value={importer.settings.industries.density} onchange={save}>
                {#each DENSITIES as i (i)}<option value={i}>{tk(`density.${i}`)}</option>{/each}
              </select>
            </label>
          </div>
          <label title={t("advanced.countTitle", { n: defaultIndustryCount(f, s.industries.density) })}>{t("advanced.count", { n: defaultIndustryCount(f, s.industries.density) })} <input type="number" step="1" min="0" bind:value={importer.settings.industries.maxIndustries} onchange={save} /></label>
          <div class="row">
            <label>{t("advanced.industrySpacing")} <input type="number" step="100" min="0" bind:value={importer.settings.industries.minSpacingM} onchange={save} /></label>
            <label>{t("advanced.townClearance")} <input type="number" step="100" min="0" bind:value={importer.settings.industries.townClearanceM} onchange={save} /></label>
          </div>
          <div class="row">
            <label>{t("advanced.edgeMargin")} <input type="number" step="100" min="0" bind:value={importer.settings.industries.edgeMarginM} onchange={save} /></label>
            <label>{t("advanced.maxShift")} <input type="number" step="500" min="0" bind:value={importer.settings.industries.maxShiftM} onchange={save} /></label>
          </div>
        </Section>

        <Section id="transform.roads" title={t("advanced.roads")}>
          {#if !s.roadsFrozen}<p class="hint">{t("roads.auto")}</p>{/if}
          <ResetRoads />
        </Section>

        <Section id="transform.rail" title={t("advanced.rail")}>
          <div class="row">
            <label title={t("advanced.minRadiusTitle")}>{t("advanced.minRadius")} <input type="number" step="50" min="55" bind:value={importer.settings.rail.minRadiusM} onchange={save} /></label>
            <label title={t("advanced.maxGradeTitle")}>{t("advanced.maxGrade")}
              <input type="number" step="0.5" min="0.5" max="8" value={Math.round(s.rail.maxGrade * 1000) / 10}
                onchange={(e) => { importer.settings.rail.maxGrade = Math.min(0.085, Math.max(0.005, num(e.currentTarget.value, 2.5) / 100)); save(); }} />
            </label>
          </div>
          <div class="row">
            <label title={t("advanced.railClearanceTitle")}>{t("advanced.railClearance")} <input type="number" step="50" min="0" bind:value={importer.settings.rail.townClearanceM} onchange={save} /></label>
            <label title={t("advanced.corridorTitle")}>{t("advanced.corridor")} <input type="number" step="100" min="0" max="2000" bind:value={importer.settings.rail.corridorM} onchange={save} /></label>
          </div>
        </Section>
      {:else}
        {#if pv}
          <div class="summary">
            <span>{t("export.summary", { towns: placedTowns, industries: (pv.industries ?? []).length, links: pv.network.links.filter((l) => s.linkPicks[l.key] !== false).length, rails: pv.network.rail.length })}</span>
            <button class="secondary" onclick={() => (listsOpen = true)}>{t("export.showLists")}</button>
          </div>
          <p class="hint">{t("export.mapHint")}</p>
        {/if}

        <Section id="export.game" title={t("export.game")} open>
          <label>{t("export.mapName")} <input bind:value={importer.settings.name} onchange={save} /></label>
          <label>{t("export.userdata")}
            <input bind:value={importer.settings.userdata} onchange={() => { save(); importer.readGameSettings(); }} placeholder="…\3493540\local" />
          </label>
        </Section>

        <p class="facts">{t("export.inGame", { size: sizeText(s.area.size, s.area.format, s.area.landscape) })}</p>
        {#if importer.exportSteps.length || importer.gameSteps.length}
          <ul class="steps">
            {#each [...importer.exportSteps.map((e) => ({ ...e, label: stepLabel("export", e) })), ...importer.gameSteps.map((g) => ({ ...g, id: `game:${g.id}`, label: t("export.gameStep", { label: stepLabel("game", g) }) }))] as st (st.id)}
              <li class={st.state}><span class="ico">{STEP_ICONS[st.state]}</span>{st.label}{#if st.detail}<span class="detail"> · {st.detail}</span>{/if}</li>
            {/each}
          </ul>
        {/if}
        <Section id="export.updates" title={t("updates.title")}>
          <UpdatesPanel />
        </Section>
      {/if}
      <p class="credits">{t("credits")}</p>
    </div>

    <footer>
      {#if panelTab === "data"}
        {#if dataOk && resultOk && !importer.running}
          <p class="ready">{t("data.ready")}</p>
        {/if}
        <button class="action" class:ok={dataOk} disabled={!!importer.running} onclick={() => importer.fetchData()}>
          {importer.running === "data" ? t("data.fetching", { pct: pct() }) : dataOk ? t("data.upToDate") : t("data.fetch")}
        </button>
      {:else if panelTab === "advanced"}
        <div class="row tight update">
          <label class="check"><input type="checkbox" bind:checked={autoPreview} /> {t("advanced.autoUpdate")}</label>
          <button class="action" class:ok={resultOk} disabled={!!importer.running} onclick={() => importer.runPreview()}>
            {importer.running === "preview" ? t("advanced.updating", { pct: pct() }) : resultOk ? t("advanced.upToDate") : t("advanced.update")}
          </button>
        </div>
      {:else}
        <button class="action" class:ok={importer.exported} disabled={!!importer.running} onclick={() => importer.run()}>
          {importer.running === "full" ? t("export.generating", { pct: pct() }) : importer.exported ? t("export.generated") : t("export.generate")}
        </button>
      {/if}
      {@render progress()}
    </footer>
    {/if}
  </aside>

  <section class="map-pane">
    <svelte:boundary onerror={(e) => importer.report(e, t("map.game"))}>
      <AreaMap
        bind:this={mapRef}
        frame={f}
        preview={pv}
        real={importer.realLayer}
        view={mapView}
        {opacity}
        {hideOff}
        linkPicks={s.linkPicks}
        {industryTypes}
        onPick={(lon, lat) => setArea({ lon, lat })}
        onToggleTown={(k) => importer.toggleTown(k)}
        onToggleIndustry={(k) => importer.toggleIndustry(k)}
        onAddIndustry={(tag, lon, lat) => importer.addIndustry(tag, lon, lat)}
        onAddRoad={(a, b) => { const na = townName(a); const nb = townName(b); if (na && nb) importer.addRoad(na, nb); }}
        onAddRail={(from, to) => importer.addRail(from, to)}
        onLink={(key) => importer.removeOrRestoreLink(key)}
      />
      {#snippet failed(error, reset)}
        <div class="crashed"><p>{t("map.crashed", { error: errorText(error) })}</p><button onclick={reset}>{t("map.retry")}</button></div>
      {/snippet}
    </svelte:boundary>
    {#if listsOpen}
      <ListsPanel onFocus={(kind, key) => { mapView = "game"; mapRef?.focus(kind, key, 460); }} onClose={() => (listsOpen = false)} />
    {/if}
    <div class="map-tools">
      <button class:active={listsOpen} onclick={() => (listsOpen = !listsOpen)}>{t("map.lists")}</button>
      <button onclick={() => mapRef?.fit()}>{t("map.fit")}</button>
      <span class="seg">
        <button class:active={mapView === "real"} disabled={!importer.realLayer} onclick={() => (mapView = "real")}>{t("map.real")}</button>
        <button class:active={mapView === "game"} onclick={() => (mapView = "game")}>{t("map.game")}</button>
      </span>
      {#if pv && mapView === "game"}
        <label class="inline">{t("map.opacity")} <input type="range" min="0" max="1" step="0.05" bind:value={opacity} /></label>
        <label class="check"><input type="checkbox" bind:checked={hideOff} /> {t("map.hideOff")}</label>
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
  .step {
    margin: 2px 0 0;
    font-size: 12px;
    color: #5b6670;
  }
  footer {
    padding: 8px 14px 10px;
    border-top: 1px solid #d5d9de;
    background: #fafbfc;
  }
  footer progress {
    margin-top: 6px;
  }
  footer .error {
    margin: 6px 0 0;
    font-size: 12px;
  }
  .ready {
    margin: 0 0 6px;
    font-size: 12px;
    color: #1f7a39;
  }
  /* The step's action: orange while something is left to do, green once done and up to date. */
  .action {
    width: 100%;
    padding: 9px 10px;
    font: inherit;
    font-size: 15px;
    font-weight: 600;
    color: #fff;
    background: #FD9401;
    border: none;
    border-radius: 6px;
    cursor: pointer;
  }
  .action.ok {
    background: #2e9d4a;
  }
  footer .update .action {
    flex: 2;
  }
  .hint {
    font-size: 12px;
    color: #5b6670;
    margin: 6px 0 2px;
  }
  .tabs button.log {
    flex: 0.7;
  }
  .badge {
    display: inline-block;
    margin-left: 4px;
    padding: 0 5px;
    border-radius: 8px;
    background: #b00020;
    color: #fff;
    font-size: 10px;
    font-weight: 600;
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
    color: #FD9401;
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
  .update-badge {
    margin-left: 8px;
    margin-right: auto;
    padding: 2px 8px;
    border: 1px solid #2e9d4a;
    border-radius: 10px;
    background: #e8f5ec;
    color: #1f7a39;
    font: inherit;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
  }
  h1 .accent {
    color: #FD9401;
  }
  /* The installed Century Gothic (a Microsoft font, not shipped with the app); close geometric fonts otherwise. */
  h1 {
    margin: 0;
    font-size: 20px;
    font-family: "Century Gothic", "URW Gothic", "TeX Gyre Adventor", "Avant Garde", sans-serif;
    font-weight: 700;
  }
  .title {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .lang select {
    font-size: 12px;
    padding: 2px 4px;
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
  /* Side by side, inputs level even when one label wraps. */
  .row > label {
    flex: 1 1 0;
    min-width: 0;
    display: flex;
    flex-direction: column;
    justify-content: flex-end;
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
    color: #FD9401;
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
  .secondary {
    background: #fff;
    color: #FD9401;
    border: 2px solid #FD9401;
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
  .credits {
    font-size: 10px;
    color: #8a949d;
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
    background: #FD9401;
    color: #fff;
    border-color: #FD9401;
  }
  .summary {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 8px 0;
    font-size: 12px;
    color: #5b6670;
  }
  .summary span {
    flex: 1;
  }
  .map-tools > button.active {
    background: #FD9401;
    color: #fff;
    border-color: #FD9401;
  }
</style>
