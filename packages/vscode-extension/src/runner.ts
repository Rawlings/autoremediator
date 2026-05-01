import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";

const execFileAsync = promisify(execFile);

export interface VulnFinding {
  packageName: string;
  cveId: string;
  severity: string;
  summary: string;
  installedVersion: string;
  safeUpgradeVersion?: string;
}

function detectPackageManager(cwd: string): "npm" | "pnpm" | "yarn" {
  if (existsSync(join(cwd, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(cwd, "yarn.lock"))) return "yarn";
  return "npm";
}

function findBin(cwd: string): { bin: string; extraArgs: string[] } {
  const local = join(cwd, "node_modules", ".bin", "autoremediator");
  if (existsSync(local)) return { bin: local, extraArgs: [] };
  return { bin: "npx", extraArgs: ["-y", "autoremediator"] };
}

export async function scanForVulns(cwd: string): Promise<VulnFinding[]> {
  const pm = detectPackageManager(cwd);
  const auditFile = join(tmpdir(), `ar-audit-${randomBytes(16).toString("hex")}.json`);

  try {
    const [auditBin, ...auditArgs]: [string, ...string[]] =
      pm === "pnpm"
        ? ["pnpm", "audit", "--json"]
        : pm === "yarn"
          ? ["yarn", "audit", "--json"]
          : ["npm", "audit", "--json"];

    let auditOutput: string;
    try {
      // npm/pnpm/yarn audit exit non-zero when vulnerabilities are found — capture stdout anyway.
      const result = await execFileAsync(auditBin, auditArgs, { cwd, maxBuffer: 10 * 1024 * 1024 });
      auditOutput = result.stdout;
    } catch (err: unknown) {
      const execErr = err as { stdout?: string };
      if (!execErr.stdout) return [];
      auditOutput = execErr.stdout;
    }

    if (!auditOutput.trim()) return [];
    await writeFile(auditFile, auditOutput, "utf8");

    const { bin, extraArgs } = findBin(cwd);
    const { stdout } = await execFileAsync(
      bin,
      [...extraArgs, "scan", "--input", auditFile, "--dry-run", "--json"],
      { cwd, maxBuffer: 5 * 1024 * 1024 }
    );

    return extractFindings(JSON.parse(stdout) as ScanReportJson);
  } finally {
    await unlink(auditFile).catch(() => {
      /* ignore — temp file cleanup */
    });
  }
}

export async function applyFix(cveId: string, cwd: string): Promise<string> {
  if (!/^CVE-\d{4}-\d{1,7}$/i.test(cveId)) {
    throw new Error(`Invalid CVE ID format: ${cveId}`);
  }
  const { bin, extraArgs } = findBin(cwd);
  const { stdout } = await execFileAsync(
    bin,
    [...extraArgs, "cve", cveId, "--cwd", cwd],
    { cwd, maxBuffer: 5 * 1024 * 1024 }
  );
  return stdout.trim();
}

// Minimal shapes matching autoremediator's ScanReport JSON output.
interface ScanReportJson {
  reports?: Array<{
    cveId: string;
    cveDetails?: { severity?: string; summary?: string } | null;
    vulnerablePackages?: Array<{
      installed: { name: string; version: string };
      affected: { firstPatchedVersion?: string };
    }>;
  }>;
}

function extractFindings(report: ScanReportJson): VulnFinding[] {
  const findings: VulnFinding[] = [];
  for (const r of report.reports ?? []) {
    for (const vp of r.vulnerablePackages ?? []) {
      findings.push({
        packageName: vp.installed.name,
        cveId: r.cveId,
        severity: r.cveDetails?.severity ?? "UNKNOWN",
        summary: r.cveDetails?.summary ?? r.cveId,
        installedVersion: vp.installed.version,
        safeUpgradeVersion: vp.affected.firstPatchedVersion,
      });
    }
  }
  return findings;
}
