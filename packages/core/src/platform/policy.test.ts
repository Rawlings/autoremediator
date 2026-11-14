import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse as yamlParse } from "yaml";
import {
  loadPolicy,
  DEFAULT_POLICY,
  loadSuppressionsFile,
  checkSlaBreach,
  isPackageAllowed,
  saveSuppressionToPolicy,
  saveSuppressionToFile,
} from "./policy.js";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "autoremediator-policy-test-"));
}

describe("loadPolicy", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns DEFAULT_POLICY when .github/autoremediator.yml does not exist", () => {
    const result = loadPolicy(tmpDir);
    expect(result).toEqual(DEFAULT_POLICY);
  });

  it("parses a valid YAML file and merges with defaults", () => {
    mkdirSync(join(tmpDir, ".github"), { recursive: true });
    writeFileSync(
      join(tmpDir, ".github", "autoremediator.yml"),
      [
        "allowMajorBumps: true",
        "denyPackages:",
        "  - lodash",
        "  - moment",
        "constraints:",
        "  directDependenciesOnly: true",
        "  installMode: prefer-offline",
      ].join("\n"),
      "utf8",
    );

    const result = loadPolicy(tmpDir);

    expect(result.allowMajorBumps).toBe(true);
    expect(result.denyPackages).toEqual(["lodash", "moment"]);
    expect(result.allowPackages).toEqual([]);
    expect(result.constraints?.directDependenciesOnly).toBe(true);
    expect(result.constraints?.installMode).toBe("prefer-offline");
    // Unset fields fall back to defaults
    expect(result.skipUnreachable).toBe(DEFAULT_POLICY.skipUnreachable);
  });

  it("applies all defaults when YAML file is empty", () => {
    mkdirSync(join(tmpDir, ".github"), { recursive: true });
    writeFileSync(join(tmpDir, ".github", "autoremediator.yml"), "", "utf8");

    const result = loadPolicy(tmpDir);
    expect(result).toEqual(DEFAULT_POLICY);
  });

  it("throws, instead of silently using defaults, when the YAML is malformed", () => {
    mkdirSync(join(tmpDir, ".github"), { recursive: true });
    writeFileSync(
      join(tmpDir, ".github", "autoremediator.yml"),
      "allowMajorBumps: :\n  broken: yaml: file",
      "utf8",
    );

    expect(() => loadPolicy(tmpDir)).toThrow(/Invalid YAML in policy/);
  });

  it("returns defaults when the default policy file is simply absent", () => {
    expect(loadPolicy(tmpDir)).toEqual(DEFAULT_POLICY);
  });

  it("uses explicitPath when provided, ignoring the default .github/autoremediator.yml", () => {
    // Write a file at the explicit path
    const explicitPath = join(tmpDir, "custom-policy.yml");
    writeFileSync(explicitPath, "allowMajorBumps: true\ndenyPackages:\n  - react", "utf8");

    // Default location has different content — should not be read
    mkdirSync(join(tmpDir, ".github"), { recursive: true });
    writeFileSync(join(tmpDir, ".github", "autoremediator.yml"), "allowMajorBumps: false", "utf8");

    const result = loadPolicy(tmpDir, explicitPath);
    expect(result.allowMajorBumps).toBe(true);
    expect(result.denyPackages).toEqual(["react"]);
  });

  it("throws when an explicitly requested policy file does not exist", () => {
    expect(() => loadPolicy(tmpDir, join(tmpDir, "does-not-exist.yml"))).toThrow(
      /Policy file not found/,
    );
  });

  describe("validation", () => {
    const policyWith = (yaml: string): string => {
      mkdirSync(join(tmpDir, ".github"), { recursive: true });
      writeFileSync(join(tmpDir, ".github", "autoremediator.yml"), yaml, "utf8");
      return tmpDir;
    };

    it("loads every documented constraint, including ones that used to be dropped", () => {
      const policy = loadPolicy(
        policyWith(`
constraints:
  typecheck: true
  requireProofOfFix: true
  enableBreakingChangeRefactor: true
  workspace: packages/app
  supplyChainPolicy:
    minPublishAgeHours: 72
    blockInstallScripts: true
`),
      );

      expect(policy.constraints).toMatchObject({
        typecheck: true,
        requireProofOfFix: true,
        enableBreakingChangeRefactor: true,
        workspace: "packages/app",
        supplyChainPolicy: { minPublishAgeHours: 72, blockInstallScripts: true },
        // defaults still fill the rest
        directDependenciesOnly: false,
        installMode: "deterministic",
      });
    });

    it("rejects unknown fields by name, so typos and removed options are caught", () => {
      expect(() => loadPolicy(policyWith("denyPackage: [lodash]\nmodelDefaults: {}\n"))).toThrow(
        /unknown field\(s\) "denyPackage", "modelDefaults"/,
      );
      expect(() => loadPolicy(policyWith("constraints:\n  typechek: true\n"))).toThrow(
        /constraints: unknown field\(s\) "typechek"/,
      );
    });

    it("rejects wrongly typed and out-of-range values with their location", () => {
      expect(() => loadPolicy(policyWith("allowMajorBumps: yes-please\n"))).toThrow(
        /allowMajorBumps/,
      );
      expect(() => loadPolicy(policyWith("patchConfidenceThresholds:\n  low: 1.5\n"))).toThrow(
        /patchConfidenceThresholds\.low/,
      );
      expect(() => loadPolicy(policyWith("constraints:\n  installMode: fast\n"))).toThrow(
        /constraints\.installMode/,
      );
    });

    it("accepts inline YAML and treats an empty file as the defaults", () => {
      expect(loadPolicy(tmpDir, "---\nallowMajorBumps: true\n").allowMajorBumps).toBe(true);
      expect(loadPolicy(policyWith("")).allowMajorBumps).toBe(false);
    });

    it("keeps suppression expiry dates written as YAML dates", () => {
      const policy = loadPolicy(
        policyWith(`
suppressions:
  - cveId: CVE-2024-0001
    justification: mitigated
    expiresAt: 2099-01-01
`),
      );
      expect(policy.suppressions?.[0]?.expiresAt).toMatch(/^2099-01-01/);
    });
  });

  it("parses patchConfidenceThresholds correctly", () => {
    mkdirSync(join(tmpDir, ".github"), { recursive: true });
    writeFileSync(
      join(tmpDir, ".github", "autoremediator.yml"),
      ["patchConfidenceThresholds:", "  low: 0.3", "  medium: 0.6", "  high: 0.9"].join("\n"),
      "utf8",
    );

    const result = loadPolicy(tmpDir);
    expect(result.patchConfidenceThresholds?.low).toBe(0.3);
    expect(result.patchConfidenceThresholds?.medium).toBe(0.6);
    expect(result.patchConfidenceThresholds?.high).toBe(0.9);
  });

  it("parses escalationGraph mapping when provided", () => {
    mkdirSync(join(tmpDir, ".github"), { recursive: true });
    writeFileSync(
      join(tmpDir, ".github", "autoremediator.yml"),
      [
        "escalationGraph:",
        "  no-safe-version: open-issue",
        "  source-fetch-failed: notify-channel",
      ].join("\n"),
      "utf8",
    );

    const result = loadPolicy(tmpDir);
    expect(result.escalationGraph?.["no-safe-version"]).toBe("open-issue");
    expect(result.escalationGraph?.["source-fetch-failed"]).toBe("notify-channel");
  });
});

