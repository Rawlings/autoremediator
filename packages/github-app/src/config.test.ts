import { describe, expect, it } from "vitest";
import { loadGitHubAppConfig } from "./config.js";

describe("loadGitHubAppConfig", () => {
  it("loads config from environment values", () => {
    const config = loadGitHubAppConfig({
      AUTOREMEDIATOR_GITHUB_APP_ID: "12345",
      AUTOREMEDIATOR_GITHUB_APP_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----",
      AUTOREMEDIATOR_GITHUB_APP_WEBHOOK_SECRET: "secret",
      AUTOREMEDIATOR_GITHUB_APP_PORT: "4010",
      AUTOREMEDIATOR_GITHUB_APP_DATA_DIR: ".autoremediator/github-app",
      AUTOREMEDIATOR_GITHUB_APP_TRIGGER_TIMEOUT_MS: "2500",
      AUTOREMEDIATOR_GITHUB_APP_ENABLE_DEFAULT_REMEDIATION: "true",
      AUTOREMEDIATOR_GITHUB_APP_LOG_EVENT_TRACES: "true",
      AUTOREMEDIATOR_GITHUB_APP_MAX_WEBHOOK_BODY_BYTES: "4096",
      AUTOREMEDIATOR_GITHUB_APP_REQUIRE_JSON_CONTENT_TYPE: "false",
      AUTOREMEDIATOR_GITHUB_APP_ALLOWED_EVENTS: "ping,check_suite, workflow_dispatch",
      AUTOREMEDIATOR_GITHUB_APP_REQUIRE_DELIVERY_ID: "true",
      AUTOREMEDIATOR_GITHUB_APP_ENABLE_JOB_QUEUE: "true",
      AUTOREMEDIATOR_GITHUB_APP_QUEUE_POLL_INTERVAL_MS: "3000",
      AUTOREMEDIATOR_GITHUB_APP_QUEUE_RETRY_DELAY_MS: "20000",
      AUTOREMEDIATOR_GITHUB_APP_QUEUE_MAX_ATTEMPTS: "4",
      AUTOREMEDIATOR_GITHUB_APP_WORKER_CONCURRENCY: "2",
      AUTOREMEDIATOR_GITHUB_APP_ENABLE_SCHEDULER: "true",
      AUTOREMEDIATOR_GITHUB_APP_SCHEDULE_INTERVAL_MS: "60000",
      AUTOREMEDIATOR_GITHUB_APP_ENABLE_STATUS_PUBLISHING: "true",
      AUTOREMEDIATOR_GITHUB_APP_STATUS_CHECK_NAME: "autoremediator/check",
    });

    expect(config.appId).toBe("12345");
    expect(config.port).toBe(4010);
    expect(config.dataDir).toBe(".autoremediator/github-app");
    expect(config.remediationTriggerTimeoutMs).toBe(2500);
    expect(config.enableDefaultRemediationHandler).toBe(true);
    expect(config.logEventTraces).toBe(true);
    expect(config.maxWebhookBodyBytes).toBe(4096);
    expect(config.requireJsonContentType).toBe(false);
    expect(config.allowedEvents).toEqual(["ping", "check_suite", "workflow_dispatch"]);
    expect(config.requireDeliveryId).toBe(true);
    expect(config.enableJobQueue).toBe(true);
    expect(config.queuePollIntervalMs).toBe(3000);
    expect(config.queueRetryDelayMs).toBe(20000);
    expect(config.queueMaxAttempts).toBe(4);
    expect(config.jobWorkerConcurrency).toBe(2);
    expect(config.enableScheduler).toBe(true);
    expect(config.scheduleIntervalMs).toBe(60000);
    expect(config.enableStatusPublishing).toBe(true);
    expect(config.statusCheckName).toBe("autoremediator/check");
  });

  it("uses defaults for optional hardening options", () => {
    const config = loadGitHubAppConfig({
      AUTOREMEDIATOR_GITHUB_APP_ID: "12345",
      AUTOREMEDIATOR_GITHUB_APP_PRIVATE_KEY: "key",
      AUTOREMEDIATOR_GITHUB_APP_WEBHOOK_SECRET: "secret",
    });

    expect(config.maxWebhookBodyBytes).toBe(262144);
    expect(config.requireJsonContentType).toBe(true);
    expect(config.enableJobQueue).toBe(true);
    expect(config.queuePollIntervalMs).toBe(2000);
    expect(config.queueRetryDelayMs).toBe(15000);
    expect(config.queueMaxAttempts).toBe(3);
    expect(config.jobWorkerConcurrency).toBe(1);
    expect(config.enableScheduler).toBe(false);
    expect(config.scheduleIntervalMs).toBe(3_600_000);
    expect(config.enableStatusPublishing).toBe(false);
    expect(config.statusCheckName).toBeUndefined();
  });

  it("fails when required values are missing", () => {
    expect(() => loadGitHubAppConfig({})).toThrow("AUTOREMEDIATOR_GITHUB_APP_ID");
  });

  it("fails when port is invalid", () => {
    expect(() =>
      loadGitHubAppConfig({
        AUTOREMEDIATOR_GITHUB_APP_ID: "12345",
        AUTOREMEDIATOR_GITHUB_APP_PRIVATE_KEY: "key",
        AUTOREMEDIATOR_GITHUB_APP_WEBHOOK_SECRET: "secret",
        AUTOREMEDIATOR_GITHUB_APP_PORT: "abc",
      })
    ).toThrow("Invalid AUTOREMEDIATOR_GITHUB_APP_PORT");
  });

  it("fails when remediation trigger timeout is invalid", () => {
    expect(() =>
      loadGitHubAppConfig({
        AUTOREMEDIATOR_GITHUB_APP_ID: "12345",
        AUTOREMEDIATOR_GITHUB_APP_PRIVATE_KEY: "key",
        AUTOREMEDIATOR_GITHUB_APP_WEBHOOK_SECRET: "secret",
        AUTOREMEDIATOR_GITHUB_APP_TRIGGER_TIMEOUT_MS: "0",
      })
    ).toThrow("Invalid AUTOREMEDIATOR_GITHUB_APP_TRIGGER_TIMEOUT_MS");
  });

  it("fails when max webhook body bytes is invalid", () => {
    expect(() =>
      loadGitHubAppConfig({
        AUTOREMEDIATOR_GITHUB_APP_ID: "12345",
        AUTOREMEDIATOR_GITHUB_APP_PRIVATE_KEY: "key",
        AUTOREMEDIATOR_GITHUB_APP_WEBHOOK_SECRET: "secret",
        AUTOREMEDIATOR_GITHUB_APP_MAX_WEBHOOK_BODY_BYTES: "0",
      })
    ).toThrow("Invalid AUTOREMEDIATOR_GITHUB_APP_MAX_WEBHOOK_BODY_BYTES");
  });

  it("fails when boolean env values are invalid", () => {
    expect(() =>
      loadGitHubAppConfig({
        AUTOREMEDIATOR_GITHUB_APP_ID: "12345",
        AUTOREMEDIATOR_GITHUB_APP_PRIVATE_KEY: "key",
        AUTOREMEDIATOR_GITHUB_APP_WEBHOOK_SECRET: "secret",
        AUTOREMEDIATOR_GITHUB_APP_ENABLE_DEFAULT_REMEDIATION: "yes",
      })
    ).toThrow("Invalid AUTOREMEDIATOR_GITHUB_APP_ENABLE_DEFAULT_REMEDIATION");
  });

  it("fails when require-json-content-type flag is invalid", () => {
    expect(() =>
      loadGitHubAppConfig({
        AUTOREMEDIATOR_GITHUB_APP_ID: "12345",
        AUTOREMEDIATOR_GITHUB_APP_PRIVATE_KEY: "key",
        AUTOREMEDIATOR_GITHUB_APP_WEBHOOK_SECRET: "secret",
        AUTOREMEDIATOR_GITHUB_APP_REQUIRE_JSON_CONTENT_TYPE: "sometimes",
      })
    ).toThrow("Invalid AUTOREMEDIATOR_GITHUB_APP_REQUIRE_JSON_CONTENT_TYPE");
  });

  it("fails when allowed events list is empty", () => {
    expect(() =>
      loadGitHubAppConfig({
        AUTOREMEDIATOR_GITHUB_APP_ID: "12345",
        AUTOREMEDIATOR_GITHUB_APP_PRIVATE_KEY: "key",
        AUTOREMEDIATOR_GITHUB_APP_WEBHOOK_SECRET: "secret",
        AUTOREMEDIATOR_GITHUB_APP_ALLOWED_EVENTS: " , ",
      })
    ).toThrow("Invalid AUTOREMEDIATOR_GITHUB_APP_ALLOWED_EVENTS");
  });

  it("fails when require-delivery-id flag is invalid", () => {
    expect(() =>
      loadGitHubAppConfig({
        AUTOREMEDIATOR_GITHUB_APP_ID: "12345",
        AUTOREMEDIATOR_GITHUB_APP_PRIVATE_KEY: "key",
        AUTOREMEDIATOR_GITHUB_APP_WEBHOOK_SECRET: "secret",
        AUTOREMEDIATOR_GITHUB_APP_REQUIRE_DELIVERY_ID: "required",
      })
    ).toThrow("Invalid AUTOREMEDIATOR_GITHUB_APP_REQUIRE_DELIVERY_ID");
  });

  it("fails when queue poll interval is invalid", () => {
    expect(() =>
      loadGitHubAppConfig({
        AUTOREMEDIATOR_GITHUB_APP_ID: "12345",
        AUTOREMEDIATOR_GITHUB_APP_PRIVATE_KEY: "key",
        AUTOREMEDIATOR_GITHUB_APP_WEBHOOK_SECRET: "secret",
        AUTOREMEDIATOR_GITHUB_APP_QUEUE_POLL_INTERVAL_MS: "0",
      })
    ).toThrow("Invalid AUTOREMEDIATOR_GITHUB_APP_QUEUE_POLL_INTERVAL_MS");
  });

  it("fails when queue max attempts is invalid", () => {
    expect(() =>
      loadGitHubAppConfig({
        AUTOREMEDIATOR_GITHUB_APP_ID: "12345",
        AUTOREMEDIATOR_GITHUB_APP_PRIVATE_KEY: "key",
        AUTOREMEDIATOR_GITHUB_APP_WEBHOOK_SECRET: "secret",
        AUTOREMEDIATOR_GITHUB_APP_QUEUE_MAX_ATTEMPTS: "-1",
      })
    ).toThrow("Invalid AUTOREMEDIATOR_GITHUB_APP_QUEUE_MAX_ATTEMPTS");
  });

  it("fails when scheduler interval is invalid", () => {
    expect(() =>
      loadGitHubAppConfig({
        AUTOREMEDIATOR_GITHUB_APP_ID: "12345",
        AUTOREMEDIATOR_GITHUB_APP_PRIVATE_KEY: "key",
        AUTOREMEDIATOR_GITHUB_APP_WEBHOOK_SECRET: "secret",
        AUTOREMEDIATOR_GITHUB_APP_SCHEDULE_INTERVAL_MS: "abc",
      })
    ).toThrow("Invalid AUTOREMEDIATOR_GITHUB_APP_SCHEDULE_INTERVAL_MS");
  });
});

