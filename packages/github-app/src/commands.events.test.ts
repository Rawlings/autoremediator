import { describe, expect, it, vi } from "vitest";

import { dispatchGitHubEvent } from "./events.js";
import { buildAppManifest } from "./setup.js";

const comment = (body: string, user: Record<string, unknown> = { login: "alice", type: "User" }) => ({
  action: "created",
  installation: { id: 1 },
  comment: { body, user },
  issue: { number: 7 },
  repository: { name: "r", owner: { login: "o" } },
});

describe("issue_comment dispatch", () => {
  it("triggers on a command from a person", async () => {
    const onRemediationRequested = vi.fn();
    const result = await dispatchGitHubEvent(
      { eventName: "issue_comment", deliveryId: "d" },
      comment("/autoremediator plan CVE-2021-23337"),
      { onRemediationRequested },
    );
    expect(result.status).toBe("handled");
    expect(onRemediationRequested).toHaveBeenCalledWith(expect.objectContaining({ eventName: "issue_comment" }));
  });

  it("never reacts to a bot, so the app cannot answer itself in a loop", async () => {
    const onRemediationRequested = vi.fn();
    for (const user of [{ login: "autoremediator[bot]", type: "Bot" }, { login: "x[bot]", type: "User" }]) {
      const result = await dispatchGitHubEvent(
        { eventName: "issue_comment" },
        comment("/autoremediator fix CVE-2021-23337", user),
        { onRemediationRequested },
      );
      expect(result.status).toBe("ignored");
    }
    expect(onRemediationRequested).not.toHaveBeenCalled();
  });

  it("ignores comments without a command, and edits and deletions", async () => {
    const onRemediationRequested = vi.fn();
    expect((await dispatchGitHubEvent({ eventName: "issue_comment" }, comment("looks good"), { onRemediationRequested })).status).toBe("ignored");
    expect(
      (await dispatchGitHubEvent({ eventName: "issue_comment" }, { ...comment("/autoremediator help"), action: "edited" }, { onRemediationRequested })).status,
    ).toBe("ignored");
    expect(onRemediationRequested).not.toHaveBeenCalled();
  });
});

describe("alert dispatch", () => {
  it("triggers on a new Dependabot alert that names an advisory", async () => {
    const onRemediationRequested = vi.fn();
    const result = await dispatchGitHubEvent(
      { eventName: "dependabot_alert" },
      { action: "created", installation: { id: 1 }, alert: { security_advisory: { cve_id: "CVE-2021-23337" } } },
      { onRemediationRequested },
    );
    expect(result.status).toBe("handled");
    expect(onRemediationRequested).toHaveBeenCalledWith(expect.objectContaining({ eventName: "dependabot_alert" }));
  });

  it("ignores dismissed or fixed alerts and alerts without an advisory", async () => {
    const onRemediationRequested = vi.fn();
    const advisory = { security_advisory: { cve_id: "CVE-2021-23337" } };
    expect((await dispatchGitHubEvent({ eventName: "dependabot_alert" }, { action: "dismissed", alert: advisory }, { onRemediationRequested })).status).toBe("ignored");
    expect((await dispatchGitHubEvent({ eventName: "code_scanning_alert" }, { action: "created", alert: { rule: { id: "js/xss" } } }, { onRemediationRequested })).status).toBe("ignored");
    expect(onRemediationRequested).not.toHaveBeenCalled();
  });
});

describe("app manifest", () => {
  it("subscribes to every event the dispatcher handles, with the permissions they need", () => {
    const manifest = buildAppManifest("https://app.example.com") as {
      default_events: string[];
      default_permissions: Record<string, string>;
    };
    for (const event of ["check_run", "check_suite", "issue_comment", "dependabot_alert", "code_scanning_alert"]) {
      expect(manifest.default_events).toContain(event);
    }
    expect(manifest.default_permissions).toMatchObject({
      issues: "write",
      vulnerability_alerts: "read",
      security_events: "read",
      checks: "write",
    });
  });
});
