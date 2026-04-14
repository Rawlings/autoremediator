import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createGitHubAppServer } from "./server.js";
import { computeWebhookSignature } from "./signature.js";
import { createFileAppStateStore, createInMemoryAppStateStore } from "./state.js";

const secret = "webhook-secret";
const serversToClose: Array<ReturnType<typeof createGitHubAppServer>> = [];

afterEach(async () => {
  await Promise.all(
    serversToClose.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        })
    )
  );
});

async function startServer() {
  const server = createGitHubAppServer({ webhookSecret: secret });
  serversToClose.push(server);

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, () => resolve());
  });

  const address = server.address() as AddressInfo;
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
}

describe("github app server", () => {
  it("returns health response", async () => {
    const { baseUrl } = await startServer();
    const response = await fetch(`${baseUrl}/health`);
    const payload = (await response.json()) as {
      status: string;
      uptimeSeconds: number;
      counters: {
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
      };
      latency: {
        averageMs: number;
        maxMs: number;
      };
      queue: {
        depth: number;
        queued: number;
        running: number;
        completed: number;
        failed: number;
      };
    };

    expect(response.status).toBe(200);
    expect(response.headers.get("x-request-id")).toBeTruthy();
    expect(payload.status).toBe("ok");
    expect(payload.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(payload.counters.totalRequests).toBe(0);
    expect(payload.counters.webhookRequests).toBe(0);
    expect(payload.counters.handled).toBe(0);
    expect(payload.counters.totalLatencyMs).toBe(0);
    expect(payload.counters.maxLatencyMs).toBe(0);
    expect(payload.counters.byEvent).toEqual({});
    expect(payload.counters.byStatusCode).toEqual({});
    expect(payload.counters.jobsDequeued).toBe(0);
    expect(payload.counters.jobsSucceeded).toBe(0);
    expect(payload.counters.jobsRetried).toBe(0);
    expect(payload.counters.jobsFailed).toBe(0);
    expect(payload.latency.averageMs).toBe(0);
    expect(payload.latency.maxMs).toBe(0);
    expect(payload.queue.depth).toBe(0);
    expect(payload.queue.queued).toBe(0);
    expect(payload.queue.running).toBe(0);
    expect(payload.queue.completed).toBe(0);
    expect(payload.queue.failed).toBe(0);
  });

  it("returns 405 for non-POST webhook routes", async () => {
    const { baseUrl } = await startServer();
    const response = await fetch(`${baseUrl}/webhook`, {
      method: "GET",
    });

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
  });

  it("rejects non-json content type by default", async () => {
    const { baseUrl } = await startServer();
    const payload = JSON.stringify({});
    const signature = computeWebhookSignature(secret, payload);

    const response = await fetch(`${baseUrl}/webhook`, {
      method: "POST",
      headers: {
        "content-type": "text/plain",
        "x-github-event": "ping",
        "x-hub-signature-256": signature,
      },
      body: payload,
    });

    const body = (await response.json()) as { error: string };
    expect(response.status).toBe(415);
    expect(body.error).toBe("Unsupported content type");
  });

  it("tracks runtime counters across processed and rejected requests", async () => {
    const { baseUrl } = await startServer();

    const badPayload = JSON.stringify({});
    await fetch(`${baseUrl}/webhook`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "ping",
        "x-hub-signature-256": "sha256=bad",
      },
      body: badPayload,
    });

    const goodPayload = JSON.stringify({ zen: "hi" });
    const signature = computeWebhookSignature(secret, goodPayload);
    await fetch(`${baseUrl}/webhook`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "ping",
        "x-github-delivery": "delivery-counter-1",
        "x-hub-signature-256": signature,
      },
      body: goodPayload,
    });

    const health = await fetch(`${baseUrl}/health`);
    const payload = (await health.json()) as {
      counters: {
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
      };
      latency: {
        averageMs: number;
        maxMs: number;
      };
    };

    expect(payload.counters.totalRequests).toBe(2);
    expect(payload.counters.webhookRequests).toBe(1);
    expect(payload.counters.handled).toBe(1);
    expect(payload.counters.rejected).toBe(1);
    expect(payload.counters.byEvent.ping).toBe(2);
    expect(payload.counters.byStatusCode["202"]).toBe(1);
    expect(payload.counters.byStatusCode["401"]).toBe(1);
    expect(payload.counters.totalLatencyMs).toBeGreaterThanOrEqual(0);
    expect(payload.counters.maxLatencyMs).toBeGreaterThanOrEqual(0);
    expect(payload.counters.lastProcessedAt).toBeTruthy();
    expect(payload.latency.averageMs).toBeGreaterThanOrEqual(0);
    expect(payload.latency.maxMs).toBe(payload.counters.maxLatencyMs);
    expect(payload.counters.jobsDequeued).toBe(0);
    expect(payload.counters.jobsSucceeded).toBe(0);
    expect(payload.counters.jobsRetried).toBe(0);
    expect(payload.counters.jobsFailed).toBe(0);
  });

  it("reports queue and worker metrics for remediation jobs", async () => {
    const stateStore = createInMemoryAppStateStore();
    stateStore.markInstallationActive(431);

    const server = createGitHubAppServer({
      webhookSecret: secret,
      stateStore,
      queuePollIntervalMs: 10,
      onRemediationRequested: async () => undefined,
    });
    serversToClose.push(server);

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, () => resolve());
    });

    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const payload = JSON.stringify({ action: "requested", installation: { id: 431 } });
    const signature = computeWebhookSignature(secret, payload);

    const webhookResponse = await fetch(`${baseUrl}/webhook`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "check_suite",
        "x-github-delivery": "delivery-queue-metrics-1",
        "x-hub-signature-256": signature,
      },
      body: payload,
    });
    expect(webhookResponse.status).toBe(202);

    await new Promise((resolve) => {
      setTimeout(resolve, 40);
    });

    const health = await fetch(`${baseUrl}/health`);
    const healthPayload = (await health.json()) as {
      counters: {
        jobsDequeued: number;
        jobsSucceeded: number;
        jobsRetried: number;
        jobsFailed: number;
      };
      queue: {
        depth: number;
        completed: number;
      };
    };

    expect(healthPayload.counters.jobsDequeued).toBeGreaterThanOrEqual(1);
    expect(healthPayload.counters.jobsSucceeded).toBeGreaterThanOrEqual(1);
    expect(healthPayload.counters.jobsRetried).toBe(0);
    expect(healthPayload.counters.jobsFailed).toBe(0);
    expect(healthPayload.queue.depth).toBeGreaterThanOrEqual(1);
    expect(healthPayload.queue.completed).toBeGreaterThanOrEqual(1);
  });

  it("tracks ignored and duplicate buckets in status counters", async () => {
    const stateStore = createInMemoryAppStateStore();
    const server = createGitHubAppServer({
      webhookSecret: secret,
      stateStore,
      allowedEvents: ["ping"],
    });
    serversToClose.push(server);

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, () => resolve());
    });

    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const ignoredPayload = JSON.stringify({ installation: { id: 1 } });
    const ignoredSig = computeWebhookSignature(secret, ignoredPayload);
    await fetch(`${baseUrl}/webhook`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "check_suite",
        "x-github-delivery": "delivery-ignored-bucket",
        "x-hub-signature-256": ignoredSig,
      },
      body: ignoredPayload,
    });

    const dupPayload = JSON.stringify({ action: "created", installation: { id: 2 } });
    const dupSig = computeWebhookSignature(secret, dupPayload);
    await fetch(`${baseUrl}/webhook`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "ping",
        "x-github-delivery": "delivery-dup-bucket",
        "x-hub-signature-256": dupSig,
      },
      body: dupPayload,
    });
    await fetch(`${baseUrl}/webhook`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "ping",
        "x-github-delivery": "delivery-dup-bucket",
        "x-hub-signature-256": dupSig,
      },
      body: dupPayload,
    });

    const health = await fetch(`${baseUrl}/health`);
    const payload = (await health.json()) as {
      counters: {
        ignored: number;
        duplicate: number;
      };
    };

    expect(payload.counters.ignored).toBeGreaterThanOrEqual(1);
    expect(payload.counters.duplicate).toBeGreaterThanOrEqual(1);
  });

  it("rejects webhook requests with invalid signature", async () => {
    const { baseUrl } = await startServer();
    const payload = JSON.stringify({});

    const response = await fetch(`${baseUrl}/webhook`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "ping",
        "x-hub-signature-256": "sha256=invalid",
      },
      body: payload,
    });

    expect(response.status).toBe(401);
  });

  it("rejects webhook requests without delivery id when strict mode enabled", async () => {
    const server = createGitHubAppServer({
      webhookSecret: secret,
      requireDeliveryId: true,
    });
    serversToClose.push(server);

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, () => resolve());
    });

    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const payload = JSON.stringify({ zen: "strict delivery id" });
    const signature = computeWebhookSignature(secret, payload);

    const response = await fetch(`${baseUrl}/webhook`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "ping",
        "x-hub-signature-256": signature,
      },
      body: payload,
    });

    const body = (await response.json()) as { error: string };
    expect(response.status).toBe(400);
    expect(body.error).toBe("Missing x-github-delivery header");
  });

  it("rejects webhook payloads that exceed configured body size limit", async () => {
    const server = createGitHubAppServer({
      webhookSecret: secret,
      maxWebhookBodyBytes: 16,
    });
    serversToClose.push(server);

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, () => resolve());
    });

    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const payload = JSON.stringify({ veryLarge: "abcdefghijklmnopqrstuvwxyz" });
    const signature = computeWebhookSignature(secret, payload);

    const response = await fetch(`${baseUrl}/webhook`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "ping",
        "x-hub-signature-256": signature,
      },
      body: payload,
    });

    const body = (await response.json()) as { error: string };
    expect(response.status).toBe(413);
    expect(body.error).toBe("Payload too large");
  });

  it("accepts valid webhook requests", async () => {
    const { baseUrl } = await startServer();
    const payload = JSON.stringify({ zen: "Keep it logically awesome." });
    const signature = computeWebhookSignature(secret, payload);

    const response = await fetch(`${baseUrl}/webhook`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "ping",
        "x-github-delivery": "delivery-1",
        "x-hub-signature-256": signature,
      },
      body: payload,
    });

    const body = (await response.json()) as { status: string; event: string };
    expect(response.status).toBe(202);
    expect(response.headers.get("x-request-id")).toBeTruthy();
    expect(body.status).toBe("handled");
    expect(body.event).toBe("ping");
  });

  it("uses provided x-request-id header", async () => {
    const { baseUrl } = await startServer();
    const payload = JSON.stringify({ zen: "request id" });
    const signature = computeWebhookSignature(secret, payload);

    const response = await fetch(`${baseUrl}/webhook`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-request-id": "req-12345",
        "x-github-event": "ping",
        "x-github-delivery": "delivery-request-id",
        "x-hub-signature-256": signature,
      },
      body: payload,
    });

    expect(response.status).toBe(202);
    expect(response.headers.get("x-request-id")).toBe("req-12345");
  });

  it("ignores events not in allowed list", async () => {
    const stateStore = createInMemoryAppStateStore();
    let callbackCount = 0;

    const server = createGitHubAppServer({
      webhookSecret: secret,
      stateStore,
      allowedEvents: ["ping"],
      onRemediationRequested: () => {
        callbackCount += 1;
      },
    });
    serversToClose.push(server);

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, () => resolve());
    });

    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const payload = JSON.stringify({ installation: { id: 321 } });
    const signature = computeWebhookSignature(secret, payload);

    const response = await fetch(`${baseUrl}/webhook`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "check_suite",
        "x-github-delivery": "delivery-disallowed-1",
        "x-hub-signature-256": signature,
      },
      body: payload,
    });

    const body = (await response.json()) as { status: string; reason: string };
    expect(response.status).toBe(202);
    expect(body.status).toBe("ignored");
    expect(body.reason).toContain("Event not allowed");
    expect(callbackCount).toBe(0);
  });

  it("returns duplicate for repeated delivery id", async () => {
    const { baseUrl } = await startServer();
    const payload = JSON.stringify({ action: "created", installation: { id: 7 } });
    const signature = computeWebhookSignature(secret, payload);

    const first = await fetch(`${baseUrl}/webhook`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "installation",
        "x-github-delivery": "delivery-dup-1",
        "x-hub-signature-256": signature,
      },
      body: payload,
    });

    const firstBody = (await first.json()) as { status: string };
    expect(first.status).toBe(202);
    expect(firstBody.status).toBe("handled");

    const duplicate = await fetch(`${baseUrl}/webhook`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "installation",
        "x-github-delivery": "delivery-dup-1",
        "x-hub-signature-256": signature,
      },
      body: payload,
    });

    const duplicateBody = (await duplicate.json()) as { status: string; reason?: string };
    expect(duplicate.status).toBe(202);
    expect(duplicateBody.status).toBe("duplicate");
    expect(duplicateBody.reason).toContain("already processed");
  });

  it("processes valid requests without delivery id", async () => {
    const { baseUrl } = await startServer();
    const payload = JSON.stringify({ zen: "No delivery id still valid" });
    const signature = computeWebhookSignature(secret, payload);

    const response = await fetch(`${baseUrl}/webhook`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "ping",
        "x-hub-signature-256": signature,
      },
      body: payload,
    });

    const body = (await response.json()) as { status: string; event: string };
    expect(response.status).toBe(202);
    expect(body.status).toBe("handled");
    expect(body.event).toBe("ping");
  });

  it("deduplicates across restart when using file-backed state", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "autoremediator-ghapp-"));
    const payload = JSON.stringify({ action: "created", installation: { id: 88 } });
    const signature = computeWebhookSignature(secret, payload);

    const serverA = createGitHubAppServer({
      webhookSecret: secret,
      stateStore: createFileAppStateStore(dataDir),
    });
    serversToClose.push(serverA);

    await new Promise<void>((resolve, reject) => {
      serverA.once("error", reject);
      serverA.listen(0, () => resolve());
    });

    const addressA = serverA.address() as AddressInfo;
    const urlA = `http://127.0.0.1:${addressA.port}`;

    const first = await fetch(`${urlA}/webhook`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "installation",
        "x-github-delivery": "delivery-restart-1",
        "x-hub-signature-256": signature,
      },
      body: payload,
    });

    expect(first.status).toBe(202);

    await new Promise<void>((resolve) => {
      serverA.close(() => resolve());
    });

    const serverB = createGitHubAppServer({
      webhookSecret: secret,
      stateStore: createFileAppStateStore(dataDir),
    });
    serversToClose.push(serverB);

    await new Promise<void>((resolve, reject) => {
      serverB.once("error", reject);
      serverB.listen(0, () => resolve());
    });

    const addressB = serverB.address() as AddressInfo;
    const urlB = `http://127.0.0.1:${addressB.port}`;

    const second = await fetch(`${urlB}/webhook`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "installation",
        "x-github-delivery": "delivery-restart-1",
        "x-hub-signature-256": signature,
      },
      body: payload,
    });

    const secondBody = (await second.json()) as { status: string };
    expect(second.status).toBe(202);
    expect(secondBody.status).toBe("duplicate");

    await rm(dataDir, { recursive: true, force: true });
  });

  it("passes check_suite events to remediation callback", async () => {
    const stateStore = createInMemoryAppStateStore();
    stateStore.markInstallationActive(321);
    const calls: Array<{ eventName: string; installationId?: number; deliveryId?: string }> = [];

    const server = createGitHubAppServer({
      webhookSecret: secret,
      stateStore,
      queuePollIntervalMs: 10,
      onRemediationRequested: (context) => {
        calls.push({
          eventName: context.eventName,
          installationId: context.installationId,
          deliveryId: context.deliveryId,
        });
      },
    });
    serversToClose.push(server);

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, () => resolve());
    });

    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const payload = JSON.stringify({ action: "requested", installation: { id: 321 } });
    const signature = computeWebhookSignature(secret, payload);

    const response = await fetch(`${baseUrl}/webhook`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "check_suite",
        "x-github-delivery": "delivery-callback-1",
        "x-hub-signature-256": signature,
      },
      body: payload,
    });

    expect(response.status).toBe(202);
    await new Promise((resolve) => {
      setTimeout(resolve, 30);
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.eventName).toBe("check_suite");
    expect(calls[0]?.installationId).toBe(321);
    expect(calls[0]?.deliveryId).toBe("delivery-callback-1");
  });

  it("still acknowledges webhook when remediation callback throws", async () => {
    const stateStore = createInMemoryAppStateStore();
    stateStore.markInstallationActive(555);

    const server = createGitHubAppServer({
      webhookSecret: secret,
      stateStore,
      queuePollIntervalMs: 10,
      onRemediationRequested: () => {
        throw new Error("trigger failed");
      },
    });
    serversToClose.push(server);

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, () => resolve());
    });

    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const payload = JSON.stringify({ installation: { id: 555 } });
    const signature = computeWebhookSignature(secret, payload);

    const response = await fetch(`${baseUrl}/webhook`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "workflow_dispatch",
        "x-github-delivery": "delivery-callback-throw",
        "x-hub-signature-256": signature,
      },
      body: payload,
    });

    const body = (await response.json()) as { status: string; reason?: string };
    expect(response.status).toBe(202);
    expect(body.status).toBe("handled");
    expect(body.reason).toBeUndefined();
  });

  it("still acknowledges webhook when remediation callback times out", async () => {
    const stateStore = createInMemoryAppStateStore();
    stateStore.markInstallationActive(556);

    const server = createGitHubAppServer({
      webhookSecret: secret,
      stateStore,
      queuePollIntervalMs: 10,
      remediationTriggerTimeoutMs: 5,
      onRemediationRequested: async () => {
        await new Promise((resolve) => {
          setTimeout(resolve, 30);
        });
      },
    });
    serversToClose.push(server);

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, () => resolve());
    });

    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const payload = JSON.stringify({ installation: { id: 556 } });
    const signature = computeWebhookSignature(secret, payload);

    const response = await fetch(`${baseUrl}/webhook`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "workflow_dispatch",
        "x-github-delivery": "delivery-callback-timeout",
        "x-hub-signature-256": signature,
      },
      body: payload,
    });

    const body = (await response.json()) as { status: string; reason?: string };
    expect(response.status).toBe(202);
    expect(body.status).toBe("handled");
    expect(body.reason).toBeUndefined();
  });

  it("emits processing trace for handled events", async () => {
    const traces: Array<{ eventName: string; status: string; installationId?: number }> = [];

    const server = createGitHubAppServer({
      webhookSecret: secret,
      onEventProcessed: (trace) => {
        traces.push({
          eventName: trace.eventName,
          status: trace.status,
          installationId: trace.installationId,
        });
      },
    });
    serversToClose.push(server);

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, () => resolve());
    });

    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const payload = JSON.stringify({ action: "created", installation: { id: 111 } });
    const signature = computeWebhookSignature(secret, payload);

    const response = await fetch(`${baseUrl}/webhook`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "installation",
        "x-github-delivery": "delivery-trace-1",
        "x-hub-signature-256": signature,
      },
      body: payload,
    });

    expect(response.status).toBe(202);
    expect(traces).toHaveLength(1);
    expect(traces[0]?.eventName).toBe("installation");
    expect(traces[0]?.status).toBe("handled");
    expect(traces[0]?.installationId).toBe(111);
  });

  it("emits processing trace for duplicate events", async () => {
    const traces: Array<{ eventName: string; status: string; reason?: string }> = [];

    const server = createGitHubAppServer({
      webhookSecret: secret,
      onEventProcessed: (trace) => {
        traces.push({
          eventName: trace.eventName,
          status: trace.status,
          reason: trace.reason,
        });
      },
    });
    serversToClose.push(server);

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, () => resolve());
    });

    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const payload = JSON.stringify({ action: "created", installation: { id: 222 } });
    const signature = computeWebhookSignature(secret, payload);

    await fetch(`${baseUrl}/webhook`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "installation",
        "x-github-delivery": "delivery-trace-dup",
        "x-hub-signature-256": signature,
      },
      body: payload,
    });

    await fetch(`${baseUrl}/webhook`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "installation",
        "x-github-delivery": "delivery-trace-dup",
        "x-hub-signature-256": signature,
      },
      body: payload,
    });

    expect(traces).toHaveLength(2);
    expect(traces[0]?.status).toBe("handled");
    expect(traces[1]?.status).toBe("duplicate");
    expect(traces[1]?.reason).toContain("already processed");
  });

  it("emits rejected trace for invalid signature", async () => {
    const traces: Array<{ eventName: string; status: string; reason?: string }> = [];

    const server = createGitHubAppServer({
      webhookSecret: secret,
      onEventProcessed: (trace) => {
        traces.push({
          eventName: trace.eventName,
          status: trace.status,
          reason: trace.reason,
        });
      },
    });
    serversToClose.push(server);

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, () => resolve());
    });

    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    await fetch(`${baseUrl}/webhook`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "ping",
        "x-hub-signature-256": "sha256=bad",
      },
      body: JSON.stringify({}),
    });

    expect(traces).toHaveLength(1);
    expect(traces[0]?.status).toBe("rejected");
    expect(traces[0]?.reason).toBe("Invalid webhook signature");
  });
});
