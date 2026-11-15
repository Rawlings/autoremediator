import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RepairStrategy } from "../healing/repair-strategy.js";
import { createDefaultRemediationHandler } from "../remediation-handler.js";
import { createInMemoryAppStateStore } from "../state.js";
import { DEFAULT_REPO_CONFIG, type AutoremediatorRepoConfig } from "../types.js";

vi.mock("autoremediator", () => ({ remediateFromScan: vi.fn() }));

const BROKEN = `import chalk from "chalk";\nconsole.log(chalk.red("x"));\n`;
const TS_ERROR = "src/app.ts:1:8 - error TS2614: Module 'chalk' has no default export.\n";

interface Setup {
  pr?: Record<string, unknown>;
  files?: Record<string, string>;
  /** Files the pull request itself changes (default: the one file the CI error names). */
  prFiles?: string[];
  getContentError?: Error;
}

function pullRequest(overrides: Record<string, unknown> = {}) {
  return {
    state: "open",
    user: { login: "dependabot[bot]" },
    head: {
      ref: "dependabot/npm_and_yarn/chalk-5.0.0",
      sha: "sha-1",
      repo: { id: 1, full_name: "o/r" },
    },
    base: { repo: { id: 1, full_name: "o/r" } },
    ...overrides,
  };
}

function makeOctokit(setup: Setup = {}) {
  const files = setup.files ?? { "src/app.ts": BROKEN };
  return {
    pulls: {
      get: vi.fn(async () => ({ data: setup.pr ?? pullRequest() })),
      listFiles: vi.fn(async ({ page }: { page?: number }) => ({
        data: (page ?? 1) > 1 ? [] : (setup.prFiles ?? ["src/app.ts"]).map((filename) => ({ filename })),
      })),
    },
    checks: { listAnnotations: vi.fn(async () => ({ data: [] })) },
    issues: {
      createComment: vi.fn(async (_args: { body: string }) => ({})),
      addLabels: vi.fn(async () => ({})),
    },
    repos: {
      getContent: vi.fn(async ({ path }: { path: string }) => {
        if (setup.getContentError) throw setup.getContentError;
        const content = files[path];
        if (content === undefined) throw Object.assign(new Error("Not Found"), { status: 404 });
        return {
          data: {
            type: "file",
            content: Buffer.from(content).toString("base64"),
            sha: `blob-${path}`,
            size: content.length,
          },
        };
      }),
      createOrUpdateFileContents: vi.fn(async (_args: Record<string, unknown>) => ({})),
    },
    // Present so that any attempt to rewrite history would be visible, and fail the test below.
    git: { updateRef: vi.fn(async () => ({})) },
  };
}

function checkRunPayload(
  overrides: Record<string, unknown> = {},
  prOverrides: Record<string, unknown> = {},
) {
  return {
    action: "completed",
    repository: { name: "r", owner: { login: "o" } },
    check_run: {
      id: 9,
      name: "build",
      conclusion: "failure",
      head_sha: "sha-1",
      output: { title: "Build failed", summary: "", text: TS_ERROR },
      pull_requests: [
        {
          number: 3,
          head: { ref: "dependabot/npm_and_yarn/chalk-5.0.0", sha: "sha-1", repo: { id: 1 } },
          base: { repo: { id: 1 } },
          ...prOverrides,
        },
      ],
      ...overrides,
    },
  };
}

function setup(
  config: Partial<AutoremediatorRepoConfig> = {},
  octokitSetup: Setup = {},
  strategy?: RepairStrategy,
) {
  const octokit = makeOctokit(octokitSetup);
  const stateStore = createInMemoryAppStateStore();
  const handler = createDefaultRemediationHandler({
    octokitFactory: vi.fn(async () => octokit as never),
    repoConfigProvider: vi.fn(async () => ({
      ...DEFAULT_REPO_CONFIG,
      botPrDoctor: { enabled: true, maxAttempts: 2 },
      ...config,
    })),
    stateStore,
    repairStrategy: strategy,
    selfAppId: "4242",
  });
  const send = (payload: Record<string, unknown> = checkRunPayload()) =>
    handler({ eventName: "check_run", installationId: 1, payload });
  return { octokit, stateStore, send };
}

