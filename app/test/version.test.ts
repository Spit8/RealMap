import { describe, expect, it } from "vitest";
import { compareVersions, isNewer, parseVersion } from "../src/lib/core/version";

describe("app versions", () => {
  it("parses tags with or without v", () => {
    expect(parseVersion("v0.2.0")).toEqual({ major: 0, minor: 2, patch: 0, pre: [] });
    expect(parseVersion("1.10.3-beta.2")).toEqual({ major: 1, minor: 10, patch: 3, pre: ["beta", "2"] });
    expect(parseVersion("0.2")).toBeNull();
    expect(parseVersion("latest")).toBeNull();
  });

  it("orders numerically, not as text", () => {
    expect(compareVersions("0.10.0", "0.9.9")).toBe(1);
    expect(compareVersions("v0.2.0", "0.2.0")).toBe(0);
    expect(compareVersions("0.2.0", "0.3.0")).toBe(-1);
    expect(isNewer("1.0.0", "0.99.99")).toBe(true);
    expect(isNewer("0.2.0", "0.2.0")).toBe(false);
  });

  it("puts pre-releases before their release", () => {
    expect(compareVersions("0.3.0-beta.1", "0.3.0")).toBe(-1);
    expect(compareVersions("0.3.0-beta.2", "0.3.0-beta.10")).toBe(-1);
    expect(compareVersions("0.3.0-alpha", "0.3.0-beta")).toBe(-1);
    expect(compareVersions("0.3.0-beta", "0.3.0-beta.1")).toBe(-1);
    expect(isNewer("0.3.0-beta.1", "0.2.0")).toBe(true);
  });

  it("never announces an unparsable version", () => {
    expect(isNewer("garbage", "0.2.0")).toBe(false);
    expect(isNewer("0.2.0", "garbage")).toBe(true);
  });
});
