/**
 * Autonomous PR Auto-Healer
 *
 * Listens to failing CI check runs on autoremediator pull requests,
 * extracts diagnostics, fetches failing files via Octokit, applies targeted
 * repairs, and pushes healing commits to trigger fresh CI verification.
 */
import type { Octokit } from "@octokit/rest";

import type { DiagnosticFinding, ParsedDiagnostic } from "../diagnostics/log-parser.js";
import type { AutoremediatorRepoConfig, ErrorLogger } from "../types.js";
import { listPullRequestChangedFiles } from "./pr-files.js";
import { repairBranchFiles } from "./repair-branch.js";
import type { RepairStrategy } from "./repair-strategy.js";

export interface HealPrOptions {
  octokit: Octokit;
  owner: string;
  repo: string;
  pullNumber: number;
  branchName: string;
  checkRunName: string;
  diagnostic: ParsedDiagnostic;
  repoConfig: AutoremediatorRepoConfig;
  logger?: ErrorLogger;
  /** How files are repaired (default: the pattern-based strategy). */
  strategy?: RepairStrategy;
}

export interface HealPrResult {
  healed: boolean;
  attempt: number;
  maxAttempts: number;
  actionTaken: "commented-human-review" | "applied-healing-commit" | "skipped";
  healedFiles?: string[];
  reason?: string;
}

// In-memory attempt tracker per repo+PR
const ATTEMPTS_MAP = new Map<string, number>();

export function getHealingAttemptKey(owner: string, repo: string, pullNumber: number): string {
  return `${owner}/${repo}#${pullNumber}`;
}

export function resetHealingAttempts(owner: string, repo: string, pullNumber: number): void {
  ATTEMPTS_MAP.delete(getHealingAttemptKey(owner, repo, pullNumber));
}

export function getHealingAttempts(owner: string, repo: string, pullNumber: number): number {
  return ATTEMPTS_MAP.get(getHealingAttemptKey(owner, repo, pullNumber)) || 0;
}

