import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { dispatchGitHubEvent } from "./events.js";
import { verifyWebhookSignature } from "./signature.js";
import { type AppStateStore, createInMemoryAppStateStore } from "./state.js";
import type { EventProcessingTrace, RemediationTriggerContext } from "./types.js";
import { createDefaultRemediationHandler } from "./remediation-handler.js";
import { createFileBackedJobQueue, createInMemoryJobQueue } from "./queue.js";
import { startJobWorker } from "./worker.js";
import { startWorkflowDispatchScheduler } from "./scheduler.js";
import { createInstallationTokenProvider } from "./auth.js";
import { createJobStatusPublisher, readRemediationStatusTarget } from "./status-publisher.js";
import type { RemediationJobResult } from "./types.js";
import {
  exchangeManifestCode,
  generateStateToken,
  parseStateCookie,
  renderAlreadyConfiguredPage,
  renderInstallPage,
  renderSetupCompletePage,
  renderSetupErrorPage,
  renderSetupForbiddenPage,
  renderSetupPage,
  resolveBaseUrl,
} from "./setup.js";

interface ServerOptions {
  webhookSecret: string;
  maxTrackedDeliveries?: number;
  stateStore?: AppStateStore;
  onRemediationRequested?: (context: RemediationTriggerContext) => Promise<RemediationJobResult | void> | RemediationJobResult | void;
  remediationTriggerTimeoutMs?: number;
  enableDefaultRemediationHandler?: boolean;
  onEventProcessed?: (trace: EventProcessingTrace) => Promise<void> | void;
  maxWebhookBodyBytes?: number;
  requireJsonContentType?: boolean;
  allowedEvents?: string[];
  requireDeliveryId?: boolean;
  runtimeCounters?: RuntimeCounters;
  appId?: string;
  privateKey?: string;
  dataDir?: string;
  enableJobQueue?: boolean;
  queuePollIntervalMs?: number;
  queueRetryDelayMs?: number;
  queueMaxAttempts?: number;
  jobWorkerConcurrency?: number;
  enableScheduler?: boolean;
  scheduleIntervalMs?: number;
  runtimeQueueSnapshot?: () => QueueRuntimeSnapshot;
  enableStatusPublishing?: boolean;
  statusCheckName?: string;
  onStatusTrace?: (message: string) => Promise<void> | void;
  baseUrl?: string;
  enableSetupRoutes?: boolean;
  setupSecret?: string;
  githubUrl?: string;
  githubApiUrl?: string;
}

interface RuntimeCounters {
  startedAt: string;
  totalRequests: number;
  webhookRequests: number;
  handled: number;
  ignored: number;
  duplicate: number;
  rejected: number;
  totalLatencyMs: number;
  maxLatencyMs: number;
  lastProcessedAt?: string;
  byEvent: Record<string, number>;
  byStatusCode: Record<string, number>;
  jobsDequeued: number;
  jobsSucceeded: number;
  jobsRetried: number;
  jobsFailed: number;
  lastJobProcessedAt?: string;
}

interface QueueRuntimeSnapshot {
  depth: number;
  queued: number;
  running: number;
  completed: number;
  failed: number;
}

interface JsonResponse {
  statusCode: number;
  body: Record<string, unknown>;
}

function writeJson(response: ServerResponse, payload: JsonResponse): void {
  response.statusCode = payload.statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("x-frame-options", "DENY");
  response.setHeader("cache-control", "no-store");
  response.end(JSON.stringify(payload.body));
}

function createRuntimeCounters(): RuntimeCounters {
  return {
    startedAt: new Date().toISOString(),
    totalRequests: 0,
    webhookRequests: 0,
    handled: 0,
    ignored: 0,
    duplicate: 0,
    rejected: 0,
    totalLatencyMs: 0,
    maxLatencyMs: 0,
    byEvent: {},
    byStatusCode: {},
    jobsDequeued: 0,
    jobsSucceeded: 0,
    jobsRetried: 0,
    jobsFailed: 0,
  };
}

function incrementCounter(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1;
}

function recordWebhookLatency(counters: RuntimeCounters, latencyMs: number): void {
  counters.totalLatencyMs += latencyMs;
  counters.maxLatencyMs = Math.max(counters.maxLatencyMs, latencyMs);
  counters.lastProcessedAt = new Date().toISOString();
}

