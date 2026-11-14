import { describe, expect, it } from "vitest";

import { decideForCommand, guardExitCode, runClaudeCodeHook } from "./hook.js";
import type { GuardReport } from "./types.js";

const report = (verdict: GuardReport["verdict"], spec = "pkg"): GuardReport => ({
  schemaVersion: "1.0",
  spec,
  verdict,
  findings: verdict === "allow" ? [] : [{ check: "malware", severity: verdict === "block" ? "block" : "warn", message: "bad thing" }],
  ...(verdict === "block" ? { alternative: { packageName: "good", reason: "safer" } } : {}),
  generatedAt: "2026-01-01T00:00:00.000Z",
});

describe("decideForCommand", () => {
  it("lets non-install commands through without any lookup", async () => {
    let called = false;
    const decision = await decideForCommand("npm run build", async () => {
      called = true;
      return [];
    });
    expect(decision.decision).toBe("allow");
    expect(called).toBe(false);
  });

  it("denies when any package is blocked and names the alternative", async () => {
    const decision = await decideForCommand("npm i a b", async (specs) => specs.map((s) => report(s === "a" ? "block" : "allow", s)));
    expect(decision.decision).toBe("deny");
    expect(decision.reason).toContain("bad thing");
    expect(decision.reason).toContain("Instead: good");
  });

  it("asks when something only warns, and allows when clear", async () => {
    expect((await decideForCommand("npm i a", async () => [report("warn")])).decision).toBe("ask");
    expect((await decideForCommand("npm i a", async () => [report("allow")])).decision).toBe("allow");
  });

  it("checks at most ten packages", async () => {
    let seen = 0;
    await decideForCommand(`npm i ${Array.from({ length: 25 }, (_, i) => `p${i}`).join(" ")}`, async (specs) => {
      seen = specs.length;
      return [];
    });
    expect(seen).toBe(10);
  });
});

describe("runClaudeCodeHook", () => {
  const input = (command: string, tool = "Bash") => JSON.stringify({ tool_name: tool, tool_input: { command } });

  it("prints a Claude Code permission decision for a blocked install", async () => {
    const out = await runClaudeCodeHook(input("npm install evil"), async () => [report("block", "evil")]);
    const parsed = JSON.parse(out ?? "{}") as { hookSpecificOutput: Record<string, string> };
    expect(parsed.hookSpecificOutput).toMatchObject({ hookEventName: "PreToolUse", permissionDecision: "deny" });
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain("evil");
  });

  it("prints nothing when the command may proceed", async () => {
    await expect(runClaudeCodeHook(input("npm install fine"), async () => [report("allow")])).resolves.toBeUndefined();
    await expect(runClaudeCodeHook(input("ls"))).resolves.toBeUndefined();
  });

  it("ignores other tools, malformed input and its own failures instead of blocking the session", async () => {
    await expect(runClaudeCodeHook(input("npm i x", "Read"), async () => [report("block")])).resolves.toBeUndefined();
    await expect(runClaudeCodeHook("not json")).resolves.toBeUndefined();
    await expect(runClaudeCodeHook(JSON.stringify({ tool_name: "Bash" }))).resolves.toBeUndefined();
    await expect(
      runClaudeCodeHook(input("npm i x"), async () => {
        throw new Error("boom");
      }),
    ).resolves.toBeUndefined();
  });
});

describe("guardExitCode", () => {
  it("is 0 clear, 3 warn, 4 block, worst wins", () => {
    expect(guardExitCode([report("allow")])).toBe(0);
    expect(guardExitCode([report("allow"), report("warn")])).toBe(3);
    expect(guardExitCode([report("warn"), report("block")])).toBe(4);
  });
});
