import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RemediationReport } from "../../platform/types.js";
import { createChangeRequestsForReports, isExistingRequestError } from "./index.js";

const git = (cwd: string, command: string): string =>
  execSync(`git ${command}`, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

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
      validationPhases: [{ phase: "install", passed: true }],
    },
  ],
  summary: "Alpha bump",
  runId: "run_aaaaaaaaaaaaaaaaaaaa",
};

const options = {
  provider: "github" as const,
  repository: "owner/repo",
  token: "ghp_fake",
  baseBranch: "main",
};

describe("re-running a change request for the same findings", () => {
  let dir: string;
  let remote: string;
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cr-rerun-"));
    remote = mkdtempSync(join(tmpdir(), "cr-rerun-remote-"));
    execSync("git init --bare -b main", { cwd: remote, stdio: "ignore" });
    execSync("git init -b main", { cwd: dir, stdio: "ignore" });
    git(dir, "config user.name human");
    git(dir, "config user.email human@example.com");
    writeFileSync(join(dir, "package.json"), '{"name":"app"}\n');
    writeFileSync(join(dir, "file.txt"), "one\n");
    git(dir, "add .");
    git(dir, 'commit -m initial');
    git(dir, `remote add origin "${remote}"`);
    git(dir, "push -u origin main");
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    rmSync(dir, { recursive: true, force: true });
    rmSync(remote, { recursive: true, force: true });
  });

  function stubGitHub(): void {
    let created = false;
    globalThis.fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        if (created) {
          return { ok: false, status: 422, text: async () => "A pull request already exists for owner:x" };
        }
        created = true;
        return { ok: true, status: 201, json: async () => ({ html_url: "https://github.com/owner/repo/pull/7" }) };
      }
      expect(String(url)).toContain("/pulls?state=open&head=owner%3Aautoremediator%2F");
      return { ok: true, status: 200, json: async () => [{ html_url: "https://github.com/owner/repo/pull/7" }] };
    }) as unknown as typeof fetch;
  }

  it("updates the same branch and pull request instead of opening a duplicate", async () => {
    stubGitHub();

    writeFileSync(join(dir, "file.txt"), "two\n");
    const first = await createChangeRequestsForReports({ cwd: dir, options, reports: [report] });
    expect(first[0]?.created).toBe(true);
    expect(first[0]?.updated).toBeUndefined();
    expect(first[0]?.branchName).toBe("autoremediator/cve-2026-0001-pkg-alpha");
    const firstSha = git(remote, `rev-parse refs/heads/${first[0]?.branchName}`);

    writeFileSync(join(dir, "file.txt"), "three\n");
    const second = await createChangeRequestsForReports({ cwd: dir, options, reports: [report] });
    expect(second[0]?.created).toBe(true);
    expect(second[0]?.updated).toBe(true);
    expect(second[0]?.branchName).toBe(first[0]?.branchName);
    expect(second[0]?.url).toBe("https://github.com/owner/repo/pull/7");

    const secondSha = git(remote, `rev-parse refs/heads/${first[0]?.branchName}`);
    expect(secondSha).not.toBe(firstSha);
    // Exactly one commit on top of main: the second run replaced the first, it did not stack.
    expect(git(remote, `rev-list --count main..refs/heads/${first[0]?.branchName}`)).toBe("1");
    expect(git(remote, `show refs/heads/${first[0]?.branchName}:file.txt`)).toBe("three");
    expect(git(dir, "rev-parse --abbrev-ref HEAD")).toBe("main");
  });

  it("puts trailers in the commit message", async () => {
    stubGitHub();
    writeFileSync(join(dir, "file.txt"), "two\n");
    const [result] = await createChangeRequestsForReports({ cwd: dir, options, reports: [report] });
    const message = git(remote, `log -1 --format=%B refs/heads/${result?.branchName}`);
    expect(message).toContain("security remediation: CVE-2026-0001");
    expect(message).toContain("Fixes-CVE: CVE-2026-0001");
    expect(message).toContain("Autoremediator-Run: run_aaaaaaaaaaaaaaaaaaaa");
    expect(message).toMatch(/Verified-By: autoremediator \(install\)/);
  });

  it("refuses to overwrite a branch a person has added commits to", async () => {
    stubGitHub();
    writeFileSync(join(dir, "file.txt"), "two\n");
    const [first] = await createChangeRequestsForReports({ cwd: dir, options, reports: [report] });
    const branch = first?.branchName ?? "";

    git(dir, `fetch origin ${branch}`);
    git(dir, `checkout -B ${branch} FETCH_HEAD`);
    writeFileSync(join(dir, "human.txt"), "my work\n");
    git(dir, "add human.txt");
    git(dir, 'commit -m "human fix"');
    git(dir, `push origin ${branch}`);
    git(dir, "checkout main");
    const humanSha = git(remote, `rev-parse refs/heads/${branch}`);

    writeFileSync(join(dir, "file.txt"), "three\n");
    const [second] = await createChangeRequestsForReports({ cwd: dir, options, reports: [report] });

    expect(second?.created).toBe(false);
    expect(second?.error).toContain("did not make; not overwriting");
    expect(git(remote, `rev-parse refs/heads/${branch}`)).toBe(humanSha);
    // The run's edits are still in the working tree for the person to deal with.
    expect(git(dir, "status --porcelain")).toContain("file.txt");
    expect(git(dir, "rev-parse --abbrev-ref HEAD")).toBe("main");
  });
});

describe("isExistingRequestError", () => {
  it("recognises duplicate-request answers and nothing else", () => {
    for (const message of [
      "A pull request already exists for owner:x",
      "Another open merge request already exists for this source branch",
      "TF401179: An active pull request for the source and target branch already exists.",
    ]) {
      expect(isExistingRequestError(message)).toBe(true);
    }
    expect(isExistingRequestError("401 Unauthorized")).toBe(false);
  });
});
