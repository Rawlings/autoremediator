import type { Octokit } from "@octokit/rest";

import type { DiagnosticFinding } from "../diagnostics/log-parser.js";
import type { ErrorLogger } from "../types.js";
import type { RepairStrategy } from "./repair-strategy.js";
import { repairPathProblem } from "./safe-paths.js";

export const MAX_REPAIRED_FILES = 5;
const MAX_FILE_BYTES = 300_000;

export interface RepairBranchOptions {
  octokit: Octokit;
  owner: string;
  repo: string;
  branchName: string;
  findingsByFile: ReadonlyMap<string, DiagnosticFinding[]>;
  strategy: RepairStrategy;
  commitMessage: string;
  logger?: ErrorLogger;
  /** For log details only. */
  pullNumber: number;
}

export interface RepairBranchResult {
  /** Files a commit was pushed for. */
  healedFiles: string[];
  /** Files left alone, with the reason, for the diagnosis comment. */
  skipped: Array<{ filePath: string; reason: string }>;
}

/**
 * Commit the strategy's repairs to the pull request branch, one file per commit through the
 * contents API. Each commit lands on top of the branch tip and names the blob it replaces, so a
 * branch that moved or a file that changed since it was read makes GitHub refuse the write. Nothing
 * here can force-push, rewrite history, or touch a path `repairPathProblem` rejects.
 */
export async function repairBranchFiles(options: RepairBranchOptions): Promise<RepairBranchResult> {
  const { octokit, owner, repo, branchName, strategy } = options;
  const healedFiles: string[] = [];
  const skipped: RepairBranchResult["skipped"] = [];

  for (const [filePath, findings] of options.findingsByFile.entries()) {
    const problem = repairPathProblem(filePath);
    if (problem) {
      skipped.push({ filePath, reason: problem });
      continue;
    }
    if (healedFiles.length >= MAX_REPAIRED_FILES) {
      skipped.push({ filePath, reason: "too many files for one attempt" });
      continue;
    }

    try {
      const fileRes = await octokit.repos.getContent({
        owner,
        repo,
        path: filePath,
        ref: branchName,
      });
      const fileData = fileRes.data as {
        type?: string;
        content?: string;
        sha?: string;
        size?: number;
      };
      if (
        Array.isArray(fileRes.data) ||
        (fileData.type !== undefined && fileData.type !== "file")
      ) {
        skipped.push({ filePath, reason: "not a file" });
        continue;
      }
      if (!fileData.content || !fileData.sha) continue;
      if ((fileData.size ?? 0) > MAX_FILE_BYTES) {
        skipped.push({ filePath, reason: "file too large" });
        continue;
      }

      const originalContent = Buffer.from(fileData.content, "base64").toString("utf8");
      const repairedContent =
        (await strategy.repair({ filePath, content: originalContent, findings })) ??
        originalContent;

      if (repairedContent !== originalContent) {
        await octokit.repos.createOrUpdateFileContents({
          owner,
          repo,
          path: filePath,
          message: options.commitMessage,
          content: Buffer.from(repairedContent, "utf8").toString("base64"),
          sha: fileData.sha,
          branch: branchName,
        });
        healedFiles.push(filePath);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      void options.logger?.({
        timestamp: new Date().toISOString(),
        source: "github-app",
        level: "warn",
        context: "pr-healer.fetchOrUpdateFile",
        message: `Failed to fetch or update file ${filePath}: ${message}`,
        error: message,
        details: { owner, repo, pullNumber: options.pullNumber, filePath, branchName },
      });
    }
  }

  return { healedFiles, skipped };
}
