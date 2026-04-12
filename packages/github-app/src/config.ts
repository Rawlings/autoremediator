import { GitHubAppConfig } from "./types.js";

function parseBooleanEnv(name: string, value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) {
    return defaultValue;
  }

  if (value === "true") {
    return true;
  }

  if (value === "false") {
    return false;
  }

  throw new Error(`Invalid ${name}: ${value}. Expected true or false.`);
}

function parseCsvEnv(name: string, value: string | undefined): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

  if (parsed.length === 0) {
    throw new Error(`Invalid ${name}: expected a comma-separated list with at least one value.`);
  }

  return [...new Set(parsed)];
}

function parsePositiveIntEnv(name: string, value: string | undefined, defaultValue: number): number {
  if (value === undefined) {
    return defaultValue;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${name}: ${value}`);
  }

  return parsed;
}

export function loadGitHubAppConfig(env: NodeJS.ProcessEnv = process.env): GitHubAppConfig {
  const appId = env.AUTOREMEDIATOR_GITHUB_APP_ID;
  const privateKey = env.AUTOREMEDIATOR_GITHUB_APP_PRIVATE_KEY;
  const webhookSecret = env.AUTOREMEDIATOR_GITHUB_APP_WEBHOOK_SECRET;

  if (!appId) {
    throw new Error("Missing required environment variable: AUTOREMEDIATOR_GITHUB_APP_ID");
  }
  if (!privateKey) {
    throw new Error("Missing required environment variable: AUTOREMEDIATOR_GITHUB_APP_PRIVATE_KEY");
  }
  if (!webhookSecret) {
    throw new Error("Missing required environment variable: AUTOREMEDIATOR_GITHUB_APP_WEBHOOK_SECRET");
  }

  const rawPort = env.AUTOREMEDIATOR_GITHUB_APP_PORT ?? "3001";
  const parsedPort = Number.parseInt(rawPort, 10);
  if (!Number.isFinite(parsedPort) || parsedPort <= 0) {
    throw new Error(`Invalid AUTOREMEDIATOR_GITHUB_APP_PORT: ${rawPort}`);
  }

  const rawTriggerTimeout = env.AUTOREMEDIATOR_GITHUB_APP_TRIGGER_TIMEOUT_MS;
  let remediationTriggerTimeoutMs: number | undefined;
  if (rawTriggerTimeout !== undefined) {
    const parsedTimeout = Number.parseInt(rawTriggerTimeout, 10);
    if (!Number.isFinite(parsedTimeout) || parsedTimeout <= 0) {
      throw new Error(`Invalid AUTOREMEDIATOR_GITHUB_APP_TRIGGER_TIMEOUT_MS: ${rawTriggerTimeout}`);
    }
    remediationTriggerTimeoutMs = parsedTimeout;
  }

  const rawMaxWebhookBodyBytes = env.AUTOREMEDIATOR_GITHUB_APP_MAX_WEBHOOK_BODY_BYTES;
  let maxWebhookBodyBytes = 262_144;
  if (rawMaxWebhookBodyBytes !== undefined) {
    const parsedMaxBody = Number.parseInt(rawMaxWebhookBodyBytes, 10);
    if (!Number.isFinite(parsedMaxBody) || parsedMaxBody <= 0) {
      throw new Error(`Invalid AUTOREMEDIATOR_GITHUB_APP_MAX_WEBHOOK_BODY_BYTES: ${rawMaxWebhookBodyBytes}`);
    }
    maxWebhookBodyBytes = parsedMaxBody;
  }

  const enableDefaultRemediationHandler = parseBooleanEnv(
    "AUTOREMEDIATOR_GITHUB_APP_ENABLE_DEFAULT_REMEDIATION",
    env.AUTOREMEDIATOR_GITHUB_APP_ENABLE_DEFAULT_REMEDIATION,
    false
  );

  const remediationDryRun = parseBooleanEnv(
    "AUTOREMEDIATOR_GITHUB_APP_REMEDIATION_DRY_RUN",
    env.AUTOREMEDIATOR_GITHUB_APP_REMEDIATION_DRY_RUN,
    true
  );

  const logEventTraces = parseBooleanEnv(
    "AUTOREMEDIATOR_GITHUB_APP_LOG_EVENT_TRACES",
    env.AUTOREMEDIATOR_GITHUB_APP_LOG_EVENT_TRACES,
    false
  );

  const requireJsonContentType = parseBooleanEnv(
    "AUTOREMEDIATOR_GITHUB_APP_REQUIRE_JSON_CONTENT_TYPE",
    env.AUTOREMEDIATOR_GITHUB_APP_REQUIRE_JSON_CONTENT_TYPE,
    true
  );

  const requireDeliveryId = parseBooleanEnv(
    "AUTOREMEDIATOR_GITHUB_APP_REQUIRE_DELIVERY_ID",
    env.AUTOREMEDIATOR_GITHUB_APP_REQUIRE_DELIVERY_ID,
    false
  );

  const allowedEvents = parseCsvEnv(
    "AUTOREMEDIATOR_GITHUB_APP_ALLOWED_EVENTS",
    env.AUTOREMEDIATOR_GITHUB_APP_ALLOWED_EVENTS
  );

  const enableJobQueue = parseBooleanEnv(
    "AUTOREMEDIATOR_GITHUB_APP_ENABLE_JOB_QUEUE",
    env.AUTOREMEDIATOR_GITHUB_APP_ENABLE_JOB_QUEUE,
    true
  );

  const queuePollIntervalMs = parsePositiveIntEnv(
    "AUTOREMEDIATOR_GITHUB_APP_QUEUE_POLL_INTERVAL_MS",
    env.AUTOREMEDIATOR_GITHUB_APP_QUEUE_POLL_INTERVAL_MS,
    2000
  );

  const queueRetryDelayMs = parsePositiveIntEnv(
    "AUTOREMEDIATOR_GITHUB_APP_QUEUE_RETRY_DELAY_MS",
    env.AUTOREMEDIATOR_GITHUB_APP_QUEUE_RETRY_DELAY_MS,
    15000
  );

  const queueMaxAttempts = parsePositiveIntEnv(
    "AUTOREMEDIATOR_GITHUB_APP_QUEUE_MAX_ATTEMPTS",
    env.AUTOREMEDIATOR_GITHUB_APP_QUEUE_MAX_ATTEMPTS,
    3
  );

  const jobWorkerConcurrency = parsePositiveIntEnv(
    "AUTOREMEDIATOR_GITHUB_APP_WORKER_CONCURRENCY",
    env.AUTOREMEDIATOR_GITHUB_APP_WORKER_CONCURRENCY,
    1
  );

  const enableScheduler = parseBooleanEnv(
    "AUTOREMEDIATOR_GITHUB_APP_ENABLE_SCHEDULER",
    env.AUTOREMEDIATOR_GITHUB_APP_ENABLE_SCHEDULER,
    false
  );

  const scheduleIntervalMs = parsePositiveIntEnv(
    "AUTOREMEDIATOR_GITHUB_APP_SCHEDULE_INTERVAL_MS",
    env.AUTOREMEDIATOR_GITHUB_APP_SCHEDULE_INTERVAL_MS,
    3_600_000
  );

  return {
    appId,
    privateKey,
    webhookSecret,
    port: parsedPort,
    dataDir: env.AUTOREMEDIATOR_GITHUB_APP_DATA_DIR,
    remediationTriggerTimeoutMs,
    enableDefaultRemediationHandler,
    remediationCwd: env.AUTOREMEDIATOR_GITHUB_APP_REMEDIATION_CWD,
    remediationDryRun,
    logEventTraces,
    maxWebhookBodyBytes,
    requireJsonContentType,
    allowedEvents,
    requireDeliveryId,
    enableJobQueue,
    queuePollIntervalMs,
    queueRetryDelayMs,
    queueMaxAttempts,
    jobWorkerConcurrency,
    enableScheduler,
    scheduleIntervalMs,
  };
}

export function requireWebhookSecret(env: NodeJS.ProcessEnv = process.env): string {
  const value = env.AUTOREMEDIATOR_GITHUB_APP_WEBHOOK_SECRET;
  if (!value) {
    throw new Error("Missing required environment variable: AUTOREMEDIATOR_GITHUB_APP_WEBHOOK_SECRET");
  }
  return value;
}
