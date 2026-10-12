import * as readline from "node:readline/promises";
import { stdin as defaultInput, stdout as defaultOutput } from "node:process";
import { remediate } from "../api/remediate/index.js";
import { parseScanInput, parseScanInputFromAudit, uniqueCveIds } from "../scanner/index.js";
import { evaluatePackage } from "../remediation/evaluate-package.js";
import { saveSuppressionToPolicy, saveSuppressionToFile } from "../platform/policy.js";
import { saveSuppressionToVexDocument } from "../api/vex/index.js";
import type { VexJustification, VexSuppression } from "../platform/types.js";
import type { CommandOptions } from "./types.js";

export interface InteractiveTriageOptions extends Omit<Partial<CommandOptions>, "input"> {
  input?: string | NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  rl?: readline.Interface;
  vexOut?: string;
}

/**
 * Interactive developer CLI triage workflow.
 * Prompts developer through security findings with actions to apply, skip, suppress, or quit.
 * Persists suppression actions to .github/autoremediator.yml, suppressions file, or CycloneDX VEX document.
 */
export async function runInteractiveTriage(
  inputPathOrOpts: string | Partial<InteractiveTriageOptions>,
  maybeOpts?: Partial<InteractiveTriageOptions>,
): Promise<void> {
  const inputPath =
    typeof inputPathOrOpts === "string"
      ? inputPathOrOpts
      : typeof inputPathOrOpts.input === "string"
        ? inputPathOrOpts.input
        : undefined;
  const opts: Partial<InteractiveTriageOptions> =
    (typeof inputPathOrOpts === "object" ? inputPathOrOpts : maybeOpts) ?? {};
  const cwd = opts.cwd ?? process.cwd();

  const outStream = opts.output ?? defaultOutput;
  const inStream = opts.input && typeof opts.input !== "string" ? opts.input : defaultInput;

  outStream.write("\n🔍 Scanning for security findings to triage...\n");

  let findings = [];
  try {
    if (inputPath && typeof inputPath === "string") {
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
    outStream.write(
      `Failed to load scan findings: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return;
  }

  const cveIds = uniqueCveIds(findings);
  if (cveIds.length === 0) {
    outStream.write("✨ No vulnerabilities found to triage!\n\n");
    return;
  }

  outStream.write(`Found ${cveIds.length} unique vulnerability(ies) to triage.\n`);

  const rl =
    opts.rl ??
    readline.createInterface({
      input: inStream,
      output: outStream,
    });

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

      outStream.write("\n" + "=".repeat(60) + "\n");
      outStream.write(`[${i + 1}/${cveIds.length}] Vulnerability: ${cveId}\n`);
      outStream.write(`  Package:  ${pkgName}\n`);
      outStream.write(`  Severity: ${severity}\n`);
      if (safeVersion) {
        outStream.write(`  Safe Upstream Version: ${safeVersion}\n`);
      }
      outStream.write("=".repeat(60) + "\n");

      let answered = false;
      while (!answered) {
        const answer = await rl.question(
          "Action: [a]pply fix, [s]kip, [x] suppress/vex, [q]uit triage? [a/s/x/q]: ",
        );
        const choice = answer.trim().toLowerCase();

        if (choice === "a" || choice === "apply") {
          outStream.write(`Applying remediation for ${cveId}...\n`);
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
              outStream.write(`✅ Successfully applied remediation for ${cveId}!\n`);
              remediatedCount++;
            } else {
              const reason = report.results[0]?.unresolvedReason ?? "unresolved";
              outStream.write(`⚠️ Remediation could not be applied automatically (${reason}).\n`);
              skippedCount++;
            }
          } catch (err) {
            outStream.write(
              `❌ Error remediating ${cveId}: ${err instanceof Error ? err.message : String(err)}\n`,
            );
            skippedCount++;
          }
          answered = true;
        } else if (choice === "s" || choice === "skip" || choice === "") {
          outStream.write(`Skipped ${cveId}.\n`);
          skippedCount++;
          answered = true;
        } else if (choice === "x" || choice === "suppress") {
          outStream.write(`Configuring suppression / VEX record for ${cveId}...\n`);

          const justAnswer = await rl.question(
            "Justification: [1] not_affected (default), [2] mitigated, [3] under_investigation, [4] fixed: ",
          );
          const justChoice = justAnswer.trim().toLowerCase();

          let justification: VexJustification = "not_affected";
          if (justChoice === "2" || justChoice === "mitigated") {
            justification = "mitigated";
          } else if (justChoice === "3" || justChoice === "under_investigation") {
            justification = "under_investigation";
          } else if (justChoice === "4" || justChoice === "fixed") {
            justification = "fixed";
          } else {
            justification = "not_affected";
          }

          const notesAnswer = await rl.question(
            "Notes/rationale for suppression (optional, press Enter to skip): ",
          );
          const notes = notesAnswer.trim() || undefined;

          const suppression: VexSuppression = {
            cveId,
            justification,
            notes,
          };

          let persistedTarget = "";
          if (opts.suppressionsFile) {
            saveSuppressionToFile(opts.suppressionsFile, suppression);
            persistedTarget = opts.suppressionsFile;
          } else {
            persistedTarget = saveSuppressionToPolicy(cwd, suppression, opts.policy);
          }

          if (opts.vexOut) {
            saveSuppressionToVexDocument(opts.vexOut, suppression);
            outStream.write(`  📄 Saved VEX statement to: ${opts.vexOut}\n`);
          }

          outStream.write(`✅ Persisted suppression for ${cveId} to ${persistedTarget}\n`);
          suppressedCount++;
          answered = true;
        } else if (choice === "q" || choice === "quit") {
          outStream.write("Exiting triage session.\n");
          return;
        } else {
          outStream.write("Invalid option. Please choose 'a', 's', 'x', or 'q'.\n");
        }
      }
    }
  } finally {
    rl.close();
    outStream.write("\n=== Triage Summary ===\n");
    outStream.write(`Total evaluated: ${cveIds.length}\n`);
    outStream.write(`Remediated:     ${remediatedCount}\n`);
    outStream.write(`Suppressed:     ${suppressedCount}\n`);
    outStream.write(`Skipped:        ${skippedCount}\n\n`);
  }
}
