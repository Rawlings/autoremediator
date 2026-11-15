import { beforeEach, describe, expect, it, vi } from "vitest";

const { select, bump, override } = vi.hoisted(() => ({
  select: vi.fn(),
  bump: vi.fn(),
  override: vi.fn(),
}));

vi.mock("./select-target.js", () => ({
  selectUpgradeTarget: select,
  describeSkipped: () => "",
}));
vi.mock("../../../infra/http/registry-config.js", () => ({ loadRegistryConfig: () => ({}) }));
vi.mock("../../../infra/package-manager/cooldown.js", () => ({
  readCooldown: () => undefined,
  withCooldown: () => undefined,
}));
vi.mock("../../upgrade/apply-version-bump.js", () => ({ applyVersionBumpTool: { execute: bump } }));
vi.mock("../../upgrade/apply-package-override/index.js", () => ({
  applyPackageOverrideTool: { execute: override },
}));

import { resolvePrimaryResult } from "./primary-strategy.js";

const vulnerable = (type: "direct" | "transitive") =>
  ({
    installed: { name: "pkg", version: "1.0.0", type },
    affected: { name: "pkg", vulnerableRange: "<2.0.0", firstPatchedVersion: "2.0.0" },
  }) as never;

const base = {
  cwd: "/p",
  packageManager: "npm" as const,
  dryRun: true,
  policy: "",
  runTests: false,
  constraints: {},
};

beforeEach(() => {
  vi.clearAllMocks();
  select.mockResolvedValue({ status: "memory-blocked", version: "2.0.0", reason: "tests broke" });
});

describe("resolvePrimaryResult when memory rejected every fixed version", () => {
  it.each(["direct", "transitive"] as const)(
    "reports a %s dependency as constraint-blocked and touches nothing",
    async (type) => {
      const rejected = new Map([["2.0.0", "tests broke"]]);
      const { result } = await resolvePrimaryResult({
        ...base,
        vulnerable: vulnerable(type),
        rejectedVersions: rejected,
      });
      expect(select).toHaveBeenCalledWith(expect.objectContaining({ rejected }));
      expect(result).toMatchObject({
        packageName: "pkg",
        strategy: "none",
        applied: false,
        unresolvedReason: "constraint-blocked",
      });
      expect(result.message).toContain("tests broke");
      expect(result.message).toContain("--ignore-memory");
      expect(bump).not.toHaveBeenCalled();
      expect(override).not.toHaveBeenCalled();
    },
  );
});
