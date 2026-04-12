export interface GitHubAppConfig {
  appId: string;
  privateKey: string;
  webhookSecret: string;
  port: number;
  dataDir?: string;
  remediationTriggerTimeoutMs?: number;
  enableDefaultRemediationHandler?: boolean;
  remediationCwd?: string;
  remediationDryRun?: boolean;
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
  eventName: "check_suite" | "workflow_dispatch";
  installationId?: number;
  deliveryId?: string;
  payload: Record<string, unknown>;
  installationToken?: string;
}

export type JobStatus = "queued" | "running" | "completed" | "failed";

export interface QueueJob {
  id: string;
  eventName: "check_suite" | "workflow_dispatch";
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