const commentsOf = (octokit: ReturnType<typeof makeOctokit>) =>
  octokit.issues.createComment.mock.calls.map((call) => call[0].body);

describe("bot PR doctor", () => {
  beforeEach(() => vi.clearAllMocks());

  it("does nothing, and reads nothing, unless the repository turned it on", async () => {
    const { octokit, send } = setup({ botPrDoctor: { enabled: false, maxAttempts: 2 } });
    await expect(send()).resolves.toMatchObject({ status: "success" });
    expect(octokit.pulls.get).not.toHaveBeenCalled();
    expect(octokit.repos.createOrUpdateFileContents).not.toHaveBeenCalled();
    expect(octokit.issues.createComment).not.toHaveBeenCalled();
  });

  it("is off in the default repository configuration", () => {
    expect(DEFAULT_REPO_CONFIG.botPrDoctor).toEqual({ enabled: false, maxAttempts: 2 });
  });

  it("pushes one repair commit onto the bot's branch and says so in one comment", async () => {
    const { octokit, send } = setup();
    await expect(send()).resolves.toMatchObject({ status: "success" });

    expect(octokit.repos.createOrUpdateFileContents).toHaveBeenCalledTimes(1);
    const commit = octokit.repos.createOrUpdateFileContents.mock.calls[0]![0] as unknown as Record<
      string,
      string
    >;
    expect(commit).toMatchObject({
      owner: "o",
      repo: "r",
      path: "src/app.ts",
      branch: "dependabot/npm_and_yarn/chalk-5.0.0",
      sha: "blob-src/app.ts",
    });
    expect(Buffer.from(commit.content!, "base64").toString("utf8")).toContain(
      'import * as chalk from "chalk";',
    );
    expect(commentsOf(octokit)).toHaveLength(1);
    expect(commentsOf(octokit)[0]).toContain("Pushed a repair commit");
    expect(octokit.git.updateRef).not.toHaveBeenCalled();
  });

  it("only ever adds commits: no ref is rewritten, and the write names the blob it replaces", async () => {
    const { octokit, send } = setup();
    await send();
    expect(octokit.git.updateRef).not.toHaveBeenCalled();
    const commit = octokit.repos.createOrUpdateFileContents.mock.calls[0]![0] as unknown as Record<
      string,
      unknown
    >;
    expect(commit.sha).toBeTruthy();
  });

  it("works for Renovate branches and authors too", async () => {
    const { octokit, send } = setup(
      {},
      {
        pr: pullRequest({
          user: { login: "renovate[bot]" },
          head: { ref: "renovate/chalk-5.x", sha: "sha-1", repo: { id: 1, full_name: "o/r" } },
        }),
      },
    );
    await send(checkRunPayload({}, { head: { ref: "renovate/chalk-5.x", repo: { id: 1 } } }));
    expect(octokit.repos.createOrUpdateFileContents).toHaveBeenCalledTimes(1);
    expect(commentsOf(octokit)[0]).toContain("Renovate");
  });

  it("ignores a pull request from a fork, however the branch is named", async () => {
    const { octokit, send } = setup();
    // The webhook already shows a different head repository: nothing is even fetched.
    const result = await send(
      checkRunPayload(
        {},
        { head: { ref: "dependabot/x", repo: { id: 2 } }, base: { repo: { id: 1 } } },
      ),
    );
    expect(result).toMatchObject({ reason: "Pull request comes from a fork" });
    expect(octokit.pulls.get).not.toHaveBeenCalled();
    expect(octokit.repos.createOrUpdateFileContents).not.toHaveBeenCalled();
  });

  it("ignores a fork that only shows once the pull request is fetched", async () => {
    const { octokit, send } = setup(
      {},
      {
        pr: pullRequest({
          head: { ref: "dependabot/x", sha: "sha-1", repo: { id: 2, full_name: "evil/r" } },
        }),
      },
    );
    await expect(send()).resolves.toMatchObject({ reason: "Pull request comes from a fork" });
    expect(octokit.repos.getContent).not.toHaveBeenCalled();
    expect(octokit.repos.createOrUpdateFileContents).not.toHaveBeenCalled();
    expect(octokit.issues.createComment).not.toHaveBeenCalled();
  });

  it("ignores a pull request whose head repository is gone", async () => {
    const { octokit, send } = setup(
      {},
      { pr: pullRequest({ head: { ref: "dependabot/x", sha: "sha-1", repo: null } }) },
    );
    await expect(send()).resolves.toMatchObject({ reason: "Pull request comes from a fork" });
    expect(octokit.repos.createOrUpdateFileContents).not.toHaveBeenCalled();
  });

  it("ignores a closed pull request", async () => {
    const { octokit, send } = setup({}, { pr: pullRequest({ state: "closed" }) });
    await expect(send()).resolves.toMatchObject({ reason: "Pull request is not open" });
    expect(octokit.repos.createOrUpdateFileContents).not.toHaveBeenCalled();
  });

  it("ignores a failure from a commit the branch has moved past", async () => {
    const { octokit, send } = setup(
      {},
      {
        pr: pullRequest({
          head: { ref: "dependabot/x", sha: "newer", repo: { id: 1, full_name: "o/r" } },
        }),
      },
    );
    await expect(send()).resolves.toMatchObject({
      reason: expect.stringContaining("current head commit"),
    });
    expect(octokit.repos.createOrUpdateFileContents).not.toHaveBeenCalled();
  });

  it("never diagnoses the app's own check runs", async () => {
    const { octokit, send } = setup();
    await expect(
      send(checkRunPayload({ name: "autoremediator/remediation" })),
    ).resolves.toMatchObject({
      reason: "Check run belongs to autoremediator",
    });
    await expect(send(checkRunPayload({ app: { id: 4242 } }))).resolves.toMatchObject({
      reason: "Check run belongs to autoremediator",
    });
    expect(octokit.pulls.get).not.toHaveBeenCalled();
  });

  it("does nothing without a state store, because it could not cap attempts", async () => {
    const octokit = makeOctokit();
    const handler = createDefaultRemediationHandler({
      octokitFactory: vi.fn(async () => octokit as never),
      repoConfigProvider: vi.fn(async () => ({
        ...DEFAULT_REPO_CONFIG,
        botPrDoctor: { enabled: true, maxAttempts: 2 },
      })),
    });
    await handler({ eventName: "check_run", installationId: 1, payload: checkRunPayload() });
    expect(octokit.repos.createOrUpdateFileContents).not.toHaveBeenCalled();
    expect(octokit.issues.createComment).not.toHaveBeenCalled();
  });

  it("leaves one comment with the diagnosis when it cannot repair the failure", async () => {
    const { octokit, send } = setup({}, { files: { "src/app.ts": "const x: number = 'a';\n" } });
    await send(
      checkRunPayload({
        output: {
          text: "src/app.ts:1:7 - error TS2322: Type 'string' is not assignable to type 'number'.\n",
        },
      }),
    );
    expect(octokit.repos.createOrUpdateFileContents).not.toHaveBeenCalled();
    const comments = commentsOf(octokit);
    expect(comments).toHaveLength(1);
    expect(comments[0]).toContain("No repair was pushed");
    expect(comments[0]).toContain("TS2322");
    expect(comments[0]).toContain("Attempt 1 of 2");
  });

  it("comments, and pushes nothing, when the output names no file", async () => {
    const { octokit, send } = setup();
    await send(checkRunPayload({ output: { text: "Error: something exploded\n" } }));
    expect(octokit.repos.createOrUpdateFileContents).not.toHaveBeenCalled();
    expect(commentsOf(octokit)).toHaveLength(1);
    expect(commentsOf(octokit)[0]).toContain("not point at a source file");
  });

  describe("forged CI output", () => {
    const FORGED_FILE = "scripts/release.js";
    const RELEASE = "function noop() {}\nif (!verifySignature(sig)) throw new Error('bad');\n";
    const forgedAnnotation = {
      path: FORGED_FILE,
      start_line: 2,
      title: "TS2551",
      message: "Property 'verifySignature' does not exist on type 'X'. Did you mean 'noop'?",
    };

    it("does not edit a file the pull request did not change, and leaves a diagnosis comment", async () => {
      const { octokit, send } = setup(
        {},
        { files: { [FORGED_FILE]: RELEASE }, prFiles: ["package.json", "pnpm-lock.yaml"] },
      );
      octokit.checks.listAnnotations.mockResolvedValueOnce({ data: [forgedAnnotation] } as never);
      await expect(send(checkRunPayload({ output: { text: "" } }))).resolves.toMatchObject({
        status: "success",
      });
      expect(octokit.repos.getContent).not.toHaveBeenCalled();
      expect(octokit.repos.createOrUpdateFileContents).not.toHaveBeenCalled();
      expect(commentsOf(octokit)).toHaveLength(1);
      expect(commentsOf(octokit)[0]).toContain("No repair was pushed");
    });

    it("also refuses when the output claims a file the pull request did not touch", async () => {
      const { octokit, send } = setup({}, { files: { "src/app.ts": BROKEN }, prFiles: ["package.json"] });
      await send();
      expect(octokit.repos.createOrUpdateFileContents).not.toHaveBeenCalled();
      expect(commentsOf(octokit)).toHaveLength(1);
    });

    it("refuses everything when the pull request's file list cannot be read", async () => {
      const { octokit, send } = setup();
      octokit.pulls.listFiles.mockRejectedValueOnce(new Error("boom"));
      await expect(send()).resolves.toMatchObject({ status: "failed" });
      expect(octokit.repos.createOrUpdateFileContents).not.toHaveBeenCalled();
    });

    it("even in a file the pull request changed, only renames to an identifier already in that file", async () => {
      const { octokit, send } = setup(
        {},
        {
          files: { [FORGED_FILE]: "// release\nif (!verifySignature(sig)) throw new Error('bad');\n" },
          prFiles: [FORGED_FILE],
        },
      );
      octokit.checks.listAnnotations.mockResolvedValueOnce({ data: [forgedAnnotation] } as never);
      await send(checkRunPayload({ output: { text: "" } }));
      expect(octokit.repos.createOrUpdateFileContents).not.toHaveBeenCalled();
    });
  });

  describe("files it will not touch", () => {
    const unsafe = [
      "package-lock.json",
      "pnpm-lock.yaml",
      "yarn.lock",
      ".github/workflows/ci.yml",
      ".github/autoremediator.yml",
      "package.json",
      "../outside.ts",
      "/etc/passwd.ts",
      "node_modules/x/index.js",
    ];

    it.each(unsafe)("%s", async (filePath) => {
      const { octokit, send } = setup({}, { files: { [filePath]: BROKEN } });
      await send(
        checkRunPayload({
          output: {
            text: `${filePath}:1:8 - error TS2614: Module 'chalk' has no default export.\n`,
          },
        }),
      );
      expect(octokit.repos.getContent).not.toHaveBeenCalled();
      expect(octokit.repos.createOrUpdateFileContents).not.toHaveBeenCalled();
    });

    it("lockfile and workflow paths taken from annotations are refused too", async () => {
      const { octokit, send } = setup({}, { files: { ".github/workflows/ci.js": BROKEN } });
      octokit.checks.listAnnotations.mockResolvedValueOnce({
        data: [
          {
            path: ".github/workflows/ci.js",
            start_line: 1,
            title: "TS2614",
            message: "error TS2614: Module 'chalk' has no default export.",
          },
        ],
      } as never);
      await send(checkRunPayload({ output: { text: "" } }));
      expect(octokit.repos.createOrUpdateFileContents).not.toHaveBeenCalled();
    });

    it("repairs the safe file and leaves the unsafe one when both are named", async () => {
      const { octokit, send } = setup(
        {},
        { files: { "src/app.ts": BROKEN, "package-lock.json": "{}" } },
      );
      await send(
        checkRunPayload({
          output: {
            text: `${TS_ERROR}package-lock.json:1:1 - error TS2614: Module 'chalk' has no default export.\n`,
          },
        }),
      );
      const paths = octokit.repos.createOrUpdateFileContents.mock.calls.map(
        (call) => (call[0] as unknown as { path: string }).path,
      );
      expect(paths).toEqual(["src/app.ts"]);
    });
  });

  describe("attempt cap", () => {
    const failAt = (sha: string) => ({
      pr: pullRequest({
        head: {
          ref: "dependabot/npm_and_yarn/chalk-5.0.0",
          sha,
          repo: { id: 1, full_name: "o/r" },
        },
      }),
    });

    it("counts attempts in the state store, one per head commit, and stops at the cap", async () => {
      const octokit = makeOctokit();
      const stateStore = createInMemoryAppStateStore();
      const handler = createDefaultRemediationHandler({
        octokitFactory: vi.fn(async () => octokit as never),
        repoConfigProvider: vi.fn(async () => ({
          ...DEFAULT_REPO_CONFIG,
          botPrDoctor: { enabled: true, maxAttempts: 2 },
        })),
        stateStore,
      });
      const run = async (sha: string) => {
        octokit.pulls.get.mockResolvedValue({ data: failAt(sha).pr } as never);
        return handler({
          eventName: "check_run",
          installationId: 1,
          payload: checkRunPayload({ head_sha: sha }),
        });
      };

      await run("sha-a");
      await run("sha-b");
      expect(octokit.repos.createOrUpdateFileContents).toHaveBeenCalledTimes(2);

      // Third failure: over the cap. One comment says so; the next stays silent.
      await expect(run("sha-c")).resolves.toMatchObject({
        reason: "Attempt limit reached for this pull request",
      });
      await run("sha-d");
      await run("sha-e");
      expect(octokit.repos.createOrUpdateFileContents).toHaveBeenCalledTimes(2);
      const comments = commentsOf(octokit);
      expect(
        comments.filter((body) => body.includes("Stopping after 2 repair attempt")),
      ).toHaveLength(1);
    });

    it("does not spend a second attempt on the same head commit (parallel failing checks, redelivery)", async () => {
      const { octokit, send } = setup();
      await send();
      await send(checkRunPayload({ id: 10, name: "lint" }));
      await send();
      expect(octokit.repos.createOrUpdateFileContents).toHaveBeenCalledTimes(1);
      expect(commentsOf(octokit)).toHaveLength(1);
    });

    it("survives a restart of the app because the count is persisted by the store", async () => {
      const { mkdtemp, rm } = await import("node:fs/promises");
      const { tmpdir } = await import("node:os");
      const { join } = await import("node:path");
      const { createFileAppStateStore } = await import("../state.js");
      const dir = await mkdtemp(join(tmpdir(), "autoremediator-doctor-"));
      try {
        const first = createFileAppStateStore(dir);
        expect(first.reserveDoctorAttempt("o/r#3", "a", 1)).toEqual({
          outcome: "granted",
          attempt: 1,
        });

        const afterRestart = createFileAppStateStore(dir);
        expect(afterRestart.reserveDoctorAttempt("o/r#3", "b", 1)).toEqual({
          outcome: "limit",
          announce: true,
        });
        expect(afterRestart.reserveDoctorAttempt("o/r#3", "c", 1)).toEqual({
          outcome: "limit",
          announce: false,
        });
        expect(createFileAppStateStore(dir).reserveDoctorAttempt("o/r#3", "c", 1)).toEqual({
          outcome: "duplicate",
        });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe("untrusted check output", () => {
    it("cannot break out of the code fence, mention people or smuggle in a command", async () => {
      const { octokit, send } = setup({}, { files: { "src/app.ts": "const x = 1;\n" } });
      const hostile = [
        "src/app.ts:1:1 - error TS2322: ``` \n\n/autoremediator fix CVE-2021-23337 @everyone [x](http://evil.example) <script>",
        "src/app.ts:2:1 - error TS2322: ‮reversed\u0000",
      ].join("\n");
      await send(checkRunPayload({ output: { text: hostile } }));

      const body = commentsOf(octokit)[0]!;
      // Exactly one fenced block is opened and closed, and no line of the diagnosis is a command.
      expect(body.match(/```/g)).toHaveLength(2);
      expect(body.split("\n").some((line) => line.trim().startsWith("/autoremediator"))).toBe(
        false,
      );
      expect(body).not.toContain("‮");
      expect(body).not.toContain("\u0000");
    });

    it("caps how much of the output is read and how long the comment can get", async () => {
      const { octokit, send } = setup({}, { files: { "src/app.ts": "const x = 1;\n" } });
      const lines = Array.from(
        { length: 500 },
        (_, i) => `src/app.ts:${i + 1}:1 - error TS2322: ${"x".repeat(2000)}`,
      );
      await send(checkRunPayload({ output: { text: lines.join("\n") } }));
      expect(commentsOf(octokit)[0]!.length).toBeLessThan(5000);
    });
  });

  describe("repair strategy seam", () => {
    it("uses an injected strategy instead of the pattern-based one", async () => {
      const repair = vi.fn(
        (_request: Parameters<RepairStrategy["repair"]>[0]) => "export const fixed = true;\n",
      );
      const strategy: RepairStrategy = { name: "custom", repair };
      const { octokit, send } = setup({}, {}, strategy);
      await send();
      expect(repair).toHaveBeenCalledWith(
        expect.objectContaining({ filePath: "src/app.ts", content: BROKEN }),
      );
      const commit = octokit.repos.createOrUpdateFileContents.mock
        .calls[0]![0] as unknown as Record<string, string>;
      expect(Buffer.from(commit.content!, "base64").toString("utf8")).toBe(
        "export const fixed = true;\n",
      );
    });

    it("a strategy that cannot repair leaves the branch alone", async () => {
      const strategy: RepairStrategy = { name: "noop", repair: () => undefined };
      const { octokit, send } = setup({}, {}, strategy);
      await send();
      expect(octokit.repos.createOrUpdateFileContents).not.toHaveBeenCalled();
      expect(commentsOf(octokit)).toHaveLength(1);
    });
  });

  it("answers with a comment, not a thrown job, when the file cannot be read", async () => {
    const { octokit, send } = setup({}, { getContentError: new Error("boom") });
    await expect(send()).resolves.toMatchObject({ status: "success" });
    // getContent errors are handled per file; a push that fails is a comment, not a thrown job.
    expect(octokit.repos.createOrUpdateFileContents).not.toHaveBeenCalled();
    expect(commentsOf(octokit)).toHaveLength(1);
  });

  it("bot branches whose name contains 'autoremediator' go to the doctor, never the generic healer", async () => {
    const { octokit, send } = setup(
      { enablePrAutoHealing: true },
      {
        pr: pullRequest({
          head: {
            ref: "dependabot/npm_and_yarn/autoremediator-1.0.0",
            sha: "sha-1",
            repo: { id: 1, full_name: "o/r" },
          },
        }),
      },
    );
    await send(
      checkRunPayload(
        {},
        { head: { ref: "dependabot/npm_and_yarn/autoremediator-1.0.0", repo: { id: 1 } } },
      ),
    );
    expect(octokit.pulls.get).toHaveBeenCalledTimes(1);
    // The doctor's commit message, not the healer's.
    const commit = octokit.repos.createOrUpdateFileContents.mock.calls[0]![0] as unknown as {
      message: string;
    };
    expect(commit.message).toContain("bot PR doctor");
  });

  it("the existing healer for autoremediator branches is unchanged when the doctor is off", async () => {
    const { octokit, send } = setup({
      botPrDoctor: { enabled: false, maxAttempts: 2 },
      enablePrAutoHealing: true,
    });
    await send({
      ...checkRunPayload(),
      check_run: {
        ...checkRunPayload().check_run,
        pull_requests: [{ number: 8, head: { ref: "autoremediator/cve-2026-1" } }],
      },
    });
    const commit = octokit.repos.createOrUpdateFileContents.mock.calls[0]![0] as unknown as {
      message: string;
    };
    expect(commit.message).toContain("auto-heal");
    expect(octokit.pulls.get).not.toHaveBeenCalled();
  });
});
