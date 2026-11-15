import { describe, expect, it, vi } from "vitest";

import type { SafeUpgradeResolution } from "../../intelligence/sources/registry.js";
import { selectUpgradeTarget, type SelectTargetDeps } from "./select-target.js";

type Trust = SelectTargetDeps["verifyTrust"];

function deps(
  ordered: string[],
  trust: Trust = async () => ({ trusted: true }),
): SelectTargetDeps & { verifyTrust: ReturnType<typeof vi.fn<Trust>> } {
  const resolution: SafeUpgradeResolution = {
    safeVersion: ordered[0],
    candidates: {},
    majorOnlyFixAvailable: false,
    ordered,
  };
  return {
    resolve: vi.fn(async () => resolution),
    verifyTrust: vi.fn<Trust>(trust),
    queryAdvisories: vi.fn(async () => []),
  };
}

const params = {
  packageName: "pkg",
  installedVersion: "1.0.0",
  firstPatchedVersion: "1.0.1",
  vulnerableRange: "<1.0.1",
};

describe("selectUpgradeTarget with remembered rejections", () => {
  it("never proposes a version memory says was rejected, and takes the next best one", async () => {
    const d = deps(["1.0.1", "1.0.2", "1.1.0"]);
    const selection = await selectUpgradeTarget(
      { ...params, rejected: new Map([["1.0.1", "tests broke (mem_0123456789)"]]) },
      d,
    );
    expect(selection).toMatchObject({
      status: "selected",
      version: "1.0.2",
      skipped: [{ version: "1.0.1", reason: "tests broke (mem_0123456789)" }],
    });
    // The rejected version was never even trust-checked.
    expect(d.verifyTrust.mock.calls.map((call) => call[1])).toEqual(["1.0.2"]);
  });

  it("does not let rejected versions use up the candidates it examines", async () => {
    const ordered = ["1.0.1", "1.0.2", "1.0.3", "1.0.4", "1.0.5", "1.0.6"];
    const d = deps(ordered, async (_name, version) =>
      version === "1.0.6" ? { trusted: true } : { trusted: false, reason: "too new" },
    );
    const rejected = new Map(ordered.slice(0, 2).map((version) => [version, "rejected"]));
    // Five candidates are examined after the two rejected ones are set aside: 1.0.3 .. 1.0.6 all fit.
    const selection = await selectUpgradeTarget({ ...params, rejected }, d);
    expect(selection).toMatchObject({ status: "selected", version: "1.0.6" });
  });

  it("reports memory-blocked when every fixed version was rejected", async () => {
    const selection = await selectUpgradeTarget(
      {
        ...params,
        rejected: new Map([
          ["1.0.1", "tests broke"],
          ["1.0.2", "tests broke"],
        ]),
      },
      deps(["1.0.1", "1.0.2"]),
    );
    expect(selection).toEqual({
      status: "memory-blocked",
      version: "1.0.1",
      reason: "tests broke",
    });
  });

  it("behaves exactly as before with nothing remembered", async () => {
    await expect(selectUpgradeTarget(params, deps(["1.0.1"]))).resolves.toMatchObject({
      status: "selected",
      version: "1.0.1",
      skipped: [],
    });
  });
});
