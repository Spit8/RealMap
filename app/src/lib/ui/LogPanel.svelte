<script lang="ts">
  /**
   * The « Journal » tab (DECISION-016): what each step did, warnings, errors, and (« Détails ») the
   * technical journal, over the whole height of the panel.
   */
  import { importer } from "$lib/state/importer.svelte";
  import { t } from "$lib/i18n/index.svelte";

  let details = $state(false);
  let list: HTMLDivElement | undefined = $state();

  const shown = $derived(details ? importer.events : importer.events.filter((e) => e.level !== "debug"));
  // Follow the newest line.
  $effect(() => {
    void shown.length;
    if (list) list.scrollTop = list.scrollHeight;
  });

  function copy(): void {
    void navigator.clipboard?.writeText(importer.events.map((e) => `${e.time} ${e.level} ${e.text}`).join("\n"));
  }
</script>

<section class="log">
  <div class="bar">
    <span class="count">{t("log.lines", { n: shown.length })}</span>
    <label><input type="checkbox" bind:checked={details} /> {t("log.details")}</label>
    <button class="link" onclick={copy}>{t("log.copy")}</button>
    <button class="link" onclick={() => importer.clearLog()}>{t("log.clear")}</button>
  </div>
  <div class="lines" bind:this={list}>
    {#each shown as e, i (i)}
      <div class={e.level}><span class="t">{e.time}</span> {e.text}</div>
    {:else}
      <p class="empty">{t("log.empty")}</p>
    {/each}
  </div>
</section>

<style>
  .log {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    background: #f7f8fa;
    font-size: 12px;
  }
  .bar {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 14px;
    border-bottom: 1px solid #d5d9de;
  }
  .bar label {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .count {
    flex: 1;
    color: #5b6670;
  }
  .lines {
    flex: 1;
    overflow-y: auto;
    padding: 6px 14px;
    font-family: ui-monospace, Consolas, monospace;
    font-size: 11px;
    white-space: pre-wrap;
  }
  .empty {
    color: #8a949d;
    font-family: system-ui, sans-serif;
  }
  .t {
    color: #8a949d;
  }
  .warn {
    color: #9a5b00;
  }
  .error {
    color: #b00020;
  }
  .debug {
    color: #6b747c;
  }
  button.link {
    border: none;
    background: none;
    padding: 0;
    color: #2a6fdb;
    cursor: pointer;
    font-size: 11px;
    text-decoration: underline;
  }
</style>
