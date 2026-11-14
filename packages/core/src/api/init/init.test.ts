import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getOperation, OPERATIONS } from "../../catalog/index.js";
import { loadPolicy } from "../../platform/policy.js";
import {
  AGENTS_MD_SECTION,
  copilotAgentContent,
  cursorRuleContent,
  INSTRUCTED_TOOLS,
  policyFileContent,
  renderSkill,
  SKILLS,
} from "./assets.js";
import { chooseHosts, detectProject, gitHostFromRemote } from "./detect.js";
import { renderDiff } from "./diff.js";
import { init } from "./index.js";
import {
  mergeClaudeGuardHook,
  mergeCodexToml,
  mergeGitignore,
  mergeJsonMcpConfig,
  mergeMarkedSection,
} from "./merge.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "init-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function put(path: string, content: string): void {
  const target = join(dir, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}
const read = (path: string): string => readFileSync(join(dir, path), "utf8");

const ENTRY = { command: "npx", args: ["-y", "-p", "autoremediator", "autoremediator-mcp"] };

describe("mergeJsonMcpConfig", () => {
  it("creates a config with the server", () => {
    const merged = mergeJsonMcpConfig(undefined, "mcpServers", ENTRY);
    expect(merged).toHaveProperty("content");
    expect(JSON.parse((merged as { content: string }).content)).toEqual({
      mcpServers: { autoremediator: ENTRY },
    });
  });

  it("keeps other servers and unrelated keys, and the file's indentation", () => {
    const existing = JSON.stringify({ other: 1, mcpServers: { github: { command: "gh" } } }, null, 4);
    const merged = mergeJsonMcpConfig(existing, "mcpServers", ENTRY) as { content: string };
    const parsed = JSON.parse(merged.content);
    expect(parsed.other).toBe(1);
    expect(parsed.mcpServers.github).toEqual({ command: "gh" });
    expect(parsed.mcpServers.autoremediator).toEqual(ENTRY);
    expect(merged.content).toContain('\n    "other"');
  });

  it("never overwrites an existing autoremediator entry", () => {
    const custom = { command: "node", args: ["x.js"], env: { A: "1" } };
    const existing = JSON.stringify({ mcpServers: { autoremediator: custom } });
    const merged = mergeJsonMcpConfig(existing, "mcpServers", ENTRY) as { content: string };
    expect(JSON.parse(merged.content).mcpServers.autoremediator).toEqual(custom);
  });

  it("adds the host-specific type field", () => {
    const merged = mergeJsonMcpConfig(undefined, "servers", ENTRY, { type: "stdio" }) as { content: string };
    expect(JSON.parse(merged.content).servers.autoremediator).toEqual({ type: "stdio", ...ENTRY });
  });

  it("refuses files it cannot parse or that have the wrong shape", () => {
    expect(mergeJsonMcpConfig("{ not json", "mcpServers", ENTRY)).toHaveProperty("conflict");
    expect(mergeJsonMcpConfig("[]", "mcpServers", ENTRY)).toHaveProperty("conflict");
    expect(mergeJsonMcpConfig('{"mcpServers": []}', "mcpServers", ENTRY)).toHaveProperty("conflict");
  });
});

describe("mergeCodexToml", () => {
  it("appends a table and keeps existing settings", () => {
    const merged = mergeCodexToml('model = "x"\n', ENTRY) as { content: string };
    expect(merged.content.startsWith('model = "x"\n')).toBe(true);
    expect(merged.content).toContain("[mcp_servers.autoremediator]");
    expect(merged.content).toContain('args = ["-y", "-p", "autoremediator", "autoremediator-mcp"]');
  });

  it("leaves a file that already has the table untouched", () => {
    const existing = '[mcp_servers.autoremediator]\ncommand = "custom"\n';
    expect(mergeCodexToml(existing, ENTRY)).toEqual({ content: existing });
  });
});

describe("mergeMarkedSection", () => {
  it("appends after existing text", () => {
    const merged = mergeMarkedSection("# Guide\n", "body") as { content: string };
    expect(merged.content.startsWith("# Guide\n\n<!-- autoremediator:begin -->")).toBe(true);
  });

  it("replaces only what is between the markers", () => {
    const first = (mergeMarkedSection("before\n", "one") as { content: string }).content;
    const second = (mergeMarkedSection(`${first}after\n`, "two") as { content: string }).content;
    expect(second).toContain("before");
    expect(second).toContain("two");
    expect(second).not.toContain("one");
    expect(second.endsWith("after\n")).toBe(true);
  });

  it("is stable when run twice", () => {
    const once = (mergeMarkedSection("x\n", "body") as { content: string }).content;
    expect(mergeMarkedSection(once, "body")).toEqual({ content: once });
  });

  it("refuses an unmatched marker", () => {
    expect(mergeMarkedSection("<!-- autoremediator:begin -->\nx", "body")).toHaveProperty("conflict");
  });
});

describe("mergeClaudeGuardHook", () => {
  it("creates settings with the hook", () => {
    const merged = mergeClaudeGuardHook(undefined, "cmd guard-hook") as { content: string };
    expect(JSON.parse(merged.content).hooks.PreToolUse[0].hooks[0].command).toBe("cmd guard-hook");
  });
  it("refuses shapes it cannot extend", () => {
    expect(mergeClaudeGuardHook("{bad", "x")).toHaveProperty("conflict");
    expect(mergeClaudeGuardHook('{"hooks":[]}', "x")).toHaveProperty("conflict");
    expect(mergeClaudeGuardHook('{"hooks":{"PreToolUse":{}}}', "x")).toHaveProperty("conflict");
  });
});

describe("mergeGitignore", () => {
  it("adds the entry once", () => {
    const once = (mergeGitignore("node_modules/\n", [".autoremediator/"]) as { content: string }).content;
    expect(once).toBe("node_modules/\n.autoremediator/\n");
    expect(mergeGitignore(once, [".autoremediator/"])).toEqual({ content: once });
  });

  it("accepts the entry without a trailing slash", () => {
    expect(mergeGitignore(".autoremediator\n", [".autoremediator/"])).toEqual({ content: ".autoremediator\n" });
  });

  it("starts a new line when the file lacks a final newline", () => {
    expect(mergeGitignore("dist", [".autoremediator/"])).toEqual({ content: "dist\n.autoremediator/\n" });
  });
});

describe("renderDiff", () => {
  it("shows additions and removals", () => {
    const diff = renderDiff("a.txt", "one\ntwo\n", "one\nthree\n");
    expect(diff).toContain("-two");
    expect(diff).toContain("+three");
    expect(diff).toContain(" one");
  });
  it("is empty when nothing changed", () => {
    expect(renderDiff("a", "x\n", "x\n")).toBe("");
  });
});

describe("detection", () => {
  it("classifies git remotes", () => {
    expect(gitHostFromRemote("git@github.com:o/r.git")).toBe("github");
    expect(gitHostFromRemote("https://gitlab.com/o/r")).toBe("gitlab");
    expect(gitHostFromRemote("https://bitbucket.org/o/r")).toBe("bitbucket");
    expect(gitHostFromRemote("https://dev.azure.com/o/p/_git/r")).toBe("azure-devops");
    expect(gitHostFromRemote("https://git.example.com/r")).toBe("other");
    expect(gitHostFromRemote(undefined)).toBe("none");
  });

  it("finds package manager, CI, hosts and model variable names, never values", async () => {
    put("pnpm-lock.yaml", "");
    put(".github/workflows/ci.yml", "");
    put(".cursor/rules/x.mdc", "");
    put("tsconfig.json", "{}");
    const facts = await detectProject(dir, { PATH: "", ANTHROPIC_API_KEY: "sk-secret-value" });
    expect(facts.packageManager).toBe("pnpm");
    expect(facts.ci).toEqual(["github-actions"]);
    expect(facts.hostsInProject).toEqual(["cursor"]);
    expect(facts.hasTsconfig).toBe(true);
    expect(facts.modelEnv).toEqual(["ANTHROPIC_API_KEY"]);
    expect(JSON.stringify(facts)).not.toContain("sk-secret-value");
  });

  it("prefers requested hosts, then hosts in the project, then installed ones", () => {
    const facts = {
      hostsInProject: ["cursor"],
      hostsOnPath: ["codex"],
    } as Parameters<typeof chooseHosts>[0];
    expect(chooseHosts(facts, ["vscode", "vscode"])).toEqual(["vscode"]);
    expect(chooseHosts(facts)).toEqual(["cursor"]);
    expect(chooseHosts({ ...facts, hostsInProject: [] })).toEqual(["codex"]);
  });
});

describe("init", () => {
  it("reports without writing unless asked", async () => {
    const result = await init({ cwd: dir, hosts: ["cursor", "vscode"] });
    expect(result.applied).toBe(false);
    expect(result.drift).toBe(true);
    expect(result.changes.every((change) => change.action !== "update" || change.diff !== "")).toBe(true);
    expect(existsSync(join(dir, ".cursor"))).toBe(false);
    expect(existsSync(join(dir, ".github"))).toBe(false);
  });

  it("writes every file for the chosen hosts, and is then idempotent", async () => {
    const result = await init({
      cwd: dir,
      hosts: ["claude-code", "cursor", "vscode", "codex", "gemini", "copilot"],
      yes: true,
    });
    expect(result.applied).toBe(true);
    expect(JSON.parse(read(".mcp.json")).mcpServers.autoremediator.command).toBe("npx");
    expect(JSON.parse(read(".cursor/mcp.json")).mcpServers.autoremediator).toBeDefined();
    expect(JSON.parse(read(".vscode/mcp.json")).servers.autoremediator.type).toBe("stdio");
    expect(JSON.parse(read(".gemini/settings.json")).mcpServers.autoremediator).toBeDefined();
    expect(read(".codex/config.toml")).toContain("[mcp_servers.autoremediator]");
    expect(read(".github/agents/autoremediator.agent.md")).toContain("name: autoremediator");
    expect(read(".claude/skills/fix-cve/SKILL.md")).toContain("planRemediation");
    expect(read(".cursor/rules/autoremediator.mdc")).toContain("alwaysApply: false");
    expect(read("AGENTS.md")).toContain("autoremediator:begin");
    expect(read(".gitignore")).toBe(".autoremediator/\n");
    expect(read(".github/autoremediator.yml")).toContain("allowMajorBumps: false");

    const again = await init({ cwd: dir, hosts: ["claude-code", "cursor", "vscode", "codex", "gemini", "copilot"], yes: true });
    expect(again.drift).toBe(false);
    expect(again.applied).toBe(false);
    expect(again.changes.every((change) => change.action === "unchanged")).toBe(true);
  });

  it("merges into existing config without losing it", async () => {
    put(".cursor/mcp.json", JSON.stringify({ mcpServers: { github: { url: "https://x" } } }));
    put("AGENTS.md", "# Team rules\n\nBe kind.\n");
    put(".gitignore", "node_modules/\n");
    await init({ cwd: dir, hosts: ["cursor"], yes: true });
    expect(JSON.parse(read(".cursor/mcp.json")).mcpServers.github).toEqual({ url: "https://x" });
    expect(read("AGENTS.md").startsWith("# Team rules\n\nBe kind.\n")).toBe(true);
    expect(read(".gitignore")).toBe("node_modules/\n.autoremediator/\n");
  });

  it("leaves a file it cannot merge alone and says so", async () => {
    put(".vscode/mcp.json", "{ // comments are not JSON\n}");
    const result = await init({ cwd: dir, hosts: ["vscode"], yes: true });
    expect(result.conflicts).toEqual([".vscode/mcp.json"]);
    expect(read(".vscode/mcp.json")).toBe("{ // comments are not JSON\n}");
  });

  it("never replaces an existing policy file", async () => {
    put(".github/autoremediator.yml", "allowMajorBumps: true\n");
    await init({ cwd: dir, hosts: [], yes: true });
    expect(read(".github/autoremediator.yml")).toBe("allowMajorBumps: true\n");
  });

  it("check mode reports drift and writes nothing", async () => {
    const result = await init({ cwd: dir, hosts: ["vscode"], check: true, yes: true });
    expect(result.drift).toBe(true);
    expect(result.applied).toBe(false);
    expect(existsSync(join(dir, ".vscode"))).toBe(false);
  });

  it("skips the policy and AGENTS.md when asked", async () => {
    await init({ cwd: dir, hosts: ["vscode"], policy: false, agentsMd: false, yes: true });
    expect(existsSync(join(dir, ".github/autoremediator.yml"))).toBe(false);
    expect(existsSync(join(dir, "AGENTS.md"))).toBe(false);
  });

  it("writes the workflow only for GitHub Actions projects, and only when asked", async () => {
    put(".github/workflows/ci.yml", "name: ci\n");
    await init({ cwd: dir, hosts: [], yes: true });
    expect(existsSync(join(dir, ".github/workflows/autoremediator.yml"))).toBe(false);
    await init({ cwd: dir, hosts: [], ci: true, yes: true });
    expect(read(".github/workflows/autoremediator.yml")).toContain("--create-change-request");
  });

  it("installs the guard hook for Claude Code only when asked, keeping the user's settings", async () => {
    put(".claude/settings.json", JSON.stringify({ permissions: { allow: ["Bash(ls)"] }, hooks: { PreToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "lint" }] }] } }));
    await init({ cwd: dir, hosts: ["claude-code"], yes: true });
    expect(JSON.parse(read(".claude/settings.json")).hooks.PreToolUse).toHaveLength(1);

    await init({ cwd: dir, hosts: ["claude-code"], guard: true, yes: true });
    const settings = JSON.parse(read(".claude/settings.json")) as {
      permissions: unknown;
      hooks: { PreToolUse: Array<{ matcher: string; hooks: Array<{ command: string }> }> };
    };
    expect(settings.permissions).toEqual({ allow: ["Bash(ls)"] });
    expect(settings.hooks.PreToolUse).toHaveLength(2);
    expect(settings.hooks.PreToolUse[1]).toMatchObject({ matcher: "Bash" });
    expect(settings.hooks.PreToolUse[1]?.hooks[0]?.command).toContain("autoremediator guard-hook");

    const again = await init({ cwd: dir, hosts: ["claude-code"], guard: true, yes: true });
    expect(again.drift).toBe(false);
  });

  it("writes a policy the policy loader accepts", async () => {
    await init({ cwd: dir, hosts: [], yes: true });
    expect(() => loadPolicy(dir)).not.toThrow();
    for (const typecheck of [true, false]) {
      expect(() => loadPolicy(dir, policyFileContent({ typecheck }).replace(/^/, "---\n"))).not.toThrow();
    }
  });
});

