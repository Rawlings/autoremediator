import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadPolicy, DEFAULT_POLICY } from "./policy.js";

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
