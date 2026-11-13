<script lang="ts">
  /**
   * Towns, industries and road / rail lists in a panel over the map (DECISION-015), out of the
   * left panel. A click on a name centres the map on it and opens its sheet.
   * Filtres et choix en masse (« Cocher les N filtrées »), choix en attente jusqu'à « Actualiser la
   * carte » (ou la case « Actualiser automatiquement »), largeur réglable à la souris.
   */
  import { errorText, importer } from "$lib/state/importer.svelte";
  import { foldName, industryColor, industryLabel, industryTitle, needsText, townTitle } from "$lib/ui/townMarkers";
  import { fmtNum, t, tk } from "$lib/i18n/index.svelte";
  import { gameTownLimit } from "$lib/core/towns";
  import ResetRoads from "$lib/ui/ResetRoads.svelte";

  type ListTab = "towns" | "industries" | "network";
  type Show = "all" | "on" | "off";
  let { onFocus, onClose }: { onFocus: (kind: "town" | "industry", key: string) => void; onClose: () => void } = $props();

  const TAB_KEY = "importcity.listTab";
  const WIDTH_KEY = "importcity.listsWidth";
  function stored(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }
  function store(key: string, v: string): void {
    try {
      localStorage.setItem(key, v);
    } catch {
      /* storage unavailable */
    }
  }
  let tab = $state<ListTab>((stored(TAB_KEY) as ListTab | null) ?? "towns");
  $effect(() => store(TAB_KEY, tab));

  // Largeur : 520 px par défaut, réglable par la poignée du bord droit (360 px à 90 % de la carte).
  let width = $state(Number(stored(WIDTH_KEY)) || 520);
  let panel: HTMLDivElement | undefined = $state();
  function startResize(e: PointerEvent): void {
    e.preventDefault();
    const x0 = e.clientX;
    const w0 = width;
    const max = () => (panel?.parentElement?.clientWidth ?? 1200) * 0.9;
    const move = (ev: PointerEvent) => (width = Math.round(Math.max(360, Math.min(max(), w0 + ev.clientX - x0))));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      store(WIDTH_KEY, String(width));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  const pv = $derived(importer.preview);
  const s = $derived(importer.settings);
  /** Rows shown at most: the filter reaches the others (a whole country has tens of thousands of places). */
  const MAX_ROWS = 300;

  // ---- Villes ----
  let townQuery = $state("");
  let townKind = $state<"all" | "city" | "town" | "village">("all");
  let townMin = $state(0);
  let townShow = $state<Show>("all");
  const townsOn = $derived((pv?.candidates ?? []).filter((c) => importer.townOn(c)).length);
  const townLimit = $derived(pv ? gameTownLimit(pv.frame) : 0);
  const townFiltered = $derived.by(() => {
    const q = foldName(townQuery.trim());
    return (pv?.candidates ?? []).filter(
      (c) =>
        (townKind === "all" || c.place === townKind) &&
        c.rank >= (townMin || 0) &&
        (townShow === "all" || (townShow === "on") === importer.townOn(c)) &&
        (!q || foldName(c.name).includes(q)),
    );
  });
  const townByKey = $derived(new Map((pv?.towns ?? []).map((x) => [x.key, x])));
  // Towns of the map with no road left (the user removed them all: DECISION-018); an industry's
  // access counts as a road for its town.
  const roadless = $derived.by(() => {
    const linked = new Set<string>();
    for (const l of pv?.network.links ?? []) {
      if (s.linkPicks[l.key] === false) continue;
      linked.add(l.a);
      linked.add(l.b);
    }
    return new Set((pv?.towns ?? []).filter((x) => !linked.has(x.name)).map((x) => x.key));
  });
  /** Choix en attente : différent de celui du dernier calcul. */
  const townPending = (c: { key: string; pick: boolean | null }) => (s.townPicks[c.key] ?? null) !== c.pick;

  // ---- Industries ----
  let indQuery = $state("");
  let indTag = $state("all");
  let indOrigin = $state("all");
  let indShow = $state<Show>("all");
  const indTags = $derived([...new Set((pv?.industryCandidates ?? []).map((c) => c.tag))].sort((a, b) => industryLabel(a).localeCompare(industryLabel(b))));
  const indFiltered = $derived.by(() => {
    const q = foldName(indQuery.trim());
    return (pv?.industryCandidates ?? []).filter(
      (c) =>
        (indTag === "all" || c.tag === indTag) &&
        (indOrigin === "all" || c.origin === indOrigin) &&
        (indShow === "all" || (indShow === "on") === importer.industryOn(c)) &&
        (!q || foldName(c.name).includes(q)),
    );
  });
  const indPending = (c: { key: string; pick: boolean | null }) => (s.industryPicks[c.key] ?? null) !== c.pick;

  const km = (m: number) => `${fmtNum(m / 1000, 1)} km`;
  const pct = (v: number) => `${Math.round(v * 100)}`;
</script>

<div class="lists" bind:this={panel} style:width="min({width}px, calc(100% - 20px))">
  <header>
    <nav>
      <button class:active={tab === "towns"} onclick={() => (tab = "towns")}>{t("lists.towns")}{pv ? ` · ${townsOn}` : ""}</button>
      <button class:active={tab === "industries"} onclick={() => (tab = "industries")}>{t("lists.industries")}{pv ? ` · ${(pv.industryCandidates ?? []).filter((c) => importer.industryOn(c)).length}` : ""}</button>
      <button class:active={tab === "network"} onclick={() => (tab = "network")}>{t("lists.network")}</button>
    </nav>
    <button class="close" title={t("lists.close")} onclick={onClose}>✕</button>
  </header>

  {#if !pv}
    <p class="empty">{t("lists.empty")}</p>
  {:else if tab === "towns"}
    <svelte:boundary onerror={(e) => importer.report(e, t("lists.towns"))}>
      <div class="filters">
        <input type="search" placeholder={t("lists.search")} bind:value={townQuery} />
        <select bind:value={townKind} title={t("lists.kindTitle")}>
          <option value="all">{t("lists.kindAll")}</option>
          <option value="city">{t("lists.kindCity")}</option>
          <option value="town">{t("lists.kindTown")}</option>
          <option value="village">{t("lists.kindVillage")}</option>
        </select>
        <label class="min" title={t("lists.minPopTitle")}>≥ <input type="number" min="0" step="500" bind:value={townMin} /></label>
        <select bind:value={townShow}>
          <option value="all">{t("lists.showAll")}</option>
          <option value="on">{t("lists.showOn")}</option>
          <option value="off">{t("lists.showOff")}</option>
        </select>
      </div>
      <div class="bulk">
        <span class="count">{t("lists.filtered", { n: fmtNum(townFiltered.length) })}</span>
        <button class="small" disabled={!townFiltered.length} onclick={() => importer.setPicks(townFiltered.map((c) => c.key), true)}>{t("lists.checkFiltered", { n: fmtNum(townFiltered.length) })}</button>
        <button class="small" disabled={!townFiltered.length} onclick={() => importer.setPicks(townFiltered.map((c) => c.key), false)}>{t("lists.uncheckFiltered", { n: fmtNum(townFiltered.length) })}</button>
        <button class="small" onclick={() => importer.resetPicks("auto")} title={t("lists.allAutoTitle")}>{t("lists.allAuto")}</button>
        <button class="small" onclick={() => importer.resetPicks("none")}>{t("lists.none")}</button>
      </div>
      {#if townLimit && townsOn > townLimit}<p class="warn line">{t("lists.overLimit", { n: townsOn, limit: townLimit })}</p>{/if}
      <ul class="rows">
        {#each townFiltered.slice(0, MAX_ROWS) as c (c.key)}
          {@const town = townByKey.get(c.key)}
          {@const pending = townPending(c)}
          <li class={pending ? "pending" : c.status} title={townTitle(c) + (town?.needs ? `\n${t("lists.needs", { needs: needsText(town.needs) })}` : "")}>
            <input type="checkbox" checked={importer.townOn(c)} onchange={() => importer.toggleTown(c.key)} />
            <button class="name" onclick={() => onFocus("town", c.key)}>{c.name}{#if c.status === "placed" && roadless.has(c.key)}<span class="warn"> · {t("lists.noRoad")}</span>{/if}</button>
            <span class="pop">{c.estimated ? "≈ " : ""}{fmtNum(c.rank)}</span>
            {#if town?.shares}<span class="pop" title={t("lists.sharesTitle")}>{pct(town.shares.com)}/{pct(town.shares.ind)} %</span>{/if}
            <span class="state">
              {#if pending}<span class="tag" title={t("lists.pendingTitle")}>{t("lists.pendingShort")}</span>{:else}{c.status === "placed" ? c.capacity : c.status === "off" ? "" : t("lists.notPlaced")}{/if}
              {#if (s.townPicks[c.key] ?? null) !== null}<button class="link" title={t("lists.autoTitle")} onclick={() => importer.setPick(c.key, null)}>{t("lists.auto")}</button>{/if}
            </span>
          </li>
        {/each}
        {#if townFiltered.length > MAX_ROWS}<li class="more">{t("lists.more", { n: fmtNum(townFiltered.length - MAX_ROWS) })}</li>{/if}
      </ul>
      {#snippet failed(error, reset)}
        <p class="error">{t("lists.error", { what: t("lists.towns"), error: errorText(error) })} <button class="link" onclick={reset}>{t("lists.retry")}</button></p>
      {/snippet}
    </svelte:boundary>
  {:else if tab === "industries"}
    <svelte:boundary onerror={(e) => importer.report(e, t("lists.industries"))}>
      <div class="filters">
        <input type="search" placeholder={t("lists.search")} bind:value={indQuery} />
        <select bind:value={indTag}>
          <option value="all">{t("lists.typeAll")}</option>
          {#each indTags as tag (tag)}<option value={tag}>{industryLabel(tag)}</option>{/each}
        </select>
        <select bind:value={indOrigin}>
          <option value="all">{t("lists.originAll")}</option>
          <option value="osm">{tk("originShort.osm")}</option>
          <option value="landcover">{tk("originShort.landcover")}</option>
          <option value="chain">{tk("originShort.chain")}</option>
          <option value="user">{tk("originShort.user")}</option>
        </select>
        <select bind:value={indShow}>
          <option value="all">{t("lists.showAll")}</option>
          <option value="on">{t("lists.showOn")}</option>
          <option value="off">{t("lists.showOff")}</option>
        </select>
      </div>
      <div class="bulk">
        <span class="count">{t("lists.filtered", { n: fmtNum(indFiltered.length) })}</span>
        <button class="small" disabled={!indFiltered.length} onclick={() => importer.setIndustryPicks(indFiltered.map((c) => c.key), true)}>{t("lists.checkFiltered", { n: fmtNum(indFiltered.length) })}</button>
        <button class="small" disabled={!indFiltered.length} onclick={() => importer.setIndustryPicks(indFiltered.map((c) => c.key), false)}>{t("lists.uncheckFiltered", { n: fmtNum(indFiltered.length) })}</button>
        <button class="small" onclick={() => importer.resetIndustryPicks()}>{t("lists.allAuto")}</button>
      </div>
      <ul class="rows">
        {#each indFiltered.slice(0, MAX_ROWS) as c (c.key)}
          {@const pending = indPending(c)}
          <li class={pending ? "pending" : c.status} title={industryTitle(c)}>
            <input type="checkbox" checked={importer.industryOn(c)} onchange={() => importer.toggleIndustry(c.key)} />
            <i class="sq" style:background={industryColor(c.tag)}></i>
            <button class="name" onclick={() => onFocus("industry", c.key)}>{c.name}{#if c.missing}<span class="warn"> · {t("sheet.missingShort", { list: c.missing.map(industryLabel).join(", ") })}</span>{/if}</button>
            <span class="pop" title={t("lists.relevanceTitle")}>{tk(`originShort.${c.origin}`)} {c.relevance ? fmtNum(c.relevance, 1) : ""}</span>
            <span class="state">
              {#if pending}<span class="tag" title={t("lists.pendingTitle")}>{t("lists.pendingShort")}</span>{:else}{c.status === "placed" || c.status === "off" ? "" : t("lists.notPlaced")}{/if}
              {#if (s.industryPicks[c.key] ?? null) !== null}<button class="link" title={t("lists.autoTitle")} onclick={() => importer.setIndustryPick(c.key, null)}>{t("lists.auto")}</button>{/if}
              {#if c.origin === "user"}<button class="del" title={t("lists.deleteIndustry")} onclick={() => importer.removeCustomIndustry(c.key)}>✕</button>{/if}
            </span>
          </li>
        {/each}
        {#if indFiltered.length > MAX_ROWS}<li class="more">{t("lists.more", { n: fmtNum(indFiltered.length - MAX_ROWS) })}</li>{/if}
      </ul>
      {#snippet failed(error, reset)}
        <p class="error">{t("lists.error", { what: t("lists.industries"), error: errorText(error) })} <button class="link" onclick={reset}>{t("lists.retry")}</button></p>
      {/snippet}
    </svelte:boundary>
  {:else}
    {@const net = pv.network}
    <ResetRoads />
    <ul class="rows">
      {#each net.links.filter((x) => x.kind === "town") as l (l.key)}
        <li class={s.linkPicks[l.key] === false ? "off" : "placed"} title={l.real ? t("lists.realRoad") : t("lists.directRoad")}>
          <input type="checkbox" checked={s.linkPicks[l.key] !== false} disabled={!!importer.running} onchange={() => importer.toggleLink(l.key)} />
          <span class="name">{l.a} – {l.b}{s.linkPicks[l.key] === true ? ` · ${t("lists.added")}` : ""}</span>
          <span class="pop">{km(l.lengthM)}</span>
          {#if s.linkPicks[l.key] === true}<button class="del" title={t("lists.deleteRoad")} onclick={() => importer.removeRoad(l.key)}>✕</button>{/if}
        </li>
      {/each}
      {#each net.rail as r (r.key)}
        <li class={s.linkPicks[r.key] === false ? "off" : "rail"}>
          <input type="checkbox" checked={s.linkPicks[r.key] !== false} disabled={!!importer.running} onchange={() => importer.toggleLink(r.key)} />
          <span class="name">{r.key.startsWith("rail:user:") ? `${t("map.railLine")} · ${t("lists.added")}` : (r.name ?? t("map.railLine"))}{r.design ? ` · ${t("lists.railFigures", { bridges: r.design.bridges, tunnels: r.design.tunnels })}` : ""}</span>
          <span class="pop">{r.design ? km(r.design.lengthM) : ""}</span>
          {#if r.key.startsWith("rail:user:")}<button class="del" title={t("lists.deleteRail")} onclick={() => importer.removeCustomRail(r.key.replace(/\.\d+$/, ""))}>✕</button>{/if}
        </li>
      {/each}
    </ul>
  {/if}
  {#if pv}
    <footer class="apply">
      <span class="pending">{importer.pendingPicks ? t("lists.pending", { n: importer.pendingPicks }) : t("lists.upToDate")}</span>
      <label title={t("lists.autoApplyTitle")}><input type="checkbox" checked={importer.autoApplyPicks} onchange={(e) => importer.setAutoApplyPicks(e.currentTarget.checked)} /> {t("lists.autoApply")}</label>
      <button class="primary" disabled={!!importer.running || !importer.stale} onclick={() => importer.runPreview()}>
        {importer.running === "preview" ? t("lists.applying") : t("lists.apply")}
      </button>
    </footer>
  {/if}
  <div class="grip" role="separator" aria-orientation="vertical" title={t("lists.resize")} onpointerdown={startResize}></div>
</div>

<style>
  .lists {
    position: absolute;
    top: 64px;
    left: 48px;
    bottom: 34px;
    display: flex;
    flex-direction: column;
    background: #fff;
    border: 1px solid #d5d9de;
    border-radius: 6px;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.18);
    z-index: 4;
    font-size: 12px;
  }
  header {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 6px 6px 0;
    border-bottom: 1px solid #d5d9de;
  }
  nav {
    flex: 1;
    display: flex;
    gap: 2px;
  }
  nav button {
    flex: 1;
    padding: 5px 4px;
    border: 1px solid transparent;
    border-bottom: none;
    border-radius: 6px 6px 0 0;
    background: #e9ecef;
    cursor: pointer;
    font: inherit;
    color: #3d4851;
  }
  nav button.active {
    background: #fff;
    border-color: #d5d9de;
    color: #FD9401;
    font-weight: 600;
  }
  .close {
    border: none;
    background: none;
    cursor: pointer;
    color: #6b747c;
    font-size: 14px;
    padding: 2px 6px;
  }
  .empty {
    color: #5b6670;
    padding: 10px;
  }
  .add {
    position: relative;
    display: flex;
    gap: 6px;
    align-items: center;
    padding: 6px;
  }
  .add input {
    flex: 1;
    min-width: 0;
    padding: 4px 6px;
    border: 1px solid #c3c9d0;
    border-radius: 4px;
    font: inherit;
  }
  .hint {
    flex: 1;
    color: #6b747c;
  }
  .suggest {
    position: absolute;
    top: 100%;
    left: 6px;
    right: 6px;
    z-index: 5;
    max-height: 220px;
    overflow-y: auto;
    margin: 0;
    padding: 0;
    list-style: none;
    background: #fff;
    border: 1px solid #c3c9d0;
    border-radius: 4px;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
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
  .rows {
    flex: 1;
    list-style: none;
    margin: 0;
    padding: 0;
    overflow-y: auto;
    border-top: 1px solid #eef0f2;
  }
  .rows li {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 2px 6px;
    border-left: 4px solid #FD9401;
  }
  .rows li.placed {
    border-left-color: #2e9d4a;
  }
  .rows li.rail {
    border-left-color: #1d2329;
  }
  .rows li.dropped,
  .rows li.limit {
    border-left-color: #8c949c;
    color: #6b747c;
  }
  .rows li.off {
    color: #6b747c;
  }
  .rows .name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    text-align: left;
    border: none;
    background: none;
    padding: 0;
    font: inherit;
    color: inherit;
  }
  .rows button.name {
    cursor: pointer;
  }
  .rows button.name:hover {
    color: #2a6fdb;
    text-decoration: underline;
  }
  .pop,
  .state {
    color: #6b747c;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  i.sq {
    display: inline-block;
    width: 8px;
    height: 8px;
    transform: rotate(45deg);
    flex: none;
  }
  .warn {
    color: #9a5b00;
  }
  .error {
    color: #b00020;
    padding: 6px;
  }
  button.small {
    flex: none;
  }
  button:disabled {
    opacity: 0.6;
    cursor: default;
  }
  button.del {
    border: none;
    background: none;
    padding: 0 2px;
    color: #b00020;
    cursor: pointer;
    font-size: 11px;
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
  .filters,
  .bulk {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    align-items: center;
    padding: 6px 6px 0;
  }
  .bulk {
    padding-bottom: 6px;
  }
  .filters input[type="search"] {
    flex: 1;
    min-width: 120px;
    padding: 4px 6px;
    border: 1px solid #c3c9d0;
    border-radius: 4px;
    font: inherit;
  }
  .filters select,
  .filters input[type="number"] {
    padding: 3px 4px;
    border: 1px solid #c3c9d0;
    border-radius: 4px;
    font: inherit;
  }
  .filters .min input {
    width: 72px;
  }
  .bulk .count {
    flex: 1;
    color: #5b6670;
  }
  .line {
    margin: 0;
    padding: 0 6px 6px;
  }
  .rows li.pending {
    border-left-color: #2a6fdb;
    background: #f3f7fd;
  }
  .rows li.more {
    border-left-color: transparent;
    color: #6b747c;
    font-style: italic;
    padding: 6px;
  }
  .tag {
    color: #2a6fdb;
    font-weight: 600;
  }
  footer.apply {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px;
    border-top: 1px solid #d5d9de;
    background: #fafbfc;
  }
  footer.apply .pending {
    flex: 1;
    color: #3d4851;
  }
  footer.apply label {
    display: flex;
    align-items: center;
    gap: 4px;
    color: #5b6670;
  }
  footer.apply button.primary {
    padding: 5px 10px;
    border-radius: 5px;
    border: 1px solid #fd9401;
    background: #fd9401;
    color: #fff;
    font: inherit;
    font-weight: 600;
    cursor: pointer;
  }
  .grip {
    position: absolute;
    top: 0;
    right: -4px;
    width: 8px;
    height: 100%;
    cursor: ew-resize;
  }
  .grip:hover {
    background: rgba(42, 111, 219, 0.25);
  }
</style>
