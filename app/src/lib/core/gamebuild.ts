/**
 * The game's build, from its log (`<UD>/crash_dump/stdout.txt`, rewritten at each launch): a game
 * update can change what mods may do (build 40423 restricted the userdata folders, FACT-034), so
 * the app says, discreetly, when the game is not a build RealMap was tested with.
 */

/**
 * Builds RealMap was tested with. 40425 only changed the build number over 40423 (same scripts,
 * PR #187 of Transport-Fever-3-Multiplayer-Mod). After a game update: test, then add it here.
 */
export const TESTED_BUILDS = [40423, 40425];

/** `Starting up build version: 40423, build name "Build"` → 40423; null when not found. */
export function parseGameBuild(stdout: string | null): number | null {
  const m = stdout ? /Starting up build version:\s*(\d+)/.exec(stdout) : null;
  return m ? Number(m[1]) : null;
}

export type BuildWarning = "newer" | "older";

/** Null for a tested (or unknown) build, else whether it is newer or older than the tested ones. */
export function buildWarning(build: number | null): BuildWarning | null {
  if (build === null || TESTED_BUILDS.includes(build)) return null;
  return build > Math.max(...TESTED_BUILDS) ? "newer" : build < Math.min(...TESTED_BUILDS) ? "older" : null;
}

/** The tested builds as shown to the user. */
export const testedBuildsText = (): string => TESTED_BUILDS.join(", ");
