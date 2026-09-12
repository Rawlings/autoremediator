import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { remediate } from "../api/remediate/index.js";
import { parseScanInput, parseScanInputFromAudit, uniqueCveIds } from "../scanner/index.js";
import { evaluatePackage } from "../remediation/evaluate-package.js";
import type { CommandOptions } from "./types.js";

/**
 * Interactive developer CLI triage workflow.
 * Prompts developer through security findings with actions to apply, skip, suppress, or quit.
 */
export async function runInteractiveTriage(
  inputPathOrOpts: string | Partial<CommandOptions>,
  maybeOpts?: Partial<CommandOptions>,
): Promise<void> {
  const inputPath = typeof inputPathOrOpts === "string" ? inputPathOrOpts : inputPathOrOpts.input;
  const opts: Partial<CommandOptions> =
    (typeof inputPathOrOpts === "object" ? inputPathOrOpts : maybeOpts) ?? {};
  const cwd = opts.cwd ?? process.cwd();

  output.write("\n🔍 Scanning for security findings to triage...\n");

  let findings = [];
  try {
    if (inputPath) {
      findings = parseScanInput(inputPath, opts.format ?? "auto");
    } else {
      findings = await parseScanInputFromAudit({
        cwd,
        packageManager: opts.packageManager,
        format: opts.format ?? "auto",
        workspace: opts.workspace,
      });
    }
  } catch (err) {
    output.write(
      `Failed to load scan findings: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return;
  }

  const cveIds = uniqueCveIds(findings);
  if (cveIds.length === 0) {
    output.write("✨ No vulnerabilities found to triage!\n\n");
    return;
  }

  output.write(`Found ${cveIds.length} unique vulnerability(ies) to triage.\n`);

  const rl = readline.createInterface({ input, output });

  let remediatedCount = 0;
  let skippedCount = 0;
  let suppressedCount = 0;

  try {
    for (let i = 0; i < cveIds.length; i++) {
      const cveId = cveIds[i]!;
      const matchingFindings = findings.filter(
        (f) => f.cveId.toUpperCase() === cveId.toUpperCase(),
      );
      const firstFinding = matchingFindings[0];
      const pkgName = firstFinding?.packageName ?? "unknown package";
      const severity = firstFinding?.severity ?? "UNKNOWN";

      let safeVersion: string | undefined;
      if (pkgName !== "unknown package") {
        try {
          const evalRes = await evaluatePackage(pkgName, { enrichIntelligence: true });
          const matchingVuln = evalRes.vulnerabilities.find(
            (v) => v.cveId.toUpperCase() === cveId.toUpperCase(),
          );
          safeVersion =
            matchingVuln?.safeUpgradeVersion ??
            evalRes.vulnerabilities.find((v) => v.safeUpgradeVersion)?.safeUpgradeVersion;
        } catch {
          // ignore evaluation error
        }
      }

      output.write("\n" + "=".repeat(60) + "\n");
      output.write(`[${i + 1}/${cveIds.length}] Vulnerability: ${cveId}\n`);
      output.write(`  Package:  ${pkgName}\n`);
      output.write(`  Severity: ${severity}\n`);
      if (safeVersion) {
        output.write(`  Safe Upstream Version: ${safeVersion}\n`);
      }
      output.write("=".repeat(60) + "\n");

      let answered = false;
      while (!answered) {
        const answer = await rl.question(
          "Action: [a]pply fix, [s]kip, [x] suppress/vex, [q]uit triage? [a/s/x/q]: ",
        );
        const choice = answer.trim().toLowerCase();

        if (choice === "a" || choice === "apply") {
          output.write(`Applying remediation for ${cveId}...\n`);
          try {
            const report = await remediate(cveId, {
              cwd,
              packageManager: opts.packageManager,
              patchesDir: opts.patchesDir,
              policy: opts.policy,
              runTests: opts.runTests,
              constraints: {
                directDependenciesOnly: opts.directDependenciesOnly,
                preferVersionBump: opts.preferVersionBump,
                workspace: opts.workspace,
              },
            });
            const applied = report.results.some((r) => r.applied);
            if (applied) {
              output.write(`✅ Successfully applied remediation for ${cveId}!\n`);
              remediatedCount++;
            } else {
              const reason = report.results[0]?.unresolvedReason ?? "unresolved";
              output.write(`⚠️ Remediation could not be applied automatically (${reason}).\n`);
              skippedCount++;
            }
          } catch (err) {
            output.write(
              `❌ Error remediating ${cveId}: ${err instanceof Error ? err.message : String(err)}\n`,
            );
            skippedCount++;
          }
          answered = true;
        } else if (choice === "s" || choice === "skip" || choice === "") {
          output.write(`Skipped ${cveId}.\n`);
          skippedCount++;
          answered = true;
        } else if (choice === "x" || choice === "suppress") {
          output.write(`Marked ${cveId} as suppressed / VEX excluded.\n`);
          suppressedCount++;
          answered = true;
        } else if (choice === "q" || choice === "quit") {
          output.write("Exiting triage session.\n");
          return;
        } else {
          output.write("Invalid option. Please choose 'a', 's', 'x', or 'q'.\n");
        }
      }
    }
  } finally {
    rl.close();
    output.write("\n=== Triage Summary ===\n");
    output.write(`Total evaluated: ${cveIds.length}\n`);
    output.write(`Remediated:     ${remediatedCount}\n`);
    output.write(`Suppressed:     ${suppressedCount}\n`);
    output.write(`Skipped:        ${skippedCount}\n\n`);
  }
}
