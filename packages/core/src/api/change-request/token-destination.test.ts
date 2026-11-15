import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RemediationReport } from "../../platform/types.js";
import { checkTokenDestination } from "./hosts.js";
import { createChangeRequestsForReports } from "./index.js";

describe("checkTokenDestination", () => {
  const check = (
    remoteUrl: string | undefined,
    over: Partial<Parameters<typeof checkTokenDestination>[0]> = {},
  ) =>
    checkTokenDestination({
      provider: "github",
      remoteUrl,
      explicitToken: false,
      env: {},
      ...over,
    });

  it("sends a GitHub token to github.com and to hosts the user named", () => {
    expect(check("https://github.com/o/r.git").send).toBe(true);
    expect(check("https://acme.ghe.com/o/r.git").send).toBe(true);
    expect(
      check("https://ghe.corp.example/o/r.git", { githubApiUrl: "https://ghe.corp.example/api/v3" })
        .send,
    ).toBe(true);
    expect(
      check("https://ghe.corp.example/o/r.git", {
        env: { GITHUB_SERVER_URL: "https://ghe.corp.example" },
      }).send,
    ).toBe(true);
  });

  it("refuses to send a GitHub token to another host", () => {
    for (const url of [
      "https://gitlab.com/g/p.git",
      "https://bitbucket.org/w/r.git",
      "https://evil.example/o/r.git",
    ]) {
      const decision = check(url);
      expect(decision.send).toBe(false);
      expect(decision.refusal).toMatch(/github token/i);
    }
  });

  it("lets an explicitly given token go to the host the remote names", () => {
    expect(check("https://git.internal.example/o/r.git", { explicitToken: true }).send).toBe(true);
  });

  it("never sends a token over http, except to the local machine", () => {
    const remote = check("http://github.com/o/r.git");
    expect(remote.send).toBe(false);
    expect(remote.refusal).toMatch(/cleartext/i);
    expect(check("http://127.0.0.1:8080/o/r.git").send).toBe(true);
    expect(check("http://localhost/o/r.git").send).toBe(true);
  });

  it("does not attach a header to ssh or local remotes, and does not call that a refusal", () => {
    for (const url of ["git@github.com:o/r.git", "/srv/git/repo.git", undefined]) {
      expect(check(url, { forPush: true })).toEqual({ send: false });
    }
  });

  it("refuses a provider token for a host that plainly belongs to a different provider", () => {
    const decision = check("https://github.com/o/r.git", { provider: "gitlab" });
    expect(decision.send).toBe(false);
    expect(decision.refusal).toMatch(/gitlab token/i);
    expect(check("https://gitlab.example.com/g/p.git", { provider: "gitlab" }).send).toBe(true);
  });
});

const report: RemediationReport = {
  cveId: "CVE-2026-0001",
  cveDetails: null,
  vulnerablePackages: [],
  results: [
    {
      packageName: "pkg-alpha",
      strategy: "version-bump",
      fromVersion: "1.0.0",
      toVersion: "1.0.1",
      applied: true,
      dryRun: false,
      message: "updated pkg-alpha",
    },
  ],
  summary: "Alpha bump",
};

function git(cwd: string, command: string): string {
  return execSync(`git ${command}`, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

describe("createChangeRequestsForReports and the token", () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "ar-token-dest-"));
    git(workDir, "init -b main");
    git(workDir, "config user.name tester");
    git(workDir, "config user.email tester@example.com");
    writeFileSync(join(workDir, "package.json"), '{"name":"app","version":"1.0.0"}\n');
    git(workDir, "add .");
    git(workDir, "commit -m initial");
    vi.stubEnv("GIT_TERMINAL_PROMPT", "0");
    vi.stubEnv("GITHUB_TOKEN", "ghp_from_env");
    vi.stubEnv("GITHUB_SERVER_URL", "");
    vi.stubEnv("GITHUB_API_URL", "");
    vi.stubEnv("GH_HOST", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(workDir, { recursive: true, force: true });
  });

  it("does not hand the GitHub token to a GitLab remote when no provider was chosen", async () => {
    git(workDir, "remote add origin https://gitlab.example.com/group/proj.git");
    writeFileSync(join(workDir, "package.json"), '{"name":"app","version":"1.0.1"}\n');
    const results = await createChangeRequestsForReports({
      cwd: workDir,
      options: { enabled: true, provider: "github", baseBranch: "main" },
      reports: [report],
    });
    expect(results[0]?.created).toBe(false);
    expect(results[0]?.error).toMatch(/not sending the github token to gitlab\.example\.com/i);
    // Nothing was committed or switched.
    expect(git(workDir, "rev-parse --abbrev-ref HEAD").trim()).toBe("main");
    expect(git(workDir, "branch --list").trim().split("\n")).toHaveLength(1);
  });

  it("does not send a token to an http remote", async () => {
    git(workDir, "remote add origin http://gitlab.example.com/group/proj.git");
    writeFileSync(join(workDir, "package.json"), '{"name":"app","version":"1.0.1"}\n');
    const results = await createChangeRequestsForReports({
      cwd: workDir,
      options: { enabled: true, provider: "gitlab", token: "glpat-x", baseBranch: "main" },
      reports: [report],
    });
    expect(results[0]?.created).toBe(false);
    expect(results[0]?.error).toMatch(/cleartext/i);
  });

  it("refuses a base branch that git would read as an option", async () => {
    git(workDir, "remote add origin https://github.com/o/r.git");
    writeFileSync(join(workDir, "package.json"), '{"name":"app","version":"1.0.1"}\n');
    await expect(
      createChangeRequestsForReports({
        cwd: workDir,
        options: { enabled: true, provider: "github", baseBranch: "--detach" },
        reports: [report],
      }),
    ).rejects.toThrow(/baseBranch is not a valid git ref/);
  });
});
