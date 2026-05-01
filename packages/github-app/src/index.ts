import { createGitHubAppServer } from "./server.js";
import { loadGitHubAppConfig } from "./config.js";
import { createFileAppStateStore } from "./state.js";
import { pathToFileURL } from "node:url";

export { loadGitHubAppConfig } from "./config.js";
export { createGitHubAppServer, handleRequest } from "./server.js";
export { verifyWebhookSignature, computeWebhookSignature } from "./signature.js";
export { dispatchGitHubEvent } from "./events.js";
export { createInMemoryAppStateStore, createFileAppStateStore } from "./state.js";
export { createDefaultRemediationHandler } from "./remediation-handler.js";
export { fetchRepoConfig } from "./repo-config.js";
export { DEFAULT_REPO_CONFIG } from "./types.js";
export type { GitHubAppConfig, AutoremediatorRepoConfig, DispatchResult, WebhookContext, EventProcessingTrace } from "./types.js";

export async function startGitHubAppServer(): Promise<void> {
  const config = loadGitHubAppConfig();
  const server = createGitHubAppServer({
    appId: config.appId,
    privateKey: config.privateKey,
    dataDir: config.dataDir,
    webhookSecret: config.webhookSecret,
    stateStore: config.dataDir ? createFileAppStateStore(config.dataDir) : undefined,
    remediationTriggerTimeoutMs: config.remediationTriggerTimeoutMs,
    enableDefaultRemediationHandler: config.enableDefaultRemediationHandler,
    maxWebhookBodyBytes: config.maxWebhookBodyBytes,
    requireJsonContentType: config.requireJsonContentType,
    allowedEvents: config.allowedEvents,
    requireDeliveryId: config.requireDeliveryId,
    enableJobQueue: config.enableJobQueue,
    queuePollIntervalMs: config.queuePollIntervalMs,
    queueRetryDelayMs: config.queueRetryDelayMs,
    queueMaxAttempts: config.queueMaxAttempts,
    jobWorkerConcurrency: config.jobWorkerConcurrency,
    enableScheduler: config.enableScheduler,
    scheduleIntervalMs: config.scheduleIntervalMs,
    enableStatusPublishing: config.enableStatusPublishing,
    statusCheckName: config.statusCheckName,
    baseUrl: config.baseUrl,
    enableSetupRoutes: config.enableSetupRoutes,
    setupSecret: config.setupSecret,
    githubUrl: config.githubUrl,
    githubApiUrl: config.githubApiUrl,
    onEventProcessed: config.logEventTraces
      ? (trace) => {
          // eslint-disable-next-line no-console
          console.log(JSON.stringify({ source: "github-app", type: "event-trace", ...trace }));
        }
      : undefined,
    onStatusTrace: config.logEventTraces
      ? (message) => {
          // eslint-disable-next-line no-console
          console.log(JSON.stringify({ source: "github-app", type: "status-trace", message }));
        }
      : undefined,
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, process.env.AUTOREMEDIATOR_GITHUB_APP_HOST ?? "127.0.0.1", () => {
      resolve();
    });
  });

  // eslint-disable-next-line no-console
  console.log(`autoremediator github app server listening on :${config.port}`);
}

const entrypointArg = process.argv[1];
if (entrypointArg && import.meta.url === pathToFileURL(entrypointArg).href) {
  startGitHubAppServer().catch((error) => {
    const message = error instanceof Error ? error.message : "Failed to start github app server";
    // eslint-disable-next-line no-console
    console.error(message);
    process.exitCode = 1;
  });
}