function readInstallationId(payload: Record<string, unknown>): number | undefined {
  const installation = payload.installation;
  if (!installation || typeof installation !== "object") {
    return undefined;
  }

  const id = (installation as { id?: unknown }).id;
  return typeof id === "number" && Number.isFinite(id) ? id : undefined;
}

async function readBody(request: IncomingMessage, maxWebhookBodyBytes?: number): Promise<string> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of request) {
    const bufferChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += bufferChunk.byteLength;

    if (maxWebhookBodyBytes !== undefined && totalBytes > maxWebhookBodyBytes) {
      throw new Error("Payload too large");
    }

    chunks.push(bufferChunk);
  }

  return Buffer.concat(chunks).toString("utf8");
}

function isJsonContentType(headerValue: string | undefined): boolean {
  if (!headerValue) {
    return false;
  }

  return headerValue.toLowerCase().startsWith("application/json");
}

async function emitRejected(
  response: ServerResponse,
  options: ServerOptions,
  requestId: string,
  requestStartedAt: number,
  details: {
    statusCode: number;
    error: string;
    eventName: string;
    deliveryId?: string;
  }
): Promise<void> {
  if (options.runtimeCounters) {
    const latencyMs = Date.now() - requestStartedAt;
    options.runtimeCounters.rejected += 1;
    incrementCounter(options.runtimeCounters.byStatusCode, String(details.statusCode));
    incrementCounter(options.runtimeCounters.byEvent, details.eventName);
    recordWebhookLatency(options.runtimeCounters, latencyMs);
  }

  await options.onEventProcessed?.({
    requestId,
    eventName: details.eventName,
    deliveryId: details.deliveryId,
    status: "rejected",
    statusCode: details.statusCode,
    latencyMs: Date.now() - requestStartedAt,
    reason: details.error,
    processedAt: new Date().toISOString(),
  });

  response.setHeader("x-request-id", requestId);
  writeJson(response, {
    statusCode: details.statusCode,
    body: { error: details.error },
  });
}

