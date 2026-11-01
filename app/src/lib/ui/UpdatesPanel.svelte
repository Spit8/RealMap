<script lang="ts">
  /**
   * App updates (DECISION-023, after HQminiMap): installed version, check, install and restart with
   * progress (or a link to the release for the portable zip and the .deb), skip a version, check at
   * startup. Shown in the Export tab; the header badge opens it.
   */
  import { openUrl } from "@tauri-apps/plugin-opener";
  import { updates } from "$lib/state/updates.svelte";
  import { fmtNum, i18n, t, tk } from "$lib/i18n/index.svelte";

  void updates.init();
  const busy = $derived(updates.phase === "checking" || updates.phase === "downloading" || updates.phase === "installing");
  const mb = (b: number) => fmtNum(b / 1_048_576, 1);
  const fmtDate = (ms: number) => new Date(ms).toLocaleString(i18n.tag, { dateStyle: "short", timeStyle: "short" });
  const open = (url: string) => void openUrl(url).catch(() => window.open(url, "_blank"));
</script>

<div class="updates">
  <div class="line">
    <span class="k">{t("updates.installed")}</span>
    <span class="v">{updates.current ? `v${updates.current}` : "…"}</span>
    <button disabled={busy} onclick={() => updates.checkNow()}>{t("updates.check")}</button>
  </div>
  <div class="line">
    <span class="k">{t("updates.status")}</span>
    <span class="v">
      {#if updates.phase === "checking"}<span class="dim">{t("updates.checking")}</span>
      {:else if updates.phase === "upToDate"}<span class="ok">{t("updates.upToDate")}</span>
      {:else if updates.phase === "error"}<span class="err">{tk(`updates.err.${updates.error ?? "other"}`)}</span>
      {:else if updates.available}<span class="ok">{t("updates.available", { version: updates.available.version })}</span>
      {:else}<span class="dim">{t("updates.never")}</span>{/if}
    </span>
  </div>
  {#if updates.available && updates.phase !== "upToDate"}
    {@const av = updates.available}
    {#if updates.phase === "downloading" || updates.phase === "installing"}
      <div class="line">
        <span class="k">{t(updates.phase === "installing" ? "updates.installing" : "updates.downloading")}</span>
        <progress value={updates.progress?.total ? updates.progress.done / updates.progress.total : undefined}></progress>
        {#if updates.progress}<span class="v">{updates.progress.total ? `${mb(updates.progress.done)} / ` : ""}{t("updates.mb", { v: mb(updates.progress.total ?? updates.progress.done) })}</span>{/if}
      </div>
    {:else}
      <div class="buttons">
        {#if updates.selfUpdate}
          <button class="go" onclick={() => updates.install()}>{t("updates.install")}</button>
        {:else}
          <button class="go" onclick={() => open(av.url)}>{t("updates.download")}</button>
        {/if}
        <button onclick={() => open(av.url)}>{t("updates.notes")}</button>
        {#if updates.skipped !== av.version}<button class="link" onclick={() => updates.skip()}>{t("updates.skip")}</button>{/if}
      </div>
      {#if !updates.selfUpdate}<p class="dim">{t(updates.portable ? "updates.manualPortable" : "updates.manual")}</p>{/if}
    {/if}
  {/if}
  <label class="check"><input type="checkbox" checked={updates.auto} onchange={(e) => updates.setAuto(e.currentTarget.checked)} /> {t("updates.auto")}</label>
  <p class="dim">
    {#if updates.lastCheck}{t("updates.lastCheck", { date: fmtDate(updates.lastCheck) })} · {/if}{t("updates.modHint")}
  </p>
</div>

<style>
  .updates {
    font-size: 13px;
  }
  .line {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 4px 0;
  }
  .k {
    color: #5b6670;
    min-width: 110px;
  }
  .v {
    flex: 1;
    font-variant-numeric: tabular-nums;
  }
  progress {
    flex: 1;
  }
  .buttons {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin: 6px 0;
  }
  button {
    font: inherit;
    padding: 3px 8px;
    cursor: pointer;
  }
  button.go {
    background: #2e9d4a;
    color: #fff;
    border: 1px solid #2e9d4a;
    border-radius: 4px;
    font-weight: 600;
  }
  button.link {
    border: none;
    background: none;
    color: #2a6fdb;
    text-decoration: underline;
  }
  button:disabled {
    opacity: 0.6;
    cursor: default;
  }
  .ok {
    color: #1f7a39;
  }
  .err {
    color: #b00020;
  }
  .dim {
    color: #6b747c;
    font-size: 12px;
    margin: 4px 0;
  }
  .check {
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: 6px;
    margin: 6px 0 2px;
  }
</style>
