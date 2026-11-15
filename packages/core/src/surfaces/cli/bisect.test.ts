import { describe, expect, it } from "vitest";

import type { BisectReport } from "../../api/index.js";
import { getOperation } from "../catalog/index.js";
import { describeBisect } from "./bisect.js";
import { createProgram } from "./program.js";

const report: BisectReport = {
  schemaVersion: "1",
  status: "culprit",
  summary:
    "leaf-b 1.0.0 -> 1.1.0 (transitive) breaks the command. Holding it at 1.0.0 makes it pass.",
  good: { ref: "v1", commit: "a".repeat(40) },
  bad: { ref: "HEAD", commit: "b".repeat(40) },
  packageManager: "npm",
  lockfile: "package-lock.json",
  command: "npm test",
  updates: [
    {
      packageName: "leaf-a",
      fromVersion: "1.0.0",
      toVersion: "1.0.1",
      dependencyScope: "transitive",
    },
    {
      packageName: "leaf-b",
      fromVersion: "1.0.0",
      toVersion: "1.1.0",
      dependencyScope: "transitive",
    },
  ],
  skipped: [
    { packageName: "new", fromVersions: [], toVersions: ["1.0.0"], reason: "added at the bad ref" },
  ],
  culprits: [
    {
      packageName: "leaf-b",
      fromVersion: "1.0.0",
      toVersion: "1.1.0",
      dependencyScope: "transitive",
    },
  ],
  holdingBackFixes: true,
  steps: [
    {
      step: 1,
      kind: "good-ref",
      updated: [],
      outcome: "pass",
      phase: "command",
      run: { command: "npm test", exitCode: 0, durationMs: 800, timedOut: false },
      outputTail: "ok",
    },
    {
      step: 2,
      kind: "bad-ref",
      updated: ["leaf-a", "leaf-b"],
      outcome: "fail",
      phase: "command",
      run: { command: "npm test", exitCode: 1, durationMs: 900, timedOut: true },
      outputTail: "TypeError: x is not a function\n    at foo",
      note: "the command was killed after 3s and counts as failing",
    },
    {
      step: 3,
      kind: "subset",
      updated: ["leaf-b"],
      outcome: "fail",
      phase: "command",
      run: { command: "npm test", exitCode: 1, durationMs: 700, timedOut: false },
      outputTail: "TypeError",
    },
  ],
  stepsUsed: 1,
  maxSteps: 30,
  remedy: {
    pins: [{ packageName: "leaf-b", version: "1.0.0", strategy: "override" }],
    runId: "run_x",
    planId: "plan_y",
    nextCommands: [
      "autoremediator runs show run_x",
      "autoremediator runs apply run_x",
      "autoremediator runs rollback run_x",
    ],
    notPlanned: [],
  },
  warnings: [],
  startedAt: "2026-01-01T00:00:00.000Z",
  durationMs: 3000,
};

describe("describeBisect", () => {
  it("shows each step, the verdict, the failing output and how to apply the plan", () => {
    const text = describeBisect(report);
    expect(text).toContain("aaaaaaaaaaaa..bbbbbbbbbbbb");
    expect(text).toContain("1 not testable one by one");
    expect(text).toMatch(/1\. pass\s+good ref\s+\[exit 0, 0\.8s\]/);
    expect(text).toMatch(/2\. fail\s+bad ref\s+\[exit 1, timed out, 0\.9s\]/);
    expect(text).toContain("good ref + 1 update(s): leaf-b");
    expect(text).toContain("the command was killed after 3s");
    expect(text).toContain("  | TypeError: x is not a function");
    expect(text).toContain("Pin back: leaf-b@1.0.0 (override)");
    expect(text).toContain("nothing was changed");
    expect(text).toContain("Apply:  autoremediator runs apply run_x");
  });
});

describe("bisect surfaces", () => {
  it("is a CLI command with the required refs and command", () => {
    const command = createProgram().commands.find((candidate) => candidate.name() === "bisect");
    expect(command).toBeDefined();
    const flags = command?.options.map((option) => option.long);
    expect(flags).toEqual(
      expect.arrayContaining([
        "--good",
        "--bad",
        "--command",
        "--timeout",
        "--max-steps",
        "--package-manager",
        "--ignore-scripts",
        "--apply",
        "--cwd",
        "--output-format",
      ]),
    );
    expect(command?.options.find((option) => option.long === "--good")?.mandatory).toBe(true);
    expect(command?.options.find((option) => option.long === "--command")?.mandatory).toBe(true);
  });

  it("is a catalog operation for the CLI and SDK only: it runs arbitrary commands, so no MCP tool and no HTTP route", () => {
    const operation = getOperation("bisectLockfile");
    expect(operation).toBeDefined();
    expect(operation?.mcp).toBe(false);
    expect(operation?.http).toBeUndefined();
    expect(operation?.input.safeParse({ good: "v1", command: "npm test" }).success).toBe(true);
    expect(operation?.input.safeParse({ command: "npm test" }).success).toBe(false);
    expect(operation?.input.safeParse({ good: "v1", command: "x", surprise: 1 }).success).toBe(
      false,
    );
  });
});