function escapeRegex(str: string): string {
  return str.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

/**
 * Attempts targeted healing repairs on file content using structured diagnostics.
 */
export function repairFileContent(content: string, findings: DiagnosticFinding[]): string {
  let repaired = content;

  for (const finding of findings) {
    const msg = finding.message;

    // 1. TypeScript ESM default export mismatch (TS2614, TS1192, "has no default export")
    // e.g. Module '"chalk"' has no default export.
    if (
      msg.includes("no default export") ||
      msg.includes("has no exported member 'default'") ||
      msg.includes("TS2614") ||
      msg.includes("TS1192")
    ) {
      const pkgMatch =
        /Module\s+['"]([^'"]+)['"]\s+has\s+no\s+default/i.exec(msg) ??
        /Module\s+['"]([^'"]+)['"]/i.exec(msg) ??
        /['"]([^'"]+)['"]/.exec(msg);
      const targetPkg = pkgMatch ? pkgMatch[1] : undefined;

      const importRegex = targetPkg
        ? new RegExp(
            `import\\s+([a-zA-Z0-9_$]+)\\s+from\\s+['"]${escapeRegex(targetPkg)}['"];?`,
            "g",
          )
        : /import\s+([a-zA-Z0-9_$]+)\s+from\s+['"]([^'"]+)['"];?/g;

      repaired = repaired.replace(importRegex, (_match, id, matchedPkg) => {
        const pkg = targetPkg || matchedPkg;
        return `import * as ${id} from "${pkg}";`;
      });
    }

    // 2. TypeScript CJS "export =" default import mismatch (TS1259)
    if (msg.includes("can only be used with a default import") || msg.includes("TS1259")) {
      const pkgMatch = /Module\s+['"]([^'"]+)['"]/i.exec(msg) ?? /['"]([^'"]+)['"]/.exec(msg);
      const targetPkg = pkgMatch ? pkgMatch[1] : undefined;

      const starImportRegex = targetPkg
        ? new RegExp(
            `import\\s+\\*\\s+as\\s+([a-zA-Z0-9_$]+)\\s+from\\s+['"]${escapeRegex(targetPkg)}['"];?`,
            "g",
          )
        : /import\s+\*\s+as\s+([a-zA-Z0-9_$]+)\s+from\s+['"]([^'"]+)['"];?/g;

      repaired = repaired.replace(starImportRegex, (_match, id, matchedPkg) => {
        const pkg = targetPkg || matchedPkg;
        return `import ${id} from "${pkg}";`;
      });
    }

    // 3. Compiler suggestion: "Did you mean 'XYZ'?"
    const suggestionMatch = /Did you mean ['"]([a-zA-Z0-9_$]+)['"]\?/.exec(msg);
    const missingMatch =
      /has no exported member ['"]([a-zA-Z0-9_$]+)['"]/.exec(msg) ??
      /Property ['"]([a-zA-Z0-9_$]+)['"] does not exist/.exec(msg);

    if (suggestionMatch && missingMatch) {
      const oldSymbol = missingMatch[1]!;
      const newSymbol = suggestionMatch[1]!;

      // The suggestion is CI text. It is applied only when that identifier is already in this
      // file, so the output can pick which existing name is used but never introduce a new one.
      if (!new RegExp(`(?<![\\w$])${escapeRegex(newSymbol)}(?![\\w$])`).test(repaired)) {
        continue;
      }

      if (finding.line && finding.line > 0) {
        // Target specifically the line indicated by the compiler diagnostic
        const lines = repaired.split("\n");
        const idx = finding.line - 1;
        if (idx >= 0 && idx < lines.length) {
          lines[idx] = lines[idx]!.replaceAll(
            new RegExp(`\\b${escapeRegex(oldSymbol)}\\b`, "g"),
            newSymbol,
          );
          repaired = lines.join("\n");
        }
      } else {
        // Replace member expression .oldSymbol -> .newSymbol
        repaired = repaired.replaceAll(
          new RegExp(`\\.${escapeRegex(oldSymbol)}\\b`, "g"),
          `.${newSymbol}`,
        );
      }
    }

    // 4. Linter: unused import removal
    if (
      finding.ruleId &&
      (finding.ruleId.includes("no-unused-vars") || finding.ruleId.includes("unused-imports"))
    ) {
      const unusedVarMatch = /['"]([a-zA-Z0-9_$]+)['"]\s+is\s+(?:defined|imported)/.exec(msg);
      if (unusedVarMatch) {
        const unusedVar = unusedVarMatch[1]!;
        const lines = repaired.split("\n");
        let idx = finding.line && finding.line > 0 ? finding.line - 1 : -1;
        if (idx < 0 || idx >= lines.length || !lines[idx]?.includes("import")) {
          // If no line or line didn't match, locate line containing the unused import
          idx = lines.findIndex(
            (l) => l.includes("import") && new RegExp(`\\b${escapeRegex(unusedVar)}\\b`).test(l),
          );
        }
        if (idx >= 0 && idx < lines.length) {
          let line = lines[idx]!;
          if (line.includes("import")) {
            const soleNamedImport = new RegExp(
              `^\\s*import\\s*(?:type\\s+)?\\{\\s*(?:type\\s+)?${escapeRegex(unusedVar)}\\s*,?\\s*\\}\\s*from\\s*['"][^'"]+['"];?\\s*$`,
            );
            const defaultImport = new RegExp(
              `^\\s*import\\s+(?:type\\s+)?${escapeRegex(unusedVar)}\\s+from\\s*['"][^'"]+['"];?\\s*$`,
            );
            if (soleNamedImport.test(line) || defaultImport.test(line)) {
              lines.splice(idx, 1);
            } else {
              line = line.replace(new RegExp(`,\\s*${escapeRegex(unusedVar)}\\b`), "");
              line = line.replace(new RegExp(`\\b${escapeRegex(unusedVar)}\\s*,\\s*`), "");
              if (/^\s*import\s*(?:type\s+)?\{\s*\}\s*from\s*['"][^'"]+['"];?\s*$/.test(line)) {
                lines.splice(idx, 1);
              } else {
                lines[idx] = line;
              }
            }
            repaired = lines.join("\n");
          }
        }
      }
    }
  }

  return repaired;
}

/** The default repair strategy: pattern-based edits for a few well-understood errors. */
export const regexRepairStrategy: RepairStrategy = {
  name: "regex",
  repair: ({ content, findings }) => repairFileContent(content, [...findings]),
};

export async function healPullRequest(options: HealPrOptions): Promise<HealPrResult> {
  const { octokit, owner, repo, pullNumber, branchName, checkRunName, diagnostic, repoConfig } =
    options;

  const maxAttempts = repoConfig.maxHealingAttempts ?? 3;
  const key = getHealingAttemptKey(owner, repo, pullNumber);
  const currentAttempts = ATTEMPTS_MAP.get(key) || 0;

  if (currentAttempts >= maxAttempts) {
    // Exceeded max healing attempts — escalate to human review
    const commentBody =
      `### ⚠️ Autoremediator Auto-Healing Limit Reached\n\n` +
      `Check run **${checkRunName}** failed on \`${branchName}\` after **${maxAttempts}** automated healing attempt(s).\n\n` +
      `**Diagnostic Summary:**\n` +
      `\`\`\`\n${diagnostic.summary}\n\`\`\`\n\n` +
      `Label \`autoremediator/needs-human-review\` added. Manual intervention is required to complete this remediation.`;

    try {
      await octokit.issues.createComment({
        owner,
        repo,
        issue_number: pullNumber,
        body: commentBody,
      });

      await octokit.issues.addLabels({
        owner,
        repo,
        issue_number: pullNumber,
        labels: ["autoremediator/needs-human-review"],
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      void options.logger?.({
        timestamp: new Date().toISOString(),
        source: "github-app",
        level: "warn",
        context: "pr-healer.maxAttempts.commentAndLabel",
        message: `Failed to comment/label PR #${pullNumber}: ${message}`,
        error: message,
        details: { owner, repo, pullNumber },
      });
    }

    return {
      healed: false,
      attempt: currentAttempts,
      maxAttempts,
      actionTaken: "commented-human-review",
      reason: "Maximum healing attempts reached.",
    };
  }

  // Increment attempt counter
  const nextAttempt = currentAttempts + 1;
  ATTEMPTS_MAP.set(key, nextAttempt);

  // Group findings by file path
  const fileFindingsMap = new Map<string, DiagnosticFinding[]>();
  for (const finding of diagnostic.findings) {
    if (finding.filePath) {
      const existing = fileFindingsMap.get(finding.filePath) ?? [];
      existing.push(finding);
      fileFindingsMap.set(finding.filePath, existing);
    }
  }

  if (fileFindingsMap.size === 0) {
    // Cannot pinpoint broken files from logs
    const commentBody =
      `### ⚠️ Autoremediator Auto-Healing Unable to Localize Failure\n\n` +
      `Check run **${checkRunName}** failed on \`${branchName}\`, but no actionable file paths could be extracted from CI logs.\n\n` +
      `**Diagnostic Summary:**\n` +
      `\`\`\`\n${diagnostic.summary}\n\`\`\`\n\n` +
      `Label \`autoremediator/needs-human-review\` added.`;

    try {
      await octokit.issues.createComment({
        owner,
        repo,
        issue_number: pullNumber,
        body: commentBody,
      });
      await octokit.issues.addLabels({
        owner,
        repo,
        issue_number: pullNumber,
        labels: ["autoremediator/needs-human-review"],
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      void options.logger?.({
        timestamp: new Date().toISOString(),
        source: "github-app",
        level: "warn",
        context: "pr-healer.localizeFailure.commentAndLabel",
        message: `Failed to comment/label PR #${pullNumber}: ${message}`,
        error: message,
        details: { owner, repo, pullNumber },
      });
    }

    return {
      healed: false,
      attempt: nextAttempt,
      maxAttempts,
      actionTaken: "commented-human-review",
      reason: "No actionable file paths found in CI diagnostics.",
    };
  }

  // CI output names the files, and anything running in the job can print it, so only files this
  // pull request itself changed may be repaired.
  let allowedFiles = new Set<string>();
  try {
    allowedFiles = await listPullRequestChangedFiles(octokit, { owner, repo, pullNumber });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    void options.logger?.({
      timestamp: new Date().toISOString(),
      source: "github-app",
      level: "warn",
      context: "pr-healer.listFiles",
      message: `Failed to list the files of PR #${pullNumber}: ${message}`,
      error: message,
      details: { owner, repo, pullNumber },
    });
  }

  const { healedFiles } = await repairBranchFiles({
    octokit,
    owner,
    repo,
    branchName,
    findingsByFile: fileFindingsMap,
    allowedFiles,
    strategy: options.strategy ?? regexRepairStrategy,
    commitMessage: `fix(autoremediator): auto-heal ${checkRunName} diagnostics [attempt ${nextAttempt}]`,
    logger: options.logger,
    pullNumber,
  });

  if (healedFiles.length === 0) {
    // None of the heuristics could repair the files
    const commentBody =
      `### ⚠️ Autoremediator Auto-Healing Unsuccessful\n\n` +
      `Check run **${checkRunName}** failed on \`${branchName}\`. Automated repair heuristics were unable to resolve the diagnostic errors.\n\n` +
      `**Diagnostic Summary:**\n` +
      `\`\`\`\n${diagnostic.summary}\n\`\`\`\n\n` +
      `Label \`autoremediator/needs-human-review\` added.`;

    try {
      await octokit.issues.createComment({
        owner,
        repo,
        issue_number: pullNumber,
        body: commentBody,
      });
      await octokit.issues.addLabels({
        owner,
        repo,
        issue_number: pullNumber,
        labels: ["autoremediator/needs-human-review"],
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      void options.logger?.({
        timestamp: new Date().toISOString(),
        source: "github-app",
        level: "warn",
        context: "pr-healer.unsuccessful.commentAndLabel",
        message: `Failed to comment/label PR #${pullNumber}: ${message}`,
        error: message,
        details: { owner, repo, pullNumber },
      });
    }

    return {
      healed: false,
      attempt: nextAttempt,
      maxAttempts,
      actionTaken: "commented-human-review",
      reason: "Diagnostic errors could not be safely repaired automatically.",
    };
  }

  // Successfully applied healing commit(s)
  const commentBody =
    `### 🩹 Autoremediator Auto-Healing Applied (Attempt ${nextAttempt}/${maxAttempts})\n\n` +
    `Pushed automated repair commit to \`${branchName}\` addressing diagnostics from **${checkRunName}**:\n` +
    healedFiles.map((f) => `- \`${f}\``).join("\n") +
    `\n\nCI check suite will re-run automatically.`;

  try {
    await octokit.issues.createComment({
      owner,
      repo,
      issue_number: pullNumber,
      body: commentBody,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    void options.logger?.({
      timestamp: new Date().toISOString(),
      source: "github-app",
      level: "warn",
      context: "pr-healer.applied.comment",
      message: `Failed to comment on PR #${pullNumber}: ${message}`,
      error: message,
      details: { owner, repo, pullNumber },
    });
  }

  return {
    healed: true,
    attempt: nextAttempt,
    maxAttempts,
    actionTaken: "applied-healing-commit",
    healedFiles,
    reason: `Applied healing commit for ${healedFiles.join(", ")}.`,
  };
}