describe("loadSuppressionsFile", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "autoremediator-supp-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns suppressions array from a valid YAML file", () => {
    const filePath = join(tmpDir, "suppressions.yml");
    writeFileSync(
      filePath,
      [
        "suppressions:",
        "  - cveId: CVE-2024-0001",
        "    justification: not_affected",
        "    notes: Only affects Linux builds",
        "  - cveId: CVE-2024-0002",
        "    justification: fixed",
      ].join("\n"),
      "utf8",
    );

    const result = loadSuppressionsFile(filePath);
    expect(result).toHaveLength(2);
    expect(result[0]?.cveId).toBe("CVE-2024-0001");
    expect(result[0]?.justification).toBe("not_affected");
    expect(result[0]?.notes).toBe("Only affects Linux builds");
    expect(result[1]?.cveId).toBe("CVE-2024-0002");
  });

  it("throws when the file does not exist", () => {
    expect(() => loadSuppressionsFile(join(tmpDir, "does-not-exist.yml"))).toThrow(
      /Cannot read suppressions file/,
    );
  });

  it("throws when the YAML is malformed", () => {
    const filePath = join(tmpDir, "bad.yml");
    writeFileSync(filePath, "suppressions: :\n  broken: yaml:", "utf8");
    expect(() => loadSuppressionsFile(filePath)).toThrow(/Cannot read suppressions file/);
  });

  it("throws when the file has no suppressions key", () => {
    const filePath = join(tmpDir, "empty.yml");
    writeFileSync(filePath, "allowMajorBumps: true", "utf8");
    expect(() => loadSuppressionsFile(filePath)).toThrow(/Invalid suppressions file/);
  });

  it("throws on an unknown justification and names the field", () => {
    const filePath = join(tmpDir, "typo.yml");
    writeFileSync(
      filePath,
      "suppressions:\n  - cveId: CVE-2024-0001\n    justification: not-affected\n",
      "utf8",
    );
    expect(() => loadSuppressionsFile(filePath)).toThrow(/suppressions\.0\.justification/);
  });
});

