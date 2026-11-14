import { spawn } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve as resolvePath } from "node:path";

import { remediateFromScan, type CveSeverity, type ScanReport } from "autoremediator";

import { codeScanningAlertTarget, dependabotAlertTarget } from "./alerts.js";
import { HELP_TEXT, parseComment } from "./commands.js";
import { summarizeScanReport } from "./summary.js";
import { botKindOfBranch, isForkPullRequest } from "./doctor/bot-pr.js";
import { runBotPrDoctor } from "./doctor/bot-pr-doctor.js";
import { collectCheckRunLogs } from "./diagnostics/check-run-logs.js";
import { parseCheckRunLogs } from "./diagnostics/log-parser.js";
import { healPullRequest, regexRepairStrategy } from "./healing/pr-healer.js";
import { fetchRepoConfig } from "./repo-config.js";
import type {
  AutoremediatorRepoConfig,
  DefaultRemediationHandlerOptions,
  ParsedAuditFinding,
  RemediationJobResult,
  RemediationTriggerContext,
} from "./types.js";

type ScanRemediateOptions = NonNullable<Parameters<typeof remediateFromScan>[1]>;
type ScanChangeRequestOptions = NonNullable<ScanRemediateOptions["changeRequest"]>;

export type { DefaultRemediationHandlerOptions, ParsedAuditFinding };

const CVE_REGEX = /CVE-\d{4}-\d+/gi;

const SEVERITY_RANK: Record<CveSeverity, number> = {
  UNKNOWN: 0,
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
  CRITICAL: 4,
};

function headRefOf(pullRequest: Record<string, unknown>): string {
  const head = pullRequest.head as Record<string, unknown> | undefined;
  return typeof head?.ref === "string" ? head.ref : "";
}

export type RemediationHandler = (
  context: RemediationTriggerContext,
) => Promise<RemediationJobResult | void>;

function readRepoFromPayload(
  payload: Record<string, unknown>,
): { owner: string; repo: string } | undefined {
  const repository = payload.repository;
  if (!repository || typeof repository !== "object") return undefined;
  const r = repository as Record<string, unknown>;
  const name = typeof r.name === "string" ? r.name : undefined;
  const ownerObj = r.owner;
  const owner =
    typeof ownerObj === "string"
      ? ownerObj
      : ownerObj && typeof ownerObj === "object"
        ? ((ownerObj as Record<string, unknown>).login as string | undefined)
        : undefined;
  if (!owner || !name) return undefined;
  return { owner, repo: name };
}

