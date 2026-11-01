import { describe, expect, it } from "vitest";
import { gameProgress, gameSteps, parseGameStatus, requestData } from "../src/lib/core/gamelink";
import { parseUserdata, toUserdata } from "../src/lib/core/luadata";

describe("app ↔ game", () => {
  it("writes the request the mod reads", () => {
    const back = parseUserdata(toUserdata(requestData("Lyon", 1730000000, 1730000000123)));
    expect(back).toEqual({ id: 1730000000123, name: "Lyon", createdAt: 1730000000 });
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
