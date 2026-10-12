import type { CveSeverity, DispositionPolicy, EscalationGraph } from "autoremediator";

export interface AutoremediatorRepoConfig {
  // Remediation behavior
  dryRun: boolean;
  runTests: boolean;
  minimumSeverity: CveSeverity;
  cwd?: string;
  // Policy / constraints  (mirrors AutoremediatorPolicy fields)
  allowMajorBumps: boolean;
  denyPackages: string[];
  allowPackages: string[];
  constraints?: {
    directDependenciesOnly?: boolean;
    preferVersionBump?: boolean;
    installMode?: "standard" | "prefer-offline" | "deterministic";
    installPreferOffline?: boolean;
    enforceFrozenLockfile?: boolean;
    workspace?: string;
  };
  modelDefaults?: Partial<Record<"remote" | "local", string>>;
  providerSafetyProfile?: "strict" | "relaxed";
  requireConsensusForHighRisk?: boolean;
  consensusProvider?: "remote" | "local";
  consensusModel?: string;
  patchConfidenceThresholds?: Partial<Record<"low" | "medium" | "high", number>>;
  dynamicModelRouting?: boolean;
  dynamicRoutingThresholdChars?: number;
  // Autonomous defense operator fields
  dispositionPolicy?: DispositionPolicy;
  containmentMode?: boolean;
  escalationGraph?: EscalationGraph;
  // Pull request creation
  pullRequest?: {
    enabled?: boolean;
    grouping?: "all" | "per-cve" | "per-package";
    repository?: string;
    baseBranch?: string;
    branchPrefix?: string;
    titlePrefix?: string;
    bodyFooter?: string;
    draft?: boolean;
    pushRemote?: string;
    tokenEnvVar?: string;
  };
  // PR Auto-healing with CI feedback loop
  enablePrAutoHealing?: boolean;
  maxHealingAttempts?: number;
}

export const DEFAULT_REPO_CONFIG: AutoremediatorRepoConfig = {
  dryRun: true,
  runTests: false,
  minimumSeverity: "HIGH",
  allowMajorBumps: false,
  denyPackages: [],
  allowPackages: [],
  enablePrAutoHealing: false,
  maxHealingAttempts: 3,
};

export interface GitHubAppConfig {
  appId: string;
  privateKey: string;
  webhookSecret: string;
  port: number;
  dataDir?: string;
  remediationTriggerTimeoutMs?: number;
  enableDefaultRemediationHandler?: boolean;
  logEventTraces?: boolean;
  maxWebhookBodyBytes?: number;
  requireJsonContentType?: boolean;
  allowedEvents?: string[];
  requireDeliveryId?: boolean;
  enableJobQueue?: boolean;
  queuePollIntervalMs?: number;
  queueRetryDelayMs?: number;
  queueMaxAttempts?: number;
  jobWorkerConcurrency?: number;
  enableScheduler?: boolean;
  scheduleIntervalMs?: number;
  enableStatusPublishing?: boolean;
  statusCheckName?: string;
  baseUrl?: string;
  enableSetupRoutes?: boolean;
  setupSecret?: string;
  githubUrl?: string;
  githubApiUrl?: string;
}

export interface DispatchResult {
  status: "handled" | "ignored" | "duplicate";
  reason?: string;
}

export interface WebhookContext {
  eventName: string;
  deliveryId?: string;
}

export interface RemediationTriggerContext {
  eventName: "check_suite" | "push" | "workflow_dispatch" | "check_run";
  installationId?: number;
  deliveryId?: string;
  payload: Record<string, unknown>;
  installationToken?: string;
}

export type RemediationJobCompletion = "success" | "partial" | "failed";

export interface RemediationJobResult {
  status: RemediationJobCompletion;
  reason?: string;
}

export type JobStatus = "queued" | "running" | "completed" | "failed";

export interface QueueJob {
  id: string;
  eventName: "check_suite" | "push" | "workflow_dispatch" | "check_run";

  installationId?: number;
  deliveryId?: string;
  payload: Record<string, unknown>;
  dedupeKey?: string;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  nextRunAt: string;
  createdAt: string;
  updatedAt: string;
  lastError?: string;
}

export interface InstallationToken {
  token: string;
  expiresAt?: string;
}

export interface EventProcessingTrace {
  requestId: string;
  eventName: string;
  deliveryId?: string;
  installationId?: number;
  status: DispatchResult["status"] | "rejected";
  statusCode: number;
  latencyMs: number;
  reason?: string;
  processedAt: string;
}

export interface AppErrorLog {
  timestamp: string;
  source: "github-app";
  level: "error" | "warn";
  context: string;
  message: string;
  error?: string;
  stack?: string;
  details?: Record<string, unknown>;
}

export type ErrorLogger = (log: AppErrorLog) => void | Promise<void>;

export interface CheckoutProviderParams {
  owner: string;
  repo: string;
  ref?: string;
  token?: string;
}

export interface CheckoutResult {
  cwd: string;
  cleanup: () => Promise<void>;
}

export type CheckoutProvider = (params: CheckoutProviderParams) => Promise<CheckoutResult>;

export interface ParsedAuditFinding {
  cveId: string;
  packageName?: string;
  severity: CveSeverity;
  fixedIn?: string;
  url?: string;
}

export interface DefaultRemediationHandlerOptions {
  octokitFactory: (installationId: number) => Promise<import("@octokit/rest").Octokit>;
  /** Override repo config fetch — useful for tests. */
  repoConfigProvider?: (owner: string, repo: string) => Promise<AutoremediatorRepoConfig>;
  /** Override audit finding collection — useful for tests. */
  auditFindingProvider?: (cwd: string) => Promise<ParsedAuditFinding[]>;
  /** Pluggable checkout provider for isolated workspaces — useful for tests. */
  checkoutProvider?: CheckoutProvider;
  /** Structured error logger */
  onError?: ErrorLogger;
}
