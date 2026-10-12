import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import { parse as yamlParse } from "yaml";
import { runInteractiveTriage } from "./triage.js";
import { saveSuppressionToPolicy, saveSuppressionToFile } from "../platform/policy.js";
import { saveSuppressionToVexDocument } from "../api/vex/index.js";

vi.mock("../remediation/evaluate-package.js", () => ({
  evaluatePackage: vi.fn().mockResolvedValue({ vulnerabilities: [] }),
}));

describe("Triage Suppression Persistence", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "autoremediator-triage-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("saveSuppressionToPolicy creates .github/autoremediator.yml and appends suppression", () => {
    const policyPath = saveSuppressionToPolicy(tmpDir, {
      cveId: "CVE-2023-1234",
      justification: "not_affected",
      notes: "Dev dependency in build-only script",
    });

    expect(existsSync(policyPath)).toBe(true);
    const content = readFileSync(policyPath, "utf8");
    const parsed = yamlParse(content);
    expect(parsed.suppressions).toEqual([
      {
        cveId: "CVE-2023-1234",
        justification: "not_affected",
        notes: "Dev dependency in build-only script",
      },
    ]);
  });

  it("saveSuppressionToPolicy preserves existing policy configurations", () => {
    const policyPath = join(tmpDir, ".github", "autoremediator.yml");
    saveSuppressionToPolicy(tmpDir, {
      cveId: "CVE-2023-1001",
      justification: "mitigated",
    });

    // Add another suppression
    saveSuppressionToPolicy(tmpDir, {
      cveId: "CVE-2023-1002",
      justification: "under_investigation",
    });

    const parsed = yamlParse(readFileSync(policyPath, "utf8"));
    expect(parsed.suppressions).toHaveLength(2);
    expect(parsed.suppressions[0].cveId).toBe("CVE-2023-1001");
    expect(parsed.suppressions[1].cveId).toBe("CVE-2023-1002");
  });

  it("saveSuppressionToFile writes suppression to dedicated YAML file", () => {
    const suppFile = join(tmpDir, "suppressions.yml");
    saveSuppressionToFile(suppFile, {
      cveId: "CVE-2024-9999",
      justification: "not_affected",
      notes: "False positive",
    });

    expect(existsSync(suppFile)).toBe(true);
    const parsed = yamlParse(readFileSync(suppFile, "utf8"));
    expect(parsed.suppressions).toHaveLength(1);
    expect(parsed.suppressions[0].cveId).toBe("CVE-2024-9999");
  });

  it("saveSuppressionToVexDocument creates standard CycloneDX 1.5 VEX JSON", () => {
    const vexPath = join(tmpDir, "vex.json");
    saveSuppressionToVexDocument(
      vexPath,
      {
        cveId: "CVE-2023-5555",
        justification: "not_affected",
        notes: "Function not reachable",
      },
      "1.0.0",
    );

    expect(existsSync(vexPath)).toBe(true);
    const doc = JSON.parse(readFileSync(vexPath, "utf8"));
    expect(doc.bomFormat).toBe("CycloneDX");
    expect(doc.specVersion).toBe("1.5");
    expect(doc.vulnerabilities).toHaveLength(1);
    expect(doc.vulnerabilities[0].id).toBe("CVE-2023-5555");
    expect(doc.vulnerabilities[0].analysis.state).toBe("not_affected");
    expect(doc.vulnerabilities[0].analysis.justification).toBe("not_affected");
  });

  it("runInteractiveTriage persists suppression decision via stream interaction", async () => {
    const scanFile = join(tmpDir, "audit.json");
    // Standard npm-audit JSON structure
    const auditData = {
      vulnerabilities: {
        "demo-pkg": {
          name: "demo-pkg",
          severity: "high",
          via: [
            {
              name: "demo-pkg",
              url: "https://nvd.nist.gov/vuln/detail/CVE-2024-8888",
            },
          ],
        },
      },
    };
    writeFileSync(scanFile, JSON.stringify(auditData, null, 2));

    const outStream = new PassThrough();
    let outputData = "";
    outStream.on("data", (chunk) => {
      outputData += chunk.toString();
    });

    const answers = ["x", "1", "Not reachable in web app"];
    const fakeRl = {
      question: vi.fn(async () => answers.shift() ?? ""),
      close: vi.fn(),
    } as unknown as import("node:readline/promises").Interface;

    const vexOut = join(tmpDir, "vex.json");

    await runInteractiveTriage(scanFile, {
      cwd: tmpDir,
      rl: fakeRl,
      output: outStream,
      vexOut,
    });

    // Check policy file was persisted
    const policyFile = join(tmpDir, ".github", "autoremediator.yml");
    expect(existsSync(policyFile)).toBe(true);
    const policyContent = yamlParse(readFileSync(policyFile, "utf8"));
    expect(policyContent.suppressions).toHaveLength(1);
    expect(policyContent.suppressions[0].cveId).toBe("CVE-2024-8888");
    expect(policyContent.suppressions[0].justification).toBe("not_affected");
    expect(policyContent.suppressions[0].notes).toBe("Not reachable in web app");

    // Check VEX file was persisted
    expect(existsSync(vexOut)).toBe(true);
    const vexDoc = JSON.parse(readFileSync(vexOut, "utf8"));
    expect(vexDoc.vulnerabilities[0].id).toBe("CVE-2024-8888");

    expect(outputData).toContain("Persisted suppression for CVE-2024-8888");
  });
});
