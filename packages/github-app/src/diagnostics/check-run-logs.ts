import type { Octokit } from "@octokit/rest";

import type { ErrorLogger } from "../types.js";

/** Check output is attacker-influenced and can be huge; only this much of it is looked at. */
const MAX_LOG_CHARS = 200_000;
const MAX_ANNOTATIONS = 50;

/**
 * Collect the text of a failed check run: its output title, summary and text, and its annotations.
 * The result is untrusted data for `parseCheckRunLogs`, never instructions.
 */
export async function collectCheckRunLogs(
  octokit: Octokit,
  repoRef: { owner: string; repo: string },
  checkRun: Record<string, unknown> | undefined,
  onError?: ErrorLogger,
): Promise<string> {
  const output = checkRun?.output as Record<string, unknown> | undefined;
  let rawLogs = [output?.title, output?.summary, output?.text].filter(Boolean).join("\n");

  if (typeof checkRun?.id === "number") {
    try {
      const annRes = await octokit.checks.listAnnotations({
        owner: repoRef.owner,
        repo: repoRef.repo,
        check_run_id: checkRun.id,
        per_page: MAX_ANNOTATIONS,
      });
      if (Array.isArray(annRes?.data)) {
        const annLines = annRes.data
          .slice(0, MAX_ANNOTATIONS)
          .map(
            (ann) =>
              `${ann.path}:${ann.start_line || 1}:1 - error ${ann.title || "check"}: ${ann.message || ""}`,
          );
        rawLogs += "\n" + annLines.join("\n");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      void onError?.({
        timestamp: new Date().toISOString(),
        source: "github-app",
        level: "warn",
        context: "remediation-handler.listAnnotations",
        message: `Failed to fetch check run annotations: ${message}`,
        error: message,
        details: { owner: repoRef.owner, repo: repoRef.repo, checkRunId: checkRun.id },
      });
    }
  }

  return rawLogs.length > MAX_LOG_CHARS ? rawLogs.slice(0, MAX_LOG_CHARS) : rawLogs;
}
