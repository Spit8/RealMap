import { describe, expect, it } from "vitest";
import {
  ALIVE_STALE_MS, diagnoseNoAnswer, gameProgress, gameSteps, parseAlive, parseGameStatus, requestData, shouldResend,
} from "../src/lib/core/gamelink";
import { parseUserdata, toUserdata } from "../src/lib/core/luadata";

describe("app ↔ game", () => {
  it("writes the request the mod reads", () => {
    const back = parseUserdata(toUserdata(requestData("Lyon", 1730000000, 1730000000123)));
    expect(back).toEqual({ id: 1730000000123, name: "Lyon", createdAt: 1730000000 });
    // Given up by the app: cancelled, so the mod never runs it later.
    expect(parseUserdata(toUserdata(requestData("Lyon", 1, 2, true)))).toEqual({ id: 2, name: "Lyon", createdAt: 1, cancelled: true });
  });

  // alive.lua as app.saveUserdata writes it (DECISION-024).
  const aliveText = (fields: string) =>
    `function data()
return {
	busy = false,
	editor = true,
	pump = "button",
	ticks = 301,
	userdata = "C:/Steam/userdata/1/3493540/local/",
	version = "1.0.1",
${fields}}
end
`;

  it("reads the mod's sign of life", () => {
    const a = parseAlive(aliveText(`	seen = 42,
	decision = "baseline",
`))!;
    expect(a).toEqual({ version: "1.0.1", userdata: "C:/Steam/userdata/1/3493540/local/", editor: true, busy: false, seen: 42, decision: "baseline" });
    expect(parseAlive(aliveText(""))!.seen).toBeUndefined();
    expect(parseAlive(null)).toBeNull();
    expect(parseAlive("function data() return { ticks = 1 } end")).toBeNull();
  });

  it("sends a request again only when the mod found it there at start", () => {
    const base = parseAlive(aliveText(`	seen = 42,
	decision = "baseline",
`));
    expect(shouldResend(base, 1000, 42)).toBe(true);
    expect(shouldResend(base, 1000, 43)).toBe(false);
    expect(shouldResend(base, ALIVE_STALE_MS + 1, 42)).toBe(false);
    expect(shouldResend(parseAlive(aliveText(`	seen = 42,
	decision = "accepted",
`)), 1000, 42)).toBe(false);
    expect(shouldResend(null, null, 42)).toBe(false);
  });

  it("says why the game does not answer", () => {
    const alive = (extra: string) => parseAlive(aliveText(extra));
    expect(diagnoseNoAnswer(null, null, "1.0.1")).toBe("silent");
    expect(diagnoseNoAnswer(alive(""), ALIVE_STALE_MS + 1, "1.0.1")).toBe("silent");
    expect(diagnoseNoAnswer({ ...alive("")!, editor: false }, 1000, "1.0.1")).toBe("notEditor");
    expect(diagnoseNoAnswer({ ...alive("")!, busy: true }, 1000, "1.0.1")).toBe("busy");
    expect(diagnoseNoAnswer(alive(""), 1000, "1.0.2")).toBe("oldMod");
    expect(diagnoseNoAnswer(alive(""), 1000, null)).toBe("notTaken");
    expect(diagnoseNoAnswer(alive(""), 1000, "1.0.1")).toBe("notTaken");
  });

  it("reads the mod's status (as app.saveUserdata writes it)", () => {
    const text = `function data()\nreturn {\n\tid = 42,\n\tmessage = "Industries 3/9",\n\treport = { [1] = "Relief importé", [2] = "Biomes importés" },\n\tstage = "industries",\n}\nend\n`;
    const st = parseGameStatus(text)!;
    expect(st).toMatchObject({ id: 42, stage: "industries", message: "Industries 3/9" });
    expect(st.report).toEqual(["Relief importé", "Biomes importés"]);
    expect(parseGameStatus("")).toBeNull();
    expect(parseGameStatus("function data() return { foo = 1 } end")).toBeNull();
  });

  it("shows the stages in order: done, running, waiting; an error on its stage", () => {
    const run = gameSteps({ id: 1, stage: "towns", message: "Villes", report: [] });
    expect(run.map((s) => s.state)).toEqual(["done", "done", "done", "run", "wait", "wait"]);
    expect(run[3].detail).toBe("Villes");
    const err = gameSteps({ id: 1, stage: "error", failed: "biomes", message: "Fichier absent", report: [] });
    expect(err.map((s) => s.state)).toEqual(["done", "fail", "wait", "wait", "wait", "wait"]);
    expect(gameSteps({ id: 1, stage: "done", message: "", report: [] }).every((s) => s.state === "done")).toBe(true);
    expect(gameSteps(null).every((s) => s.state === "wait")).toBe(true);
    expect(gameProgress({ id: 1, stage: "done", message: "", report: [] })).toBe(1);
    expect(gameProgress({ id: 1, stage: "heightmap", message: "", report: [] })).toBeCloseTo(0.5 / 6, 6);
  });
});
