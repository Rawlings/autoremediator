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

interface ServerOptions {
  webhookSecret: string;
  maxTrackedDeliveries?: number;
  stateStore?: AppStateStore;
  onRemediationRequested?: (context: RemediationTriggerContext) => Promise<void> | void;
  remediationTriggerTimeoutMs?: number;
  enableDefaultRemediationHandler?: boolean;
  remediationCwd?: string;
  remediationDryRun?: boolean;
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
  const deliveryId = Array.isArray(deliveryHeader) ? deliveryHeader[0] : deliveryHeader;

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
  const defaultRemediationHandler = options.enableDefaultRemediationHandler
    ? createDefaultRemediationHandler({
        cwd: options.remediationCwd,
        dryRun: options.remediationDryRun,
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

  const installationTokenProvider =
    normalizedOptions.appId && normalizedOptions.privateKey
      ? createInstallationTokenProvider({
          appId: normalizedOptions.appId,
          privateKey: normalizedOptions.privateKey,
        })
      : undefined;

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
    queue.enqueue({
      eventName: context.eventName,
      installationId: context.installationId,
      deliveryId: context.deliveryId,
      payload: context.payload,
      dedupeKey: context.deliveryId,
      maxAttempts: normalizedOptions.queueMaxAttempts ?? 3,
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
        const token = await installationTokenProvider?.getInstallationToken(job.installationId);
        installationToken = token?.token;
      }

      await remediationHandler({
        eventName: job.eventName,
        installationId: job.installationId,
        deliveryId: job.deliveryId,
        payload: job.payload,
        installationToken,
      });

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
