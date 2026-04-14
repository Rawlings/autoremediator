import { describe, expect, it } from "vitest";
import { dispatchGitHubEvent } from "./events.js";
import { createInMemoryAppStateStore } from "./state.js";

describe("dispatchGitHubEvent", () => {
  it("handles supported installation actions", async () => {
    const stateStore = createInMemoryAppStateStore();
    const result = await dispatchGitHubEvent(
      { eventName: "installation", deliveryId: "delivery-1" },
      { action: "created", installation: { id: 42 } },
      { stateStore }
    );

    expect(result.status).toBe("handled");
  });

  it("ignores unsupported installation actions", async () => {
    const result = await dispatchGitHubEvent(
      { eventName: "installation", deliveryId: "delivery-2" },
      { action: "renamed", installation: { id: 42 } }
    );

    expect(result.status).toBe("ignored");
    expect(result.reason).toContain("Unsupported installation action");
  });

  it("handles supported installation_repositories actions", async () => {
    const stateStore = createInMemoryAppStateStore();
    await dispatchGitHubEvent(
      { eventName: "installation", deliveryId: "delivery-prime" },
      { action: "created", installation: { id: 42 } },
      { stateStore }
    );

    const result = await dispatchGitHubEvent(
      { eventName: "installation_repositories", deliveryId: "delivery-3" },
      { action: "added", installation: { id: 42 } },
      { stateStore }
    );

    expect(result.status).toBe("handled");
  });

  it("ignores unsupported installation_repositories actions", async () => {
    const result = await dispatchGitHubEvent(
      { eventName: "installation_repositories", deliveryId: "delivery-4" },
      { action: "migrated", installation: { id: 42 } }
    );

    expect(result.status).toBe("ignored");
    expect(result.reason).toContain("Unsupported installation_repositories action");
  });

  it("ignores check_suite when installation is inactive", async () => {
    const stateStore = createInMemoryAppStateStore();
    await dispatchGitHubEvent(
      { eventName: "installation", deliveryId: "delivery-install" },
      { action: "deleted", installation: { id: 99 } },
      { stateStore }
    );

    const result = await dispatchGitHubEvent(
      { eventName: "check_suite", deliveryId: "delivery-check" },
      { action: "requested", installation: { id: 99 } },
      { stateStore }
    );

    expect(result.status).toBe("ignored");
    expect(result.reason).toContain("not active");
  });

  it("ignores check_suite.completed action", async () => {
    const result = await dispatchGitHubEvent(
      { eventName: "check_suite", deliveryId: "delivery-completed" },
      { action: "completed" }
    );

    expect(result.status).toBe("ignored");
    expect(result.reason).toContain("check_suite action not triggerable");
  });

  it("fires remediation callback for active check_suite.requested", async () => {
    const stateStore = createInMemoryAppStateStore();
    await dispatchGitHubEvent(
      { eventName: "installation", deliveryId: "delivery-activate" },
      { action: "created", installation: { id: 7 } },
      { stateStore }
    );

    const calls: Array<{ eventName: string; installationId?: number; deliveryId?: string }> = [];

    const result = await dispatchGitHubEvent(
      { eventName: "check_suite", deliveryId: "delivery-trigger" },
      { action: "requested", installation: { id: 7 } },
      {
        stateStore,
        onRemediationRequested: (context) => {
          calls.push({
            eventName: context.eventName,
            installationId: context.installationId,
            deliveryId: context.deliveryId,
          });
        },
      }
    );

    expect(result.status).toBe("handled");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.eventName).toBe("check_suite");
    expect(calls[0]?.installationId).toBe(7);
    expect(calls[0]?.deliveryId).toBe("delivery-trigger");
  });

  it("fires remediation callback for push to default branch", async () => {
    const stateStore = createInMemoryAppStateStore();
    await dispatchGitHubEvent(
      { eventName: "installation", deliveryId: "delivery-push-install" },
      { action: "created", installation: { id: 20 } },
      { stateStore }
    );

    const calls: string[] = [];

    const result = await dispatchGitHubEvent(
      { eventName: "push", deliveryId: "delivery-push" },
      {
        ref: "refs/heads/main",
        installation: { id: 20 },
        repository: { default_branch: "main" },
      },
      {
        stateStore,
        onRemediationRequested: (context) => {
          calls.push(context.eventName);
        },
      }
    );

    expect(result.status).toBe("handled");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe("push");
  });

  it("ignores push to non-default branch", async () => {
    const result = await dispatchGitHubEvent(
      { eventName: "push", deliveryId: "delivery-push-feature" },
      {
        ref: "refs/heads/feature/my-branch",
        repository: { default_branch: "main" },
      }
    );

    expect(result.status).toBe("ignored");
    expect(result.reason).toContain("non-default branch");
  });

  it("handles installation.new_permissions_accepted", async () => {
    const stateStore = createInMemoryAppStateStore();
    const result = await dispatchGitHubEvent(
      { eventName: "installation", deliveryId: "delivery-perms" },
      { action: "new_permissions_accepted", installation: { id: 55 } },
      { stateStore }
    );

    expect(result.status).toBe("handled");
    expect(stateStore.isInstallationActive(55)).toBe(true);
  });

  it("does not fail event dispatch when remediation callback throws", async () => {
    const stateStore = createInMemoryAppStateStore();
    await dispatchGitHubEvent(
      { eventName: "installation", deliveryId: "delivery-activate-2" },
      { action: "created", installation: { id: 8 } },
      { stateStore }
    );

    const result = await dispatchGitHubEvent(
      { eventName: "workflow_dispatch", deliveryId: "delivery-throw" },
      { installation: { id: 8 } },
      {
        stateStore,
        onRemediationRequested: () => {
          throw new Error("boom");
        },
      }
    );

    expect(result.status).toBe("handled");
    expect(result.reason).toContain("Remediation trigger failed");
  });

  it("handles remediation callback timeout", async () => {
    const stateStore = createInMemoryAppStateStore();
    await dispatchGitHubEvent(
      { eventName: "installation", deliveryId: "delivery-activate-3" },
      { action: "created", installation: { id: 9 } },
      { stateStore }
    );

    const result = await dispatchGitHubEvent(
      { eventName: "workflow_dispatch", deliveryId: "delivery-timeout" },
      { installation: { id: 9 } },
      {
        stateStore,
        remediationTriggerTimeoutMs: 5,
        onRemediationRequested: async () => {
          await new Promise((resolve) => {
            setTimeout(resolve, 25);
          });
        },
      }
    );

    expect(result.status).toBe("handled");
    expect(result.reason).toContain("Timed out");
  });

  it("ignores unknown event types", async () => {
    const result = await dispatchGitHubEvent(
      { eventName: "issues", deliveryId: "delivery-5" },
      { action: "opened" }
    );

    expect(result.status).toBe("ignored");
    expect(result.reason).toContain("Unhandled event type");
  });
});
