<script lang="ts">
  /**
   * « Appliquer les paramètres par défaut » for the town roads, shown once they were changed by hand
   * (DECISION-018). It forgets the user's roads, so it asks first, in the app (no `window.confirm`).
   */
  import { importer } from "$lib/state/importer.svelte";
  import { t } from "$lib/i18n/index.svelte";

  let asking = $state(false);
</script>

{#if importer.settings.roadsFrozen}
  <div class="reset">
    {#if asking}
      <span class="ask">{t("roads.resetConfirm")}</span>
      <button class="yes" disabled={!!importer.running} onclick={() => { asking = false; importer.resetRoads(); }}>{t("roads.resetYes")}</button>
      <button onclick={() => (asking = false)}>{t("roads.resetCancel")}</button>
    {:else}
      <span class="ask">{t("roads.manual")}</span>
      <button disabled={!!importer.running} title={t("roads.resetTitle")} onclick={() => (asking = true)}>{t("roads.reset")}</button>
    {/if}
  </div>
{/if}

<style>
  .reset {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    padding: 6px;
    font-size: 12px;
  }
  .ask {
    flex: 1 1 160px;
    color: #5b6670;
  }
  button {
    flex: none;
    font: inherit;
    padding: 3px 8px;
    cursor: pointer;
  }
  button.yes {
    background: #b00020;
    color: #fff;
    border: 1px solid #b00020;
    border-radius: 4px;
  }
  button:disabled {
    opacity: 0.6;
    cursor: default;
  }
</style>
