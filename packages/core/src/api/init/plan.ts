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
  GENERATED_MARKER,
  guardHookCommand,
} from "./assets.js";
import {
  COPILOT_HOOKS_PATH,
  copilotGuardHookEntry,
  CURSOR_HOOKS_PATH,
  cursorGuardHookEntry,
  pnpmfileGuardContent,
  PNPMFILE_MARKER,
  PNPMFILE_PATH,
} from "./guard-assets.js";
import {
  mergeClaudeGuardHook,
  mergeHooksFile,
  mergeCodexToml,
  mergeRunStateIgnore,
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
function toChange(
  path: string,
  reason: string,
  before: string | undefined,
  merged: MergeResult,
): FileChange {
  if ("conflict" in merged) {
    return {
      path,
      action: "conflict",
      reason: `${path} ${merged.conflict}`,
      ...(before === undefined ? {} : { before }),
      after: before ?? "",
    };
  }
  const action =
    before === undefined ? "create" : before === merged.content ? "unchanged" : "update";
  return {
    path,
    action,
    reason,
    ...(before === undefined ? {} : { before }),
    after: merged.content,
  };
}

/** Write a file only when it is absent; an existing file is the user's and is not replaced. */
function createOnly(
  path: string,
  reason: string,
  before: string | undefined,
  content: string,
): FileChange {
  if (before === undefined) return { path, action: "create", reason, after: content };
  return { path, action: "unchanged", reason, before, after: before };
}

/**
 * Write a file we generate: create it, or refresh it when it differs from what we would write. A file
 * that is already there is ours only if it carries the generated marker; otherwise it is a person's
 * own file (or one an older release wrote, which had no marker) and is left alone.
 */
function owned(
  path: string,
  reason: string,
  before: string | undefined,
  content: string,
): FileChange {
  if (before !== undefined && !before.includes(GENERATED_MARKER)) {
    return {
      path,
      action: "conflict",
      reason: `${path} exists and was not written by autoremediator init (it has no "${GENERATED_MARKER}" line), so it was left alone; to let init manage it, delete the file and run init again`,
      before,
      after: before,
    };
  }
  const action = before === undefined ? "create" : before === content ? "unchanged" : "update";
  return { path, action, reason, ...(before === undefined ? {} : { before }), after: content };
}

function hostChanges(
  cwd: string,
  host: AgentHost,
  guard: boolean,
  hosts: AgentHost[],
): FileChange[] {
  const entry = mcpServerEntry();
  const json = (
    path: string,
    key: "mcpServers" | "servers",
    extra: Record<string, unknown> = {},
  ) => {
    const before = readIfExists(cwd, path);
    return toChange(
      path,
      "connect the Autoremediator MCP server",
      before,
      mergeJsonMcpConfig(before, key, entry, extra),
    );
  };
  const copilotHooks = (): FileChange[] => {
    const before = readIfExists(cwd, COPILOT_HOOKS_PATH);
    return [
      toChange(
        COPILOT_HOOKS_PATH,
        "check package installs with guard before Copilot runs shell commands",
        before,
        mergeHooksFile(before, "preToolUse", copilotGuardHookEntry()),
      ),
    ];
  };
  const builders: Record<AgentHost, () => FileChange[]> = {
    "claude-code": () => [
      json(".mcp.json", "mcpServers"),
      ...SKILLS.map((skill) => {
        const path = `.claude/skills/${skill.name}/SKILL.md`;
        return owned(
          path,
          "teach Claude Code the safe remediation steps",
          readIfExists(cwd, path),
          renderSkill(skill),
        );
      }),
      ...(guard
        ? [
            (() => {
              const before = readIfExists(cwd, ".claude/settings.json");
              return toChange(
                ".claude/settings.json",
                "check package installs with guard before Claude Code runs them",
                before,
                mergeClaudeGuardHook(before, guardHookCommand()),
              );
            })(),
          ]
        : []),
    ],
    cursor: () => [
      json(".cursor/mcp.json", "mcpServers"),
      owned(
        CURSOR_RULE_PATH,
        "teach Cursor the safe remediation steps",
        readIfExists(cwd, CURSOR_RULE_PATH),
        cursorRuleContent(),
      ),
      ...(guard
        ? [
            (() => {
              const before = readIfExists(cwd, CURSOR_HOOKS_PATH);
              return toChange(
                CURSOR_HOOKS_PATH,
                "check package installs with guard before Cursor runs them",
                before,
                mergeHooksFile(before, "beforeShellExecution", cursorGuardHookEntry()),
              );
            })(),
          ]
        : []),
    ],
    // The Copilot harness in VS Code reads the same repository hook files as Copilot itself.
    vscode: () => [
      json(".vscode/mcp.json", "servers", { type: "stdio" }),
      ...(guard && !hosts.includes("copilot") ? copilotHooks() : []),
    ],
    gemini: () => [json(".gemini/settings.json", "mcpServers")],
    codex: () => {
      const before = readIfExists(cwd, ".codex/config.toml");
      return [
        toChange(
          ".codex/config.toml",
          "connect the Autoremediator MCP server",
          before,
          mergeCodexToml(before, entry),
        ),
      ];
    },
    copilot: () => [
      owned(
        COPILOT_AGENT_PATH,
        "add a Copilot custom agent for dependency remediation",
        readIfExists(cwd, COPILOT_AGENT_PATH),
        copilotAgentContent(),
      ),
      ...(guard ? copilotHooks() : []),
    ],
  };
  return builders[host]();
}

/**
 * The pnpmfile that checks new dependencies. Ours is refreshed; any other `.pnpmfile.cjs` or a
 * `.pnpmfile.mjs` (which pnpm prefers) is the user's, so it is reported as a conflict rather than edited.
 */
function pnpmfileChange(cwd: string): FileChange {
  const reason =
    "check dependencies pnpm is about to add with guard (run pnpm install once afterwards to record it in the lockfile)";
  const before = readIfExists(cwd, PNPMFILE_PATH);
  const content = pnpmfileGuardContent();
  if (readIfExists(cwd, ".pnpmfile.mjs") !== undefined) {
    return {
      path: PNPMFILE_PATH,
      action: "conflict",
      reason: `${PNPMFILE_PATH} is not used because .pnpmfile.mjs exists; add the guard to that file by hand (see the guard guide)`,
      after: before ?? "",
    };
  }
  if (before !== undefined && !before.includes(PNPMFILE_MARKER)) {
    return {
      path: PNPMFILE_PATH,
      action: "conflict",
      reason: `${PNPMFILE_PATH} has hooks of its own, so it was left alone; add the guard to it by hand (see the guard guide)`,
      before,
      after: before,
    };
  }
  return {
    path: PNPMFILE_PATH,
    action: before === undefined ? "create" : before === content ? "unchanged" : "update",
    reason,
    ...(before === undefined ? {} : { before }),
    after: content,
  };
}

/** Everything `init` would write, in a stable order. Reads the project; writes nothing. */
export function planInit(
  facts: ProjectFacts,
  hosts: AgentHost[],
  options: InitOptions,
): FileChange[] {
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
    toChange(
      ".gitignore",
      "keep run state out of git, but not recipes or the autonomy track record",
      gitignoreBefore,
      mergeRunStateIgnore(gitignoreBefore),
    ),
  );

  for (const host of hosts) changes.push(...hostChanges(cwd, host, options.guard === true, hosts));

  if (options.guard && facts.packageManager === "pnpm") changes.push(pnpmfileChange(cwd));

  if (options.agentsMd !== false && hosts.length > 0) {
    const before = readIfExists(cwd, "AGENTS.md");
    changes.push(
      toChange(
        "AGENTS.md",
        "tell any coding agent how to use Autoremediator",
        before,
        mergeMarkedSection(before, AGENTS_MD_SECTION),
      ),
    );
  }

  if (options.ci && facts.ci.includes("github-actions")) {
    changes.push(
      createOnly(
        WORKFLOW_PATH,
        "run remediation weekly and open a pull request",
        readIfExists(cwd, WORKFLOW_PATH),
        workflowContent(),
      ),
    );
  }

  return changes;
}
