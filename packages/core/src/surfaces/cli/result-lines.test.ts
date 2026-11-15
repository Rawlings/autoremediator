import { describe, expect, it } from "vitest";

import type { PatchResult } from "../../features/remediate/types.js";
import { formatResultLines } from "./result-lines.js";

function result(overrides: Partial<PatchResult>): PatchResult {
  return {
    packageName: "lodash",
    strategy: "version-bump",
    fromVersion: "4.17.20",
    toVersion: "4.17.21",
    applied: false,
    dryRun: false,
    message: "",
    ...overrides,
  };
}

describe("formatResultLines", () => {
  it("describes applied, dry-run and unresolved results", () => {
    const lines = formatResultLines([
      result({ applied: true, dependencyScope: "direct" }),
      result({ packageName: "minimist", dryRun: true, dependencyScope: "transitive" }),
      result({
        packageName: "left-pad",
        strategy: "none",
        toVersion: undefined,
        unresolvedReason: "no-safe-version",
        message: "No fixed version exists",
      }),
    ]);

    expect(lines).toEqual([
      "✔ lodash 4.17.20 → 4.17.21 (version-bump, direct): fixed",
      "○ minimist 4.17.20 → 4.17.21 (version-bump, transitive): would fix (dry run)",
      "✘ left-pad 4.17.20: not fixed, no-safe-version. No fixed version exists",
    ]);
  });

  it("lists a package once when several advisories hit it", () => {
    const same = result({ applied: true });
    expect(formatResultLines([same, { ...same }])).toHaveLength(1);
  });

  it("reports suppressed results as unchanged", () => {
    const [line] = formatResultLines([result({ suppressedBy: { justification: "not_affected" } })]);
    expect(line).toBe("- lodash 4.17.20: not changed, suppressed as not_affected");
  });

  it("caps long lists and says how many were hidden", () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      result({ packageName: `pkg-${i}`, applied: true }),
    );
    const lines = formatResultLines(many);
    expect(lines).toHaveLength(26);
    expect(lines.at(-1)).toContain("5 more");
  });
});
