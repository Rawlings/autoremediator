import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join, resolve, relative, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { remediateFromScan, type CveSeverity, type ScanReport } from "autoremediator";
import type { Octokit } from "@octokit/rest";
import type { AutoremediatorRepoConfig, RemediationJobResult, RemediationTriggerContext } from "./types.js";
import { fetchRepoConfig } from "./repo-config.js";

type ScanRemediateOptions = NonNullable<Parameters<typeof remediateFromScan>[1]>;
type ScanChangeRequestOptions = NonNullable<ScanRemediateOptions["changeRequest"]>;

interface ParsedAuditFinding {
  cveId: string;
  severity: CveSeverity;
}

const CVE_REGEX = /CVE-\d{4}-\d+/gi;

const SEVERITY_RANK: Record<CveSeverity, number> = {
  UNKNOWN: 0,
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
  CRITICAL: 4,
};

export interface DefaultRemediationHandlerOptions {
  octokitFactory: (installationId: number) => Promise<Octokit>;
  /** Override repo config fetch — useful for tests. */
  repoConfigProvider?: (owner: string, repo: string) => Promise<AutoremediatorRepoConfig>;
  /** Override audit finding collection — useful for tests. */
  auditFindingProvider?: (cwd: string) => Promise<ParsedAuditFinding[]>;
}

export type RemediationHandler = (context: RemediationTriggerContext) => Promise<RemediationJobResult | void>;

function readRepoFromPayload(payload: Record<string, unknown>): { owner: string; repo: string } | undefined {
  const repository = payload.repository;
  if (!repository || typeof repository !== "object") return undefined;
  const r = repository as Record<string, unknown>;
  const name = typeof r.name === "string" ? r.name : undefined;
  const ownerObj = r.owner;
  const owner =
    typeof ownerObj === "string"
      ? ownerObj
      : ownerObj && typeof ownerObj === "object"
        ? (ownerObj as Record<string, unknown>).login as string | undefined
        : undefined;
  if (!owner || !name) return undefined;
  return { owner, repo: name };
}

