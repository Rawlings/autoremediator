import { Octokit } from "@octokit/rest";
import type { QueueJob } from "./types.js";

type CheckStatus = "queued" | "in_progress" | "completed";
type CheckConclusion = "success" | "failure" | "neutral";

export interface RemediationJobStatusTarget {
  owner: string;
  repo: string;
  headSha: string;
}

interface CreateStatusPublisherOptions {
  enabled: boolean;
  checkName?: string;
  githubApiUrl?: string;
  onTrace?: (message: string) => void;
}

interface PublishStatusContext {
  job: QueueJob;
  installationToken?: string;
  target: RemediationJobStatusTarget;
}

interface PublishCompletionContext extends PublishStatusContext {
  outcome: "success" | "partial" | "failed";
  reason?: string;
}

interface JobStatusPublisher {
  publishQueued(context: PublishStatusContext): Promise<void>;
  publishRunning(context: PublishStatusContext): Promise<void>;
  publishCompleted(context: PublishCompletionContext): Promise<void>;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function readStringField(record: Record<string, unknown> | undefined, field: string): string | undefined {
  if (!record) {
    return undefined;
  }

  const value = record[field];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function buildTracePrefix(job: QueueJob): string {
  return `job=${job.id}, event=${job.eventName}, delivery=${job.deliveryId ?? "none"}`;
}

function normalizeConclusion(outcome: "success" | "partial" | "failed"): CheckConclusion {
  if (outcome === "success") {
    return "success";
  }

  if (outcome === "partial") {
    return "neutral";
  }

  return "failure";
}

function normalizeSummary(outcome: "success" | "partial" | "failed", reason?: string): string {
  if (reason && reason.length > 0) {
    return reason.length > 1024 ? reason.slice(0, 1024) : reason;
  }

  if (outcome === "success") {
    return "Remediation completed successfully.";
  }

  if (outcome === "partial") {
    return "Remediation completed with partial outcomes.";
  }

  return "Remediation failed.";
}

function readStatusTargetFromCheckSuite(payload: Record<string, unknown>): RemediationJobStatusTarget | undefined {
  const repository = asRecord(payload.repository);
  const owner = asRecord(repository?.owner);
  const ownerLogin = readStringField(owner, "login");
  const repoName = readStringField(repository, "name");

  const checkSuite = asRecord(payload.check_suite);
  const headSha = readStringField(checkSuite, "head_sha");

  if (!ownerLogin || !repoName || !headSha) {
    return undefined;
  }

  return {
    owner: ownerLogin,
    repo: repoName,
    headSha,
  };
}

function readStatusTargetFromWorkflowDispatch(payload: Record<string, unknown>): RemediationJobStatusTarget | undefined {
  const repository = asRecord(payload.repository);
  const owner = asRecord(repository?.owner);
  const ownerLogin = readStringField(owner, "login");
  const repoName = readStringField(repository, "name");

  const workflow = asRecord(payload.workflow);
  const headCommit = asRecord(payload.head_commit);
  const ref = asRecord(payload.ref);

  const headSha =
    readStringField(headCommit, "id") ??
    readStringField(workflow, "head_sha") ??
    readStringField(ref, "sha") ??
    readStringField(payload, "head_sha");

  if (!ownerLogin || !repoName || !headSha) {
    return undefined;
  }

  return {
    owner: ownerLogin,
    repo: repoName,
    headSha,
  };
}

export function readRemediationStatusTarget(payload: Record<string, unknown>): RemediationJobStatusTarget | undefined {
  return readStatusTargetFromCheckSuite(payload) ?? readStatusTargetFromWorkflowDispatch(payload);
}

async function publishCheck(
  token: string,
  target: RemediationJobStatusTarget,
  checkName: string,
  status: CheckStatus,
  options: { conclusion?: CheckConclusion; summary: string; githubApiUrl?: string }
): Promise<void> {
  const octokitOptions: ConstructorParameters<typeof Octokit>[0] = { auth: token };
  if (options.githubApiUrl) {
    octokitOptions.baseUrl = options.githubApiUrl.replace(/\/$/, "");
  }
  const octokit = new Octokit(octokitOptions);

  await octokit.rest.checks.create({
    owner: target.owner,
    repo: target.repo,
    name: checkName,
    head_sha: target.headSha,
    status,
    conclusion: options.conclusion,
    output: {
      title: checkName,
      summary: options.summary,
    },
  });
}

export function createJobStatusPublisher(options: CreateStatusPublisherOptions): JobStatusPublisher {
  const checkName = options.checkName && options.checkName.length > 0
    ? options.checkName
    : "autoremediator/remediation";

  const publishSafely = async (
    context: PublishStatusContext,
    phase: "queued" | "running" | "completed",
    publish: () => Promise<void>
  ): Promise<void> => {
    if (!options.enabled) {
      return;
    }

    if (!context.installationToken) {
      options.onTrace?.(
        `Status publish skipped (${phase}): missing installation token (${buildTracePrefix(context.job)})`
      );
      return;
    }

    try {
      await publish();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      options.onTrace?.(
        `Status publish failed (${phase}): ${message} (${buildTracePrefix(context.job)})`
      );
    }
  };

  return {
    async publishQueued(context: PublishStatusContext): Promise<void> {
      await publishSafely(context, "queued", async () => {
        await publishCheck(context.installationToken as string, context.target, checkName, "queued", {
          summary: "Remediation job queued.",
          githubApiUrl: options.githubApiUrl,
        });
      });
    },

    async publishRunning(context: PublishStatusContext): Promise<void> {
      await publishSafely(context, "running", async () => {
        await publishCheck(context.installationToken as string, context.target, checkName, "in_progress", {
          summary: "Remediation job is running.",
          githubApiUrl: options.githubApiUrl,
        });
      });
    },

    async publishCompleted(context: PublishCompletionContext): Promise<void> {
      await publishSafely(context, "completed", async () => {
        await publishCheck(context.installationToken as string, context.target, checkName, "completed", {
          conclusion: normalizeConclusion(context.outcome),
          summary: normalizeSummary(context.outcome, context.reason),
          githubApiUrl: options.githubApiUrl,
        });
      });
    },
  };
}

export type { JobStatusPublisher };
