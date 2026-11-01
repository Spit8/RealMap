/**
 * The app and the game talk through two userdata files (DECISION-012): the game cannot be called
 * from outside. After writing the map's files, the app writes `<UD>/importcity/request.lua`; the
 * importcity mod (running in the Map Editor) picks it up, builds the map in a fixed order and
 * reports each stage in `<UD>/importcity/status.lua`, which the app reads back.
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

/** What the app writes in `request.lua`: a new `id` asks the mod for a new generation. */
export function requestData(name: string, createdAt: number, id: number): { id: number; name: string; createdAt: number } {
  return { id, name, createdAt };
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
