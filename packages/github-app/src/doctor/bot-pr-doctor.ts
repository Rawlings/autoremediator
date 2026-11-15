/**
 * Bot PR doctor: when CI fails on a Dependabot or Renovate pull request, diagnose the failure and
 * either push a small repair commit to the bot's branch or leave one comment with the diagnosis.
 *
 * What keeps it safe, in the order it is checked:
 * - it is off unless the repository turns it on (`botPrDoctor.enabled`);
 * - it only acts on open pull requests whose branch is in the same repository (never a fork), and
 *   only when the failing check ran against the branch's current head commit;
 * - attempts are counted per pull request in the app state store, once per head commit, and stop at
 *   the repository's cap, after which it says so once and goes quiet;
 * - the check output is parsed as data, and anything running in the CI job can forge it. File
 *   paths found in it are accepted only if `repairPathProblem` allows them (no lockfiles,
 *   workflows, policy files or manifests) AND the pull request itself changed that file. A
 *   Dependabot or Renovate pull request changes manifests and lockfiles, so in practice source
 *   edits are refused and the doctor leaves a diagnosis comment;
 * - changes are commits on top of the branch tip through the contents API: never a force-push.
 */
import type { Octokit } from "@octokit/rest";

import { collectCheckRunLogs } from "../diagnostics/check-run-logs.js";
import {
  parseCheckRunLogs,
  type DiagnosticFinding,
  type ParsedDiagnostic,
} from "../diagnostics/log-parser.js";
import { fenced, oneLine } from "../diagnostics/sanitize.js";
import { errorMessage } from "../errors.js";
import { listPullRequestChangedFiles } from "../healing/pr-files.js";
import { repairBranchFiles } from "../healing/repair-branch.js";
import type { RepairStrategy } from "../healing/repair-strategy.js";
import { repairPathProblem } from "../healing/safe-paths.js";
import type { AppStateStore } from "../state.js";
import type { AutoremediatorRepoConfig, ErrorLogger, RemediationJobResult } from "../types.js";
import { detectBotPr, isForkPullRequest } from "./bot-pr.js";

export interface BotPrDoctorParams {
  octokit: Octokit;
  owner: string;
  repo: string;
  pullNumber: number;
  /** The `check_run` object from the webhook payload. */
  checkRun: Record<string, unknown>;
  repoConfig: AutoremediatorRepoConfig;
  stateStore?: AppStateStore;
  strategy: RepairStrategy;
  selfAppId?: string;
  logger?: ErrorLogger;
}

const MAX_FINDINGS_SHOWN = 8;

function skip(reason: string): RemediationJobResult {
  return { status: "success", reason };
}

function describeFinding(finding: DiagnosticFinding): string {
  const where = finding.filePath
    ? `${oneLine(finding.filePath, 120)}${finding.line ? `:${finding.line}` : ""} `
    : "";
  const rule = finding.ruleId ? `${oneLine(finding.ruleId, 40)}: ` : "";
  return `[${finding.category}] ${where}${rule}${finding.message}`;
}

function diagnosisComment(params: {
  botName: string;
  checkRunName: string;
  attempt: number;
  maxAttempts: number;
  outcome: string;
  diagnostic: ParsedDiagnostic;
}): string {
  const { diagnostic } = params;
  const shown = diagnostic.findings
    .slice(0, MAX_FINDINGS_SHOWN)
    .map((finding) => describeFinding(finding));
  const more = diagnostic.findings.length - shown.length;
  const lines =
    shown.length > 0
      ? [...shown, ...(more > 0 ? [`... and ${more} more`] : [])]
      : ["No structured errors could be read from the check output."];

  return [
    "**Autoremediator bot PR doctor**",
    "",
    `Check **${oneLine(params.checkRunName, 80)}** failed on this ${params.botName} pull request. ${params.outcome}`,
    "",
    "What the check reported (CI output, shown as plain text):",
    "",
    fenced(lines),
    "",
    `Attempt ${params.attempt} of ${params.maxAttempts}. Nothing was merged or force-pushed.`,
  ].join("\n");
}

async function comment(params: BotPrDoctorParams, body: string, context: string): Promise<void> {
  try {
    await params.octokit.issues.createComment({
      owner: params.owner,
      repo: params.repo,
      issue_number: params.pullNumber,
      body,
    });
  } catch (error) {
    const message = errorMessage(error);
    void params.logger?.({
      timestamp: new Date().toISOString(),
      source: "github-app",
      level: "warn",
      context,
      message: `Failed to comment on PR #${params.pullNumber}: ${message}`,
      error: message,
      details: { owner: params.owner, repo: params.repo, pullNumber: params.pullNumber },
    });
  }
}

