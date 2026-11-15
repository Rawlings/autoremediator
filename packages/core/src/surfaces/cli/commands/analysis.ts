import { checkReachability, evaluatePackage, scanDelta } from "../../../api/index.js";
import { logJson } from "../output.js";

export async function runReachability(opts: {
  cwd?: string;
  package: string;
  symbol?: string;
  traceFile?: string;
  outputFormat?: string;
}): Promise<void> {
  const result = await checkReachability({
    cwd: opts.cwd,
    packageName: opts.package,
    symbol: opts.symbol,
    traceFile: opts.traceFile,
  });

  if (opts.outputFormat === "json") {
    logJson(result);
    return;
  }

  process.stdout.write(`Package: ${result.packageName}\n`);
  process.stdout.write(`Status: ${result.status}\n`);
  process.stdout.write(`Reason: ${result.reason}\n`);
  if (result.runtime) {
    process.stdout.write(`Runtime: ${result.runtime.verdict}\n`);
    process.stdout.write(`Note: ${result.runtime.caveat}\n`);
  }
  if (result.evidence && result.evidence.length > 0) {
    process.stdout.write(`Evidence files (${result.evidence.length}):\n`);
    for (const ev of result.evidence) {
      process.stdout.write(
        `  - ${ev.filePath} [${ev.matchType}] (invoked: ${ev.invoked ?? false})\n`,
      );
    }
  }
}

export async function runEvaluate(
  packageName: string,
  opts: {
    cwd?: string;
    version?: string;
    outputFormat?: string;
  },
): Promise<void> {
  const report = await evaluatePackage(packageName, {
    version: opts.version,
    cwd: opts.cwd,
    enrichIntelligence: true,
  });

  if (opts.outputFormat === "json") {
    logJson(report);
    return;
  }

  process.stdout.write(
    `Package: ${report.packageName}${report.evaluatedVersion ? `@${report.evaluatedVersion}` : ""}\n`,
  );
  process.stdout.write(`Verdict: ${report.verdict.toUpperCase()}\n`);
  process.stdout.write(`Summary: ${report.summary}\n`);
  if (report.recommendedVersion) {
    process.stdout.write(`Recommended Version: ${report.recommendedVersion}\n`);
  }
  if (report.vulnerabilities.length > 0) {
    process.stdout.write(`Known Vulnerabilities (${report.vulnerabilities.length}):\n`);
    for (const vuln of report.vulnerabilities) {
      process.stdout.write(`  - [${vuln.cveId}] (${vuln.severity}) ${vuln.summary}\n`);
      if (vuln.safeUpgradeVersion) {
        process.stdout.write(`    Safe upgrade: ${vuln.safeUpgradeVersion}\n`);
      }
    }
  }
}

export async function runDiffAudit(opts: {
  cwd?: string;
  base?: string;
  outputFormat?: string;
  ci?: boolean;
}): Promise<void> {
  const report = await scanDelta({
    cwd: opts.cwd,
    baseRef: opts.base,
  });

  if (opts.outputFormat === "json") {
    logJson(report);
    if (opts.ci) {
      process.exitCode = report.netRiskVerdict === "degraded" ? 1 : 0;
    }
    return;
  }

  process.stdout.write(`Delta scan against base: ${report.baseRef}\n`);
  process.stdout.write(`Net Risk Verdict: ${report.netRiskVerdict.toUpperCase()}\n`);
  process.stdout.write(`Dependency Changes: ${report.dependencyChanges.length}\n`);
  process.stdout.write(`Newly Introduced CVEs: ${report.introducedFindings.length}\n`);
  process.stdout.write(`Resolved CVEs: ${report.resolvedFindings.length}\n`);
  process.stdout.write(`Summary: ${report.summary}\n`);

  if (report.introducedFindings.length > 0) {
    process.stdout.write(`\nIntroduced Findings:\n`);
    for (const f of report.introducedFindings) {
      process.stdout.write(
        `  - [${f.cveId}] ${f.packageName}@${f.installedVersion ?? "unknown"} (${f.severity}): ${f.summary}\n`,
      );
    }
  }

  if (opts.ci) {
    process.exitCode = report.netRiskVerdict === "degraded" ? 1 : 0;
  }
}
