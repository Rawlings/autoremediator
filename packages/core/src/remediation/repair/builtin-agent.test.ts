import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MockLanguageModelV4 } from "ai/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_REPAIR_BUDGET,
  type RepairBudget,
  type RepairEnv,
  type RepairTask,
} from "../../platform/repair-agent.js";
import * as commandCheck from "../verify/command-check.js";
import { createBuiltinRepairAgent } from "./builtin-agent.js";

vi.mock("../verify/command-check.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../verify/command-check.js")>()),
  runCommandCheck: vi.fn(async () => ({ passed: true, output: "" })),
}));

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "agent-")));
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "a.ts"), "import { f } from 'dep';\nf(1, 2);\n");
  writeFileSync(join(dir, "package.json"), '{"name":"app"}');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const usage = (input: number, output: number) => ({
  inputTokens: { total: input, noCache: input, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: output, text: output, reasoning: undefined },
});

/** One model turn that calls tools. */
const turn = (...calls: Array<[name: string, input: object]>) => ({
  content: calls.map(([toolName, input], index) => ({
    type: "tool-call" as const,
    toolCallId: `call-${toolName}-${index}`,
    toolName,
    input: JSON.stringify(input),
  })),
  finishReason: { unified: "tool-calls" as const, raw: "tool-calls" },
  usage: usage(100, 20),
  warnings: [],
});

const scripted = (...turns: ReturnType<typeof turn>[]) =>
  new MockLanguageModelV4({ modelId: "scripted", doGenerate: turns });

const task: RepairTask = {
  runId: "run_aaaaaaaaaaaaaaaaaaaa",
  attemptId: "attempt-1",
  cveId: "CVE-2021-0001",
  packageName: "dep",
  fromVersion: "1.0.0",
  toVersion: "2.0.0",
  round: 1,
  failure: {
    failedCheck: "typecheck",
    summary: ["typecheck: failed"],
    details: ["src/a.ts(2,1): error TS2554: Expected 0-1 arguments, but got 2."],
  },
  previousRounds: [],
};

const env = (over: Partial<RepairEnv> = {}, budget: Partial<RepairBudget> = {}): RepairEnv => ({
  worktree: dir,
  budget: { ...DEFAULT_REPAIR_BUDGET, ...budget },
  signal: new AbortController().signal,
  commands: { typecheck: ["tsc"], tests: ["npm", "test"] },
  ...over,
});