describe("checkSlaBreach", () => {
  // Current date for tests: April 25, 2026
  const MS_PER_HOUR = 60 * 60 * 1000;
  const slaPolicy = { critical: 72, high: 168, medium: 720 };

  it("returns SlaBreach when CVE is overdue for its severity", () => {
    // Published 200 hours ago; critical SLA is 72 hours → 128 hours overdue
    const publishedAt = new Date(Date.now() - 200 * MS_PER_HOUR).toISOString();
    const result = checkSlaBreach("CVE-2024-0001", "CRITICAL", publishedAt, slaPolicy);
    expect(result).not.toBeNull();
    expect(result?.cveId).toBe("CVE-2024-0001");
    expect(result?.severity).toBe("CRITICAL");
    expect(result?.hoursOverdue).toBeGreaterThanOrEqual(127);
    expect(result?.deadlineAt).toBeDefined();
  });

  it("returns null when CVE has not yet exceeded SLA", () => {
    // Published 10 hours ago; critical SLA is 72 hours
    const publishedAt = new Date(Date.now() - 10 * MS_PER_HOUR).toISOString();
    const result = checkSlaBreach("CVE-2024-0002", "CRITICAL", publishedAt, slaPolicy);
    expect(result).toBeNull();
  });

  it("returns null when severity has no configured SLA window", () => {
    const publishedAt = new Date(Date.now() - 1000 * MS_PER_HOUR).toISOString();
    const result = checkSlaBreach("CVE-2024-0003", "LOW", publishedAt, slaPolicy);
    expect(result).toBeNull();
  });

  it("returns null for UNKNOWN severity when no matching SLA is configured", () => {
    const publishedAt = new Date(Date.now() - 1000 * MS_PER_HOUR).toISOString();
    const result = checkSlaBreach("CVE-2024-0004", "UNKNOWN", publishedAt, slaPolicy);
    expect(result).toBeNull();
  });

  it("returns null when publishedAt is not a valid date string", () => {
    const result = checkSlaBreach("CVE-2024-0005", "HIGH", "not-a-date", slaPolicy);
    expect(result).toBeNull();
  });

  it("includes correct deadlineAt in the breach", () => {
    const publishedAt = new Date(Date.now() - 200 * MS_PER_HOUR).toISOString();
    const result = checkSlaBreach("CVE-2024-0006", "HIGH", publishedAt, { high: 72 });
    expect(result).not.toBeNull();
    const expected = new Date(new Date(publishedAt).getTime() + 72 * MS_PER_HOUR).toISOString();
    expect(result?.deadlineAt).toBe(expected);
  });
});