export async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: ServerOptions
): Promise<void> {
  const requestStartedAt = Date.now();
  const requestIdHeader = request.headers["x-request-id"];
  const requestId = (Array.isArray(requestIdHeader) ? requestIdHeader[0] : requestIdHeader) ?? randomUUID();

  if (request.method === "GET" && request.url === "/health") {
    const counters = options.runtimeCounters;
    const uptimeSeconds = counters
      ? Math.floor((Date.now() - new Date(counters.startedAt).getTime()) / 1000)
      : undefined;
    const averageLatencyMs =
      counters && counters.webhookRequests + counters.rejected > 0
        ? counters.totalLatencyMs / (counters.webhookRequests + counters.rejected)
        : 0;
    const queue = options.runtimeQueueSnapshot?.();

    response.setHeader("x-request-id", requestId);
    writeJson(response, {
      statusCode: 200,
      body: {
        status: "ok",
        service: "github-app",
        uptimeSeconds,
        counters,
        latency: {
          averageMs: averageLatencyMs,
          maxMs: counters?.maxLatencyMs ?? 0,
        },
        queue,
      },
    });
    return;
  }

  if (options.enableSetupRoutes !== false && request.method === "GET") {
    const parsedUrl = new URL(request.url ?? "/", "http://placeholder");

    if (parsedUrl.pathname === "/setup") {
      // If already configured, show a safe "already registered" page instead
      if (options.appId) {
        response.statusCode = 200;
        response.setHeader("content-type", "text/html; charset=utf-8");
        response.end(renderAlreadyConfiguredPage());
        return;
      }
      // Enforce setup secret when configured
      if (options.setupSecret) {
        const providedSecret = parsedUrl.searchParams.get("secret");
        if (providedSecret !== options.setupSecret) {
          response.statusCode = 403;
          response.setHeader("content-type", "text/html; charset=utf-8");
          response.end(renderSetupForbiddenPage());
          return;
        }
      }
      const baseUrl = options.baseUrl ?? resolveBaseUrl(request.headers.host);
      const state = generateStateToken();
      response.statusCode = 200;
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.setHeader("Set-Cookie", `autoremediator_setup_state=${state}; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600`);
      response.end(renderSetupPage(baseUrl, options.githubUrl, state));
      return;
    }

    if (parsedUrl.pathname === "/setup/complete") {
      const code = parsedUrl.searchParams.get("code");
      if (!code) {
        response.statusCode = 400;
        response.setHeader("content-type", "text/html; charset=utf-8");
        response.end(renderSetupErrorPage("Missing code parameter from GitHub."));
        return;
      }
      if (code.length < 5 || code.length > 512) {
        response.statusCode = 400;
        response.setHeader("content-type", "text/html; charset=utf-8");
        response.end(renderSetupErrorPage("Invalid code parameter length."));
        return;
      }
      const returnedState = parsedUrl.searchParams.get("state");
      const cookieState = parseStateCookie(request.headers.cookie);
      const clearStateCookie = "autoremediator_setup_state=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0";
      if (!returnedState || !cookieState || returnedState !== cookieState) {
        response.statusCode = 400;
        response.setHeader("content-type", "text/html; charset=utf-8");
        response.setHeader("Set-Cookie", clearStateCookie);
        response.end(renderSetupErrorPage(
          "Invalid or missing state parameter. Possible CSRF attempt. Please start the setup process again."
        ));
        return;
      }
      response.setHeader("Set-Cookie", clearStateCookie);
      try {
        const result = await exchangeManifestCode(code, options.githubApiUrl);
        response.statusCode = 200;
        response.setHeader("content-type", "text/html; charset=utf-8");
        response.end(renderSetupCompletePage(result));
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error during code exchange";
        response.statusCode = 500;
        response.setHeader("content-type", "text/html; charset=utf-8");
        response.end(renderSetupErrorPage(message));
      }
      return;
    }

    if (parsedUrl.pathname === "/install") {
      const installationId = parsedUrl.searchParams.get("installation_id") ?? undefined;
      response.statusCode = 200;
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end(renderInstallPage(installationId));
      return;
    }
  }

  if (request.url === "/webhook" && request.method !== "POST") {
    response.setHeader("allow", "POST");
    response.setHeader("x-request-id", requestId);
    writeJson(response, {
      statusCode: 405,
      body: { error: "Method not allowed" },
    });
    return;
  }

  if (request.method !== "POST" || request.url !== "/webhook") {
    response.setHeader("x-request-id", requestId);
    writeJson(response, {
      statusCode: 404,
      body: { error: "Not found" },
    });
    return;
  }

  if (options.runtimeCounters) {
    options.runtimeCounters.totalRequests += 1;
  }

  const eventHeader = request.headers["x-github-event"];
  const eventName = Array.isArray(eventHeader) ? eventHeader[0] : eventHeader;

  const deliveryHeader = request.headers["x-github-delivery"];
  let deliveryId = Array.isArray(deliveryHeader) ? deliveryHeader[0] : deliveryHeader;
  // Sanitize deliveryId: reject values with unsafe characters (log injection prevention)
  if (deliveryId && (deliveryId.length > 256 || !/^[\w.-]+$/.test(deliveryId))) {
    deliveryId = undefined;
  }

  const eventNameForTrace = eventName ?? "unknown";

  if (options.requireDeliveryId && !deliveryId) {
    await emitRejected(response, options, requestId, requestStartedAt, {
      statusCode: 400,
      error: "Missing x-github-delivery header",
      eventName: eventNameForTrace,
      deliveryId,
    });
    return;
  }

  if (options.requireJsonContentType !== false) {
    const contentTypeHeader = request.headers["content-type"];
    const contentType = Array.isArray(contentTypeHeader) ? contentTypeHeader[0] : contentTypeHeader;
    if (!isJsonContentType(contentType)) {
      await emitRejected(response, options, requestId, requestStartedAt, {
        statusCode: 415,
        error: "Unsupported content type",
        eventName: eventNameForTrace,
        deliveryId,
      });
      return;
    }
  }

  let rawBody: string;
  try {
    rawBody = await readBody(request, options.maxWebhookBodyBytes);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to read webhook payload";
    if (message === "Payload too large") {
      await emitRejected(response, options, requestId, requestStartedAt, {
        statusCode: 413,
        error: "Payload too large",
        eventName: eventNameForTrace,
        deliveryId,
      });
      return;
    }

    await emitRejected(response, options, requestId, requestStartedAt, {
      statusCode: 400,
      error: message,
      eventName: eventNameForTrace,
      deliveryId,
    });
    return;
  }
  const signature = request.headers["x-hub-signature-256"];
  const signatureHeader = Array.isArray(signature) ? signature[0] : signature;

  if (!verifyWebhookSignature(options.webhookSecret, rawBody, signatureHeader)) {
    await emitRejected(response, options, requestId, requestStartedAt, {
      statusCode: 401,
      error: "Invalid webhook signature",
      eventName: eventNameForTrace,
      deliveryId,
    });
    return;
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    await emitRejected(response, options, requestId, requestStartedAt, {
      statusCode: 400,
      error: "Invalid JSON payload",
      eventName: eventNameForTrace,
      deliveryId,
    });
    return;
  }

  if (!eventName) {
    await emitRejected(response, options, requestId, requestStartedAt, {
      statusCode: 400,
      error: "Missing x-github-event header",
      eventName: eventNameForTrace,
      deliveryId,
    });
    return;
  }

  if (options.allowedEvents && !options.allowedEvents.includes(eventName)) {
    if (options.runtimeCounters) {
      options.runtimeCounters.webhookRequests += 1;
      options.runtimeCounters.ignored += 1;
      incrementCounter(options.runtimeCounters.byEvent, eventName);
      incrementCounter(options.runtimeCounters.byStatusCode, "202");
    }

    const reason = `Event not allowed: ${eventName}`;
    const trace: EventProcessingTrace = {
      requestId,
      eventName,
      deliveryId,
      status: "ignored",
      statusCode: 202,
      latencyMs: Date.now() - requestStartedAt,
      reason,
      processedAt: new Date().toISOString(),
    };
    await options.onEventProcessed?.(trace);

    response.setHeader("x-request-id", requestId);
    writeJson(response, {
      statusCode: 202,
      body: {
        status: "ignored",
        reason,
        event: eventName,
        deliveryId,
      },
    });
    return;
  }

  if (deliveryId && options.stateStore?.hasProcessedDelivery(deliveryId)) {
    if (options.runtimeCounters) {
      const latencyMs = Date.now() - requestStartedAt;
      options.runtimeCounters.webhookRequests += 1;
      options.runtimeCounters.duplicate += 1;
      incrementCounter(options.runtimeCounters.byEvent, eventName);
      incrementCounter(options.runtimeCounters.byStatusCode, "202");
      recordWebhookLatency(options.runtimeCounters, latencyMs);
    }

    const trace: EventProcessingTrace = {
      requestId,
      eventName,
      deliveryId,
      status: "duplicate",
      statusCode: 202,
      latencyMs: Date.now() - requestStartedAt,
      reason: "Webhook delivery already processed",
      processedAt: new Date().toISOString(),
    };
    await options.onEventProcessed?.(trace);

    response.setHeader("x-request-id", requestId);
    writeJson(response, {
      statusCode: 202,
      body: {
        status: trace.status,
        reason: trace.reason,
        event: eventName,
        deliveryId,
      },
    });
    return;
  }

  const result = await dispatchGitHubEvent({ eventName, deliveryId }, payload, {
    stateStore: options.stateStore,
    onRemediationRequested: options.onRemediationRequested,
    remediationTriggerTimeoutMs: options.remediationTriggerTimeoutMs,
  });

  if (deliveryId && options.stateStore && result.status !== "ignored") {
    options.stateStore.markDeliveryProcessed(deliveryId);
  }

  if (options.runtimeCounters) {
    const latencyMs = Date.now() - requestStartedAt;
    options.runtimeCounters.webhookRequests += 1;
    incrementCounter(options.runtimeCounters.byEvent, eventName);
    incrementCounter(options.runtimeCounters.byStatusCode, "202");
    if (result.status === "handled") {
      options.runtimeCounters.handled += 1;
    }
    if (result.status === "ignored") {
      options.runtimeCounters.ignored += 1;
    }
    if (result.status === "duplicate") {
      options.runtimeCounters.duplicate += 1;
    }
    recordWebhookLatency(options.runtimeCounters, latencyMs);
  }

  const trace: EventProcessingTrace = {
    requestId,
    eventName,
    deliveryId,
    installationId: readInstallationId(payload),
    status: result.status,
    statusCode: 202,
    latencyMs: Date.now() - requestStartedAt,
    reason: result.reason,
    processedAt: new Date().toISOString(),
  };
  await options.onEventProcessed?.(trace);

  response.setHeader("x-request-id", requestId);
  writeJson(response, {
    statusCode: 202,
    body: {
      status: result.status,
      reason: result.reason,
      event: eventName,
      deliveryId,
    },
  });
}