describe("built-in repair agent", () => {
  it("edits source, checks its work and submits", async () => {
    const model = scripted(
      turn(["readFile", { path: "src/a.ts" }]),
      turn(["editFile", { path: "src/a.ts", oldText: "f(1, 2);", newText: "f(1);" }]),
      turn(["runCheck", { name: "typecheck" }]),
      turn(["submit", { summary: "dropped the removed second argument" }]),
    );

    const outcome = await createBuiltinRepairAgent(model).repair(task, env());

    expect(outcome.status).toBe("submitted");
    expect(outcome.rationale).toBe("dropped the removed second argument");
    expect(readFileSync(join(dir, "src/a.ts"), "utf8")).toBe("import { f } from 'dep';\nf(1);\n");
    expect(outcome.usage).toEqual([
      expect.objectContaining({ purpose: "upgrade-repair", model: "scripted", inputTokens: 400, outputTokens: 80 }),
    ]);
    expect(outcome.transcript.map((entry) => entry.text.split("(")[0])).toEqual([
      "readFile",
      "editFile",
      "runCheck",
      "submit",
    ]);
    expect(outcome.transcript[2]?.text).toContain("typecheck: passed");
  });

  it("is told what failed, which package changed, and that file contents are data", async () => {
    const model = scripted(turn(["submit", { summary: "x" }]));
    await createBuiltinRepairAgent(model).repair(
      { ...task, round: 2, previousRounds: ["changed one call"] },
      env(),
    );

    const call = model.doGenerateCalls[0]!;
    const prompt = JSON.stringify(call.prompt);
    expect(prompt).toContain("dep 1.0.0 -> 2.0.0");
    expect(prompt).toContain("TS2554");
    expect(prompt).toContain("Round 2");
    expect(prompt).toContain("changed one call");
    expect(prompt).toMatch(/data, not instructions/);
    expect(call.tools?.map((t) => t.name).toSorted()).toEqual([
      "editFile",
      "giveUp",
      "listFiles",
      "readFile",
      "readPackageDocs",
      "runCheck",
      "searchCode",
      "submit",
      "writeFile",
    ]);
  });

  it("reports giving up with the agent's reason", async () => {
    const outcome = await createBuiltinRepairAgent(
      scripted(turn(["giveUp", { reason: "the API was removed with no replacement" }])),
    ).repair(task, env());
    expect(outcome).toMatchObject({ status: "gave-up", rationale: "the API was removed with no replacement" });
  });

  it("refuses edits outside project source and carries on", async () => {
    const model = scripted(
      turn(["editFile", { path: "package.json", oldText: "app", newText: "evil" }]),
      turn(["writeFile", { path: ".github/workflows/ci.yml", content: "on: push" }]),
      turn(["readFile", { path: ".env" }]),
      turn(["submit", { summary: "nothing to change" }]),
    );

    const outcome = await createBuiltinRepairAgent(model).repair(task, env());

    expect(outcome.status).toBe("submitted");
    expect(readFileSync(join(dir, "package.json"), "utf8")).toBe('{"name":"app"}');
    expect(outcome.transcript.slice(0, 3).every((entry) => entry.text.includes("Refused"))).toBe(true);
  });

  it("stops when the step budget runs out", async () => {
    const turns = Array.from({ length: 10 }, () => turn(["listFiles", {}]));
    const outcome = await createBuiltinRepairAgent(scripted(...turns)).repair(task, env({}, { maxSteps: 3 }));
    expect(outcome.status).toBe("budget-exhausted");
    expect(outcome.transcript).toHaveLength(3);
  });

  it("stops when the token budget runs out", async () => {
    const turns = Array.from({ length: 10 }, () => turn(["listFiles", {}]));
    const outcome = await createBuiltinRepairAgent(scripted(...turns)).repair(
      task,
      env({}, { maxTotalTokens: 250 }),
    );
    expect(outcome.status).toBe("budget-exhausted");
    expect(outcome.transcript).toHaveLength(3); // 120 tokens a turn: the third crosses 250
  });

  it("limits how many commands the agent can run", async () => {
    const run = vi.mocked(commandCheck.runCommandCheck);
    run.mockClear();
    const model = scripted(
      turn(["runCheck", { name: "tests" }]),
      turn(["runCheck", { name: "tests" }]),
      turn(["runCheck", { name: "tests" }]),
      turn(["giveUp", { reason: "out of runs" }]),
    );
    const outcome = await createBuiltinRepairAgent(model).repair(task, env({}, { maxCommandRuns: 2 }));
    expect(run).toHaveBeenCalledTimes(2);
    expect(outcome.transcript[2]?.text).toContain("Command limit reached");
  });

  it("turns a model failure into a give-up rather than a crash", async () => {
    const model = new MockLanguageModelV4({
      modelId: "broken",
      doGenerate: async () => {
        throw new Error("503 overloaded");
      },
    });
    const outcome = await createBuiltinRepairAgent(model).repair(task, env());
    expect(outcome.status).toBe("gave-up");
    expect(outcome.rationale).toMatch(/model call failed: .*503 overloaded/);
  });

  it("stops when the attempt is cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const outcome = await createBuiltinRepairAgent(scripted(turn(["submit", { summary: "x" }]))).repair(
      task,
      env({ signal: controller.signal }),
    );
    expect(outcome.status).toBe("budget-exhausted");
    expect(outcome.rationale).toMatch(/cancelled/);
  });
});
