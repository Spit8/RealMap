<script lang="ts">
  /**
   * Towns, industries and road / rail lists in a panel over the map (DECISION-015), out of the
   * left panel. A click on a name centres the map on it and opens its sheet.
   */
  import { errorText, importer } from "$lib/state/importer.svelte";
  import { foldName, industryColor, industryLabel, industryTitle, needsText, shownTownKeys, townTitle } from "$lib/ui/townMarkers";
  import { fmtNum, t, tk } from "$lib/i18n/index.svelte";
  import ResetRoads from "$lib/ui/ResetRoads.svelte";

  type ListTab = "towns" | "industries" | "network";
  let { onFocus, onClose }: { onFocus: (kind: "town" | "industry", key: string) => void; onClose: () => void } = $props();

  const TAB_KEY = "importcity.listTab";
  function stored(): ListTab {
    try {
      return (localStorage.getItem(TAB_KEY) as ListTab | null) ?? "towns";
    } catch {
      return "towns";
    }
  }
  let tab = $state<ListTab>(stored());
  $effect(() => {
    try {
      localStorage.setItem(TAB_KEY, tab);
    } catch {
      /* storage unavailable */
    }
  });

  const pv = $derived(importer.preview);
  const s = $derived(importer.settings);
  const placedTowns = $derived((pv?.candidates ?? []).filter((c) => c.status === "placed").length);

  // Towns: the chosen ones and the 10 most populous others; the rest is reached through « Ajouter ».
  const listedTowns = $derived.by(() => {
    const all = pv?.candidates ?? [];
    const keys = shownTownKeys(all);
    return all.filter((c) => keys.has(c.key));
  });
  const townByKey = $derived(new Map((pv?.towns ?? []).map((x) => [x.key, x])));
  // Towns of the map with no road left (the user removed them all: DECISION-018).
  const roadless = $derived.by(() => {
    const linked = new Set<string>();
    for (const l of pv?.network.links ?? []) {
      if (s.linkPicks[l.key] === false) continue;
      linked.add(l.a);
      linked.add(l.b);
    }
    return new Set((pv?.towns ?? []).filter((x) => !linked.has(x.name)).map((x) => x.key));
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

  const km = (m: number) => `${fmtNum(m / 1000, 1)} km`;
  const pct = (v: number) => `${Math.round(v * 100)}`;
</script>

<div class="lists">
  <header>
    <nav>
      <button class:active={tab === "towns"} onclick={() => (tab = "towns")}>{t("lists.towns")}{pv ? ` · ${placedTowns}` : ""}</button>
      <button class:active={tab === "industries"} onclick={() => (tab = "industries")}>{t("lists.industries")}{pv ? ` · ${(pv.industries ?? []).length}` : ""}</button>
      <button class:active={tab === "network"} onclick={() => (tab = "network")}>{t("lists.network")}</button>
    </nav>
    <button class="close" title={t("lists.close")} onclick={onClose}>✕</button>
  </header>

  {#if !pv}
    <p class="empty">{t("lists.empty")}</p>
  {:else if tab === "towns"}
    <svelte:boundary onerror={(e) => importer.report(e, t("lists.towns"))}>
      <div class="add">
        <input type="search" placeholder={t("lists.addTown")} bind:value={townQuery}
          onfocus={() => (townFocus = true)}
          onblur={() => setTimeout(() => (townFocus = false), 150)}
          onkeydown={(e) => { if (e.key === "Enter" && suggestions[0]) addTown(suggestions[0].key); }} />
        {#if townFocus && suggestions.length}
          <ul class="suggest">
            {#each suggestions as c (c.key)}
              <li><button onmousedown={() => addTown(c.key)}>{c.name} <span class="pop">{c.estimated ? "≈ " : ""}{fmtNum(c.rank)}</span></button></li>
            {/each}
          </ul>
        {/if}
        <button class="small" disabled={!!importer.running} onclick={() => importer.resetPicks("auto")} title={t("lists.allAutoTitle")}>{t("lists.allAuto")}</button>
        <button class="small" disabled={!!importer.running} onclick={() => importer.resetPicks("none")}>{t("lists.none")}</button>
      </div>
      <ul class="rows">
        {#each listedTowns as c (c.key)}
          {@const town = townByKey.get(c.key)}
          <li class={c.status} title={townTitle(c) + (town?.needs ? `\n${t("lists.needs", { needs: needsText(town.needs) })}` : "")}>
            <input type="checkbox" checked={c.status !== "off"} disabled={!!importer.running} onchange={() => importer.toggleTown(c.key)} />
            <button class="name" onclick={() => onFocus("town", c.key)}>{c.name}{#if c.status === "placed" && roadless.has(c.key)}<span class="warn"> · {t("lists.noRoad")}</span>{/if}</button>
            <span class="pop">{c.estimated ? "≈ " : ""}{fmtNum(c.rank)}</span>
            {#if town?.shares}<span class="pop" title={t("lists.sharesTitle")}>{pct(town.shares.com)}/{pct(town.shares.ind)} %</span>{/if}
            <span class="state">
              {c.status === "placed" ? c.capacity : c.status === "off" ? "" : t("lists.notPlaced")}
              {#if c.pick !== null}<button class="link" title={t("lists.autoTitle")} onclick={() => importer.setPick(c.key, null)}>{t("lists.auto")}</button>{/if}
            </span>
          </li>
        {/each}
      </ul>
      {#snippet failed(error, reset)}
        <p class="error">{t("lists.error", { what: t("lists.towns"), error: errorText(error) })} <button class="link" onclick={reset}>{t("lists.retry")}</button></p>
      {/snippet}
    </svelte:boundary>
  {:else if tab === "industries"}
    <svelte:boundary onerror={(e) => importer.report(e, t("lists.industries"))}>
      <div class="add">
        <span class="hint">{t("lists.industryHint")}</span>
        <button class="small" disabled={!!importer.running} onclick={() => importer.resetIndustryPicks()}>{t("lists.allAuto")}</button>
      </div>
      <ul class="rows">
        {#each pv.industryCandidates ?? [] as c (c.key)}
          <li class={c.status} title={industryTitle(c)}>
            <input type="checkbox" checked={c.status !== "off"} disabled={!!importer.running} onchange={() => importer.toggleIndustry(c.key)} />
            <i class="sq" style:background={industryColor(c.tag)}></i>
            <button class="name" onclick={() => onFocus("industry", c.key)}>{c.name}{#if c.missing}<span class="warn"> · {t("sheet.missingShort", { list: c.missing.map(industryLabel).join(", ") })}</span>{/if}</button>
            <span class="pop" title={t("lists.relevanceTitle")}>{tk(`originShort.${c.origin}`)} {c.relevance ? fmtNum(c.relevance, 1) : ""}</span>
            <span class="state">
              {c.status === "placed" || c.status === "off" ? "" : t("lists.notPlaced")}
              {#if c.pick !== null}<button class="link" title={t("lists.autoTitle")} onclick={() => importer.setIndustryPick(c.key, null)}>{t("lists.auto")}</button>{/if}
              {#if c.origin === "user"}<button class="del" title={t("lists.deleteIndustry")} onclick={() => importer.removeCustomIndustry(c.key)}>✕</button>{/if}
            </span>
          </li>
        {/each}
      </ul>
      {#snippet failed(error, reset)}
        <p class="error">{t("lists.error", { what: t("lists.industries"), error: errorText(error) })} <button class="link" onclick={reset}>{t("lists.retry")}</button></p>
      {/snippet}
    </svelte:boundary>
  {:else}
    {@const net = pv.network}
    <ResetRoads />
    <ul class="rows">
      {#each net.links as l (l.key)}
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
</div>

<style>
  .lists {
    position: absolute;
    top: 64px;
    left: 48px;
    bottom: 34px;
    width: min(400px, calc(100% - 20px));
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
</style>
