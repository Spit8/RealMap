import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const meta = join(__dirname, "..", "..", "importcity", "mod", "_metadata");

describe("mod page", () => {
  // The game's Mod Manager renders description.html with its own rich text: an unknown tag or
  // entity crashes the game when the mod's page opens ("Unbound UI transformation for tag name",
  // seen 2026-11-01 with <code>, <i> and &lt;). Only the tags HQminiMap's page uses are safe.
  it("description.html uses only the tags the game renders", () => {
    const html = readFileSync(join(meta, "description.html"), "utf8");
    const tags = new Set([...html.matchAll(/<\/?([a-zA-Z0-9]+)/g)].map((m) => m[1].toLowerCase()));
    for (const tag of tags) expect(["p", "b", "h2", "ul", "ol", "li", "a"], tag).toContain(tag);
    expect(html).not.toMatch(/&[a-z]+;|&#\d+;/);
  });

  it("modinfo.json has a summary for every language of the app", () => {
    const info = JSON.parse(readFileSync(join(meta, "modinfo.json"), "utf8"));
    expect(info.name).toBe("RealMap");
    for (const lang of ["fr", "de", "it", "es", "zh_CN"]) expect(info.localization[lang]?.summary, lang).toBeTruthy();
  });
});
