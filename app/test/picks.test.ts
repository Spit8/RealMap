import { describe, expect, it } from "vitest";
import { defaultSettings, optionsKeyOf, optionsOnlyKeyOf, pendingPickChanges } from "../src/lib/state/settings";

describe("choices wait for « Update the map »", () => {
  it("a town or industry pick does not change the options-only key", () => {
    const s = defaultSettings();
    const before = optionsOnlyKeyOf(s);
    s.townPicks = { "Lodz|19.4560,51.7590": true };
    s.industryPicks = { a: false };
    s.linkPicks = { "town:A|B": false };
    expect(optionsOnlyKeyOf(s)).toBe(before);
    s.towns = { ...s.towns, maxTowns: s.towns.maxTowns + 1 };
    expect(optionsOnlyKeyOf(s)).not.toBe(before);
  });

  it("counts the changes since the last computation", () => {
    const s = defaultSettings();
    s.townPicks = { a: true, b: false };
    const key = optionsKeyOf(s);
    expect(pendingPickChanges(key, s)).toBe(0);
    s.townPicks = { a: true, c: true, d: true };
    s.industryPicks = { x: false };
    s.customIndustries = [{ key: "user:farm|1,2", tag: "farm", lon: 1, lat: 2 }];
    // b back to auto, c and d added, x removed, one industry added by hand.
    expect(pendingPickChanges(key, s)).toBe(5);
    expect(pendingPickChanges("not json", s)).toBe(0);
  });
});
