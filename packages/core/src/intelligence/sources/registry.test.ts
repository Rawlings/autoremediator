import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyUpgradeLevel, resolveSafeUpgradeVersion } from "./registry.js";

describe("resolveSafeUpgradeVersion", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("prefers patch upgrades before minor and major upgrades", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            versions: {
              "1.2.3": { version: "1.2.3", dist: { tarball: "https://example.test/1.2.3.tgz" } },
              "1.2.4": { version: "1.2.4", dist: { tarball: "https://example.test/1.2.4.tgz" } },
              "1.3.0": { version: "1.3.0", dist: { tarball: "https://example.test/1.3.0.tgz" } },
              "2.0.0": { version: "2.0.0", dist: { tarball: "https://example.test/2.0.0.tgz" } },
            },
          }),
      }),
    );

    const resolution = await resolveSafeUpgradeVersion(
      "lodash",
      "1.2.3",
      "1.2.4",
      ">=1.0.0 <1.2.4",
    );

    expect(resolution.safeVersion).toBe("1.2.4");
    expect(resolution.upgradeLevel).toBe("patch");
    expect(resolution.candidates).toEqual({
      patch: "1.2.4",
      minor: "1.3.0",
      major: "2.0.0",
    });
    expect(resolution.majorOnlyFixAvailable).toBe(false);
  });

  it("falls back to a minor upgrade when no patch upgrade exists", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            versions: {
              "1.2.3": { version: "1.2.3", dist: { tarball: "https://example.test/1.2.3.tgz" } },
              "1.3.1": { version: "1.3.1", dist: { tarball: "https://example.test/1.3.1.tgz" } },
              "2.0.0": { version: "2.0.0", dist: { tarball: "https://example.test/2.0.0.tgz" } },
            },
          }),
      }),
    );

    const resolution = await resolveSafeUpgradeVersion(
      "lodash",
      "1.2.3",
      "1.3.1",
      ">=1.0.0 <1.3.1",
    );

    expect(resolution.safeVersion).toBe("1.3.1");
    expect(resolution.upgradeLevel).toBe("minor");
    expect(resolution.candidates).toEqual({
      minor: "1.3.1",
      major: "2.0.0",
    });
    expect(resolution.majorOnlyFixAvailable).toBe(false);
  });

  it("flags when only a major upgrade can resolve the vulnerability", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            versions: {
              "1.2.3": { version: "1.2.3", dist: { tarball: "https://example.test/1.2.3.tgz" } },
              "2.0.0": { version: "2.0.0", dist: { tarball: "https://example.test/2.0.0.tgz" } },
            },
          }),
      }),
    );

    const resolution = await resolveSafeUpgradeVersion(
      "lodash",
      "1.2.3",
      "2.0.0",
      ">=1.0.0 <2.0.0",
    );

    expect(resolution.safeVersion).toBe("2.0.0");
    expect(resolution.upgradeLevel).toBe("major");
    expect(resolution.candidates).toEqual({
      major: "2.0.0",
    });
    expect(resolution.majorOnlyFixAvailable).toBe(true);
  });
});

describe("classifyUpgradeLevel", () => {
  it("classifies patch upgrades and identical versions", () => {
    expect(classifyUpgradeLevel("1.2.3", "1.2.4")).toBe("patch");
    expect(classifyUpgradeLevel("1.2.3", "1.2.3")).toBe("patch");
  });

  it("classifies minor upgrades within the same major", () => {
    expect(classifyUpgradeLevel("1.2.3", "1.3.0")).toBe("minor");
    expect(classifyUpgradeLevel("1.2.3", "1.3.1")).toBe("minor");
  });

  it("classifies major upgrades", () => {
    expect(classifyUpgradeLevel("1.2.3", "2.0.0")).toBe("major");
    expect(classifyUpgradeLevel("1.9.9", "2.0.0")).toBe("major");
  });

  it("never classifies major version downgrades as minor upgrades", () => {
    // Critical test: 5.0.0 -> 4.17.21 must return undefined, NOT minor
    expect(classifyUpgradeLevel("5.0.0", "4.17.21")).toBeUndefined();
    expect(classifyUpgradeLevel("2.0.0", "1.9.9")).toBeUndefined();
  });

  it("returns undefined for minor or patch downgrades", () => {
    expect(classifyUpgradeLevel("1.5.0", "1.4.9")).toBeUndefined();
    expect(classifyUpgradeLevel("1.2.3", "1.2.2")).toBeUndefined();
  });

  it("returns undefined for invalid semver input", () => {
    expect(classifyUpgradeLevel("invalid", "1.0.0")).toBeUndefined();
    expect(classifyUpgradeLevel("1.0.0", "invalid")).toBeUndefined();
  });
});