export function createDefaultRemediationHandler(options: DefaultRemediationHandlerOptions): RemediationHandler {
  return async (context: RemediationTriggerContext): Promise<RemediationJobResult | void> => {
    if (
      context.eventName !== "check_suite" &&
      context.eventName !== "workflow_dispatch" &&
      context.eventName !== "push"
    ) {
      return;
    }

    const installationId = context.installationId ?? 0;
    const octokit = await options.octokitFactory(installationId);

    let repoConfig: AutoremediatorRepoConfig;
    const repoRef = readRepoFromPayload(context.payload ?? {});

    if (options.repoConfigProvider && repoRef) {
      repoConfig = await options.repoConfigProvider(repoRef.owner, repoRef.repo);
    } else if (repoRef) {
      repoConfig = await fetchRepoConfig(octokit, repoRef.owner, repoRef.repo);
    } else {
      // No repository in payload — use defaults
      const { DEFAULT_REPO_CONFIG } = await import("./types.js");
      repoConfig = { ...DEFAULT_REPO_CONFIG };
    }

    const rawCwd = repoConfig.cwd ?? process.cwd();
    // Resolve and constrain cwd — must not escape the current working directory
    const resolvedCwd = isAbsolute(rawCwd) ? rawCwd : resolve(process.cwd(), rawCwd);
    const rel = relative(process.cwd(), resolvedCwd);
    if (rel.startsWith("..") || rel.includes("\0")) {
      throw new Error(`Repository config cwd escapes the working directory: ${rawCwd}`);
    }
    const cwd = resolvedCwd;
    const dryRun = repoConfig.dryRun;
    const runTests = repoConfig.runTests;
    const minimumSeverity = repoConfig.minimumSeverity;

    const changeRequest: ScanChangeRequestOptions | undefined = repoConfig.pullRequest?.enabled
      ? {
          enabled: true,
          provider: "github",
          grouping: repoConfig.pullRequest.grouping,
          repository: repoConfig.pullRequest.repository,
          baseBranch: repoConfig.pullRequest.baseBranch,
          branchPrefix: repoConfig.pullRequest.branchPrefix,
          titlePrefix: repoConfig.pullRequest.titlePrefix,
          bodyFooter: repoConfig.pullRequest.bodyFooter,
          draft: repoConfig.pullRequest.draft,
          pushRemote: repoConfig.pullRequest.pushRemote,
          tokenEnvVar: repoConfig.pullRequest.tokenEnvVar,
        }
      : undefined;

    const policyOptions = {
      allowMajorBumps: repoConfig.allowMajorBumps,
      denyPackages: repoConfig.denyPackages,
      allowPackages: repoConfig.allowPackages,
      constraints: repoConfig.constraints,
      modelDefaults: repoConfig.modelDefaults,
      providerSafetyProfile: repoConfig.providerSafetyProfile,
      requireConsensusForHighRisk: repoConfig.requireConsensusForHighRisk,
      consensusProvider: repoConfig.consensusProvider,
      consensusModel: repoConfig.consensusModel,
      patchConfidenceThresholds: repoConfig.patchConfidenceThresholds,
      dynamicModelRouting: repoConfig.dynamicModelRouting,
      dynamicRoutingThresholdChars: repoConfig.dynamicRoutingThresholdChars,
      dispositionPolicy: repoConfig.dispositionPolicy,
      containmentMode: repoConfig.containmentMode,
      escalationGraph: repoConfig.escalationGraph,
    };

    if (minimumSeverity === "UNKNOWN") {
      const report = await remediateFromScan("", {
        cwd,
        audit: true,
        dryRun,
        runTests,
        changeRequest,
        ...policyOptions,
      });
      return toRemediationJobResult(report);
    }

    const findings = options.auditFindingProvider
      ? await options.auditFindingProvider(cwd)
      : await collectAuditFindings(cwd);

    const cveIds = selectCvesByMinimumSeverity(findings, minimumSeverity);
    if (cveIds.length === 0) {
      return { status: "success", reason: "No CVEs matched minimum severity filter" };
    }

    const tempDir = await mkdtemp(join(tmpdir(), "autoremediator-ghapp-"));
    const filteredSarifPath = join(tempDir, "filtered-findings.sarif");

    try {
      await writeFile(filteredSarifPath, JSON.stringify(createSarifFromCves(cveIds), null, 2), "utf8");

      const report = await remediateFromScan(filteredSarifPath, {
        cwd,
        format: "sarif",
        audit: false,
        dryRun,
        runTests,
        changeRequest,
        ...policyOptions,
      });

      return toRemediationJobResult(report);
    } finally {
      try {
        await rm(tempDir, { recursive: true, force: true });
      } catch {
        // Cleanup failure is non-fatal; temp directory may linger but is OS-managed
      }
    }
  };
}

function toRemediationJobResult(report: ScanReport): RemediationJobResult {
  if (report.status === "ok") {
    return { status: "success" };
  }

  if (report.status === "partial") {
    return {
      status: "partial",
      reason: `Scan completed with partial result (${report.successCount} success, ${report.failedCount} failed)`,
    };
  }

  return {
    status: "failed",
    reason: `Scan remediation failed (${report.failedCount} failed outcomes)`,
  };
}

function selectCvesByMinimumSeverity(findings: ParsedAuditFinding[], minimumSeverity: CveSeverity): string[] {
  const minRank = SEVERITY_RANK[minimumSeverity];
  const cves = new Set<string>();

  for (const finding of findings) {
    if (SEVERITY_RANK[finding.severity] >= minRank) {
      cves.add(finding.cveId.toUpperCase());
    }
  }

  return [...cves].sort((a, b) => a.localeCompare(b));
}

function normalizeSeverity(raw?: string): CveSeverity {
  if (!raw) {
    return "UNKNOWN";
  }

  const normalized = raw.toUpperCase();
  if (normalized === "LOW" || normalized === "HIGH" || normalized === "CRITICAL") {
    return normalized;
  }
  if (normalized === "MEDIUM" || normalized === "MODERATE") {
    return "MEDIUM";
  }

  return "UNKNOWN";
}

function extractCveIds(value: string): string[] {
  return (value.match(CVE_REGEX) ?? []).map((item) => item.toUpperCase());
}

