import { describe, expect, it, vi } from "vitest";

import type { SafeUpgradeResolution } from "../../intelligence/sources/registry.js";
import { describeSkipped, selectUpgradeTarget, type SelectTargetDeps } from "./select-target.js";

function deps(options: {
  ordered: string[];
  untrusted?: Record<string, string>;
  advisories?: Record<string, number>;
  advisoryError?: boolean;
}): SelectTargetDeps & { queryAdvisories: ReturnType<typeof vi.fn> } {
  const resolution: SafeUpgradeResolution = {
    safeVersion: options.ordered[0],
    candidates: {},
    majorOnlyFixAvailable: false,
    ordered: options.ordered,
  };
  return {
    resolve: vi.fn(async () => resolution),
    verifyTrust: vi.fn(async (_name: string, version: string) => {
      const reason = options.untrusted?.[version];
      return reason ? { trusted: false, reason } : { trusted: true };
    }),
    queryAdvisories: vi.fn(async (_name: string, version: string) => {
      if (options.advisoryError) throw new Error("osv down");
      return Array.from({ length: options.advisories?.[version] ?? 0 });
    }),
  };
}

const params = {
  packageName: "pkg",
  installedVersion: "1.0.0",
  firstPatchedVersion: "1.0.1",
  vulnerableRange: "<1.0.1",
};

describe("selectUpgradeTarget", () => {
  it("reports no safe version when nothing fixes the advisory", async () => {
    await expect(selectUpgradeTarget(params, deps({ ordered: [] }))).resolves.toEqual({
      status: "no-safe-version",
    });
  });

  it("takes the best candidate when it is trusted and clean", async () => {
    const d = deps({ ordered: ["1.0.1", "1.0.2"] });
    await expect(selectUpgradeTarget(params, d)).resolves.toMatchObject({
      status: "selected",
      version: "1.0.1",
      knownAdvisories: 0,
      skipped: [],
    });
    expect(d.queryAdvisories).toHaveBeenCalledTimes(1);
  });

  it("moves past a candidate the trust gate rejects", async () => {
    const d = deps({ ordered: ["1.0.1", "1.0.2"], untrusted: { "1.0.1": "has postinstall" } });
    const result = await selectUpgradeTarget(params, d);

    expect(result).toMatchObject({ status: "selected", version: "1.0.2" });
    expect(result.status === "selected" && result.skipped).toEqual([
      { version: "1.0.1", reason: "supply-chain trust gate: has postinstall" },
    ]);
  });

  it("reports the first rejection when every candidate is blocked", async () => {
    const d = deps({
      ordered: ["1.0.1", "1.0.2"],
      untrusted: { "1.0.1": "too new", "1.0.2": "too new" },
    });
    await expect(selectUpgradeTarget(params, d)).resolves.toEqual({
      status: "trust-blocked",
      version: "1.0.1",
      reason: "too new",
    });
  });

  it("prefers a later candidate with no known advisories", async () => {
    const d = deps({ ordered: ["1.0.1", "1.0.2"], advisories: { "1.0.1": 2 } });
    const result = await selectUpgradeTarget(params, d);

    expect(result).toMatchObject({ status: "selected", version: "1.0.2", knownAdvisories: 0 });
    expect(result.status === "selected" && result.skipped).toEqual([
      { version: "1.0.1", reason: "2 known advisories" },
    ]);
  });

  it("falls back to the first candidate with advisories when none is clean", async () => {
    const d = deps({ ordered: ["1.0.1", "1.0.2"], advisories: { "1.0.1": 1, "1.0.2": 3 } });
    const result = await selectUpgradeTarget(params, d);

    expect(result).toMatchObject({ status: "selected", version: "1.0.1", knownAdvisories: 1 });
    expect(result.status === "selected" && result.skipped).toEqual([
      { version: "1.0.2", reason: "3 known advisories" },
    ]);
  });

  it("does not let a failed advisory lookup block the choice", async () => {
    const d = deps({ ordered: ["1.0.1"], advisoryError: true });
    await expect(selectUpgradeTarget(params, d)).resolves.toMatchObject({
      status: "selected",
      version: "1.0.1",
      knownAdvisories: undefined,
    });
  });

  it("skips the advisory lookup when offline", async () => {
    const d = deps({ ordered: ["1.0.1"], advisories: { "1.0.1": 9 } });
    await expect(selectUpgradeTarget({ ...params, offline: true }, d)).resolves.toMatchObject({
      status: "selected",
      version: "1.0.1",
    });
    expect(d.queryAdvisories).not.toHaveBeenCalled();
  });

  it("examines at most five candidates", async () => {
    const ordered = ["1.0.1", "1.0.2", "1.0.3", "1.0.4", "1.0.5", "1.0.6"];
    const d = deps({ ordered, advisories: Object.fromEntries(ordered.map((v) => [v, 1])) });
    await selectUpgradeTarget(params, d);
    expect(d.queryAdvisories).toHaveBeenCalledTimes(5);
  });
});

describe("describeSkipped", () => {
  it("is empty when nothing was skipped", () => {
    expect(describeSkipped([])).toBe("");
  });

  it("lists skipped versions with reasons", () => {
    expect(describeSkipped([{ version: "1.0.1", reason: "2 known advisories" }])).toBe(
      " Skipped 1.0.1 (2 known advisories).",
    );
  });
});
