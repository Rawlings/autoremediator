import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import { runInteractiveTriage } from "./triage.js";
import { loadPolicy } from "../platform/policy.js";
import { parse as yamlParse } from "yaml";

vi.mock("../remediation/evaluate-package.js", () => ({
  evaluatePackage: vi.fn().mockResolvedValue({ vulnerabilities: [] }),
}));

describe("CLI Triage Adversarial White-Box Challenges", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "triage-challenge-"));
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  function createMockRl(answers: string[]) {
    return {
      question: vi.fn(async () => answers.shift() ?? ""),
      close: vi.fn(),
    } as unknown as import("node:readline/promises").Interface;
  }

  it("handles empty findings without prompting and exits cleanly", async () => {
    const emptyScan = join(testDir, "empty-scan.json");
    await writeFile(emptyScan, JSON.stringify({ vulnerabilities: {} }), "utf8");

    const outStream = new PassThrough();
    let out = "";
    outStream.on("data", (chunk) => {
      out += chunk.toString();
    });

    await runInteractiveTriage(emptyScan, {
      cwd: testDir,
      output: outStream,
    });

    expect(out).toContain("No vulnerabilities found to triage!");
  });

  it("handles non-existent or malformed scan files gracefully", async () => {
    const outStream = new PassThrough();
    let out = "";
    outStream.on("data", (chunk) => {
      out += chunk.toString();
    });

    await runInteractiveTriage(join(testDir, "missing-file.json"), {
      cwd: testDir,
      output: outStream,
    });

    expect(out).toContain("Failed to load scan findings");
  });

  it("handles invalid choices followed by valid skip and quit choices", async () => {
    const scanFile = join(testDir, "scan.json");
    const scanData = {
      vulnerabilities: {
        "demo-a": {
          name: "demo-a",
          severity: "high",
          via: [{ name: "CVE-2023-1111" }],
        },
        "demo-b": {
          name: "demo-b",
          severity: "low",
          via: [{ name: "CVE-2023-2222" }],
        },
      },
    };
    await writeFile(scanFile, JSON.stringify(scanData), "utf8");

    const outStream = new PassThrough();
    let out = "";
    outStream.on("data", (chunk) => {
      out += chunk.toString();
    });

    // For CVE 1: send invalid option 'invalid', then 's' (skip)
    // For CVE 2: send 'q' (quit)
    const mockRl = createMockRl(["invalid", "s", "q"]);

    await runInteractiveTriage(scanFile, {
      cwd: testDir,
      rl: mockRl,
      output: outStream,
    });

    expect(out).toContain("Found 2 unique vulnerability(ies) to triage.");
    expect(out).toContain("Invalid option. Please choose 'a', 's', 'x', or 'q'.");
    expect(out).toContain("Skipped CVE-2023-1111.");
    expect(out).toContain("Exiting triage session.");
    expect(out).toContain("Skipped:        1");
  });

  it("persists VEX suppression to repository policy configuration on [x] choice", async () => {
    const scanFile = join(testDir, "scan.json");
    const scanData = {
      vulnerabilities: {
        "vulnerable-lib": {
          name: "vulnerable-lib",
          severity: "critical",
          via: [{ name: "CVE-2024-9999" }],
        },
      },
    };
    await writeFile(scanFile, JSON.stringify(scanData), "utf8");

    const outStream = new PassThrough();
    let out = "";
    outStream.on("data", (chunk) => {
      out += chunk.toString();
    });

    // Action: 'x', Justification: '2' (mitigated), Notes: 'Mitigated via firewall'
    const mockRl = createMockRl(["x", "2", "Mitigated via firewall"]);

    await runInteractiveTriage(scanFile, {
      cwd: testDir,
      rl: mockRl,
      output: outStream,
    });

    expect(out).toContain("Configuring suppression / VEX record for CVE-2024-9999");
    expect(out).toContain("Persisted suppression for CVE-2024-9999");
    expect(out).toContain("Suppressed:     1");

    // Verify written policy file on disk
    const loaded = loadPolicy(testDir);
    expect(loaded.suppressions.length).toBe(1);
    expect(loaded.suppressions[0]?.cveId).toBe("CVE-2024-9999");
    expect(loaded.suppressions[0]?.justification).toBe("mitigated");
    expect(loaded.suppressions[0]?.notes).toBe("Mitigated via firewall");
  });

  it("persists VEX suppression to dedicated suppressions file and VEX document", async () => {
    const scanFile = join(testDir, "scan.json");
    const suppressionsPath = join(testDir, "my-suppressions.yml");
    const vexPath = join(testDir, "vex.json");
    const scanData = {
      vulnerabilities: {
        "dep-pkg": {
          name: "dep-pkg",
          severity: "moderate",
          via: [{ name: "GHSA-xxxx-yyyy-zzzz" }],
        },
      },
    };
    await writeFile(scanFile, JSON.stringify(scanData), "utf8");

    const outStream = new PassThrough();
    let out = "";
    outStream.on("data", (chunk) => {
      out += chunk.toString();
    });

    // Action: 'x', Justification: '3' (under_investigation), Notes: 'Investigating impact'
    const mockRl = createMockRl(["x", "3", "Investigating impact"]);

    await runInteractiveTriage(scanFile, {
      cwd: testDir,
      rl: mockRl,
      output: outStream,
      suppressionsFile: suppressionsPath,
      vexOut: vexPath,
    });

    expect(out).toContain("Saved VEX statement to:");

    // Verify dedicated YAML file
    const yamlContent = await readFile(suppressionsPath, "utf8");
    const parsedYaml = yamlParse(yamlContent) as {
      suppressions: Array<{ cveId: string; justification: string }>;
    };
    expect(parsedYaml.suppressions[0]?.cveId).toBe("GHSA-XXXX-YYYY-ZZZZ");
    expect(parsedYaml.suppressions[0]?.justification).toBe("under_investigation");

    // Verify VEX JSON document
    const vexContent = await readFile(vexPath, "utf8");
    const parsedVex = JSON.parse(vexContent) as {
      vulnerabilities?: Array<{ id: string; analysis?: { state: string; justification?: string } }>;
    };
    expect(parsedVex.vulnerabilities).toBeDefined();
    expect(parsedVex.vulnerabilities?.[0]?.id).toBe("GHSA-XXXX-YYYY-ZZZZ");
    expect(parsedVex.vulnerabilities?.[0]?.analysis?.state).toBe("not_affected");
    expect(parsedVex.vulnerabilities?.[0]?.analysis?.justification).toBe("under_investigation");
  });

  it("supports justifications [4] (fixed) and default [1] (not_affected)", async () => {
    const scanFile = join(testDir, "scan.json");
    const scanData = {
      vulnerabilities: {
        "pkg-one": {
          name: "pkg-one",
          severity: "high",
          via: [{ name: "CVE-2024-0001" }],
        },
        "pkg-two": {
          name: "pkg-two",
          severity: "low",
          via: [{ name: "CVE-2024-0002" }],
        },
      },
    };
    await writeFile(scanFile, JSON.stringify(scanData), "utf8");

    const outStream = new PassThrough();
    let out = "";
    outStream.on("data", (chunk) => {
      out += chunk.toString();
    });

    // For CVE 1: 'x', '4' (fixed), notes: 'Manually patched'
    // For CVE 2: 'x', '1' (not_affected), notes: ''
    const mockRl = createMockRl(["x", "4", "Manually patched", "x", "1", ""]);

    await runInteractiveTriage(scanFile, {
      cwd: testDir,
      rl: mockRl,
      output: outStream,
    });

    expect(out).toContain("Suppressed:     2");
    const loaded = loadPolicy(testDir);
    expect(loaded.suppressions.length).toBe(2);
    expect(loaded.suppressions[0]?.justification).toBe("fixed");
    expect(loaded.suppressions[1]?.justification).toBe("not_affected");
  });
});
