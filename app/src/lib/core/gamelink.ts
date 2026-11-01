/**
 * The app and the game talk through two userdata files (DECISION-012): the game cannot be called
 * from outside. After writing the map's files, the app writes `<UD>/towns_industries/realmap_request.lua`; the
 * importcity mod (running in the Map Editor) picks it up, builds the map in a fixed order and
 * reports each stage in `<UD>/towns_industries/realmap_status.lua`, which the app reads back.
 */
import { parseUserdata } from "./luadata";

/** Stages in the order the mod runs them. */
export const GAME_STAGES: { id: GameStage; label: string }[] = [
  { id: "heightmap", label: "Relief (heightmap)" },
  { id: "biomes", label: "Biomes" },
  // Before towns, industries and roads (DECISION-014): they adapt to the track, not the reverse.
  { id: "rail", label: "Voie ferrée" },
  { id: "towns", label: "Villes et tailles" },
  { id: "industries", label: "Industries et noms" },
  { id: "roads", label: "Routes entre villes" },
];

export type GameStage = "heightmap" | "biomes" | "towns" | "industries" | "roads" | "rail";

export interface GameStatus {
  /** The request answered. */
  id: number;
  stage: GameStage | "check" | "done" | "error";
  message: string;
  /** Stage the error happened in (stage = "error"). */
  failed?: string;
  /** One line per finished stage, for the log. */
  report: string[];
}

/**
 * What the app writes in `request.lua`: a new `id` asks the mod for a new generation. `cancelled`
 * when the app gave up waiting: the mod must not run it later (the app no longer follows it).
 */
export function requestData(
  name: string, createdAt: number, id: number, cancelled = false,
): { id: number; name: string; createdAt: number; cancelled?: boolean } {
  return cancelled ? { id, name, createdAt, cancelled } : { id, name, createdAt };
}

/** What the mod made of the last request it read (DECISION-024). */
export type AliveDecision = "accepted" | "answered" | "baseline" | "cancelled" | "unreadable";

/** `<UD>/towns_industries/realmap_alive.lua`: the mod's sign of life, rewritten every few seconds. */
export interface GameAlive {
  version: string;
  /** The userdata folder the game uses (as the game writes it). */
  userdata: string;
  editor: boolean;
  busy: boolean;
  /** Id of the last request read and what the mod made of it. */
  seen?: number;
  decision?: AliveDecision;
}

/** alive.lua older than this (by the file's date): the mod is not running (it rewrites it every ~5 s). */
export const ALIVE_STALE_MS = 60_000;

export function parseAlive(text: string | null): GameAlive | null {
  if (!text) return null;
  const v = parseUserdata(text) as Record<string, unknown> | null;
  if (!v || typeof v !== "object" || typeof v.version !== "string") return null;
  return {
    version: v.version,
    userdata: typeof v.userdata === "string" ? v.userdata : "",
    editor: v.editor === true,
    busy: v.busy === true,
    seen: typeof v.seen === "number" ? v.seen : undefined,
    decision: typeof v.decision === "string" ? (v.decision as AliveDecision) : undefined,
  };
}

/** The mod is running in that folder: alive.lua rewritten less than ALIVE_STALE_MS ago. */
export function isAlive(alive: GameAlive | null, ageMs: number | null): alive is GameAlive {
  return alive !== null && ageMs !== null && ageMs < ALIVE_STALE_MS;
}

/**
 * The mod found request `id` already there when it started looking (sent while the Map Editor was
 * loading, say) and left it alone: the app sends it again under a new id.
 */
export function shouldResend(alive: GameAlive | null, ageMs: number | null, id: number): boolean {
  return isAlive(alive, ageMs) && alive.seen === id && alive.decision === "baseline";
}

/** Why the game did not answer request `id`, from alive.lua (null = missing). */
export type NoAnswer = "silent" | "notEditor" | "busy" | "oldMod" | "notTaken";

export function diagnoseNoAnswer(alive: GameAlive | null, ageMs: number | null, appVersion: string | null): NoAnswer {
  if (!isAlive(alive, ageMs)) return "silent";
  if (!alive.editor) return "notEditor";
  if (alive.busy) return "busy";
  if (appVersion && alive.version !== appVersion) return "oldMod";
  return "notTaken";
}

/** `status.lua` as written by the mod, or null when it is missing or not one. */
export function parseGameStatus(text: string | null): GameStatus | null {
  if (!text) return null;
  const v = parseUserdata(text) as Record<string, unknown> | null;
  if (!v || typeof v !== "object" || typeof v.id !== "number" || typeof v.stage !== "string") return null;
  const report = Array.isArray(v.report) ? v.report.filter((x): x is string => typeof x === "string") : [];
  return {
    id: v.id,
    stage: v.stage as GameStatus["stage"],
    message: typeof v.message === "string" ? v.message : "",
    failed: typeof v.failed === "string" ? v.failed : undefined,
    report,
  };
}

export type StepState = "wait" | "run" | "done" | "skip" | "fail";

/** The stage list as shown in the app, from the last status (null = not answered yet). */
export function gameSteps(st: GameStatus | null): { id: string; label: string; state: StepState; detail?: string }[] {
  const at = st ? GAME_STAGES.findIndex((g) => g.id === (st.stage === "error" ? st.failed : st.stage)) : -1;
  return GAME_STAGES.map((g, k) => {
    let state: StepState = "wait";
    if (st?.stage === "done" || (at >= 0 && k < at)) state = "done";
    else if (k === at) state = st?.stage === "error" ? "fail" : "run";
    return { id: g.id, label: g.label, state, detail: k === at ? st?.message || undefined : undefined };
  });
}

/** Share of the stages done (for the progress bar). */
export function gameProgress(st: GameStatus | null): number {
  if (!st) return 0;
  if (st.stage === "done") return 1;
  const at = GAME_STAGES.findIndex((g) => g.id === st.stage);
  return at < 0 ? 0 : (at + 0.5) / GAME_STAGES.length;
}
