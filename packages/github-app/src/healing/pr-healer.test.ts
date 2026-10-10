import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  healPullRequest,
  repairFileContent,
  resetHealingAttempts,
} from "./pr-healer.js";
import { DEFAULT_REPO_CONFIG } from "../types.js";

describe("PR Auto-Healer", () => {
  beforeEach(() => {
    resetHealingAttempts("test-owner", "test-repo", 42);
  });

  describe("repairFileContent", () => {
    it("fixes default export mismatch by converting to namespace import", () => {
      const code = `import chalk from "chalk";\nconsole.log(chalk.red("test"));\n`;
      const findings = [
        {
          filePath: "src/app.ts",
          message: "Module 'chalk' has no default export. TS2614",
          category: "typescript" as const,
        },
      ];
      const repaired = repairFileContent(code, findings);
      expect(repaired).toContain('import * as chalk from "chalk";');
    });

    it("replaces missing symbol using compiler Did you mean suggestion", () => {
      const code = `import { rimraf } from "rimraf";\nrimraf.sync("/tmp/test");\n`;
      const findings = [
        {
          filePath: "src/clean.ts",
          message:
            "Property 'sync' does not exist on type 'typeof import(\"rimraf\")'. Did you mean 'rimrafSync'?",
          category: "typescript" as const,
        },
      ];
      const repaired = repairFileContent(code, findings);
      expect(repaired).toContain("rimrafSync");
    });

    it("removes unused imports flagged by linter", () => {
      const code = `import { useState, useEffect } from "react";\n`;
      const findings = [
        {
          filePath: "src/Comp.tsx",
          ruleId: "@typescript-eslint/no-unused-vars",
          message: "'useEffect' is defined but never used.",
          category: "lint" as const,
        },
      ];
      const repaired = repairFileContent(code, findings);
      expect(repaired).not.toContain("useEffect");
      expect(repaired).toContain("useState");
    });

    it("inserts @ts-expect-error fallback when typecheck error has line number", () => {
      const code = `const x: number = "hello";\n`;
      const findings = [
        {
          filePath: "src/types.ts",
          line: 1,
          ruleId: "TS2322",
          message: "Type 'string' is not assignable to type 'number'.",
          category: "typescript" as const,
        },
      ];
      const repaired = repairFileContent(code, findings);
      expect(repaired).toContain("// @ts-expect-error [autoremediator-heal]: TS2322");
      expect(repaired).toContain('const x: number = "hello";');
    });
  });

  describe("healPullRequest flow", () => {
    it("fetches broken file from PR branch, repairs it, and pushes commit", async () => {
      const createComment = vi.fn().mockResolvedValue({});
      const addLabels = vi.fn().mockResolvedValue({});
      const getContent = vi.fn().mockResolvedValue({
        data: {
          content: Buffer.from(
            `import chalk from "chalk";\nconsole.log(chalk.red("test"));\n`,
            "utf8",
          ).toString("base64"),
          sha: "blob-sha-1234",
        },
      });
      const createOrUpdateFileContents = vi.fn().mockResolvedValue({});

      const octokit = {
        issues: {
          createComment,
          addLabels,
        },
        repos: {
          getContent,
          createOrUpdateFileContents,
        },
      } as any;

      const result = await healPullRequest({
        octokit,
        owner: "test-owner",
        repo: "test-repo",
        pullNumber: 42,
        branchName: "autoremediator/cve-2026-1234",
        checkRunName: "build-and-test",
        diagnostic: {
          findings: [
            {
              filePath: "src/app.ts",
              message: "Module 'chalk' has no default export. TS2614",
              category: "typescript",
            },
          ],
          summary: "Found 1 diagnostic failure(s)",
          rawSnippet: "error TS2614",
        },
        repoConfig: {
          ...DEFAULT_REPO_CONFIG,
          enablePrAutoHealing: true,
          maxHealingAttempts: 3,
        },
      });

      expect(result.healed).toBe(true);
      expect(result.attempt).toBe(1);
      expect(result.maxAttempts).toBe(3);
      expect(result.actionTaken).toBe("applied-healing-commit");
      expect(result.healedFiles).toEqual(["src/app.ts"]);

      // Verify getContent was called on target file and branch
      expect(getContent).toHaveBeenCalledWith({
        owner: "test-owner",
        repo: "test-repo",
        path: "src/app.ts",
        ref: "autoremediator/cve-2026-1234",
      });

      // Verify healing commit was pushed with new content
      expect(createOrUpdateFileContents).toHaveBeenCalledTimes(1);
      const commitArgs = createOrUpdateFileContents.mock.calls[0][0];
      expect(commitArgs.branch).toBe("autoremediator/cve-2026-1234");
      expect(commitArgs.sha).toBe("blob-sha-1234");
      const decodedContent = Buffer.from(commitArgs.content, "base64").toString("utf8");
      expect(decodedContent).toContain('import * as chalk from "chalk";');

      // Verify PR comment
      expect(createComment).toHaveBeenCalledWith(
        expect.objectContaining({
          issue_number: 42,
          body: expect.stringContaining("Attempt 1/3"),
        }),
      );
    });

    it("escalates to human review when maximum healing attempts is reached", async () => {
      const createComment = vi.fn().mockResolvedValue({});
      const addLabels = vi.fn().mockResolvedValue({});
      const octokit = {
        issues: {
          createComment,
          addLabels,
        },
      } as any;

      const repoConfig = {
        ...DEFAULT_REPO_CONFIG,
        enablePrAutoHealing: true,
        maxHealingAttempts: 2,
      };

      const key = "test-owner/test-repo#42";
      // Simulate attempts reached
      const diagnostic = {
        findings: [{ filePath: "src/app.ts", message: "fail", category: "typescript" as const }],
        summary: "error",
        rawSnippet: "err",
      };

      // Attempt 1 & 2
      await healPullRequest({
        octokit: {
          ...octokit,
          repos: {
            getContent: vi.fn().mockRejectedValue(new Error("skip")),
          },
        },
        owner: "test-owner",
        repo: "test-repo",
        pullNumber: 42,
        branchName: "autoremediator/cve-2026-1234",
        checkRunName: "build",
        diagnostic,
        repoConfig,
      });

      await healPullRequest({
        octokit: {
          ...octokit,
          repos: {
            getContent: vi.fn().mockRejectedValue(new Error("skip")),
          },
        },
        owner: "test-owner",
        repo: "test-repo",
        pullNumber: 42,
        branchName: "autoremediator/cve-2026-1234",
        checkRunName: "build",
        diagnostic,
        repoConfig,
      });

      // Attempt 3 (exceeds maxAttempts: 2)
      const result = await healPullRequest({
        octokit,
        owner: "test-owner",
        repo: "test-repo",
        pullNumber: 42,
        branchName: "autoremediator/cve-2026-1234",
        checkRunName: "build",
        diagnostic,
        repoConfig,
      });

      expect(result.healed).toBe(false);
      expect(result.actionTaken).toBe("commented-human-review");
      expect(result.reason).toContain("Maximum healing attempts reached");
      expect(addLabels).toHaveBeenCalledWith({
        owner: "test-owner",
        repo: "test-repo",
        issue_number: 42,
        labels: ["autoremediator/needs-human-review"],
      });
    });

    it("escalates to human review when diagnostics cannot be repaired", async () => {
      const createComment = vi.fn().mockResolvedValue({});
      const addLabels = vi.fn().mockResolvedValue({});
      const getContent = vi.fn().mockResolvedValue({
        data: {
          content: Buffer.from("const a = 1;\n", "utf8").toString("base64"),
          sha: "sha-1",
        },
      });

      const octokit = {
        issues: {
          createComment,
          addLabels,
        },
        repos: {
          getContent,
        },
      } as any;

      const result = await healPullRequest({
        octokit,
        owner: "test-owner",
        repo: "test-repo",
        pullNumber: 42,
        branchName: "autoremediator/cve-2026-1234",
        checkRunName: "custom-gate",
        diagnostic: {
          findings: [
            {
              filePath: "src/a.ts",
              message: "unrepairable obscure error",
              category: "general",
            },
          ],
          summary: "Unknown failure",
          rawSnippet: "raw",
        },
        repoConfig: {
          ...DEFAULT_REPO_CONFIG,
          enablePrAutoHealing: true,
          maxHealingAttempts: 3,
        },
      });

      expect(result.healed).toBe(false);
      expect(result.actionTaken).toBe("commented-human-review");
      expect(addLabels).toHaveBeenCalledWith({
        owner: "test-owner",
        repo: "test-repo",
        issue_number: 42,
        labels: ["autoremediator/needs-human-review"],
      });
    });
  });
});
