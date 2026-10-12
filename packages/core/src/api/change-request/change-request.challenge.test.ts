import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createChangeRequestsForReports } from "./index.js";
import type { RemediationReport } from "../../platform/types.js";

describe("Milestone 5 Challenge: Multi-Group Change Requests (Feature 24)", () => {
  let testDir: string;
  let remoteDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "challenger-m5-cr-"));
    remoteDir = mkdtempSync(join(tmpdir(), "challenger-m5-remote-"));

    // 1. Initialize bare remote repository
    execSync("git init --bare -b main", { cwd: remoteDir, stdio: "ignore" });

    // 2. Initialize local repository
    execSync("git init -b main", { cwd: testDir, stdio: "ignore" });
    execSync("git config user.name 'autoremediator[bot]'", { cwd: testDir, stdio: "ignore" });
    execSync("git config user.email 'autoremediator[bot]@users.noreply.github.com'", {
      cwd: testDir,
      stdio: "ignore",
    });

    // 3. Initial commit
    writeFileSync(
      join(testDir, "package.json"),
      JSON.stringify({ name: "app", version: "1.0.0" }, null, 2),
    );
    writeFileSync(join(testDir, "file1.txt"), "initial content\n");
    execSync("git add .", { cwd: testDir, stdio: "ignore" });
    execSync("git commit -m 'initial commit'", { cwd: testDir, stdio: "ignore" });

    // 4. Attach remote and push main
    execSync(`git remote add origin "${remoteDir}"`, { cwd: testDir, stdio: "ignore" });
    execSync("git push -u origin main", { cwd: testDir, stdio: "ignore" });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    rmSync(remoteDir, { recursive: true, force: true });
  });

  const sampleReport1: RemediationReport = {
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
    agentSteps: 1,
    summary: "Alpha bump",
  };

  const sampleReport2: RemediationReport = {
    cveId: "CVE-2026-0002",
    cveDetails: null,
    vulnerablePackages: [],
    results: [
      {
        packageName: "pkg-beta",
        strategy: "version-bump",
        fromVersion: "2.0.0",
        toVersion: "2.0.1",
        applied: true,
        dryRun: false,
        message: "updated pkg-beta",
      },
    ],
    agentSteps: 1,
    summary: "Beta bump",
  };

  it("handles completely empty working tree without crashing or throwing git fatal error", async () => {
    // Repository is completely clean — no changes have been made
    const results = await createChangeRequestsForReports({
      cwd: testDir,
      options: {
        provider: "github",
        repository: "owner/repo",
        token: "fake-token",
      },
      reports: [sampleReport1],
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.created).toBe(false);
    expect(results[0]?.error).toBe("No repository changes to include in change request.");
    expect(results[0]?.branchName).toBe("");

    // Working tree must remain on main and completely clean
    const currentBranch = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd: testDir,
      encoding: "utf8",
    }).trim();
    expect(currentBranch).toBe("main");
    const status = execSync("git status --porcelain", { cwd: testDir, encoding: "utf8" }).trim();
    expect(status).toBe("");
  });

  it("handles 0-diff groups across multiple groupings without git commit crash", async () => {
    const results = await createChangeRequestsForReports({
      cwd: testDir,
      options: {
        provider: "github",
        grouping: "per-cve",
        repository: "owner/repo",
        token: "fake-token",
      },
      reports: [sampleReport1, sampleReport2],
    });

    expect(results).toHaveLength(2);
    for (const res of results) {
      expect(res.created).toBe(false);
      expect(res.error).toBe("No repository changes to include in change request.");
    }

    const currentBranch = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd: testDir,
      encoding: "utf8",
    }).trim();
    expect(currentBranch).toBe("main");
  });

  it("handles multi-CVE grouping where only group 1 has edits, and cleanly restores baseBranch", async () => {
    // Mock GitHub API fetch for PR creation
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ html_url: "https://github.com/owner/repo/pull/42" }),
    });
    globalThis.fetch = fetchMock as any;

    try {
      // Introduce changes for Group 1 on disk
      writeFileSync(join(testDir, "file1.txt"), "modified for CVE-2026-0001\n");

      const results = await createChangeRequestsForReports({
        cwd: testDir,
        options: {
          provider: "github",
          grouping: "per-cve",
          repository: "owner/repo",
          token: "ghp_secret_token",
          baseBranch: "main",
        },
        reports: [sampleReport1, sampleReport2],
      });

      expect(results).toHaveLength(2);

      // Group 1 should succeed
      expect(results[0]?.created).toBe(true);
      expect(results[0]?.cveIds).toEqual(["CVE-2026-0001"]);
      expect(results[0]?.url).toBe("https://github.com/owner/repo/pull/42");
      expect(results[0]?.branchName).toMatch(/^autoremediator\/cve-2026-0001-/);

      // Group 2 should cleanly report no changes without 'fatal: nothing to commit' crash
      expect(results[1]?.created).toBe(false);
      expect(results[1]?.cveIds).toEqual(["CVE-2026-0002"]);
      expect(results[1]?.error).toBe("No repository changes to include in change request.");

      // Verify baseBranch was cleanly restored
      const currentBranch = execSync("git rev-parse --abbrev-ref HEAD", {
        cwd: testDir,
        encoding: "utf8",
      }).trim();
      expect(currentBranch).toBe("main");

      // Verify working tree on main is clean
      const status = execSync("git status --porcelain", { cwd: testDir, encoding: "utf8" }).trim();
      expect(status).toBe("");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("recovers and cleanly restores baseBranch when git push fails", async () => {
    // Mutate file
    writeFileSync(join(testDir, "file1.txt"), "modified content\n");

    const results = await createChangeRequestsForReports({
      cwd: testDir,
      options: {
        provider: "github",
        repository: "owner/repo",
        pushRemote: "nonexistent-remote",
        baseBranch: "main",
      },
      reports: [sampleReport1],
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.created).toBe(false);
    expect(results[0]?.error).toBeDefined();

    // Despite push failure, working tree must be cleanly restored to main
    const currentBranch = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd: testDir,
      encoding: "utf8",
    }).trim();
    expect(currentBranch).toBe("main");
  });

  it("handles staged 0-diff edge cases (e.g. files touched but content identical)", async () => {
    // Touch file without content change or with .gitignore
    writeFileSync(join(testDir, ".gitignore"), "ignored.tmp\n");
    execSync("git add .gitignore && git commit -m 'add gitignore'", {
      cwd: testDir,
      stdio: "ignore",
    });

    // Write ignored file
    writeFileSync(join(testDir, "ignored.tmp"), "ignored data");

    const results = await createChangeRequestsForReports({
      cwd: testDir,
      options: {
        provider: "github",
        repository: "owner/repo",
      },
      reports: [sampleReport1],
    });

    expect(results[0]?.created).toBe(false);
    expect(results[0]?.error).toBe("No repository changes to include in change request.");

    const currentBranch = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd: testDir,
      encoding: "utf8",
    }).trim();
    expect(currentBranch).toBe("main");
  });

  it("handles detached HEAD state when baseBranch is explicitly provided", async () => {
    const headCommit = execSync("git rev-parse HEAD", { cwd: testDir, encoding: "utf8" }).trim();
    // Detach HEAD at current commit
    execSync(`git checkout ${headCommit}`, { cwd: testDir, stdio: "ignore" });

    // Verify detached HEAD
    const detachedRef = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd: testDir,
      encoding: "utf8",
    }).trim();
    expect(detachedRef).toBe("HEAD");

    // Mutate file
    writeFileSync(join(testDir, "file1.txt"), "mutated in detached head\n");

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ html_url: "https://github.com/owner/repo/pull/99" }),
    }) as any;

    try {
      const results = await createChangeRequestsForReports({
        cwd: testDir,
        options: {
          provider: "github",
          repository: "owner/repo",
          token: "ghp_tok",
          baseBranch: "main",
        },
        reports: [sampleReport1],
      });

      expect(results[0]?.created).toBe(true);

      // Verify branch is restored to main
      const currentBranch = execSync("git rev-parse --abbrev-ref HEAD", {
        cwd: testDir,
        encoding: "utf8",
      }).trim();
      expect(currentBranch).toBe("main");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("handles detached HEAD state when baseBranch is omitted", async () => {
    const headCommit = execSync("git rev-parse HEAD", { cwd: testDir, encoding: "utf8" }).trim();
    execSync(`git checkout ${headCommit}`, { cwd: testDir, stdio: "ignore" });

    // Mutate file
    writeFileSync(join(testDir, "file1.txt"), "mutated in detached head without baseBranch\n");

    const originalFetch = globalThis.fetch;
    let requestedBase = "";
    globalThis.fetch = vi.fn().mockImplementation(async (_url, init) => {
      const body = JSON.parse(init.body);
      requestedBase = body.base;
      return {
        ok: true,
        json: async () => ({ html_url: "https://github.com/owner/repo/pull/100" }),
      };
    }) as any;

    try {
      const results = await createChangeRequestsForReports({
        cwd: testDir,
        options: {
          provider: "github",
          repository: "owner/repo",
          token: "ghp_tok",
        },
        reports: [sampleReport1],
      });

      expect(results[0]?.created).toBe(true);
      // Observe what base branch was detected and where the working tree ended up
      const currentBranch = execSync("git rev-parse --abbrev-ref HEAD", {
        cwd: testDir,
        encoding: "utf8",
      }).trim();
      // Note: when baseBranch is omitted and git is in detached HEAD, detectCurrentBranch returns 'HEAD'
      // which git checkout HEAD keeps on the newly created branch
      expect(currentBranch).toMatch(/^autoremediator\//);
      expect(requestedBase).toBe("HEAD");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
