/**
 * App updates from the GitHub releases (as HQminiMap, DECISION-023). Installs that the Tauri
 * updater can replace (Windows installers, macOS app, AppImage) check its signed latest.json and
 * update in place, then restart; the portable zip, the .deb and dev builds only read the latest
 * release from the GitHub API and link to it. Only published releases count: drafts and
 * pre-releases are never offered.
 */
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { ask } from "@tauri-apps/plugin-dialog";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { isNewer } from "$lib/core/version";
import { t } from "$lib/i18n/index.svelte";
import { importer } from "./importer.svelte";

const REPO = "Spit8/RealMap";
export const RELEASES = `https://github.com/${REPO}/releases`;
const LS_AUTO = "importcity.updates.auto";
const LS_SKIP = "importcity.updates.skip";
const LS_LAST = "importcity.updates.lastCheck";
/** Startup check delay: leaves the first seconds to the app itself. */
const AUTO_DELAY_MS = 5000;

export type UpdatePhase = "idle" | "checking" | "upToDate" | "available" | "downloading" | "installing" | "error";
export type UpdateError = "network" | "notFound" | "limited" | "signature" | "install" | "other";

export interface AvailableUpdate {
  version: string;
  /** Release page (notes, every download, the mod zip). */
  url: string;
  date?: string;
}

interface InstallInfo {
  portable: boolean;
  selfUpdate: boolean;
}

function load(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function save(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* storage unavailable */
  }
}

export function errorCode(err: unknown): UpdateError {
  const msg = String(err).toLowerCase();
  if (msg.includes("signature")) return "signature";
  if (/\b403\b|rate limit/.test(msg)) return "limited";
  // No public release (private repository, or none published yet): not a connection problem.
  if (/valid release json|release.?not.?found|\b404\b|not found/.test(msg)) return "notFound";
  if (/network|fetch|request|connect|dns|timed out|http/.test(msg)) return "network";
  return "other";
}

class Updates {
  current = $state("");
  /** Install replaceable by the updater (false until init, in dev, portable and .deb). */
  selfUpdate = $state(false);
  portable = $state(false);
  phase = $state<UpdatePhase>("idle");
  available = $state<AvailableUpdate | null>(null);
  error = $state<UpdateError | null>(null);
  /** Download progress in bytes (total unknown when the server does not send it). */
  progress = $state<{ done: number; total: number | null } | null>(null);
  auto = $state(load(LS_AUTO) !== "0");
  skipped = $state<string | null>(load(LS_SKIP));
  lastCheck = $state<number | null>(Number(load(LS_LAST)) || null);
  private update: Update | null = null;
  private ready: Promise<void> | null = null;

  /** Header badge: a newer version the user did not set aside. */
  get badge(): boolean {
    return this.available !== null && this.available.version !== this.skipped;
  }

  init(): Promise<void> {
    this.ready ??= (async () => {
      try {
        this.current = await getVersion();
      } catch (err) {
        console.warn("getVersion", err);
        this.current = this.current || "0.0.0";
      }
      try {
        const info = await invoke<InstallInfo>("install_info");
        this.portable = info.portable;
        this.selfUpdate = info.selfUpdate && !import.meta.env.DEV;
      } catch (err) {
        console.warn("install_info", err);
      }
    })();
    return this.ready;
  }

  /** Startup: one check after a short delay, if enabled. */
  start(): () => void {
    const timer = setTimeout(() => {
      if (this.auto) void this.checkNow();
    }, AUTO_DELAY_MS);
    return () => clearTimeout(timer);
  }

  setAuto(on: boolean): void {
    this.auto = on;
    save(LS_AUTO, on ? null : "0");
  }

  skip(): void {
    this.skipped = this.available?.version ?? null;
    save(LS_SKIP, this.skipped);
  }

  async checkNow(): Promise<void> {
    if (this.phase === "checking" || this.phase === "downloading" || this.phase === "installing") return;
    await this.init();
    this.phase = "checking";
    this.error = null;
    try {
      this.available = this.selfUpdate ? await this.checkUpdater() : await this.checkGitHub();
      this.phase = this.available ? "available" : "upToDate";
      this.lastCheck = Date.now();
      save(LS_LAST, String(this.lastCheck));
    } catch (err) {
      console.warn("update check", err);
      this.error = errorCode(err);
      this.phase = "error";
    }
  }

  private async checkUpdater(): Promise<AvailableUpdate | null> {
    await this.update?.close();
    this.update = await check();
    if (!this.update || !isNewer(this.update.version, this.current)) return null;
    const v = this.update.version.replace(/^v/, "");
    return { version: v, url: `${RELEASES}/tag/v${v}`, date: this.update.date };
  }

  private async checkGitHub(): Promise<AvailableUpdate | null> {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const rel = (await res.json()) as { tag_name: string; html_url: string; published_at?: string };
    if (!isNewer(rel.tag_name, this.current)) return null;
    return { version: rel.tag_name.replace(/^v/, ""), url: rel.html_url, date: rel.published_at };
  }

  /** Download, install (the installer closes the app on Windows) and restart. */
  async install(): Promise<void> {
    if (!this.update || !this.selfUpdate) return;
    if (importer.running) {
      const ok = await ask(t("updates.busy"), {
        title: t("updates.title"), kind: "warning", okLabel: t("updates.install"), cancelLabel: t("updates.cancel"),
      });
      if (!ok) return;
    }
    this.phase = "downloading";
    this.error = null;
    this.progress = { done: 0, total: null };
    try {
      await this.update.downloadAndInstall((ev) => {
        if (ev.event === "Started") this.progress = { done: 0, total: ev.data.contentLength ?? null };
        else if (ev.event === "Progress" && this.progress) this.progress = { ...this.progress, done: this.progress.done + ev.data.chunkLength };
        else if (ev.event === "Finished") this.phase = "installing";
      });
      await relaunch();
    } catch (err) {
      console.warn("update install", err);
      const code = errorCode(err);
      this.error = code === "other" ? "install" : code;
      this.phase = "error";
    } finally {
      this.progress = null;
    }
  }
}

export const updates = new Updates();