export function createDefaultRemediationHandler(
  options: DefaultRemediationHandlerOptions,
): RemediationHandler {
  return async (context: RemediationTriggerContext): Promise<RemediationJobResult | void> => {
    if (
      context.eventName !== "check_suite" &&
      context.eventName !== "workflow_dispatch" &&
      context.eventName !== "push" &&
      context.eventName !== "check_run" &&
      context.eventName !== "issue_comment" &&
      context.eventName !== "dependabot_alert" &&
      context.eventName !== "code_scanning_alert"
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
      repoConfig = await fetchRepoConfig(octokit, repoRef.owner, repoRef.repo, options.onError);
    } else {
      // No repository in payload — use defaults
      const { DEFAULT_REPO_CONFIG } = await import("./types.js");
      repoConfig = { ...DEFAULT_REPO_CONFIG };
    }

    // Special handler branch for check_run (PR auto-healing)
    if (context.eventName === "check_run") {
      const checkRun = context.payload.check_run as Record<string, unknown> | undefined;
      const pullRequests =
        (checkRun?.pull_requests as Array<Record<string, unknown>> | undefined) ?? [];
      // Bot branches are the doctor's, even when a dependency name puts "autoremediator" in them.
      const botPr = pullRequests.find((p) => botKindOfBranch(headRefOf(p)) !== undefined);
      if (botPr) {
        if (typeof botPr.number !== "number" || !repoRef || !checkRun) return;
        // The webhook shows the head repository; the doctor checks again against the live pull request.
        if (isForkPullRequest(botPr)) return { status: "success", reason: "Pull request comes from a fork" };
        return runBotPrDoctor({
          octokit,
          owner: repoRef.owner,
          repo: repoRef.repo,
          pullNumber: botPr.number,
          checkRun,
          repoConfig,
          stateStore: options.stateStore,
          strategy: options.repairStrategy ?? regexRepairStrategy,
          selfAppId: options.selfAppId,
          logger: options.onError,
        });
      }

      const pr = pullRequests.find((p) => {
        const ref = headRefOf(p);
        return ref.startsWith("autoremediator/") || ref.includes("autoremediator");
      });

      if (!pr || typeof pr.number !== "number" || !repoRef) {
        return;
      }

      if (!repoConfig.enablePrAutoHealing) {
        return { status: "success", reason: "PR auto-healing disabled in repo config" };
      }

      const rawLogs = await collectCheckRunLogs(octokit, repoRef, checkRun, options.onError);

      const diagnostic = parseCheckRunLogs(rawLogs);
      const head = pr.head as Record<string, unknown> | undefined;
      const branchName = typeof head?.ref === "string" ? head.ref : "unknown";

      const healResult = await healPullRequest({
        octokit,
        owner: repoRef.owner,
        repo: repoRef.repo,
        pullNumber: pr.number,
        branchName,
        checkRunName: typeof checkRun?.name === "string" ? checkRun.name : "CI Check",
        diagnostic,
        repoConfig,
        logger: options.onError,
      });

      return {
        status: healResult.healed ? "success" : "failed",
        reason: healResult.reason,
      };
    }

    const payload = context.payload ?? {};

    // Work that names its advisories (a comment command or an alert) instead of scanning for them.
    let targeted: TargetedRun | undefined;
    if (context.eventName === "issue_comment") {
      const outcome = await prepareCommentRun(octokit, repoRef, payload, options);
      if ("done" in outcome) return outcome.done;
      targeted = outcome.run;
    } else if (
      context.eventName === "dependabot_alert" ||
      context.eventName === "code_scanning_alert"
    ) {
      const target =
        context.eventName === "dependabot_alert"
          ? dependabotAlertTarget(payload)
          : codeScanningAlertTarget(payload);
      if (!target) return;
      if (SEVERITY_RANK[normalizeSeverity(target.severity)] < SEVERITY_RANK[repoConfig.minimumSeverity]) {
        return { status: "success", reason: "Alert is below the configured minimum severity" };
      }
      targeted = { cveIds: target.advisoryIds };
    }

    const headSha =
      typeof (payload.check_suite as Record<string, unknown> | undefined)?.head_sha === "string"
        ? ((payload.check_suite as Record<string, unknown>).head_sha as string)
        : typeof payload.after === "string"
          ? payload.after
          : undefined;
    const branchOrRef =
      typeof (payload.check_suite as Record<string, unknown> | undefined)?.head_branch === "string"
        ? ((payload.check_suite as Record<string, unknown>).head_branch as string)
        : typeof payload.ref === "string"
          ? payload.ref.replace(/^refs\/heads\//, "")
          : undefined;
    const targetRef = headSha ?? branchOrRef;

    let isolatedWorkspaceDir: string | undefined;
    let cleanupCheckout: (() => Promise<void>) | undefined;

    if (options.checkoutProvider) {
      const checkout = await options.checkoutProvider({
        owner: repoRef?.owner ?? "unknown",
        repo: repoRef?.repo ?? "unknown",
        ref: targetRef,
        token: context.installationToken,
      });
      isolatedWorkspaceDir = checkout.cwd;
      cleanupCheckout = checkout.cleanup;
    } else if (repoRef) {
      const tempRepoDir = await mkdtemp(join(tmpdir(), "autoremediator-repo-"));
      cleanupCheckout = async () => {
        await rm(tempRepoDir, { recursive: true, force: true }).catch(() => {});
      };

      const token = context.installationToken;
      const cloneUrl = token
        ? `https://x-access-token:${token}@github.com/${repoRef.owner}/${repoRef.repo}.git`
        : `https://github.com/${repoRef.owner}/${repoRef.repo}.git`;
      const cloneArgs = ["clone", "--depth", "1"];
      if (targetRef) {
        cloneArgs.push("--branch", targetRef);
      }
      cloneArgs.push(cloneUrl, tempRepoDir);

      try {
        const cloneRes = await runCommand("git", cloneArgs, tempRepoDir);
        if (cloneRes.exitCode !== 0) {
          throw new Error(`git clone failed (code ${cloneRes.exitCode}): ${cloneRes.output}`);
        }
        await runCommand("git", ["config", "user.name", "autoremediator[bot]"], tempRepoDir);
        await runCommand(
          "git",
          ["config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com"],
          tempRepoDir,
        );
        isolatedWorkspaceDir = tempRepoDir;
      } catch (cloneError) {
        if (process.env.NODE_ENV === "test" || !token) {
          await runCommand("git", ["init"], tempRepoDir);
          await runCommand("git", ["config", "user.name", "autoremediator[bot]"], tempRepoDir);
          await runCommand(
            "git",
            ["config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com"],
            tempRepoDir,
          );
          isolatedWorkspaceDir = tempRepoDir;
        } else {
          if (cleanupCheckout) {
            await cleanupCheckout();
          }
          throw cloneError;
        }
      }
    } else {
      isolatedWorkspaceDir = process.cwd();
    }

    let cwd = isolatedWorkspaceDir;
    if (repoConfig.cwd) {
      cwd = resolvePath(isolatedWorkspaceDir, repoConfig.cwd);
      const escaped = relative(isolatedWorkspaceDir, cwd);
      if (escaped.startsWith("..") || isAbsolute(escaped)) {
        throw new Error(
          `Configured cwd "${repoConfig.cwd}" resolves outside the repository checkout.`,
        );
      }
    }

    const dryRun = targeted?.forceDryRun ?? repoConfig.dryRun;
    const runTests = repoConfig.runTests;
    const minimumSeverity = repoConfig.minimumSeverity;

    const pullRequest = repoConfig.pullRequest ?? {};
    // A plan never changes anything; a fix asked for in a comment always ends in a reviewable pull request.
    const wantsPullRequest = targeted?.forceDryRun
      ? false
      : Boolean(pullRequest.enabled || targeted?.forcePullRequest);
    const changeRequest: ScanChangeRequestOptions | undefined = wantsPullRequest
      ? {
          enabled: true,
          provider: "github",
          grouping: pullRequest.grouping,
          repository: pullRequest.repository ?? (repoRef ? `${repoRef.owner}/${repoRef.repo}` : undefined),
          baseBranch: pullRequest.baseBranch,
          branchPrefix: pullRequest.branchPrefix,
          titlePrefix: pullRequest.titlePrefix,
          bodyFooter: pullRequest.bodyFooter,
          draft: pullRequest.draft,
          pushRemote: pullRequest.pushRemote,
          tokenEnvVar: pullRequest.tokenEnvVar,
          token: context.installationToken,
        }
      : undefined;

    const policyOptions = {
      allowMajorBumps: repoConfig.allowMajorBumps,
      denyPackages: repoConfig.denyPackages,
      allowPackages: repoConfig.allowPackages,
      constraints: repoConfig.constraints,
      patchConfidenceThresholds: repoConfig.patchConfidenceThresholds,
      dispositionPolicy: repoConfig.dispositionPolicy,
      containmentMode: repoConfig.containmentMode,
      escalationGraph: repoConfig.escalationGraph,
    };

    try {
      if (!targeted && minimumSeverity === "UNKNOWN") {
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

      const cveIds =
        targeted?.cveIds ??
        selectCvesByMinimumSeverity(
          options.auditFindingProvider
            ? await options.auditFindingProvider(cwd)
            : await collectAuditFindings(cwd),
          minimumSeverity,
        );
      if (cveIds.length === 0) {
        return { status: "success", reason: "No CVEs matched minimum severity filter" };
      }

      const tempDir = await mkdtemp(join(tmpdir(), "autoremediator-ghapp-"));
      const filteredSarifPath = join(tempDir, "filtered-findings.sarif");

      try {
        await writeFile(
          filteredSarifPath,
          JSON.stringify(createSarifFromCves(cveIds), null, 2),
          "utf8",
        );

        const report = await remediateFromScan(filteredSarifPath, {
          cwd,
          format: "sarif",
          audit: false,
          dryRun,
          runTests,
          changeRequest,
          ...policyOptions,
        });

        if (targeted?.reply && repoRef) {
          await postComment(
            octokit,
            repoRef,
            targeted.reply.issueNumber,
            summarizeScanReport(report, targeted.reply.mode),
            options,
          );
        }
        return toRemediationJobResult(report);
      } finally {
        try {
          await rm(tempDir, { recursive: true, force: true });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          void options.onError?.({
            timestamp: new Date().toISOString(),
            source: "github-app",
            level: "warn",
            context: "remediation-handler.sarifCleanup",
            message: `Failed to remove temporary directory ${tempDir}: ${message}`,
            error: message,
          });
        }
      }
    } catch (error) {
      if (targeted?.reply && repoRef) {
        // The error text can contain clone URLs, so it stays in the logs and out of the comment.
        await postComment(
          octokit,
          repoRef,
          targeted.reply.issueNumber,
          "**Autoremediator** could not finish this request. See the app logs for details.",
          options,
        );
      }
      throw error;
    } finally {
      if (cleanupCheckout) {
        try {
          await cleanupCheckout();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          void options.onError?.({
            timestamp: new Date().toISOString(),
            source: "github-app",
            level: "warn",
            context: "remediation-handler.checkoutCleanup",
            message: `Failed to cleanup checkout workspace: ${message}`,
            error: message,
          });
        }
      }
    }
  };
}

interface TargetedRun {
  cveIds: string[];
  forceDryRun?: boolean;
  forcePullRequest?: boolean;
  reply?: { issueNumber: number; mode: "plan" | "fix" };
}

type RepoRef = { owner: string; repo: string };
type Octokit = Awaited<ReturnType<DefaultRemediationHandlerOptions["octokitFactory"]>>;

async function postComment(
  octokit: Octokit,
  repo: RepoRef,
  issueNumber: number,
  body: string,
  options: DefaultRemediationHandlerOptions,
): Promise<void> {
  try {
    await octokit.issues.createComment({ owner: repo.owner, repo: repo.repo, issue_number: issueNumber, body });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    void options.onError?.({
      timestamp: new Date().toISOString(),
      source: "github-app",
      level: "warn",
      context: "remediation-handler.postComment",
      message: `Failed to post comment: ${message}`,
      error: message,
    });
  }
}

/** Only people who can already push may ask the app to change the repository. */
async function hasWriteAccess(octokit: Octokit, repo: RepoRef, login: string): Promise<boolean> {
  try {
    const { data } = await octokit.repos.getCollaboratorPermissionLevel({
      owner: repo.owner,
      repo: repo.repo,
      username: login,
    });
    return data.permission === "admin" || data.permission === "write";
  } catch {
    return false;
  }
}

async function prepareCommentRun(
  octokit: Octokit,
  repo: RepoRef | undefined,
  payload: Record<string, unknown>,
  options: DefaultRemediationHandlerOptions,
): Promise<{ done: RemediationJobResult | undefined } | { run: TargetedRun }> {
  const comment = payload.comment as Record<string, unknown> | undefined;
  const issue = payload.issue as Record<string, unknown> | undefined;
  const issueNumber = issue?.number;
  const login = (comment?.user as Record<string, unknown> | undefined)?.login;
  const command = parseComment(typeof comment?.body === "string" ? comment.body : "");
  if (!command || !repo || typeof issueNumber !== "number" || typeof login !== "string") {
    return { done: undefined };
  }

  if (!(await hasWriteAccess(octokit, repo, login))) {
    await postComment(
      octokit,
      repo,
      issueNumber,
      "Autoremediator commands need write access to this repository.",
      options,
    );
    return { done: { status: "success", reason: "Commenter lacks write access" } };
  }

  if (command.name === "rollback") {
    await postComment(
      octokit,
      repo,
      issueNumber,
      await rollbackReply(octokit, repo, issueNumber, Boolean(issue?.pull_request)),
      options,
    );
    return { done: { status: "success" } };
  }

  if (command.name === "help" || command.advisoryIds.length === 0) {
    const note =
      command.name !== "help" && command.advisoryIds.length === 0
        ? "That command needs at least one CVE or GHSA id.\n\n"
        : "";
    await postComment(octokit, repo, issueNumber, `${note}${HELP_TEXT}`, options);
    return { done: { status: "success" } };
  }

  const modeKey = (id: string) => `${repo.owner}/${repo.repo}:${id}`.toLowerCase();
  let mode: "plan" | "fix";
  if (command.name === "retry") {
    // Retry runs each advisory the way it was last run in this repository. That history lives in
    // the state store, so without one there is nothing to repeat.
    const known = command.advisoryIds.map((id) => ({
      id,
      mode: options.stateStore?.getRemediationMode(modeKey(id)),
    }));
    const unknown = known.filter((entry) => entry.mode === undefined).map((entry) => entry.id);
    if (unknown.length > 0) {
      await postComment(
        octokit,
        repo,
        issueNumber,
        `Nothing to retry for ${unknown.join(", ")}: no earlier \`plan\` or \`fix\` of it was recorded for this repository. Use \`/autoremediator plan\` or \`/autoremediator fix\` first.`,
        options,
      );
      return { done: { status: "success", reason: "Nothing to retry" } };
    }
    const modes = new Set(known.map((entry) => entry.mode));
    if (modes.size > 1) {
      await postComment(
        octokit,
        repo,
        issueNumber,
        "Those advisories were last run in different modes (plan and fix). Retry them in separate comments.",
        options,
      );
      return { done: { status: "success", reason: "Mixed retry modes" } };
    }
    mode = known[0]?.mode === "fix" ? "fix" : "plan";
  } else {
    mode = command.name === "fix" ? "fix" : "plan";
  }

  // Remember the request before running it, so a run that fails can still be retried.
  for (const id of command.advisoryIds) options.stateStore?.recordRemediationMode(modeKey(id), mode);

  return {
    run: {
      cveIds: command.advisoryIds,
      forceDryRun: mode === "plan",
      forcePullRequest: mode === "fix",
      reply: { issueNumber, mode },
    },
  };
}

const RUN_TRAILER = /^Autoremediator-Run:[ \t]*(run_[0-9a-z]{20})[ \t]*$/gm;
const MAX_ROLLBACK_RUNS = 5;

function runIdsIn(text: string | null | undefined): string[] {
  return [...(text ?? "").matchAll(RUN_TRAILER)].map((match) => match[1] ?? "").filter(Boolean);
}

/**
 * The comment for `/autoremediator rollback`: the exact command that undoes a recorded run. The
 * app never rolls back itself. Run ids are read from `Autoremediator-Run:` trailers and echoed
 * only if they match the run id format exactly.
 */
async function rollbackReply(
  octokit: Octokit,
  repo: RepoRef,
  issueNumber: number,
  isPullRequest: boolean,
): Promise<string> {
  const runIds = new Set<string>();
  try {
    const { data } = await octokit.issues.get({
      owner: repo.owner,
      repo: repo.repo,
      issue_number: issueNumber,
    });
    for (const id of runIdsIn(data.body)) runIds.add(id);

    if (runIds.size === 0 && isPullRequest) {
      const { data: commits } = await octokit.pulls.listCommits({
        owner: repo.owner,
        repo: repo.repo,
        pull_number: issueNumber,
        per_page: 100,
      });
      for (const commit of commits) {
        for (const id of runIdsIn(commit.commit.message)) runIds.add(id);
      }
    }
  } catch {
    return "**Autoremediator** could not read this pull request to look for a recorded run. Try again, or revert its commits.";
  }

  const ids = [...runIds].slice(0, MAX_ROLLBACK_RUNS);
  if (ids.length === 0) {
    return [
      "**Autoremediator rollback**",
      "",
      "No `Autoremediator-Run:` trailer was found in this description or its commits, so there is no recorded run to roll back.",
      "To undo the change, revert its commits or close the pull request.",
    ].join("\n");
  }

  return [
    "**Autoremediator rollback**",
    "",
    "Autoremediator does not roll anything back from a comment. This records the following run(s); to undo one, run this in the checkout that made it:",
    "",
    "```sh",
    ...ids.map((id) => `autoremediator runs rollback ${id}`),
    "```",
    "",
    "It restores the files the run changed and reinstalls. A run is recorded in the `.autoremediator/runs` folder of the checkout where it ran: if this pull request was opened by the app from a temporary checkout, that record is gone, and reverting the pull request's commits is the way back.",
  ].join("\n");
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

function selectCvesByMinimumSeverity(
  findings: ParsedAuditFinding[],
  minimumSeverity: CveSeverity,
): string[] {
  const minRank = SEVERITY_RANK[minimumSeverity];
  const cves = new Set<string>();

  for (const finding of findings) {
    if (SEVERITY_RANK[finding.severity] >= minRank) {
      cves.add(finding.cveId.toUpperCase());
    }
  }

  return [...cves].toSorted((a, b) => a.localeCompare(b));
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
      const text =
        typeof viaEntry === "string" ? viaEntry : `${viaEntry.url ?? ""} ${viaEntry.name ?? ""}`;
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

async function runCommand(
  command: string,
  args: string[],
  cwd: string,
): Promise<{ output: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
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
            text: `${cveId} was selected for remediation`,
          },
        })),
      },
    ],
  };
}
