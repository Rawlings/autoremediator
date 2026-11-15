import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RemediationReport } from "../remediate/types.js";
import { createChangeRequestsForReports } from "./index.js";
import type { ChangeRequestProvider } from "./types.js";

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

describe("change requests on non-GitHub hosts (real git)", () => {
  let workDir: string;
  let bareDir: string;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "ar-host-work-"));
    bareDir = mkdtempSync(join(tmpdir(), "ar-host-bare-"));
    git(bareDir, "init --bare -b main");
    git(workDir, "init -b main");
    git(workDir, "config user.name tester");
    git(workDir, "config user.email tester@example.com");
    writeFileSync(join(workDir, "package.json"), '{"name":"app","version":"1.0.0"}\n');
    git(workDir, "add .");
    git(workDir, "commit -m initial");
    // Never let a failing push prompt for credentials or go through a proxy.
    vi.stubEnv("GIT_TERMINAL_PROMPT", "0");
    vi.stubEnv("NO_PROXY", "127.0.0.1");
    vi.stubEnv("no_proxy", "127.0.0.1");
    vi.stubEnv("CI_API_V4_URL", "");
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.unstubAllEnvs();
    rmSync(workDir, { recursive: true, force: true });
    rmSync(bareDir, { recursive: true, force: true });
  });

  it("pushes a GitLab branch and opens a merge request through the REST API", async () => {
    // Map the https remote to the local bare repo so git pushes for real without a network.
    const remoteUrl = "https://gitlab.example.com/group/sub/proj.git";
    git(workDir, `config url."${bareDir}".insteadOf "${remoteUrl}"`);
    git(workDir, `remote add origin ${remoteUrl}`);
    git(workDir, "push origin main");

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({
        web_url: "https://gitlab.example.com/group/sub/proj/-/merge_requests/9",
      }),
      text: async () => "",
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    writeFileSync(join(workDir, "package.json"), '{"name":"app","version":"1.0.1"}\n');
    const results = await createChangeRequestsForReports({
      cwd: workDir,
      options: { enabled: true, provider: "gitlab", token: "glpat-secret", baseBranch: "main" },
      reports: [report],
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.error).toBeUndefined();
    expect(results[0]?.created).toBe(true);
    expect(results[0]?.url).toBe("https://gitlab.example.com/group/sub/proj/-/merge_requests/9");

    const [endpoint, init] = fetchMock.mock.calls[0] as [
      string,
      { headers: Record<string, string>; body: string },
    ];
    expect(endpoint).toBe(
      "https://gitlab.example.com/api/v4/projects/group%2Fsub%2Fproj/merge_requests",
    );
    expect(init.headers["private-token"]).toBe("glpat-secret");
    const payload = JSON.parse(init.body) as { source_branch: string; target_branch: string };
    expect(payload.target_branch).toBe("main");
    expect(payload.source_branch).toBe(results[0]?.branchName);

    // The branch really landed on the remote, with a non-GitHub commit identity.
    const branches = git(bareDir, "branch --list");
    expect(branches).toContain(payload.source_branch);
    const author = git(bareDir, `log -1 --format=%ae ${payload.source_branch}`).trim();
    expect(author).not.toContain("github");
    expect(git(workDir, "rev-parse --abbrev-ref HEAD").trim()).toBe("main");
  });

  it("opens a Bitbucket pull request after pushing, deriving workspace/repo from the remote", async () => {
    const remoteUrl = "https://bitbucket.org/ws/repo.git";
    git(workDir, `config url."${bareDir}".insteadOf "${remoteUrl}"`);
    git(workDir, `remote add origin ${remoteUrl}`);
    git(workDir, "push origin main");

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({
        links: { html: { href: "https://bitbucket.org/ws/repo/pull-requests/1" } },
      }),
      text: async () => "",
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    writeFileSync(join(workDir, "package.json"), '{"name":"app","version":"1.0.1"}\n');
    const results = await createChangeRequestsForReports({
      cwd: workDir,
      options: { enabled: true, provider: "bitbucket", token: "bbtok", baseBranch: "main" },
      reports: [report],
    });

    expect(results[0]?.error).toBeUndefined();
    expect(results[0]?.url).toBe("https://bitbucket.org/ws/repo/pull-requests/1");
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe(
      "https://api.bitbucket.org/2.0/repositories/ws/repo/pullrequests",
    );
    expect(git(bareDir, "branch --list")).toContain(results[0]?.branchName);
  });

  it("opens an Azure DevOps pull request, deriving org/project/repo from an ssh remote", async () => {
    const remoteUrl = "git@ssh.dev.azure.com:v3/org/proj/repo";
    git(workDir, `config url."${bareDir}".insteadOf "${remoteUrl}"`);
    git(workDir, `remote add origin ${remoteUrl}`);
    git(workDir, "push origin main");

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ pullRequestId: 4 }),
      text: async () => "",
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    writeFileSync(join(workDir, "package.json"), '{"name":"app","version":"1.0.1"}\n');
    const results = await createChangeRequestsForReports({
      cwd: workDir,
      options: { enabled: true, provider: "azure-devops", token: "pat", baseBranch: "main" },
      reports: [report],
    });

    expect(results[0]?.error).toBeUndefined();
    expect(results[0]?.url).toBe("https://dev.azure.com/org/proj/_git/repo/pullrequest/4");
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe(
      "https://dev.azure.com/org/proj/_apis/git/repositories/repo/pullrequests?api-version=7.1",
    );
  });

  it("refuses Bitbucket and Azure DevOps change requests without a token, before touching git", async () => {
    git(workDir, `remote add origin ${bareDir}`);
    writeFileSync(join(workDir, "package.json"), '{"name":"app","version":"1.0.1"}\n');

    for (const provider of ["bitbucket", "azure-devops"] as ChangeRequestProvider[]) {
      const results = await createChangeRequestsForReports({
        cwd: workDir,
        options: {
          enabled: true,
          provider,
          repository: provider === "bitbucket" ? "a/b" : "a/b/c",
          baseBranch: "main",
        },
        reports: [report],
      });
      expect(results[0]?.created).toBe(false);
      expect(results[0]?.error).toContain("token is required");
      expect(git(workDir, "rev-parse --abbrev-ref HEAD").trim()).toBe("main");
      expect(git(workDir, "branch --list").trim().split("\n")).toHaveLength(1);
    }
  });

  it("authenticates the HTTPS push with the provider-specific header", async () => {
    const seen: string[] = [];
    const server: Server = createServer((req, res) => {
      seen.push(req.headers.authorization ?? "");
      res.statusCode = 500;
      res.end("stop");
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const port = (server.address() as AddressInfo).port;

    try {
      const expectations: Array<[ChangeRequestProvider, string, string]> = [
        ["gitlab", "glpat-1", "oauth2:glpat-1"],
        ["github", "ghp-1", "x-access-token:ghp-1"],
        ["bitbucket", "bb-1", "x-token-auth:bb-1"],
        ["azure-devops", "pat-1", ":pat-1"],
      ];
      for (const [provider, token, userPass] of expectations) {
        seen.length = 0;
        git(workDir, "remote remove origin || true");
        git(workDir, `remote add origin http://127.0.0.1:${port}/g/p.git`);
        writeFileSync(join(workDir, "package.json"), `{"name":"app","provider":"${provider}"}\n`);
        const results = await createChangeRequestsForReports({
          cwd: workDir,
          options: {
            enabled: true,
            provider,
            token,
            repository: provider === "azure-devops" ? "o/p/r" : "g/p",
            baseBranch: "main",
          },
          reports: [report],
        });
        // The push fails against the stub server, which is what lets us inspect the header.
        expect(results[0]?.created).toBe(false);
        expect(seen[0]).toBe(`basic ${Buffer.from(userPass).toString("base64")}`);
        git(workDir, "checkout -- .");
      }
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    }
  });
});
