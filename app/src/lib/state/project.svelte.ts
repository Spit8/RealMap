/**
 * One open map project (DECISION-036): its settings and everything computed for it (phase-1 data,
 * result, export, journal), plus where it lives on disk. The app (`importer.svelte.ts`) works on the
 * active project; the others wait as they are.
 */
import type { DataStep, DataSummary, LogEvent, PreviewState, RealLayer, RunResult } from "./importer.svelte";
import { projectTitle, type Inputs } from "./projectfile";
import { dataKeyOf, optionsKeyOf, type Settings } from "./settings";

let nextId = 1;

export class Project {
  readonly id = `p${nextId++}`;
  /** The `.realmap` file, null until saved once. */
  path = $state<string | null>(null);
  /** « Sans titre N » for a project never saved. */
  untitled = $state(1);
  settings = $state<Settings>() as Settings;
  events = $state<LogEvent[]>([]);
  dataSteps = $state<DataStep[]>([]);
  gameSteps = $state<DataStep[]>([]);
  exportSteps = $state<DataStep[]>([]);
  error = $state<string | null>(null);
  preview = $state<PreviewState | null>(null);
  result = $state<RunResult | null>(null);
  previewKey = $state("");
  exportKey = $state("");
  dataSummary = $state<DataSummary | null>(null);
  realLayer = $state.raw<RealLayer | null>(null);
  dataKey = $state("");
  /** Phase-1 data (not reactive: large typed arrays). Null when not fetched or left on disk. */
  previewInputs: { key: string; inputs: Inputs } | null = null;
  /** The data is in the project file and not loaded (an inactive saved project frees its memory). */
  dataOnDisk = $state(false);
  /** Being read from its file (session restored at start). */
  loading = $state(false);
  lastReport = "";
  /** `key` at the last save or open: the project is modified when they differ. */
  savedKey = $state("");

  /** What is saved: settings, data fetched for which area, result for which options. */
  key = $derived(JSON.stringify([this.settings, this.dataKey, this.previewKey]));
  dirty = $derived(this.key !== this.savedKey);
  title = $derived(this.path ? projectTitle(this.path) : "");

  constructor(settings: Settings, untitled = 1) {
    this.settings = settings;
    this.untitled = untitled;
    this.savedKey = this.key;
  }

  /** The project as it is now counts as saved (after a save, an open, or a new blank project). */
  markSaved(): void {
    this.savedKey = this.key;
  }

  /** Data fetched for the current area and sources. */
  get hasData(): boolean {
    return !!this.dataSummary && this.dataKey === dataKeyOf(this.settings);
  }

  /** A result on the map computed with the current options. */
  get resultFresh(): boolean {
    return !!this.preview && this.previewKey === optionsKeyOf(this.settings);
  }
}
