import { afterEach, describe, expect, it, vi } from "vitest";
import { findFixedVersionTool } from "./find-fixed-version.js";

describe("findFixedVersionTool", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("handles v-prefixed versions and pre-releases without NaN errors", async () => {
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

    const result = await findFixedVersionTool.execute({
      packageName: "foo",
      installedVersion: "v1.2.3",
      firstPatchedVersion: "2.0.0",
      vulnerableRange: "<2.0.0",
    });

    expect(result.safeVersion).toBe("2.0.0");
    expect(result.isMajorBump).toBe(true);
    expect(result.majorOnlyFixAvailable).toBe(true);
    expect(result.message).toContain("only a major upgrade is available");
  });

  it("correctly identifies non-major bump for patch upgrades", async () => {
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
            },
          }),
      }),
    );

    const result = await findFixedVersionTool.execute({
      packageName: "foo",
      installedVersion: "1.2.3",
      firstPatchedVersion: "1.2.4",
      vulnerableRange: "<1.2.4",
    });

    expect(result.safeVersion).toBe("1.2.4");
    expect(result.upgradeLevel).toBe("patch");
    expect(result.isMajorBump).toBe(false);
    expect(result.message).toContain("Found patch upgrade 1.2.4");
  });

  it("returns appropriate message when no safe version is found", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            versions: {
              "1.2.3": { version: "1.2.3", dist: { tarball: "https://example.test/1.2.3.tgz" } },
            },
          }),
      }),
    );

    const result = await findFixedVersionTool.execute({
      packageName: "foo",
      installedVersion: "1.2.3",
      firstPatchedVersion: "1.3.0",
      vulnerableRange: "<1.3.0",
    });

    expect(result.safeVersion).toBeUndefined();
    expect(result.isMajorBump).toBe(false);
    expect(result.message).toContain("No safe upgrade version found");
  });
});