describe("agent instructions", () => {
  it("only name operations that exist in the catalog", () => {
    for (const tool of INSTRUCTED_TOOLS) {
      expect(getOperation(tool)).toBeDefined();
    }
  });

  it("only name tools that an MCP host can call", () => {
    const mcp = new Set(OPERATIONS.filter((operation) => operation.mcp).map((operation) => operation.name));
    for (const tool of INSTRUCTED_TOOLS) expect(mcp.has(tool)).toBe(true);
  });

  it("each skill mentions every tool it declares, and each tool is declared by some skill", () => {
    for (const skill of SKILLS) {
      for (const tool of skill.tools) expect(skill.body).toContain(tool);
    }
    const declared = new Set(SKILLS.flatMap((skill) => skill.tools));
    for (const tool of INSTRUCTED_TOOLS) expect(declared.has(tool)).toBe(true);
  });

  it("any backticked camelCase word that is a catalog operation is declared", () => {
    const names = new Set(OPERATIONS.map((operation) => operation.name));
    const undeclared: string[] = [];
    for (const skill of SKILLS) {
      for (const [, word] of skill.body.matchAll(/`([a-z][A-Za-z]+)`/g)) {
        if (word && names.has(word) && !(skill.tools as readonly string[]).includes(word)) {
          undeclared.push(`${skill.name}:${word}`);
        }
      }
    }
    expect(undeclared).toEqual([]);
  });

  it("renders skills with valid frontmatter", () => {
    for (const skill of SKILLS) {
      const text = renderSkill(skill);
      expect(text).toMatch(new RegExp(`^---\\nname: ${skill.name}\\ndescription: .+\\n---\\n`));
    }
    expect(copilotAgentContent()).toMatch(/^---\nname: autoremediator\ndescription: .+\n---\n/);
    expect(cursorRuleContent()).toContain(AGENTS_MD_SECTION);
  });

  it("describes the CLI commands that exist", () => {
    for (const command of ["autoremediator plan", "runs apply", "runs rollback", "autoremediator guard"]) {
      expect(AGENTS_MD_SECTION).toContain(command);
    }
  });
});

describe("catalog entry", () => {
  it("is a command-line and SDK operation, not an MCP tool or HTTP route", () => {
    const operation = getOperation("init");
    expect(operation).toBeDefined();
    expect(operation?.mcp).toBe(false);
    expect(operation?.http).toBeUndefined();
  });
});
