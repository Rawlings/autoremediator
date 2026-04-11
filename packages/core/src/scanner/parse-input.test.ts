import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  execa: vi.fn(),
  detectPackageManager: vi.fn(),
  resolveAuditCommand: vi.fn(),
}));

vi.mock("execa", () => ({
  execa: mocked.execa,
}));

vi.mock("../platform/package-manager.js", () => ({
  detectPackageManager: mocked.detectPackageManager,
  resolveAuditCommand: mocked.resolveAuditCommand,
}));

import { parseScanInputFromAudit } from "./parse-input.js";

describe("parseScanInputFromAudit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocked.detectPackageManager.mockReturnValue("npm");
    mocked.resolveAuditCommand.mockImplementation((pm: string) =>
      pm === "yarn" ? ["yarn", "audit", "--json"] : [pm, "audit", "--json"]
    );
  });

  it("parses npm audit json output in auto mode", async () => {
    mocked.execa.mockResolvedValue({
      stdout: JSON.stringify({
        vulnerabilities: {
          lodash: {
            name: "lodash",
            severity: "high",
            via: ["CVE-2021-23337"],
          },
        },
      }),
      stderr: "",
    });

    const findings = await parseScanInputFromAudit({
      cwd: "/tmp/project",
      packageManager: "npm",
      format: "auto",
    });

    expect(mocked.execa).toHaveBeenCalledWith(
      "npm",
      ["audit", "--json"],
      expect.objectContaining({ cwd: "/tmp/project", reject: false })
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ cveId: "CVE-2021-23337", source: "npm-audit" });
  });

  it("parses yarn audit ndjson output in auto mode", async () => {
    mocked.execa.mockResolvedValue({
      stdout: [
        JSON.stringify({
          type: "auditAdvisory",
          data: {
            advisory: {
              module_name: "lodash",
              severity: "high",
              cves: ["CVE-2021-23337"],
            },
          },
        }),
      ].join("\n"),
      stderr: "",
    });

    const findings = await parseScanInputFromAudit({
      cwd: "/tmp/project",
      packageManager: "yarn",
      format: "auto",
    });

    expect(mocked.execa).toHaveBeenCalledWith(
      "yarn",
      ["audit", "--json"],
      expect.objectContaining({ cwd: "/tmp/project", reject: false })
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ cveId: "CVE-2021-23337", source: "yarn-audit" });
  });

  it("rejects sarif format with audit mode", async () => {
    await expect(
      parseScanInputFromAudit({
        cwd: "/tmp/project",
        packageManager: "npm",
        format: "sarif",
      })
    ).rejects.toThrow("SARIF format is not supported with --audit mode.");
  });

  it("rejects npm-audit format with yarn package manager in audit mode", async () => {
    await expect(
      parseScanInputFromAudit({
        cwd: "/tmp/project",
        packageManager: "yarn",
        format: "npm-audit",
      })
    ).rejects.toThrow(
      'Format "npm-audit" is not supported with package manager "yarn" in --audit mode. Use --format yarn-audit or --format auto.'
    );
  });

  it("rejects yarn-audit format with npm package manager in audit mode", async () => {
    await expect(
      parseScanInputFromAudit({
        cwd: "/tmp/project",
        packageManager: "npm",
        format: "yarn-audit",
      })
    ).rejects.toThrow(
      'Format "yarn-audit" is not supported with package manager "npm" in --audit mode. Use --format npm-audit or --format auto.'
    );
  });

  it("uses workspace when resolving audit command", async () => {
    mocked.resolveAuditCommand.mockReturnValue([
      "npm",
      "audit",
      "--json",
      "--workspace",
      "web-app",
    ]);
    mocked.execa.mockResolvedValue({
      stdout: JSON.stringify({ vulnerabilities: {} }),
      stderr: "",
    });

    await parseScanInputFromAudit({
      cwd: "/tmp/project",
      packageManager: "npm",
      format: "auto",
      workspace: "web-app",
    });

    expect(mocked.resolveAuditCommand).toHaveBeenCalledWith("npm", { workspace: "web-app" });
    expect(mocked.execa).toHaveBeenCalledWith(
      "npm",
      ["audit", "--json", "--workspace", "web-app"],
      expect.objectContaining({ cwd: "/tmp/project", reject: false })
    );
  });

  it("includes command context when npm audit output cannot be parsed", async () => {
    mocked.execa.mockResolvedValue({
      stdout: "not-json",
      stderr: "",
      exitCode: 0,
    });

    await expect(
      parseScanInputFromAudit({
        cwd: "/tmp/project",
        packageManager: "npm",
        format: "npm-audit",
      })
    ).rejects.toThrow("Failed to parse output from npm audit --json as npm-audit");
  });

  it("includes exit code context when yarn audit output cannot be parsed", async () => {
    mocked.execa.mockResolvedValue({
      stdout: "still-not-json",
      stderr: "error output",
      exitCode: 1,
    });

    await expect(
      parseScanInputFromAudit({
        cwd: "/tmp/project",
        packageManager: "yarn",
        format: "yarn-audit",
      })
    ).rejects.toThrow("Failed to parse output from yarn audit --json (exit code 1) as yarn-audit");
  });
});