export async function runBotPrDoctor(params: BotPrDoctorParams): Promise<RemediationJobResult> {
  const { octokit, owner, repo, pullNumber, checkRun, repoConfig, stateStore } = params;
  const doctor = repoConfig.botPrDoctor;
  if (!doctor?.enabled) return skip("Bot PR doctor disabled in repo config");

  // The app's own check runs (status publishing) must never start a repair of their own.
  const checkName = typeof checkRun.name === "string" ? checkRun.name : "CI check";
  const checkApp = checkRun.app as Record<string, unknown> | undefined;
  if (
    checkName.toLowerCase().startsWith("autoremediator") ||
    (params.selfAppId !== undefined && String(checkApp?.id) === params.selfAppId)
  ) {
    return skip("Check run belongs to autoremediator");
  }

  if (!stateStore) return skip("No state store to count attempts in; bot PR doctor not run");

  // The webhook only names the pull request; what GitHub says about it now decides.
  const { data: pr } = await octokit.pulls.get({ owner, repo, pull_number: pullNumber });
  if (pr.state !== "open") return skip("Pull request is not open");
  if (isForkPullRequest(pr)) return skip("Pull request comes from a fork");

  const headRef = pr.head.ref;
  const botKind = detectBotPr(headRef, pr.user?.login);
  if (!botKind) return skip("Not a Dependabot or Renovate pull request");

  const checkSha = typeof checkRun.head_sha === "string" ? checkRun.head_sha : undefined;
  if (!checkSha || checkSha !== pr.head.sha) {
    return skip("Failing check is not for the branch's current head commit");
  }

  const reservation = stateStore.reserveDoctorAttempt(
    `${owner}/${repo}#${pullNumber}`.toLowerCase(),
    pr.head.sha,
    doctor.maxAttempts,
  );
  if (reservation.outcome === "duplicate") {
    return skip("This head commit was already looked at");
  }
  if (reservation.outcome === "limit") {
    if (reservation.announce) {
      await comment(
        params,
        [
          "**Autoremediator bot PR doctor**",
          "",
          `Stopping after ${doctor.maxAttempts} repair attempt(s) on this pull request; CI is still failing, so it needs a person.`,
        ].join("\n"),
        "bot-pr-doctor.limit",
      );
    }
    return skip("Attempt limit reached for this pull request");
  }

  const { attempt } = reservation;
  const botName = botKind === "dependabot" ? "Dependabot" : "Renovate";

  try {
    const logs = await collectCheckRunLogs(octokit, { owner, repo }, checkRun, params.logger);
    const diagnostic = parseCheckRunLogs(logs);

    const changedFiles = await listPullRequestChangedFiles(octokit, { owner, repo, pullNumber });
    const findingsByFile = new Map<string, DiagnosticFinding[]>();
    for (const finding of diagnostic.findings) {
      if (!finding.filePath || repairPathProblem(finding.filePath)) continue;
      if (!changedFiles.has(finding.filePath)) continue;
      const existing = findingsByFile.get(finding.filePath) ?? [];
      existing.push(finding);
      findingsByFile.set(finding.filePath, existing);
    }

    const report = (outcome: string) =>
      diagnosisComment({
        botName,
        checkRunName: checkName,
        attempt,
        maxAttempts: doctor.maxAttempts,
        outcome,
        diagnostic,
      });

    if (findingsByFile.size === 0) {
      await comment(
        params,
        report(
          "No repair was pushed: the output does not point at a source file this pull request changed and that is safe to edit.",
        ),
        "bot-pr-doctor.unlocalized",
      );
      return skip("No repairable file found in the check output");
    }

    const { healedFiles } = await repairBranchFiles({
      octokit,
      owner,
      repo,
      branchName: headRef,
      findingsByFile,
      allowedFiles: changedFiles,
      strategy: params.strategy,
      commitMessage: `fix: repair ${oneLine(checkName, 60)} after dependency update (autoremediator bot PR doctor, attempt ${attempt}/${doctor.maxAttempts})`,
      logger: params.logger,
      pullNumber,
    });

    if (healedFiles.length === 0) {
      await comment(
        params,
        report("No repair was pushed: the errors are not ones it can fix safely."),
        "bot-pr-doctor.unrepaired",
      );
      return skip("Failure could not be repaired safely");
    }

    await comment(
      params,
      report(
        `Pushed a repair commit to \`${oneLine(headRef, 100)}\` touching ${healedFiles
          .map((file) => `\`${oneLine(file, 120)}\``)
          .join(", ")}. CI will run again.`,
      ),
      "bot-pr-doctor.repaired",
    );
    return { status: "success", reason: `Pushed repair for ${healedFiles.join(", ")}` };
  } catch (error) {
    // The attempt is already counted, so a retry of this job would be skipped as a duplicate;
    // report the failure instead of throwing.
    const message = errorMessage(error);
    void params.logger?.({
      timestamp: new Date().toISOString(),
      source: "github-app",
      level: "error",
      context: "bot-pr-doctor.run",
      message: `Bot PR doctor failed on PR #${pullNumber}: ${message}`,
      error: message,
      details: { owner, repo, pullNumber },
    });
    return { status: "failed", reason: "Bot PR doctor failed; see the app logs" };
  }
}
