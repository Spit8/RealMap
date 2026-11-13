import { describe, expect, it } from "vitest";
import type { TownCandidate } from "../src/lib/core/towns";
import { foldName, SHOWN_OFF, shownTownKeys } from "../src/lib/ui/townMarkers";

const cand = (name: string, rank: number, status: TownCandidate["status"]): TownCandidate => ({
  key: name, name, place: "town", lon: 0, lat: 0, rank, estimated: false, pick: null, status,
});

describe("town list", () => {
  it("shows the chosen towns, the ones not placed, and the 10 most populous others", () => {
    const all = [
      cand("A", 90_000, "placed"),
      ...Array.from({ length: 15 }, (_, k) => cand(`off${k}`, 50_000 - k, "off")),
      cand("B", 1_000, "dropped"),
      cand("C", 500, "placed"),
    ];
    const keys = shownTownKeys(all);
    expect(keys.has("A") && keys.has("B") && keys.has("C")).toBe(true);
    expect([...keys].filter((k) => k.startsWith("off"))).toHaveLength(SHOWN_OFF);
    expect(keys.has("off0") && !keys.has("off14")).toBe(true);
  });

  it("finds places without accents or case", () => {
    expect(foldName("Écully")).toBe("ecully");
    expect(foldName("Cherbourg-en-Cotentin").includes(foldName("Cher"))).toBe(true);
  });
});