export function createGitHubAppServer(options: ServerOptions): Server {
  const installationTokenProvider =
    options.appId && options.privateKey
      ? createInstallationTokenProvider({
          appId: options.appId,
          privateKey: options.privateKey,
        })
      : undefined;

  const defaultRemediationHandler =
    options.enableDefaultRemediationHandler && installationTokenProvider
      ? createDefaultRemediationHandler({
          octokitFactory: async (installationId: number) => {
            const { token } = await installationTokenProvider.getInstallationToken(installationId);
            const { Octokit } = await import("@octokit/rest");
            return new Octokit({ auth: token });
          },
        })
      : undefined;

  const normalizedOptions: ServerOptions = {
    ...options,
    stateStore: options.stateStore ?? createInMemoryAppStateStore(options.maxTrackedDeliveries),
    onRemediationRequested: options.onRemediationRequested ?? defaultRemediationHandler,
    runtimeCounters: options.runtimeCounters ?? createRuntimeCounters(),
  };

  const remediationHandler = normalizedOptions.onRemediationRequested;

  const queue = normalizedOptions.enableJobQueue === false
    ? createInMemoryJobQueue()
    : normalizedOptions.dataDir
      ? createFileBackedJobQueue(join(normalizedOptions.dataDir, "job-queue.json"))
      : createInMemoryJobQueue();

  const statusPublisherTokenProvider =
    normalizedOptions.appId && normalizedOptions.privateKey
      ? createInstallationTokenProvider({
          appId: normalizedOptions.appId,
          privateKey: normalizedOptions.privateKey,
        })
      : undefined;

  const statusPublisher = createJobStatusPublisher({
    enabled: normalizedOptions.enableStatusPublishing ?? false,
    checkName: normalizedOptions.statusCheckName,
    githubApiUrl: normalizedOptions.githubApiUrl,
    onTrace: (message) => {
      void normalizedOptions.onStatusTrace?.(message);
    },
  });

  normalizedOptions.runtimeQueueSnapshot = () => {
    const jobs = queue.listJobs();
    let queued = 0;
    let running = 0;
    let completed = 0;
    let failed = 0;

    for (const job of jobs) {
      if (job.status === "queued") {
        queued += 1;
      }
      if (job.status === "running") {
        running += 1;
      }
      if (job.status === "completed") {
        completed += 1;
      }
      if (job.status === "failed") {
        failed += 1;
      }
    }

    return {
      depth: jobs.length,
      queued,
      running,
      completed,
      failed,
    };
  };

  normalizedOptions.onRemediationRequested = (context) => {
    const statusTarget = readRemediationStatusTarget(context.payload);

    queue.enqueue({
      eventName: context.eventName,
      installationId: context.installationId,
      deliveryId: context.deliveryId,
      payload: context.payload,
      dedupeKey: context.deliveryId,
      maxAttempts: normalizedOptions.queueMaxAttempts ?? 3,
    });

    if (!statusTarget) {
      void normalizedOptions.onStatusTrace?.(
        `Status publish skipped (queued): missing repository/head_sha for delivery=${context.deliveryId ?? "none"}`
      );
      return;
    }

    void (async () => {
      const installationToken =
        context.installationId !== undefined
          ? (await statusPublisherTokenProvider?.getInstallationToken(context.installationId))?.token
          : undefined;

      await statusPublisher.publishQueued({
        job: {
          id: context.deliveryId ?? "queued",
          eventName: context.eventName,
          installationId: context.installationId,
          deliveryId: context.deliveryId,
          payload: context.payload,
          status: "queued",
          attempts: 0,
          maxAttempts: normalizedOptions.queueMaxAttempts ?? 3,
          nextRunAt: new Date().toISOString(),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        installationToken,
        target: statusTarget,
      });
    })().catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      void normalizedOptions.onStatusTrace?.(`Status publish failed (queued): ${message}`);
    });
  };

  const workerHandle = startJobWorker({
    queue,
    pollIntervalMs: normalizedOptions.queuePollIntervalMs ?? 2000,
    concurrency: normalizedOptions.jobWorkerConcurrency ?? 1,
    retryDelayMs: normalizedOptions.queueRetryDelayMs ?? 15000,
    processJob: async (job) => {
      if (normalizedOptions.runtimeCounters) {
        normalizedOptions.runtimeCounters.jobsDequeued += 1;
      }

      if (!remediationHandler) {
        if (normalizedOptions.runtimeCounters) {
          normalizedOptions.runtimeCounters.jobsSucceeded += 1;
          normalizedOptions.runtimeCounters.lastJobProcessedAt = new Date().toISOString();
        }
        return;
      }

      let installationToken: string | undefined;
      if (job.installationId !== undefined) {
        const token = await statusPublisherTokenProvider?.getInstallationToken(job.installationId);
        installationToken = token?.token;
      }

      const statusTarget = readRemediationStatusTarget(job.payload);
      if (!statusTarget) {
        void normalizedOptions.onStatusTrace?.(
          `Status publish skipped (running): missing repository/head_sha for job=${job.id}`
        );
      } else {
        await statusPublisher.publishRunning({
          job,
          installationToken,
          target: statusTarget,
        });
      }

      let remediationResult: RemediationJobResult | void;
      try {
        remediationResult = await remediationHandler({
          eventName: job.eventName,
          installationId: job.installationId,
          deliveryId: job.deliveryId,
          payload: job.payload,
          installationToken,
        });
      } catch (error) {
        if (statusTarget) {
          await statusPublisher.publishCompleted({
            job,
            installationToken,
            target: statusTarget,
            outcome: "failed",
            reason: error instanceof Error ? error.message : String(error),
          });
        }

        throw error;
      }

      if (statusTarget) {
        const outcome = remediationResult?.status ?? "success";
        await statusPublisher.publishCompleted({
          job,
          installationToken,
          target: statusTarget,
          outcome,
          reason: remediationResult?.reason,
        });
      }

      if (normalizedOptions.runtimeCounters) {
        normalizedOptions.runtimeCounters.jobsSucceeded += 1;
        normalizedOptions.runtimeCounters.lastJobProcessedAt = new Date().toISOString();
      }
    },
    onJobFailed: (job) => {
      if (!normalizedOptions.runtimeCounters) {
        return;
      }

      if (job.status === "queued") {
        normalizedOptions.runtimeCounters.jobsRetried += 1;
      }

      if (job.status === "failed") {
        normalizedOptions.runtimeCounters.jobsFailed += 1;

        const statusTarget = readRemediationStatusTarget(job.payload);
        if (statusTarget) {
          void (async () => {
            const installationToken =
              job.installationId !== undefined
                ? (await statusPublisherTokenProvider?.getInstallationToken(job.installationId))?.token
                : undefined;

            await statusPublisher.publishCompleted({
              job,
              installationToken,
              target: statusTarget,
              outcome: "failed",
              reason: job.lastError,
            });
          })();
        } else {
          void normalizedOptions.onStatusTrace?.(
            `Status publish skipped (completed): missing repository/head_sha for job=${job.id}`
          );
        }
      }

      normalizedOptions.runtimeCounters.lastJobProcessedAt = new Date().toISOString();
    },
  });

  const schedulerHandle = normalizedOptions.enableScheduler
    ? startWorkflowDispatchScheduler({
        queue,
        intervalMs: normalizedOptions.scheduleIntervalMs ?? 3_600_000,
        queueMaxAttempts: normalizedOptions.queueMaxAttempts ?? 3,
      })
    : undefined;

  const server = createServer(async (request, response) => {
    try {
      await handleRequest(request, response, normalizedOptions);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unexpected server error";
      writeJson(response, {
        statusCode: 500,
        body: { error: message },
      });
    }
  });

  server.on("close", () => {
    workerHandle.stop();
    schedulerHandle?.stop();
  });

  return server;
}
