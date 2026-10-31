<script lang="ts">
  /**
   * The log at the bottom of the left panel: what each step did, warnings, errors, and (« Détails »)
   * the technical journal. Folds away; opens by itself on an error.
   */
  import { importer } from "$lib/state/importer.svelte";

  const OPEN_KEY = "importcity.logOpen";
  const read = (): boolean => {
    try {
      return localStorage.getItem(OPEN_KEY) !== "0";
    } catch {
      return true;
    }
  };
  let open = $state(read());
  let details = $state(false);
  let list: HTMLDivElement | undefined = $state();
  $effect(() => {
    try {
      localStorage.setItem(OPEN_KEY, open ? "1" : "0");
    } catch {
      /* storage unavailable */
    }
  });

  const shown = $derived(details ? importer.events : importer.events.filter((e) => e.level !== "debug"));
  const errors = $derived(importer.events.filter((e) => e.level === "error").length);
  let seenErrors = 0;
  $effect(() => {
    if (errors > seenErrors) open = true;
    seenErrors = errors;
  });
  // Follow the newest line.
  $effect(() => {
    void shown.length;
    if (list) list.scrollTop = list.scrollHeight;
  });

  function copy(): void {
    void navigator.clipboard?.writeText(importer.events.map((e) => `${e.time} ${e.level} ${e.text}`).join("\n"));
  }
</script>

<section class="log" class:open>
  <div class="bar">
    <button class="toggle" onclick={() => (open = !open)}>{open ? "▾" : "▸"} Journal ({shown.length}){errors ? ` · ${errors} erreur${errors > 1 ? "s" : ""}` : ""}</button>
    {#if open}
      <label><input type="checkbox" bind:checked={details} /> Détails</label>
      <button class="link" onclick={copy}>Copier</button>
      <button class="link" onclick={() => importer.clearLog()}>Effacer</button>
    {/if}
  </div>
  {#if open}
    <div class="lines" bind:this={list}>
      {#each shown as e, i (i)}
        <div class={e.level}><span class="t">{e.time}</span> {e.text}</div>
      {/each}
    </div>
  {/if}
</section>

<style>
  .log {
    border-top: 1px solid #d5d9de;
    background: #f7f8fa;
    font-size: 12px;
  }
  .log.open {
    height: 30%;
    min-height: 120px;
    display: flex;
    flex-direction: column;
  }
  .bar {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 4px 10px;
  }
  .bar label {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .toggle {
    flex: 1;
    text-align: left;
    border: none;
    background: none;
    font: inherit;
    font-weight: 600;
    cursor: pointer;
    padding: 0;
  }
  .lines {
    flex: 1;
    overflow-y: auto;
    padding: 0 10px 6px;
    font-family: ui-monospace, Consolas, monospace;
    font-size: 11px;
    white-space: pre-wrap;
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
