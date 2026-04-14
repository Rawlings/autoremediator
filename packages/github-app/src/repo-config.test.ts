import { describe, expect, it, vi, beforeEach } from "vitest";
import { fetchRepoConfig } from "./repo-config.js";
import { DEFAULT_REPO_CONFIG } from "./types.js";
import type { Octokit } from "@octokit/rest";

function makeOctokit(stub: () => Promise<unknown>): Octokit {
  return {
    rest: {
      repos: {
        getContent: stub,
      },
    },
  } as unknown as Octokit;
}

function encodeYaml(yaml: string): string {
  return Buffer.from(yaml, "utf8").toString("base64");
}

describe("fetchRepoConfig", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns DEFAULT_REPO_CONFIG when file returns 404", async () => {
    const octokit = makeOctokit(async () => {
      const err = Object.assign(new Error("Not Found"), { status: 404 });
      throw err;
    });

    const result = await fetchRepoConfig(octokit, "acme", "web");
    expect(result).toEqual(DEFAULT_REPO_CONFIG);
  });

  it("returns DEFAULT_REPO_CONFIG when YAML is malformed", async () => {
    const octokit = makeOctokit(async () => ({
      data: {
        type: "file",
        content: encodeYaml("dryRun: :\n  broken: yaml"),
      },
    }));

    const result = await fetchRepoConfig(octokit, "acme", "web");
    expect(result).toEqual(DEFAULT_REPO_CONFIG);
  });

  it("returns DEFAULT_REPO_CONFIG when content is empty", async () => {
    const octokit = makeOctokit(async () => ({
      data: {
        type: "file",
        content: encodeYaml(""),
      },
    }));

    const result = await fetchRepoConfig(octokit, "acme", "web");
    expect(result).toEqual(DEFAULT_REPO_CONFIG);
  });

  it("returns DEFAULT_REPO_CONFIG when data is a directory listing", async () => {
    const octokit = makeOctokit(async () => ({
      data: [{ name: "autoremediator.yml", type: "file" }],
    }));

    const result = await fetchRepoConfig(octokit, "acme", "web");
    expect(result).toEqual(DEFAULT_REPO_CONFIG);
  });

  it("parses a full YAML file and merges with defaults", async () => {
    const yaml = [
      "dryRun: false",
      "runTests: true",
      "minimumSeverity: CRITICAL",
      "allowMajorBumps: true",
      "denyPackages:",
      "  - lodash",
      "pullRequest:",
      "  enabled: true",
      "  grouping: per-package",
      "  baseBranch: main",
      "  branchPrefix: autoremediator/fix",
    ].join("\n");

    const octokit = makeOctokit(async () => ({
      data: {
        type: "file",
        content: encodeYaml(yaml),
      },
    }));

    const result = await fetchRepoConfig(octokit, "acme", "web");

    expect(result.dryRun).toBe(false);
    expect(result.runTests).toBe(true);
    expect(result.minimumSeverity).toBe("CRITICAL");
    expect(result.allowMajorBumps).toBe(true);
    expect(result.denyPackages).toEqual(["lodash"]);
    expect(result.pullRequest?.enabled).toBe(true);
    expect(result.pullRequest?.grouping).toBe("per-package");
    expect(result.pullRequest?.baseBranch).toBe("main");
    expect(result.pullRequest?.branchPrefix).toBe("autoremediator/fix");
    // Unspecified fields use defaults
    expect(result.allowPackages).toEqual(DEFAULT_REPO_CONFIG.allowPackages);
  });

  it("returns DEFAULT_REPO_CONFIG on unexpected errors", async () => {
    const octokit = makeOctokit(async () => {
      throw new Error("Network timeout");
    });

    const result = await fetchRepoConfig(octokit, "acme", "web");
    expect(result).toEqual(DEFAULT_REPO_CONFIG);
  });
});
