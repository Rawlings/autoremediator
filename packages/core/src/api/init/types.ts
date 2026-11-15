/** Agent hosts `init` knows how to configure. */
export const AGENT_HOSTS = [
  "claude-code",
  "cursor",
  "vscode",
  "codex",
  "gemini",
  "copilot",
] as const;
export type AgentHost = (typeof AGENT_HOSTS)[number];

export type GitHost = "github" | "gitlab" | "bitbucket" | "azure-devops" | "other" | "none";
export type CiSystem = "github-actions" | "gitlab-ci" | "bitbucket-pipelines" | "azure-pipelines";

/** What `init` found out about the project. Never contains secret values. */
export interface ProjectFacts {
  cwd: string;
  packageManager: string;
  gitHost: GitHost;
  ci: CiSystem[];
  /** Hosts with a trace in the project (config folder, instruction file). */
  hostsInProject: AgentHost[];
  /** Hosts whose command-line tool is on PATH. */
  hostsOnPath: AgentHost[];
  /** Names (not values) of model API key variables that are set. */
  modelEnv: string[];
  hasTsconfig: boolean;
  hasPolicy: boolean;
}

/**
 * - `create`: the file does not exist yet.
 * - `update`: the file exists and will change.
 * - `unchanged`: already as init would write it.
 * - `conflict`: the file exists but init cannot change it safely (for example invalid JSON); it is left alone.
 */
export type ChangeAction = "create" | "update" | "unchanged" | "conflict";

export interface FileChange {
  /** Path relative to the project. */
  path: string;
  action: ChangeAction;
  reason: string;
  before?: string;
  after: string;
}

export interface InitChangeSummary {
  path: string;
  action: ChangeAction;
  reason: string;
  /** Line diff of the change; empty when nothing changes. */
  diff: string;
}

export interface InitOptions {
  cwd?: string;
  /** Hosts to configure. Default: those found in the project, else those on PATH. */
  hosts?: AgentHost[];
  /** Also write a scheduled remediation workflow for the detected CI. Default false. */
  ci?: boolean;
  /** Write the policy file when missing. Default true. */
  policy?: boolean;
  /** Also install guard hooks (Claude Code, Cursor, Copilot) and a pnpmfile (pnpm projects) that check package installs. Default false. */
  guard?: boolean;
  /** Add an Autoremediator section to AGENTS.md. Default true. */
  agentsMd?: boolean;
  /** Write the changes. Without it, `init` only reports what it would do. */
  yes?: boolean;
  /** Report drift only; never writes. */
  check?: boolean;
}

export interface InitResult {
  cwd: string;
  facts: ProjectFacts;
  hosts: AgentHost[];
  changes: InitChangeSummary[];
  /** True when at least one file would change (or did). */
  drift: boolean;
  /** True when files were written. */
  applied: boolean;
  /** Files left alone because they could not be changed safely. */
  conflicts: string[];
}
