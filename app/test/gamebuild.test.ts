import { describe, expect, it } from "vitest";
import { buildWarning, parseGameBuild, TESTED_BUILDS } from "../src/lib/core/gamebuild";

describe("game build", () => {
  it("reads the build from the game's log", () => {
    const log = `[2026-11-01 12:09:35Z - MESSAGE  - Main             - Main           ]  User data folder: C:/x/\n` +
      `[2026-11-01 12:09:35Z - MESSAGE  - Main             - Main           ]  Starting up build version: 40423, build name "Build"\n`;
    expect(parseGameBuild(log)).toBe(40423);
    expect(parseGameBuild("no build here")).toBeNull();
    expect(parseGameBuild(null)).toBeNull();
  });

  it("warns only outside the tested builds", () => {
    for (const b of TESTED_BUILDS) expect(buildWarning(b)).toBeNull();
    expect(buildWarning(null)).toBeNull();
    expect(buildWarning(Math.max(...TESTED_BUILDS) + 1)).toBe("newer");
    expect(buildWarning(40408)).toBe("older");
  });
});