describe("isPackageAllowed", () => {
  it("allows packages by default when deny/allow are empty", () => {
    expect(isPackageAllowed(DEFAULT_POLICY, "lodash")).toBe(true);
    expect(isPackageAllowed(DEFAULT_POLICY, "@scope/pkg")).toBe(true);
  });

  it("blocks packages explicitly listed in denyPackages", () => {
    const policy = { ...DEFAULT_POLICY, denyPackages: ["lodash", "axios"] };
    expect(isPackageAllowed(policy, "lodash")).toBe(false);
    expect(isPackageAllowed(policy, "axios")).toBe(false);
    expect(isPackageAllowed(policy, "react")).toBe(true);
  });

  it("blocks packages matching scope wildcards (@scope/*) in denyPackages", () => {
    const policy = { ...DEFAULT_POLICY, denyPackages: ["@evil/*"] };
    expect(isPackageAllowed(policy, "@evil/core")).toBe(false);
    expect(isPackageAllowed(policy, "@evil/utils")).toBe(false);
    expect(isPackageAllowed(policy, "@good/core")).toBe(true);
    expect(isPackageAllowed(policy, "evil-core")).toBe(true);
  });

  it("blocks packages matching name wildcards (prefix-*) in denyPackages", () => {
    const policy = { ...DEFAULT_POLICY, denyPackages: ["malicious-*"] };
    expect(isPackageAllowed(policy, "malicious-pkg")).toBe(false);
    expect(isPackageAllowed(policy, "malicious-tools")).toBe(false);
    expect(isPackageAllowed(policy, "safe-pkg")).toBe(true);
  });

  it("enforces allowPackages whitelist when non-empty", () => {
    const policy = { ...DEFAULT_POLICY, allowPackages: ["react", "@types/*"] };
    expect(isPackageAllowed(policy, "react")).toBe(true);
    expect(isPackageAllowed(policy, "@types/node")).toBe(true);
    expect(isPackageAllowed(policy, "lodash")).toBe(false);
  });
});

describe("saveSuppressionToPolicy & saveSuppressionToFile", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("saves suppression to .github/autoremediator.yml preserving existing config", () => {
    const targetFile = saveSuppressionToPolicy(tmpDir, {
      cveId: "CVE-2024-1111",
      justification: "not_affected",
      notes: "False positive in test",
    });

    expect(existsSync(targetFile)).toBe(true);
    const content = yamlParse(readFileSync(targetFile, "utf8"));
    expect(content.suppressions).toEqual([
      {
        cveId: "CVE-2024-1111",
        justification: "not_affected",
        notes: "False positive in test",
      },
    ]);

    // Update existing suppression
    saveSuppressionToPolicy(tmpDir, {
      cveId: "CVE-2024-1111",
      justification: "mitigated",
      notes: "Mitigated by firewall",
    });

    const updated = yamlParse(readFileSync(targetFile, "utf8"));
    expect(updated.suppressions).toHaveLength(1);
    expect(updated.suppressions[0].justification).toBe("mitigated");
  });

  it("saves suppression to a dedicated file via saveSuppressionToFile", () => {
    const suppPath = join(tmpDir, "custom", "suppressions.yaml");
    saveSuppressionToFile(suppPath, {
      cveId: "CVE-2025-2222",
      justification: "under_investigation",
    });

    expect(existsSync(suppPath)).toBe(true);
    const content = yamlParse(readFileSync(suppPath, "utf8"));
    expect(content.suppressions).toHaveLength(1);
    expect(content.suppressions[0].cveId).toBe("CVE-2025-2222");
  });
});
