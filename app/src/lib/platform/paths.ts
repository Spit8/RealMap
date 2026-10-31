/**
 * TF3 folders written by the app, all under the userdata root (`<UD>`). The Map Editor reads
 * heightmaps from `<UD>/heightmaps` and town lists from `<UD>/towns_industries` (FACT-001/002);
 * the app's own notes (real heights, area) go to `<UD>/importcity`.
 */
import { invoke } from "@tauri-apps/api/core";
import { joinPath } from "./fsx";

export interface GamePaths {
  userdata: string;
  heightmaps: string;
  townsIndustries: string;
  notes: string;
}

export function gamePaths(userdata: string): GamePaths {
  return {
    userdata,
    heightmaps: joinPath(userdata, "heightmaps"),
    townsIndustries: joinPath(userdata, "towns_industries"),
    notes: joinPath(userdata, "importcity"),
  };
}

export interface DetectedPaths {
  userdata: string | null;
  candidates: string[];
}

export async function detectUserdata(): Promise<DetectedPaths> {
  try {
    return await invoke("detect_paths");
  } catch {
    return { userdata: null, candidates: [] };
  }
}

/** Let the fs plugin write in a folder outside its static scope (chosen by hand). */
export async function allowDirs(dirs: string[]): Promise<void> {
  try {
    await invoke("allow_dirs", { dirs });
  } catch {
    /* not in Tauri (tests) */
  }
}