function parseNpmAuditFindings(content: string): ParsedAuditFinding[] {
  const parsed = JSON.parse(content) as {
    vulnerabilities?: Record<
      string,
      {
        name?: string;
        severity?: string;
        via?: Array<string | { url?: string; name?: string }>;
      }
    >;
  };

  const findings: ParsedAuditFinding[] = [];
  const seen = new Set<string>();

  for (const vuln of Object.values(parsed.vulnerabilities ?? {})) {
    const severity = normalizeSeverity(vuln.severity);
    for (const viaEntry of vuln.via ?? []) {
      const text = typeof viaEntry === "string" ? viaEntry : `${viaEntry.url ?? ""} ${viaEntry.name ?? ""}`;
      for (const cveId of extractCveIds(text)) {
        const key = `${cveId}:${vuln.name ?? ""}`;
        if (seen.has(key)) {
          continue;
        }

        seen.add(key);
        findings.push({ cveId, severity });
      }
    }
  }

  return findings;
}

function parseYarnAuditFindings(content: string): ParsedAuditFinding[] {
  const findings: ParsedAuditFinding[] = [];
  const seen = new Set<string>();
  const lines = content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  for (const line of lines) {
    let parsedLine: unknown;
    try {
      parsedLine = JSON.parse(line);
    } catch {
      continue;
    }

    const event = parsedLine as {
      type?: string;
      data?: {
        advisory?: {
          module_name?: string;
          severity?: string;
          url?: string;
          cves?: string[];
        };
      };
    };

    if (event.type !== "auditAdvisory") {
      continue;
    }

    const advisory = event.data?.advisory;
    const text = `${advisory?.url ?? ""} ${(advisory?.cves ?? []).join(" ")}`;
    const severity = normalizeSeverity(advisory?.severity);

    for (const cveId of extractCveIds(text)) {
      const key = `${cveId}:${advisory?.module_name ?? ""}`;
      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      findings.push({ cveId, severity });
    }
  }

  return findings;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function detectPackageManager(cwd: string): Promise<"npm" | "pnpm" | "yarn"> {
  if (await fileExists(join(cwd, "yarn.lock"))) {
    return "yarn";
  }
  if (await fileExists(join(cwd, "pnpm-lock.yaml"))) {
    return "pnpm";
  }

  return "npm";
}

async function runCommand(command: string, args: string[], cwd: string): Promise<{ output: string; exitCode: number }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    child.once("error", (error) => {
      reject(error);
    });

    child.once("close", (code) => {
      resolve({
        output: [stdout, stderr].filter(Boolean).join("\n").trim(),
        exitCode: code ?? 0,
      });
    });
  });
}

async function collectAuditFindings(cwd: string): Promise<ParsedAuditFinding[]> {
  const packageManager = await detectPackageManager(cwd);
  const commands: Array<[string, string[]]> =
    packageManager === "yarn"
      ? [
          ["yarn", ["npm", "audit", "--json"]],
          ["yarn", ["audit", "--json"]],
        ]
      : packageManager === "pnpm"
        ? [["pnpm", ["audit", "--json"]]]
        : [["npm", ["audit", "--json"]]];

  let lastError = "No audit output received.";

  for (const [command, args] of commands) {
    let result: { output: string; exitCode: number };
    try {
      result = await runCommand(command, args, cwd);
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      continue;
    }

    if (!result.output) {
      lastError = `No audit output received from ${command} ${args.join(" ")}.`;
      continue;
    }

    let findings: ParsedAuditFinding[] = [];
    try {
      findings = parseNpmAuditFindings(result.output);
    } catch {
      findings = [];
    }

    if (findings.length === 0) {
      findings = parseYarnAuditFindings(result.output);
    }

    if (result.exitCode !== 0 && findings.length === 0) {
      lastError = `Failed to parse output from ${command} ${args.join(" ")} (exit code ${result.exitCode}).`;
      continue;
    }

    return findings;
  }

  throw new Error(lastError);
}

function createSarifFromCves(cveIds: string[]): Record<string, unknown> {
  return {
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "autoremediator-github-app",
            informationUri: "https://github.com/rawlings/autoremediator",
          },
        },
        results: cveIds.map((cveId) => ({
          ruleId: cveId,
          level: "warning",
          message: {
            text: `${cveId} matched configured minimum severity filter`,
          },
        })),
      },
    ],
  };
}