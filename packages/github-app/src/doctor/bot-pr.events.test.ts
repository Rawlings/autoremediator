import { describe, expect, it, vi } from "vitest";

import { dispatchGitHubEvent } from "../events.js";

const failure = (pullRequests: unknown[]) => ({
  action: "completed",
  installation: { id: 1 },
  check_run: { conclusion: "failure", pull_requests: pullRequests },
});

const pr = (ref: string, headRepoId = 1) => ({
  number: 3,
  head: { ref, repo: { id: headRepoId } },
  base: { repo: { id: 1 } },
});

describe("check_run dispatch for bot pull requests", () => {
  it.each(["dependabot/npm_and_yarn/chalk-5.0.0", "renovate/chalk-5.x"])(
    "hands %s to the handler",
    async (ref) => {
      const onRemediationRequested = vi.fn();
      const result = await dispatchGitHubEvent(
        { eventName: "check_run", deliveryId: "d" },
        failure([pr(ref)]),
        { onRemediationRequested },
      );
      expect(result.status).toBe("handled");
      expect(onRemediationRequested).toHaveBeenCalledWith(
        expect.objectContaining({ eventName: "check_run" }),
      );
    },
  );

  it("drops a bot branch that lives in a fork", async () => {
    const onRemediationRequested = vi.fn();
    const result = await dispatchGitHubEvent(
      { eventName: "check_run" },
      failure([pr("dependabot/x", 99)]),
      { onRemediationRequested },
    );
    expect(result.status).toBe("ignored");
    expect(result.reason).toContain("fork");
    expect(onRemediationRequested).not.toHaveBeenCalled();
  });

  it("still ignores ordinary branches, with the original reason", async () => {
    const onRemediationRequested = vi.fn();
    const result = await dispatchGitHubEvent(
      { eventName: "check_run" },
      failure([pr("feature/dependabot-notes")]),
      { onRemediationRequested },
    );
    expect(result).toEqual({
      status: "ignored",
      reason: "check_run failure not on an autoremediator pull request branch",
    });
    expect(onRemediationRequested).not.toHaveBeenCalled();
  });

  it("still passes autoremediator branches, including those without repository details", async () => {
    const onRemediationRequested = vi.fn();
    const result = await dispatchGitHubEvent(
      { eventName: "check_run" },
      failure([{ number: 4, head: { ref: "autoremediator/cve-2026-1" } }]),
      { onRemediationRequested },
    );
    expect(result.status).toBe("handled");
    expect(onRemediationRequested).toHaveBeenCalledTimes(1);
  });

  it("ignores checks that did not fail, and incomplete ones, for bot branches too", async () => {
    const onRemediationRequested = vi.fn();
    const base = failure([pr("dependabot/x")]);
    for (const payload of [
      { ...base, check_run: { ...base.check_run, conclusion: "success" } },
      { ...base, action: "created" },
    ]) {
      expect(
        (await dispatchGitHubEvent({ eventName: "check_run" }, payload, { onRemediationRequested }))
          .status,
      ).toBe("ignored");
    }
    expect(onRemediationRequested).not.toHaveBeenCalled();
  });
});
