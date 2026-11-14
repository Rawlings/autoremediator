import { describe, expect, it } from "vitest";

import { commandFromHookInput, decideForCommand, guardExitCode, runClaudeCodeHook, runHostHook } from "./hook.js";
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

describe("runHostHook", () => {
  const cursorInput = (command: string) => JSON.stringify({ hook_event_name: "beforeShellExecution", command, cwd: "/work" });
  const copilotInput = (command: string, tool = "bash") =>
    JSON.stringify({ sessionId: "s", timestamp: 1, cwd: "/work", toolName: tool, toolArgs: JSON.stringify({ command }) });
  const copilotVsCodeInput = (command: string) =>
    JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } });

  it("answers Cursor with its permission schema, and always with JSON", async () => {
    const deny = JSON.parse((await runHostHook("cursor", cursorInput("npm i evil"), async () => [report("block", "evil")])) ?? "") as Record<string, string>;
    expect(deny).toMatchObject({ permission: "deny" });
    expect(deny.user_message).toContain("evil");
    expect(deny.agent_message).toContain("Instead: good");

    const ask = JSON.parse((await runHostHook("cursor", cursorInput("npm i x"), async () => [report("warn")])) ?? "") as Record<string, string>;
    expect(ask.permission).toBe("ask");

    for (const stdin of [cursorInput("npm i fine"), cursorInput("ls"), "not json", JSON.stringify({})]) {
      const out = await runHostHook("cursor", stdin, async () => [report("allow")]);
      expect(JSON.parse(out ?? "")).toEqual({ permission: "allow" });
    }
    const failed = await runHostHook("cursor", cursorInput("npm i x"), async () => {
      throw new Error("boom");
    });
    expect(JSON.parse(failed ?? "")).toEqual({ permission: "allow" });
  });

  it("answers Copilot with a top-level permission decision and prints nothing to allow", async () => {
    const deny = JSON.parse((await runHostHook("copilot", copilotInput("npm i evil"), async () => [report("block", "evil")])) ?? "") as Record<string, string>;
    expect(deny.permissionDecision).toBe("deny");
    expect(deny.permissionDecisionReason).toContain("evil");
    expect(Object.keys(deny).toSorted()).toEqual(["permissionDecision", "permissionDecisionReason"]);

    const ask = JSON.parse((await runHostHook("copilot", copilotInput("npm i x"), async () => [report("warn")])) ?? "") as Record<string, string>;
    expect(ask.permissionDecision).toBe("ask");

    await expect(runHostHook("copilot", copilotInput("npm i fine"), async () => [report("allow")])).resolves.toBeUndefined();
    await expect(runHostHook("copilot", copilotInput("ls"))).resolves.toBeUndefined();
    await expect(runHostHook("copilot", "not json")).resolves.toBeUndefined();
  });

  it("reads Copilot's PascalCase alias and object-valued arguments, and only shell tools", async () => {
    const out = await runHostHook("copilot", copilotVsCodeInput("pnpm add evil"), async () => [report("block", "evil")]);
    expect(JSON.parse(out ?? "")).toMatchObject({ permissionDecision: "deny" });

    const objectArgs = JSON.stringify({ toolName: "powershell", toolArgs: { command: "npm i evil" } });
    expect(JSON.parse((await runHostHook("copilot", objectArgs, async () => [report("block", "evil")])) ?? "")).toMatchObject({
      permissionDecision: "deny",
    });

    let called = false;
    await runHostHook("copilot", copilotInput("npm i evil", "edit"), async () => {
      called = true;
      return [report("block")];
    });
    expect(called).toBe(false);
  });

  it("keeps Claude Code's output exactly as before", async () => {
    const input = JSON.stringify({ tool_name: "Bash", tool_input: { command: "npm install evil" } });
    const viaHost = await runHostHook("claude-code", input, async () => [report("block", "evil")]);
    const direct = await runClaudeCodeHook(input, async () => [report("block", "evil")]);
    expect(viaHost).toBe(direct);
    await expect(runHostHook("claude-code", input, async () => [report("allow")])).resolves.toBeUndefined();
  });
});

describe("commandFromHookInput", () => {
  it("finds the command in each host's payload", () => {
    expect(commandFromHookInput("claude-code", { tool_name: "Bash", tool_input: { command: "a" } })).toBe("a");
    expect(commandFromHookInput("claude-code", { tool_name: "Edit", tool_input: { command: "a" } })).toBeUndefined();
    expect(commandFromHookInput("cursor", { command: "b" })).toBe("b");
    expect(commandFromHookInput("copilot", { toolName: "bash", toolArgs: '{"command":"c"}' })).toBe("c");
    expect(commandFromHookInput("copilot", { toolName: "bash", toolArgs: "not json" })).toBeUndefined();
  });
});
