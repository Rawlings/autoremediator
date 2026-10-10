/**
 * Autonomous PR Auto-Healer
 *
 * Listens to failing CI check runs on autoremediator pull requests,
 * extracts diagnostics, fetches failing files via Octokit, applies targeted
 * repairs, and pushes healing commits to trigger fresh CI verification.
 */
import type { Octokit } from "@octokit/rest";
import type { AutoremediatorRepoConfig } from "../types.js";
import type { DiagnosticFinding, ParsedDiagnostic } from "../diagnostics/log-parser.js";

export interface HealPrOptions {
  octokit: Octokit;
  owner: string;
  repo: string;
  pullNumber: number;
  branchName: string;
  checkRunName: string;
  diagnostic: ParsedDiagnostic;
  repoConfig: AutoremediatorRepoConfig;
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
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
        msg.match(/Module\s+['"]([^'"]+)['"]\s+has\s+no\s+default/i) ||
        msg.match(/Module\s+['"]([^'"]+)['"]/i) ||
        msg.match(/['"]([^'"]+)['"]/);
      const targetPkg = pkgMatch ? pkgMatch[1] : undefined;

      const importRegex = targetPkg
        ? new RegExp(`import\\s+([a-zA-Z0-9_$]+)\\s+from\\s+['"]${escapeRegex(targetPkg)}['"];?`, "g")
        : /import\s+([a-zA-Z0-9_$]+)\\s+from\s+['"]([^'"]+)['"];?/g;

