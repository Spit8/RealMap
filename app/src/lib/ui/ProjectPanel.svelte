<script lang="ts">
  /**
   * « Projet » tab: the open projects as a tree (click = make it active, right click = Save, Save as,
   * Close; ✱ = changes not saved; the arrow shows what the project holds), and the active project's
   * journal below.
   */
  import { importer, sizeText } from "$lib/state/importer.svelte";
  import type { Project } from "$lib/state/project.svelte";
  import { fmtNum, t } from "$lib/i18n/index.svelte";
  import ContextMenu from "./ContextMenu.svelte";
  import { projectItems } from "./FileMenu.svelte";
  import LogPanel from "./LogPanel.svelte";

  let open = $state<Record<string, boolean>>({});
  let menu = $state<{ x: number; y: number; id: string } | null>(null);
  const busy = $derived(!!importer.running);

  function details(p: Project): string[] {
    const a = p.settings.area;
    return [
      t("project.zone", { size: sizeText(a.size, a.format, a.landscape), scale: a.scale, lat: fmtNum(a.lat, 3), lon: fmtNum(a.lon, 3) }),
      p.hasData ? t("project.dataOk", { relief: p.dataSummary!.relief }) : p.dataSummary ? t("project.dataStale") : t("project.noData"),
      p.resultFresh ? t("project.resultOk") : p.preview ? t("project.resultStale") : t("project.resultNone"),
      p.exportKey ? t("project.exported", { name: p.settings.name }) : t("project.notExported"),
      p.path ?? t("project.notSaved"),
    ];
  }

  function onMenu(e: MouseEvent, id: string): void {
    e.preventDefault();
    menu = { x: e.clientX, y: e.clientY, id };
  }
</script>

<div class="panel">
  <div class="tree">
    <div class="head">{t("project.open")}</div>
    <ul role="tree">
      {#each importer.projects as p (p.id)}
        {@const active = p.id === importer.active.id}
        {@const expanded = open[p.id] ?? active}
        <li role="treeitem" aria-selected={active} aria-expanded={expanded}>
          <div class="row" class:active>
            <button class="arrow" aria-label={t("project.details")} onclick={() => (open = { ...open, [p.id]: !expanded })}>{expanded ? "▾" : "▸"}</button>
            <button
              class="name"
              disabled={busy && !active}
              title={busy && !active ? t("file.busy") : (p.path ?? t("project.notSaved"))}
              onclick={() => importer.activate(p.id)}
              oncontextmenu={(e) => onMenu(e, p.id)}
            >
              {importer.projectName(p)}{#if p.dirty}<span class="star" title={t("project.modified")}> ✱</span>{/if}
              {#if p.loading}<span class="muted"> · {t("project.reading")}</span>{/if}
            </button>
          </div>
          {#if expanded}
            <ul class="details" role="group">
              {#each details(p) as line, i (i)}<li>{line}</li>{/each}
            </ul>
          {/if}
        </li>
      {/each}
    </ul>
  </div>
  <div class="log-title">{t("tabs.log")}</div>
  <LogPanel />
</div>

{#if menu}
  <ContextMenu x={menu.x} y={menu.y} items={projectItems(menu.id, false)} onClose={() => (menu = null)} />
{/if}

<style>
  .panel {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .tree {
    flex: 0 1 auto;
    max-height: 45%;
    overflow: auto;
    padding: 8px 10px 6px;
    border-bottom: 1px solid #d5d9de;
  }
  .head,
  .log-title {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: #5b6670;
  }
  .head {
    margin-bottom: 4px;
  }
  .log-title {
    padding: 6px 10px 2px;
    background: #f7f8fa;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .row {
    display: flex;
    align-items: center;
    border-radius: 4px;
  }
  .row:hover {
    background: #f1f5fb;
  }
  .row.active .name {
    color: #fd9401;
    font-weight: 600;
  }
  .arrow {
    width: 20px;
    border: 0;
    background: none;
    color: #5b6670;
    cursor: pointer;
    font-size: 11px;
    padding: 4px 0;
  }
  .name {
    flex: 1;
    min-width: 0;
    text-align: left;
    border: 0;
    background: none;
    padding: 4px 4px;
    font: inherit;
    font-size: 13px;
    color: #1d2329;
    cursor: pointer;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .name:disabled {
    cursor: default;
    color: #8a949d;
  }
  .star {
    color: #fd9401;
  }
  .muted {
    color: #8a949d;
    font-weight: normal;
  }
  .details {
    margin: 0 0 6px 24px;
    font-size: 11.5px;
    color: #5b6670;
  }
  .details li {
    padding: 1px 0;
    overflow-wrap: anywhere;
  }
</style>
