import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  AGENTS_MD_SECTION,
  COPILOT_AGENT_PATH,
  CURSOR_RULE_PATH,
  mcpServerEntry,
  policyFileContent,
  POLICY_FILE_PATH,
  renderSkill,
  SKILLS,
  WORKFLOW_PATH,
  workflowContent,
  copilotAgentContent,
  cursorRuleContent,
} from "./assets.js";
import {
  mergeCodexToml,
  mergeGitignore,
  mergeJsonMcpConfig,
  mergeMarkedSection,
  type MergeResult,
} from "./merge.js";
import type { AgentHost, FileChange, InitOptions, ProjectFacts } from "./types.js";

function readIfExists(cwd: string, path: string): string | undefined {
  const absolute = join(cwd, path);
  return existsSync(absolute) ? readFileSync(absolute, "utf8") : undefined;
}

/** Turn a merge outcome into a reviewable change. */
function toChange(path: string, reason: string, before: string | undefined, merged: MergeResult): FileChange {
  if ("conflict" in merged) {
    return { path, action: "conflict", reason: `${path} ${merged.conflict}`, ...(before === undefined ? {} : { before }), after: before ?? "" };
  }
  const action = before === undefined ? "create" : before === merged.content ? "unchanged" : "update";
  return { path, action, reason, ...(before === undefined ? {} : { before }), after: merged.content };
}

/** Write a file only when it is absent; an existing file is the user's and is not replaced. */
function createOnly(path: string, reason: string, before: string | undefined, content: string): FileChange {
  if (before === undefined) return { path, action: "create", reason, after: content };
  return { path, action: "unchanged", reason, before, after: before };
}

/** Write a file we own: create it, or refresh it when it differs from what we would write. */
function owned(path: string, reason: string, before: string | undefined, content: string): FileChange {
  const action = before === undefined ? "create" : before === content ? "unchanged" : "update";
  return { path, action, reason, ...(before === undefined ? {} : { before }), after: content };
}

function hostChanges(cwd: string, host: AgentHost): FileChange[] {
  const entry = mcpServerEntry();
  const json = (path: string, key: "mcpServers" | "servers", extra: Record<string, unknown> = {}) => {
    const before = readIfExists(cwd, path);
    return toChange(path, "connect the Autoremediator MCP server", before, mergeJsonMcpConfig(before, key, entry, extra));
  };
  const builders: Record<AgentHost, () => FileChange[]> = {
    "claude-code": () => [
      json(".mcp.json", "mcpServers"),
      ...SKILLS.map((skill) => {
        const path = `.claude/skills/${skill.name}/SKILL.md`;
        return owned(path, "teach Claude Code the safe remediation steps", readIfExists(cwd, path), renderSkill(skill));
      }),
    ],
    cursor: () => [
      json(".cursor/mcp.json", "mcpServers"),
      owned(CURSOR_RULE_PATH, "teach Cursor the safe remediation steps", readIfExists(cwd, CURSOR_RULE_PATH), cursorRuleContent()),
    ],
    vscode: () => [json(".vscode/mcp.json", "servers", { type: "stdio" })],
    gemini: () => [json(".gemini/settings.json", "mcpServers")],
    codex: () => {
      const before = readIfExists(cwd, ".codex/config.toml");
      return [toChange(".codex/config.toml", "connect the Autoremediator MCP server", before, mergeCodexToml(before, entry))];
    },
    copilot: () => [
      owned(
        COPILOT_AGENT_PATH,
        "add a Copilot custom agent for dependency remediation",
        readIfExists(cwd, COPILOT_AGENT_PATH),
        copilotAgentContent(),
      ),
    ],
  };
  return builders[host]();
}

/** Everything `init` would write, in a stable order. Reads the project; writes nothing. */
export function planInit(facts: ProjectFacts, hosts: AgentHost[], options: InitOptions): FileChange[] {
  const { cwd } = facts;
  const changes: FileChange[] = [];

  if (options.policy !== false) {
    changes.push(
      createOnly(
        POLICY_FILE_PATH,
        "set the rules for what may change",
        readIfExists(cwd, POLICY_FILE_PATH),
        policyFileContent({ typecheck: facts.hasTsconfig }),
      ),
    );
  }

  const gitignoreBefore = readIfExists(cwd, ".gitignore");
  changes.push(
    toChange(".gitignore", "keep run state out of git", gitignoreBefore, mergeGitignore(gitignoreBefore, [".autoremediator/"])),
  );

  for (const host of hosts) changes.push(...hostChanges(cwd, host));

  if (options.agentsMd !== false && hosts.length > 0) {
    const before = readIfExists(cwd, "AGENTS.md");
    changes.push(
      toChange("AGENTS.md", "tell any coding agent how to use Autoremediator", before, mergeMarkedSection(before, AGENTS_MD_SECTION)),
    );
  }

  if (options.ci && facts.ci.includes("github-actions")) {
    changes.push(
      createOnly(WORKFLOW_PATH, "run remediation weekly and open a pull request", readIfExists(cwd, WORKFLOW_PATH), workflowContent()),
    );
  }

  return changes;
}