      repaired = repaired.replace(importRegex, (_match, id, matchedPkg) => {
        const pkg = targetPkg || matchedPkg;
        return `import * as ${id} from "${pkg}";`;
      });
    }

    // 2. TypeScript CJS "export =" default import mismatch (TS1259)
    if (msg.includes("can only be used with a default import") || msg.includes("TS1259")) {
      const pkgMatch =
        msg.match(/Module\s+['"]([^'"]+)['"]/i) ||
        msg.match(/['"]([^'"]+)['"]/);
      const targetPkg = pkgMatch ? pkgMatch[1] : undefined;

      const starImportRegex = targetPkg
        ? new RegExp(`import\\s+\\*\\s+as\\s+([a-zA-Z0-9_$]+)\\s+from\\s+['"]${escapeRegex(targetPkg)}['"];?`, "g")
        : /import\s+\*\s+as\s+([a-zA-Z0-9_$]+)\\s+from\s+['"]([^'"]+)['"];?/g;

      repaired = repaired.replace(starImportRegex, (_match, id, matchedPkg) => {
        const pkg = targetPkg || matchedPkg;
        return `import ${id} from "${pkg}";`;
      });
    }

    // 3. Compiler suggestion: "Did you mean 'XYZ'?"
    const suggestionMatch = msg.match(/Did you mean ['"]([a-zA-Z0-9_$]+)['"]\?/);
    const missingMatch =
      msg.match(/has no exported member ['"]([a-zA-Z0-9_$]+)['"]/) ||
      msg.match(/Property ['"]([a-zA-Z0-9_$]+)['"] does not exist/);

    if (suggestionMatch && missingMatch) {
      const oldSymbol = missingMatch[1]!;
      const newSymbol = suggestionMatch[1]!;

      if (finding.line && finding.line > 0) {
        // Target specifically the line indicated by the compiler diagnostic
        const lines = repaired.split("\n");
        const idx = finding.line - 1;
        if (idx >= 0 && idx < lines.length) {
          lines[idx] = lines[idx]!.replace(
            new RegExp(`\\b${escapeRegex(oldSymbol)}\\b`, "g"),
            newSymbol,
          );
          repaired = lines.join("\n");
        }
      } else {
        // Replace member expression .oldSymbol -> .newSymbol
        repaired = repaired.replace(
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
      const unusedVarMatch = msg.match(/['"]([a-zA-Z0-9_$]+)['"]\s+is\s+(?:defined|imported)/);
      if (unusedVarMatch) {
        const unusedVar = unusedVarMatch[1]!;
        const lines = repaired.split("\n");
        let idx = (finding.line && finding.line > 0) ? finding.line - 1 : -1;
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
              `^\\s*import\\s*\\{\\s*${escapeRegex(unusedVar)}\\s*\\}\\s*from\\s*['"][^'"]+['"];?\\s*$`,
            );
            const defaultImport = new RegExp(
              `^\\s*import\\s+${escapeRegex(unusedVar)}\\s+from\\s*['"][^'"]+['"];?\\s*$`,
            );
            if (soleNamedImport.test(line) || defaultImport.test(line)) {
              lines.splice(idx, 1);
            } else {
              line = line.replace(new RegExp(`,\\s*${escapeRegex(unusedVar)}\\b`), "");
              line = line.replace(new RegExp(`\\b${escapeRegex(unusedVar)}\\s*,\\s*`), "");
              lines[idx] = line;
            }
            repaired = lines.join("\n");
          }
        }
      }
    }
  }

  // 5. Targeted type error suppression fallback (@ts-expect-error)
  // Sort descending by line number to prevent insertion index skew!
  const lineFindings = findings
    .filter((f) => f.category === "typescript" && typeof f.line === "number" && f.line > 0)
    .sort((a, b) => b.line! - a.line!);

  const fileLines = repaired.split("\n");
  const processedLines = new Set<number>();

  for (const finding of lineFindings) {
    const lineNum = finding.line!;
    if (processedLines.has(lineNum)) continue;
    processedLines.add(lineNum);

    const targetIdx = lineNum - 1;
    if (targetIdx >= 0 && targetIdx < fileLines.length) {
      const prevLine = targetIdx > 0 ? fileLines[targetIdx - 1] : "";
      if (
        !prevLine?.includes("@ts-expect-error") &&
        !fileLines[targetIdx]?.includes("@ts-expect-error")
      ) {
        const indent = fileLines[targetIdx]!.match(/^\s*/)?.[0] || "";
        fileLines.splice(
          targetIdx,
          0,
          `${indent}// @ts-expect-error [autoremediator-heal]: ${finding.ruleId || "compile-error"}`,
        );
      }
    }
  }

  return fileLines.join("\n");
}

export async function healPullRequest(options: HealPrOptions): Promise<HealPrResult> {
  const {
    octokit,
    owner,
    repo,
    pullNumber,
    branchName,
    checkRunName,
    diagnostic,
    repoConfig,
  } = options;

  const maxAttempts = repoConfig.maxHealingAttempts ?? 3;
  const key = getHealingAttemptKey(owner, repo, pullNumber);
  const currentAttempts = ATTEMPTS_MAP.get(key) || 0;

  if (currentAttempts >= maxAttempts) {
    // Exceeded max healing attempts — escalate to human review
    const commentBody = `### ⚠️ Autoremediator Auto-Healing Limit Reached\n\n` +
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
    } catch {
      // Ignore GitHub API label/comment errors
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
      const existing = fileFindingsMap.get(finding.filePath) || [];
      existing.push(finding);
      fileFindingsMap.set(finding.filePath, existing);
    }
  }

  if (fileFindingsMap.size === 0) {
    // Cannot pinpoint broken files from logs
    const commentBody = `### ⚠️ Autoremediator Auto-Healing Unable to Localize Failure\n\n` +
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
    } catch {
      // Ignore
    }

    return {
      healed: false,
      attempt: nextAttempt,
      maxAttempts,
      actionTaken: "commented-human-review",
      reason: "No actionable file paths found in CI diagnostics.",
    };
  }

  const healedFiles: string[] = [];

  for (const [filePath, findings] of fileFindingsMap.entries()) {
    try {
      // Fetch current content from branch via GitHub REST API
      const fileRes = await octokit.repos.getContent({
        owner,
        repo,
        path: filePath,
        ref: branchName,
      });

      const fileData = fileRes.data as { content?: string; sha?: string; encoding?: string };
      if (!fileData?.content || !fileData?.sha) continue;

      const originalContent = Buffer.from(fileData.content, "base64").toString("utf8");
      const repairedContent = repairFileContent(originalContent, findings);

      if (repairedContent !== originalContent) {
        // Push healing commit to branch
        await octokit.repos.createOrUpdateFileContents({
          owner,
          repo,
          path: filePath,
          message: `fix(autoremediator): auto-heal ${checkRunName} diagnostics [attempt ${nextAttempt}]`,
          content: Buffer.from(repairedContent, "utf8").toString("base64"),
          sha: fileData.sha,
          branch: branchName,
        });

        healedFiles.push(filePath);
      }
    } catch {
      // Ignore file fetch/update errors for this file and continue to next
    }
  }

  if (healedFiles.length === 0) {
    // None of the heuristics could repair the files
    const commentBody = `### ⚠️ Autoremediator Auto-Healing Unsuccessful\n\n` +
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
    } catch {
      // Ignore
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
  const commentBody = `### 🩹 Autoremediator Auto-Healing Applied (Attempt ${nextAttempt}/${maxAttempts})\n\n` +
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
  } catch {
    // Ignore
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
