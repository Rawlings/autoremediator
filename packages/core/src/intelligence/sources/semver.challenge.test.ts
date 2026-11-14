import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveInventoryVersion } from "../../remediation/tools/check-inventory.js";
import { classifyUpgradeLevel, resolveSafeUpgradeVersion } from "./registry.js";

describe("Feature 14: Adversarial Semver Resolution & Classification (Co-located Challenge Suite)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("resolveInventoryVersion edge cases", () => {
    it("handles complex ranges, protocols, wildcards, and v-prefixes", () => {
      // Comparison ranges
      expect(resolveInventoryVersion(">=1.2.3 <2.0.0")).toBe("1.2.3");
      expect(resolveInventoryVersion(">1.2.3 <2.0.0")).toBe("1.2.4");
      expect(resolveInventoryVersion(">=0.0.1 <0.1.0")).toBe("0.0.1");

      // Caret & tilde edge cases
      expect(resolveInventoryVersion("^0.0.1")).toBe("0.0.1");
      expect(resolveInventoryVersion("^0.1.0")).toBe("0.1.0");
      expect(resolveInventoryVersion("~0.0.1")).toBe("0.0.1");

      // Workspace specifiers
      expect(resolveInventoryVersion("workspace:*")).toBe("0.0.0");
      expect(resolveInventoryVersion("workspace:^1.2.3")).toBe("1.2.3");
      expect(resolveInventoryVersion("workspace:~2.0.0")).toBe("2.0.0");
      expect(resolveInventoryVersion("workspace:1.0.0")).toBe("1.0.0");

      // v-prefixes and prereleases
      expect(resolveInventoryVersion("v1.2.3")).toBe("1.2.3");
      expect(resolveInventoryVersion("v1.2.3-beta.2")).toBe("1.2.3-beta.2");

      // npm: aliases
      expect(resolveInventoryVersion("npm:lodash@^4.17.21")).toBe("4.17.21");
      expect(resolveInventoryVersion("npm:@scope/pkg@>=2.0.0 <3.0.0")).toBe("2.0.0");

      // Wildcards
      expect(resolveInventoryVersion("*")).toBe("0.0.0");
      expect(resolveInventoryVersion("1.x")).toBe("1.0.0");
      expect(resolveInventoryVersion("1.2.x")).toBe("1.2.0");

      // Non-semver git URLs preserved
      expect(resolveInventoryVersion("git+https://github.com/org/repo.git")).toBe(
        "git+https://github.com/org/repo.git",
      );
    });
  });

  describe("classifyUpgradeLevel downgrade protection", () => {
    it("strictly returns undefined for all major version downgrades (never minor/patch)", () => {
      // Critical test: 5.0.0 -> 4.17.21 must NEVER return minor
      expect(classifyUpgradeLevel("5.0.0", "4.17.21")).toBeUndefined();
      expect(classifyUpgradeLevel("2.0.0", "1.9.9")).toBeUndefined();
      expect(classifyUpgradeLevel("10.0.0", "9.1.0")).toBeUndefined();
      expect(classifyUpgradeLevel("v5.0.0", "v4.17.21")).toBeUndefined();
    });

    it("returns undefined for minor or patch downgrades", () => {
      expect(classifyUpgradeLevel("1.5.0", "1.4.9")).toBeUndefined();
      expect(classifyUpgradeLevel("2.2.0", "2.1.9")).toBeUndefined();
      expect(classifyUpgradeLevel("1.2.4", "1.2.3")).toBeUndefined();
      expect(classifyUpgradeLevel("0.0.2", "0.0.1")).toBeUndefined();
    });

    it("returns undefined for non-semver or garbage inputs", () => {
      expect(classifyUpgradeLevel("not-semver", "1.0.0")).toBeUndefined();
      expect(classifyUpgradeLevel("1.0.0", "not-semver")).toBeUndefined();
      expect(classifyUpgradeLevel("", "")).toBeUndefined();
    });

    it("correctly classifies valid upgrades across patch, minor, and major", () => {
      // Patch
      expect(classifyUpgradeLevel("1.2.3", "1.2.4")).toBe("patch");
      expect(classifyUpgradeLevel("1.2.3", "1.2.3")).toBe("patch");

      // Minor
      expect(classifyUpgradeLevel("1.2.3", "1.3.0")).toBe("minor");
      expect(classifyUpgradeLevel("1.2.3", "1.4.1")).toBe("minor");

      // Major
      expect(classifyUpgradeLevel("1.2.3", "2.0.0")).toBe("major");
      expect(classifyUpgradeLevel("1.9.9", "2.0.0")).toBe("major");

      // v-prefixes
      expect(classifyUpgradeLevel("v1.2.3", "v1.3.0")).toBe("minor");
      expect(classifyUpgradeLevel("v1.2.3", "v2.0.0")).toBe("major");
    });
  });

  describe("resolveSafeUpgradeVersion", () => {
    it("prefers patch upgrades before minor and major", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              versions: {
                "1.0.0": { version: "1.0.0", dist: { tarball: "t.tgz" } },
                "1.0.1": { version: "1.0.1", dist: { tarball: "t.tgz" } },
                "1.1.0": { version: "1.1.0", dist: { tarball: "t.tgz" } },
                "2.0.0": { version: "2.0.0", dist: { tarball: "t.tgz" } },
              },
            }),
        }),
      );

      const res = await resolveSafeUpgradeVersion("multi-version-pkg", "1.0.0", "1.0.1", "<1.0.1");

      expect(res.safeVersion).toBe("1.0.1");
      expect(res.upgradeLevel).toBe("patch");
      expect(res.upgradeLevel).not.toBe("major");
      expect(res.majorOnlyFixAvailable).toBe(false);
    });

    it("falls back to minor upgrade when no patch exists", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              versions: {
                "1.0.0": { version: "1.0.0", dist: { tarball: "t.tgz" } },
                "1.2.0": { version: "1.2.0", dist: { tarball: "t.tgz" } },
                "2.0.0": { version: "2.0.0", dist: { tarball: "t.tgz" } },
              },
            }),
        }),
      );

      const res = await resolveSafeUpgradeVersion("minor-fallback-pkg", "1.0.0", "1.2.0", "<1.2.0");

      expect(res.safeVersion).toBe("1.2.0");
      expect(res.upgradeLevel).toBe("minor");
      expect(res.upgradeLevel).not.toBe("major");
      expect(res.majorOnlyFixAvailable).toBe(false);
    });

    it("flags major-only bump correctly and handles v-prefixed installedVersion without NaN", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              versions: {
                "1.0.0": { version: "1.0.0", dist: { tarball: "t.tgz" } },
                "2.0.0": { version: "2.0.0", dist: { tarball: "t.tgz" } },
              },
            }),
        }),
      );

      const res = await resolveSafeUpgradeVersion("major-only-pkg", "v1.0.0", "2.0.0", "<2.0.0");

      expect(res.safeVersion).toBe("2.0.0");
      expect(res.upgradeLevel).toBe("major");
      expect(res.upgradeLevel).toBe("major");
      expect(res.majorOnlyFixAvailable).toBe(true);
    });

    it("returns undefined safeVersion when all candidate versions are downgrades", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              versions: {
                "4.17.21": { version: "4.17.21", dist: { tarball: "t.tgz" } },
              },
            }),
        }),
      );

      const res = await resolveSafeUpgradeVersion(
        "downgrade-only-pkg",
        "5.0.0",
        "4.17.21",
        "<4.17.21",
      );

      expect(res.safeVersion).toBeUndefined();
      expect(res.upgradeLevel).not.toBe("major");
    });
  });
});
