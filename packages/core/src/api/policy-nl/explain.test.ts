import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { explainPolicy } from "./explain.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "policy-explain-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});
const write = (text: string, name = ".github/autoremediator.yml") => {
  const target = join(dir, name);
  mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(target, text, "utf8");
};

const FULL = `
allowMajorBumps: false
denyPackages: [left-pad, "@acme/*"]
allowPackages: [react]
constraints:
  directDependenciesOnly: true
  typecheck: true
  supplyChainPolicy: { minPublishAgeHours: 72, blockInstallScripts: true }
exploitSignalOverride:
  kev: { mandatory: true }
  epss: { mandatory: true, threshold: 0.5 }
suppressions:
  - { cveId: CVE-2024-0001, justification: not_affected, notes: "path disabled", expiresAt: "2026-12-31" }
sla: { critical: 24, high: 168 }
dispositionPolicy: { minConfidenceForAutoApply: 0.8, holdForTransitive: true }
containmentMode: true
escalationGraph: { no-safe-version: hold-branch }
autonomy: { ceiling: L2 }
`;

describe("explainPolicy", () => {
  it("describes the built-in defaults when there is no policy file", () => {
    const result = explainPolicy({ cwd: dir });
    expect(result.exists).toBe(false);
    expect(result.sentences).toEqual([
      "Major version upgrades are never made.",
      "No autonomy ceiling is set, so earned autonomy is off.",
    ]);
  });

  it("states each part of a full policy as a sentence tied to its key", () => {
    write(FULL);
    const result = explainPolicy({ cwd: dir });
    const byKey = Object.fromEntries(result.rules.map((rule) => [rule.key, rule.sentence]));

    expect(result.exists).toBe(true);
    expect(byKey["allowMajorBumps"]).toBe("Major version upgrades are never made.");
    expect(byKey["denyPackages"]).toBe("Never touch these packages: left-pad, @acme/*.");
    expect(byKey["allowPackages"]).toBe("Only these packages may be changed: react.");
    expect(byKey["constraints.supplyChainPolicy.minPublishAgeHours"]).toBe(
      "Versions published less than 3 days ago are skipped.",
    );
    expect(byKey["exploitSignalOverride.kev"]).toContain("KEV");
    expect(byKey["exploitSignalOverride.epss"]).toContain("above 0.5");
    expect(byKey["sla.critical"]).toBe(
      "Critical vulnerabilities must be fixed within 24 hours of publication.",
    );
    expect(byKey["sla.high"]).toContain("7 days");
    expect(byKey["suppressions"]).toBe(
      "CVE-2024-0001 is suppressed as not_affected until 2026-12-31 (path disabled).",
    );
    expect(byKey["dispositionPolicy.minConfidenceForAutoApply"]).toContain("0.8");
    expect(byKey["containmentMode"]).toContain("rolled back");
    expect(byKey["escalationGraph.no-safe-version"]).toBe(
      "When a result is unresolved as no-safe-version, the follow-up is hold-branch.",
    );
    expect(byKey["autonomy.ceiling"]).toContain("L2");
    expect(result.sentences).toHaveLength(result.rules.length);
  });

  it("is deterministic", () => {
    write(FULL);
    expect(explainPolicy({ cwd: dir })).toEqual(explainPolicy({ cwd: dir }));
  });

  it("reads an explicit path or inline policy and fails loudly on a broken one", () => {
    write("allowMajorBumps: true\n", "custom.yml");
    expect(explainPolicy({ cwd: dir, policy: "custom.yml" }).sentences[0]).toBe(
      "Major version upgrades are allowed.",
    );
    expect(explainPolicy({ cwd: dir, policy: "---\ndenyPackages: [a]" }).source).toBe(
      "(inline policy)",
    );
    expect(() => explainPolicy({ cwd: dir, policy: "missing.yml" })).toThrow(/not found/);
    write("allowMajorBumps: sometimes\n");
    expect(() => explainPolicy({ cwd: dir })).toThrow(/Invalid policy/);
  });

  it("cleans suppression notes before showing them", () => {
    write(
      `suppressions:\n  - { cveId: CVE-2024-1, justification: fixed, notes: "a\\u0000b\\nc" }\n`,
    );
    const sentence = explainPolicy({ cwd: dir }).rules.find(
      (rule) => rule.key === "suppressions",
    )?.sentence;
    expect(sentence).toBe("CVE-2024-1 is suppressed as fixed with no expiry (ab c).");
  });
});
