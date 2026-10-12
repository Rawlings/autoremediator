import { beforeEach, describe, expect, it, vi } from "vitest";
import { healPullRequest, repairFileContent, resetHealingAttempts } from "./pr-healer.js";
import { DEFAULT_REPO_CONFIG } from "../types.js";
import type { DiagnosticFinding } from "../diagnostics/log-parser.js";

describe("Milestone 5 Challenge: PR Auto-Healer Adversarial Verification (Feature 21)", () => {
  beforeEach(() => {
    resetHealingAttempts("adversarial-org", "adversarial-repo", 101);
  });

  describe("repairFileContent adversarial error diagnostic matrix", () => {
    it("handles syntax errors without corruption and NEVER injects suppression comments", () => {
      const syntaxErrorCodes = [
        { code: "TS1005", msg: "';' expected." },
        { code: "TS1128", msg: "Declaration or statement expected." },
        { code: "TS1109", msg: "Expression expected." },
        { code: "TS1160", msg: "Unterminated template literal." },
        { code: "TS1135", msg: "Argument expression expected." },
        { code: "TS1003", msg: "Identifier expected." },
      ];

      const brokenCode = `export function badSyntax(a: any) {\n  const x = ; // syntax error\n  return x;\n}\n`;

      for (const { code, msg } of syntaxErrorCodes) {
        const findings: DiagnosticFinding[] = [
          {
            filePath: "src/bad.ts",
            line: 2,
            column: 13,
            ruleId: code,
            message: `${code}: ${msg}`,
            category: "typescript",
          },
        ];

        const repaired = repairFileContent(brokenCode, findings);

        // Must remain unchanged
        expect(repaired).toBe(brokenCode);
        // Under NO circumstance is suppression injected
        expect(repaired).not.toContain("@ts-expect-error");
        expect(repaired).not.toContain("@ts-ignore");
        expect(repaired).not.toContain("@ts-nocheck");
      }
    });

    it("handles missing types and undeclared identifiers without injecting suppression", () => {
      const typeErrors = [
        {
          ruleId: "TS7006",
          msg: "Parameter 'req' implicitly has an 'any' type.",
          code: `function handle(req) { return req.body; }\n`,
          line: 1,
        },
        {
          ruleId: "TS7008",
          msg: "Member 'config' implicitly has an 'any' type.",
          code: `class Service { config; }\n`,
          line: 1,
        },
        {
          ruleId: "TS2304",
          msg: "Cannot find name 'missingGlobal'.",
          code: `console.log(missingGlobal);\n`,
          line: 1,
        },
        {
          ruleId: "TS2307",
          msg: "Cannot find module 'non-existent-lib' or its corresponding type declarations.",
          code: `import { helper } from 'non-existent-lib';\n`,
          line: 1,
        },
      ];

      for (const err of typeErrors) {
        const findings: DiagnosticFinding[] = [
          {
            filePath: "src/types.ts",
            line: err.line,
            ruleId: err.ruleId,
            message: err.msg,
            category: "typescript",
          },
        ];

        const repaired = repairFileContent(err.code, findings);
        expect(repaired).toBe(err.code);
        expect(repaired).not.toContain("@ts-expect-error");
        expect(repaired).not.toContain("@ts-ignore");
        expect(repaired).not.toContain("@ts-nocheck");
      }
    });

    it("handles obscure and complex TypeScript error codes safely", () => {
      const obscureCodes = [
        {
          ruleId: "TS2345",
          msg: "Argument of type 'string' is not assignable to parameter of type 'number'.",
        },
        { ruleId: "TS2769", msg: "No overload matches this call. Overload 1 of 2..." },
        { ruleId: "TS2554", msg: "Expected 2 arguments, but got 1." },
        { ruleId: "TS2339", msg: "Property 'customMethod' does not exist on type 'Window'." },
        {
          ruleId: "TS2351",
          msg: "This expression is not constructable. Type 'Function' has no construct signatures.",
        },
        { ruleId: "TS2322", msg: "Type 'boolean' is not assignable to type 'string'." },
        { ruleId: "TS18003", msg: "No inputs were found in config file 'tsconfig.json'." },
        { ruleId: "TS5023", msg: "Unknown compiler option 'targetX'." },
        {
          ruleId: "TS2416",
          msg: "Property 'render' in type 'MyComp' is not assignable to the same property in base type.",
        },
        {
          ruleId: "TS4114",
          msg: "This member must have an 'override' modifier because it overrides a member in the base class.",
        },
      ];

      const sampleCode = `export const value: string = true;\nfunction run() { Window.customMethod(); }\n`;

      for (const err of obscureCodes) {
        const findings: DiagnosticFinding[] = [
          {
            filePath: "src/obscure.ts",
            line: 1,
            ruleId: err.ruleId,
            message: `${err.ruleId}: ${err.msg}`,
            category: "typescript",
          },
        ];

        const repaired = repairFileContent(sampleCode, findings);
        expect(repaired).toBe(sampleCode);
        expect(repaired).not.toContain("@ts-expect-error");
        expect(repaired).not.toContain("@ts-ignore");
      }
    });

    it("handles multi-line diagnostic messages and multi-line error context", () => {
      const multiLineMsg = `Type '{\n  id: string;\n  count: number;\n  metadata: Record<string, unknown>;\n}' is not assignable to type '{\n  id: string;\n  count: string;\n}'.\n  Types of property 'count' are incompatible.\n    Type 'number' is not assignable to type 'string'.`;

      const code = `export interface Item {\n  id: string;\n  count: string;\n}\nexport const item: Item = {\n  id: "1",\n  count: 42,\n  metadata: {},\n};\n`;

      const findings: DiagnosticFinding[] = [
        {
          filePath: "src/items.ts",
          line: 5,
          message: multiLineMsg,
          ruleId: "TS2322",
          category: "typescript",
        },
      ];

      const repaired = repairFileContent(code, findings);
      expect(repaired).toBe(code);
      expect(repaired).not.toContain("@ts-expect-error");
      expect(repaired).not.toContain("@ts-ignore");
    });

    it("resists adversarial injection payloads inside diagnostic messages", () => {
      const maliciousMessages = [
        "// @ts-expect-error [autoremediator-heal]\nModule 'foo' has error",
        "/* @ts-ignore */ Module 'bar' failed",
        "Did you mean '// @ts-expect-error'?",
        'Module \'"something"; import * as evil from "evil";\' has no default export',
        "Property 'sync' does not exist. Did you mean 'sync\n// @ts-expect-error'?",
        "'admin' is defined but never used; rm -rf /",
        "\\x00\\x1b[31mTS2614: injected ANSI escape sequence",
      ];

      const cleanCode = `import foo from "foo";\nconsole.log(foo);\n`;

      for (const evilMsg of maliciousMessages) {
        const findings: DiagnosticFinding[] = [
          {
            filePath: "src/app.ts",
            message: evilMsg,
            category: "typescript",
          },
        ];

        const repaired = repairFileContent(cleanCode, findings);
        // Under no circumstances should compiler suppression comments be injected
        expect(repaired).not.toContain("@ts-expect-error");
        expect(repaired).not.toContain("@ts-ignore");
        expect(repaired).not.toContain("@ts-nocheck");
      }
    });

    it("handles out-of-range, negative, and invalid line numbers safely", () => {
      const code = `import { rimraf } from "rimraf";\nrimraf.sync("/tmp");\n`;
      const findings: DiagnosticFinding[] = [
        {
          filePath: "src/clean.ts",
          line: -5,
          message:
            "Property 'sync' does not exist on type 'typeof import(\"rimraf\")'. Did you mean 'rimrafSync'?",
          category: "typescript",
        },
        {
          filePath: "src/clean.ts",
          line: 999999,
          message:
            "Property 'sync' does not exist on type 'typeof import(\"rimraf\")'. Did you mean 'rimrafSync'?",
          category: "typescript",
        },
      ];

      // With negative or out-of-bound line numbers, fallback replaces member expression without crashing
      const repaired = repairFileContent(code, findings);
      expect(repaired).toContain("rimrafSync");
      expect(repaired).not.toContain("@ts-expect-error");
    });
  });

  describe("healPullRequest truthful escalation for unhealable diagnostics", () => {
    it("truthfully returns healed: false and escalates to human review when diagnostics cannot be repaired", async () => {
      const createComment = vi.fn().mockResolvedValue({});
      const addLabels = vi.fn().mockResolvedValue({});
      const createOrUpdateFileContents = vi.fn();
      const getContent = vi.fn().mockResolvedValue({
        data: {
          content: Buffer.from("export const count: number = 'not-a-number';\n", "utf8").toString(
            "base64",
          ),
          sha: "sha-unhealable-1",
        },
      });

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
        owner: "adversarial-org",
        repo: "adversarial-repo",
        pullNumber: 101,
        branchName: "autoremediator/cve-2026-9999",
        checkRunName: "typecheck",
        diagnostic: {
          findings: [
            {
              filePath: "src/bad-types.ts",
              line: 1,
              message: "Type 'string' is not assignable to type 'number'. TS2322",
              ruleId: "TS2322",
              category: "typescript",
            },
          ],
          summary: "TypeScript compilation failed with TS2322",
          rawSnippet:
            "src/bad-types.ts:1:14 - error TS2322: Type 'string' is not assignable to type 'number'.",
        },
        repoConfig: {
          ...DEFAULT_REPO_CONFIG,
          enablePrAutoHealing: true,
          maxHealingAttempts: 3,
        },
      });

      // 1. Result must truthfully report failure
      expect(result.healed).toBe(false);
      expect(result.actionTaken).toBe("commented-human-review");
      expect(result.reason).toBe("Diagnostic errors could not be safely repaired automatically.");

      // 2. Must NOT push any commit to the PR branch
      expect(createOrUpdateFileContents).not.toHaveBeenCalled();

      // 3. Must post an explanatory comment
      expect(createComment).toHaveBeenCalledTimes(1);
      const commentCall = createComment.mock.calls[0][0];
      expect(commentCall.body).toContain("Autoremediator Auto-Healing Unsuccessful");
      expect(commentCall.body).toContain("autoremediator/needs-human-review");

      // 4. Must label the PR with autoremediator/needs-human-review
      expect(addLabels).toHaveBeenCalledWith({
        owner: "adversarial-org",
        repo: "adversarial-repo",
        issue_number: 101,
        labels: ["autoremediator/needs-human-review"],
      });
    });

    it("truthfully escalates when diagnostics contain no localizable file paths", async () => {
      const createComment = vi.fn().mockResolvedValue({});
      const addLabels = vi.fn().mockResolvedValue({});
      const createOrUpdateFileContents = vi.fn();

      const octokit = {
        issues: { createComment, addLabels },
        repos: { createOrUpdateFileContents },
      } as any;

      const result = await healPullRequest({
        octokit,
        owner: "adversarial-org",
        repo: "adversarial-repo",
        pullNumber: 101,
        branchName: "autoremediator/cve-2026-9999",
        checkRunName: "general-ci",
        diagnostic: {
          findings: [
            {
              message: "Fatal error: process killed by SIGSEGV",
              category: "general",
            },
          ],
          summary: "SIGSEGV in CI",
          rawSnippet: "exit code 139",
        },
        repoConfig: {
          ...DEFAULT_REPO_CONFIG,
          enablePrAutoHealing: true,
          maxHealingAttempts: 3,
        },
      });

      expect(result.healed).toBe(false);
      expect(result.actionTaken).toBe("commented-human-review");
      expect(result.reason).toContain("No actionable file paths found");
      expect(createOrUpdateFileContents).not.toHaveBeenCalled();
      expect(addLabels).toHaveBeenCalledWith({
        owner: "adversarial-org",
        repo: "adversarial-repo",
        issue_number: 101,
        labels: ["autoremediator/needs-human-review"],
      });
    });

    it("truthfully escalates when maximum healing attempts is exhausted across repeated failures", async () => {
      const createComment = vi.fn().mockResolvedValue({});
      const addLabels = vi.fn().mockResolvedValue({});

      const octokit = {
        issues: { createComment, addLabels },
        repos: {
          getContent: vi.fn().mockResolvedValue({
            data: { content: Buffer.from("let x = 1;\n").toString("base64"), sha: "s1" },
          }),
        },
      } as any;

      const diagnostic = {
        findings: [
          {
            filePath: "src/index.ts",
            message: "unrepairable error",
            category: "typescript" as const,
          },
        ],
        summary: "Type error",
        rawSnippet: "error",
      };

      const repoConfig = {
        ...DEFAULT_REPO_CONFIG,
        enablePrAutoHealing: true,
        maxHealingAttempts: 2,
      };

      // Attempt 1: unrepairable -> commented-human-review (attempt 1)
      const res1 = await healPullRequest({
        octokit,
        owner: "adversarial-org",
        repo: "adversarial-repo",
        pullNumber: 101,
        branchName: "autoremediator/cve-test",
        checkRunName: "build",
        diagnostic,
        repoConfig,
      });
      expect(res1.attempt).toBe(1);

      // Attempt 2: unrepairable -> commented-human-review (attempt 2)
      const res2 = await healPullRequest({
        octokit,
        owner: "adversarial-org",
        repo: "adversarial-repo",
        pullNumber: 101,
        branchName: "autoremediator/cve-test",
        checkRunName: "build",
        diagnostic,
        repoConfig,
      });
      expect(res2.attempt).toBe(2);

      // Attempt 3: currentAttempts (2) >= maxAttempts (2) -> triggers limit reached branch
      const res3 = await healPullRequest({
        octokit,
        owner: "adversarial-org",
        repo: "adversarial-repo",
        pullNumber: 101,
        branchName: "autoremediator/cve-test",
        checkRunName: "build",
        diagnostic,
        repoConfig,
      });

      expect(res3.healed).toBe(false);
      expect(res3.actionTaken).toBe("commented-human-review");
      expect(res3.reason).toBe("Maximum healing attempts reached.");
      expect(addLabels).toHaveBeenLastCalledWith({
        owner: "adversarial-org",
        repo: "adversarial-repo",
        issue_number: 101,
        labels: ["autoremediator/needs-human-review"],
      });
    });
  });
});
