import { assessUpgrade, findVulnerableSymbols } from "../../../api/index.js";
import { logJson } from "../output.js";

function describeSite(site: {
  file: string;
  line: number;
  text: string;
  confidence: string;
}): string {
  return `${site.file}:${site.line}${site.confidence === "name-match" ? " (name match)" : ""}  ${site.text}`;
}

export async function runAssess(
  packageName: string,
  opts: { cwd?: string; from: string; to: string; outputFormat?: string },
): Promise<void> {
  const result = await assessUpgrade({
    packageName,
    from: opts.from,
    to: opts.to,
    cwd: opts.cwd,
  });

  if (opts.outputFormat === "json") {
    logJson(result);
    return;
  }

  process.stdout.write(
    `${result.packageName} ${result.fromVersion} -> ${result.toVersion}${result.upgradeLevel ? ` (${result.upgradeLevel})` : ""}\n`,
  );
  process.stdout.write(
    `Breakability: ${result.breakability.toUpperCase()} (score ${result.score})\n`,
  );
  process.stdout.write(`${result.summary}\n`);
  for (const finding of result.findings) {
    const where = finding.symbol
      ? ` ${finding.specifier ?? ""}${finding.symbol === "default" ? "" : `#${finding.symbol}`}${finding.member ? `.${finding.member}` : ""}`
      : "";
    process.stdout.write(
      `\n[${finding.severity}, ${finding.evidence}, ${finding.points} pts]${where}\n  ${finding.reason}\n`,
    );
    if (finding.before !== undefined || finding.after !== undefined) {
      if (finding.before !== undefined) process.stdout.write(`  before: ${finding.before}\n`);
      if (finding.after !== undefined) process.stdout.write(`  after:  ${finding.after}\n`);
    }
    for (const site of finding.affectedCallSites) {
      process.stdout.write(`  - ${describeSite(site)}\n`);
    }
    if (finding.totalCallSites > finding.affectedCallSites.length) {
      process.stdout.write(
        `  ... and ${finding.totalCallSites - finding.affectedCallSites.length} more\n`,
      );
    }
  }
  if (result.limitations.length > 0) {
    process.stdout.write("\nLimitations:\n");
    for (const limitation of result.limitations) process.stdout.write(`  - ${limitation}\n`);
  }
}

export async function runSymbols(
  packageName: string,
  opts: {
    cwd?: string;
    from: string;
    to: string;
    advisoryText?: string;
    cwe?: string;
    limit?: number;
    reachability?: boolean;
    outputFormat?: string;
  },
): Promise<void> {
  const result = await findVulnerableSymbols({
    packageName,
    from: opts.from,
    to: opts.to,
    cwd: opts.cwd,
    advisoryText: opts.advisoryText,
    cwes: opts.cwe
      ?.split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry !== ""),
    limit: opts.limit,
    checkReachability: opts.reachability,
  });

  if (opts.outputFormat === "json") {
    logJson(result);
    return;
  }

  process.stdout.write(
    `${result.packageName} ${result.fromVersion} -> ${result.toVersion}: candidate vulnerable symbols (HEURISTIC: a changed export is not proof it was the vulnerable one)\n`,
  );
  process.stdout.write(
    `${result.candidates.length} of ${result.totalCandidates} candidate${result.totalCandidates === 1 ? "" : "s"} shown${result.reachableCount === undefined ? "" : `, ${result.reachableCount} reachable from this project`}\n`,
  );
  for (const candidate of result.candidates) {
    process.stdout.write(
      `\n${candidate.score}  ${candidate.specifier}${candidate.symbol === candidate.exportName ? `#${candidate.symbol}` : ` (${candidate.symbol})`}  [${candidate.basis}] ${candidate.file}\n`,
    );
    for (const reason of candidate.reasons) process.stdout.write(`    ${reason}\n`);
    if (candidate.via.length > 0) process.stdout.write(`    via: ${candidate.via.join(", ")}\n`);
    if (candidate.reachability) {
      process.stdout.write(
        `    reachability: ${candidate.reachability.status} - ${candidate.reachability.reason}\n`,
      );
    }
  }
  if (result.changedInternals.length > 0) {
    process.stdout.write(
      `\nChanged internals not tied to an export: ${result.changedInternals
        .slice(0, 10)
        .map((entry) => `${entry.name} (${entry.file})`)
        .join(", ")}${result.changedInternals.length > 10 ? ", ..." : ""}\n`,
    );
  }
  process.stdout.write("\nLimitations:\n");
  for (const limitation of result.limitations) process.stdout.write(`  - ${limitation}\n`);
}
