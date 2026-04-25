import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadPolicy, DEFAULT_POLICY, loadSuppressionsFile, checkSlaBreach } from "./policy.js";

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
      "utf8"
    );

    const result = loadPolicy(tmpDir);

    expect(result.allowMajorBumps).toBe(true);
    expect(result.denyPackages).toEqual(["lodash", "moment"]);
    expect(result.allowPackages).toEqual([]);
    expect(result.constraints?.directDependenciesOnly).toBe(true);
    expect(result.constraints?.installMode).toBe("prefer-offline");
    // Unset fields fall back to defaults
    expect(result.dynamicModelRouting).toBe(DEFAULT_POLICY.dynamicModelRouting);
    expect(result.providerSafetyProfile).toBe(DEFAULT_POLICY.providerSafetyProfile);
  });

  it("applies all defaults when YAML file is empty", () => {
    mkdirSync(join(tmpDir, ".github"), { recursive: true });
    writeFileSync(join(tmpDir, ".github", "autoremediator.yml"), "", "utf8");

    const result = loadPolicy(tmpDir);
    expect(result).toEqual(DEFAULT_POLICY);
  });

  it("returns DEFAULT_POLICY when YAML is malformed", () => {
    mkdirSync(join(tmpDir, ".github"), { recursive: true });
    writeFileSync(
      join(tmpDir, ".github", "autoremediator.yml"),
      "allowMajorBumps: :\n  broken: yaml: file",
      "utf8"
    );

    const result = loadPolicy(tmpDir);
    expect(result).toEqual(DEFAULT_POLICY);
  });

  it("uses explicitPath when provided, ignoring the default .github/autoremediator.yml", () => {
    // Write a file at the explicit path
    const explicitPath = join(tmpDir, "custom-policy.yml");
    writeFileSync(
      explicitPath,
      "allowMajorBumps: true\ndenyPackages:\n  - react",
      "utf8"
    );

    // Default location has different content — should not be read
    mkdirSync(join(tmpDir, ".github"), { recursive: true });
    writeFileSync(
      join(tmpDir, ".github", "autoremediator.yml"),
      "allowMajorBumps: false",
      "utf8"
    );

    const result = loadPolicy(tmpDir, explicitPath);
    expect(result.allowMajorBumps).toBe(true);
    expect(result.denyPackages).toEqual(["react"]);
  });

  it("returns DEFAULT_POLICY when explicitPath points to a non-existent file", () => {
    const result = loadPolicy(tmpDir, join(tmpDir, "does-not-exist.yml"));
    expect(result).toEqual(DEFAULT_POLICY);
  });

  it("parses patchConfidenceThresholds correctly", () => {
    mkdirSync(join(tmpDir, ".github"), { recursive: true });
    writeFileSync(
      join(tmpDir, ".github", "autoremediator.yml"),
      [
        "patchConfidenceThresholds:",
        "  low: 0.3",
        "  medium: 0.6",
        "  high: 0.9",
      ].join("\n"),
      "utf8"
    );

    const result = loadPolicy(tmpDir);
    expect(result.patchConfidenceThresholds?.low).toBe(0.3);
    expect(result.patchConfidenceThresholds?.medium).toBe(0.6);
    expect(result.patchConfidenceThresholds?.high).toBe(0.9);
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
      "utf8"
    );

    const result = loadSuppressionsFile(filePath);
    expect(result).toHaveLength(2);
    expect(result[0]?.cveId).toBe("CVE-2024-0001");
    expect(result[0]?.justification).toBe("not_affected");
    expect(result[0]?.notes).toBe("Only affects Linux builds");
    expect(result[1]?.cveId).toBe("CVE-2024-0002");
  });

  it("returns empty array when file does not exist", () => {
    const result = loadSuppressionsFile(join(tmpDir, "does-not-exist.yml"));
    expect(result).toEqual([]);
  });

  it("returns empty array when YAML is malformed", () => {
    const filePath = join(tmpDir, "bad.yml");
    writeFileSync(filePath, "suppressions: :\n  broken: yaml:", "utf8");
    const result = loadSuppressionsFile(filePath);
    expect(result).toEqual([]);
  });

  it("returns empty array when YAML has no suppressions key", () => {
    const filePath = join(tmpDir, "empty.yml");
    writeFileSync(filePath, "allowMajorBumps: true", "utf8");
    const result = loadSuppressionsFile(filePath);
    expect(result).toEqual([]);
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
