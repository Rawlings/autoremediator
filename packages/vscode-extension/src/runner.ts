import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, statSync } from "node:fs";
import { randomBytes } from "node:crypto";

const execFileAsync = promisify(execFile);

export interface VulnFinding {
  packageName: string;
  cveId: string;
  severity: string;
  summary: string;
  installedVersion: string;
  safeUpgradeVersion?: string;
  inCisaKev?: boolean;
  epssScore?: number;
  epssPercentile?: number;
  reachabilityStatus?: string;
  dependencyScope?: "direct" | "transitive";
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

// In-memory debounce / scan cache keyed by cwd
interface ScanCacheEntry {
  timestamp: number;
  packageJsonMtime: number;
  findings: VulnFinding[];
}

const scanCache = new Map<string, ScanCacheEntry>();
const activeScans = new Map<string, Promise<VulnFinding[]>>();

export async function scanForVulns(cwd: string, force = false): Promise<VulnFinding[]> {
  const pkgJsonPath = join(cwd, "package.json");
  let pkgMtime = 0;
  try {
    pkgMtime = statSync(pkgJsonPath).mtimeMs;
  } catch {
    // If package.json doesn't exist, cannot scan
    return [];
  }

  const cached = scanCache.get(cwd);
  const now = Date.now();
  if (!force && cached?.packageJsonMtime === pkgMtime && now - cached.timestamp < 15000) {
    return cached.findings;
  }

  const inFlight = activeScans.get(cwd);
  if (inFlight) {
    return inFlight;
  }

  const scanPromise = (async () => {
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
        const result = await execFileAsync(auditBin, auditArgs, {
          cwd,
          maxBuffer: 10 * 1024 * 1024,
        });
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
        { cwd, maxBuffer: 5 * 1024 * 1024 },
      );

      const findings = extractFindings(JSON.parse(stdout) as ScanReportJson);
      scanCache.set(cwd, {
        timestamp: Date.now(),
        packageJsonMtime: pkgMtime,
        findings,
      });
      return findings;
    } finally {
      activeScans.delete(cwd);
      await unlink(auditFile).catch(() => {
        /* ignore — temp file cleanup */
      });
    }
  })();

  activeScans.set(cwd, scanPromise);
  return scanPromise;
}

export async function applyFix(cveId: string, cwd: string): Promise<string> {
  if (!/^CVE-\d{4}-\d{1,7}$/i.test(cveId)) {
    throw new Error(`Invalid CVE ID format: ${cveId}`);
  }
  const { bin, extraArgs } = findBin(cwd);
  const { stdout } = await execFileAsync(bin, [...extraArgs, "cve", cveId, "--cwd", cwd], {
    cwd,
    maxBuffer: 5 * 1024 * 1024,
  });
  // Invalidate cache on fix
  scanCache.delete(cwd);
  return stdout.trim();
}

export async function checkPackageReachability(
  packageName: string,
  cwd: string,
  symbol?: string,
): Promise<{ status: string; reason: string; callCount?: number }> {
  const { bin, extraArgs } = findBin(cwd);
  const args = [
    ...extraArgs,
    "reachability",
    "--package",
    packageName,
    "--cwd",
    cwd,
    "--output-format",
    "json",
  ];
  if (symbol) {
    args.push("--symbol", symbol);
  }
  try {
    const { stdout } = await execFileAsync(bin, args, { cwd, maxBuffer: 2 * 1024 * 1024 });
    const parsed = JSON.parse(stdout) as {
      status: string;
      reason: string;
      evidence?: Array<{ callCount?: number }>;
    };
    const callCount = parsed.evidence?.reduce((acc, e) => acc + (e.callCount ?? 0), 0);
    return { status: parsed.status, reason: parsed.reason, callCount };
  } catch (err: unknown) {
    return { status: "unknown", reason: (err as Error).message };
  }
}

export async function scanGitDelta(
  cwd: string,
  baseRef = "HEAD",
): Promise<{
  netRiskVerdict: string;
  summary: string;
  introducedCount: number;
  resolvedCount: number;
}> {
  const { bin, extraArgs } = findBin(cwd);
  const args = [...extraArgs, "diff", "--base", baseRef, "--cwd", cwd, "--output-format", "json"];
  const { stdout } = await execFileAsync(bin, args, { cwd, maxBuffer: 5 * 1024 * 1024 });
  const parsed = JSON.parse(stdout) as {
    netRiskVerdict: string;
    summary: string;
    introducedFindings?: unknown[];
    resolvedFindings?: unknown[];
  };
  return {
    netRiskVerdict: parsed.netRiskVerdict,
    summary: parsed.summary,
    introducedCount: parsed.introducedFindings?.length ?? 0,
    resolvedCount: parsed.resolvedFindings?.length ?? 0,
  };
}

// Minimal shapes matching autoremediator's ScanReport JSON output.
interface ScanReportJson {
  reports?: Array<{
    cveId: string;
    cveDetails?: {
      severity?: string;
      summary?: string;
      epss?: { epss?: number; percentile?: number };
      cisaKev?: boolean;
    } | null;
    vulnerablePackages?: Array<{
      installed: { name: string; version: string; type?: "direct" | "transitive" };
      affected: { firstPatchedVersion?: string };
    }>;
    results?: Array<{
      packageName: string;
      reachability?: { status?: string };
    }>;
  }>;
}

function extractFindings(report: ScanReportJson): VulnFinding[] {
  const findings: VulnFinding[] = [];
  for (const r of report.reports ?? []) {
    const reachabilityMap = new Map<string, string>();
    for (const res of r.results ?? []) {
      if (res.reachability?.status) {
        reachabilityMap.set(res.packageName, res.reachability.status);
      }
    }

    for (const vp of r.vulnerablePackages ?? []) {
      findings.push({
        packageName: vp.installed.name,
        cveId: r.cveId,
        severity: r.cveDetails?.severity ?? "UNKNOWN",
        summary: r.cveDetails?.summary ?? r.cveId,
        installedVersion: vp.installed.version,
        safeUpgradeVersion: vp.affected.firstPatchedVersion,
        inCisaKev: Boolean(r.cveDetails?.cisaKev),
        epssScore: r.cveDetails?.epss?.epss,
        epssPercentile: r.cveDetails?.epss?.percentile,
        reachabilityStatus: reachabilityMap.get(vp.installed.name),
        dependencyScope: vp.installed.type ?? "direct",
      });
    }
  }
  return findings;
}
