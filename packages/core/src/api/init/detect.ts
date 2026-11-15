import { existsSync, readFileSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";

import { safeExeca } from "../../platform/safe-exec.js";
import { detectPackageManager } from "../../platform/package-manager/index.js";
import { AGENT_HOSTS, type AgentHost, type CiSystem, type GitHost, type ProjectFacts } from "./types.js";

/** Files or folders whose presence says a host is used in this project. */
const HOST_MARKERS: Record<AgentHost, string[]> = {
  "claude-code": [".claude", "CLAUDE.md", ".mcp.json"],
  cursor: [".cursor", ".cursorrules"],
  vscode: [".vscode"],
  codex: [".codex"],
  gemini: [".gemini", "GEMINI.md"],
  copilot: [".github/copilot-instructions.md", ".github/agents", ".github/instructions"],
};

/** Command that starts each host from a terminal. */
const HOST_COMMANDS: Record<AgentHost, string> = {
  "claude-code": "claude",
  cursor: "cursor",
  vscode: "code",
  codex: "codex",
  gemini: "gemini",
  copilot: "copilot",
};

/** Model provider variables whose presence is useful to report. Names only. */
const MODEL_ENV_NAMES = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "GEMINI_API_KEY",
  "AUTOREMEDIATOR_MODEL",
];

/** Host name of a git remote (`https://h/..`, `ssh://u@h:22/..`, `u@h:path`), lower-cased. */
function remoteHostname(remote: string): string {
  let rest = remote.trim().toLowerCase();
  const scheme = rest.indexOf("://");
  const hasScheme = scheme !== -1;
  if (hasScheme) rest = rest.slice(scheme + 3);
  // `scp`-style remotes end the host at the first `:`; URLs end the authority at the first `/`.
  const stops = (hasScheme ? ["/"] : ["/", ":"]).map((stop) => rest.indexOf(stop)).filter((index) => index !== -1);
  const authority = rest.slice(0, stops.length > 0 ? Math.min(...stops) : rest.length);
  const host = authority.slice(authority.lastIndexOf("@") + 1);
  const port = hasScheme ? host.indexOf(":") : -1;
  return port === -1 ? host : host.slice(0, port);
}

export function gitHostFromRemote(remote: string | undefined): GitHost {
  if (!remote) return "none";
  const host = remoteHostname(remote);
  const labels = host.split(".");
  const isDomain = (domain: string): boolean => host === domain || host.endsWith(`.${domain}`);
  // Self-hosted instances (`github.example.com`, `gitlab.corp`) name the product in a label.
  if (labels.includes("github")) return "github";
  if (labels.includes("gitlab")) return "gitlab";
  if (labels.includes("bitbucket")) return "bitbucket";
  if (isDomain("dev.azure.com") || isDomain("visualstudio.com")) return "azure-devops";
  return "other";
}

function isExecutable(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function findOnPath(command: string, env: NodeJS.ProcessEnv): boolean {
  const exts = process.platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    if (exts.some((ext) => isExecutable(join(dir, command + ext)))) return true;
  }
  return false;
}

async function readOriginRemote(cwd: string): Promise<string | undefined> {
  try {
    const result = await safeExeca("git", ["remote", "get-url", "origin"], { cwd, stdio: "pipe" });
    const url = result.stdout.trim();
    return url || undefined;
  } catch {
    return undefined;
  }
}

function detectCi(cwd: string): CiSystem[] {
  const found: CiSystem[] = [];
  if (existsSync(join(cwd, ".github", "workflows"))) found.push("github-actions");
  if (existsSync(join(cwd, ".gitlab-ci.yml"))) found.push("gitlab-ci");
  if (existsSync(join(cwd, "bitbucket-pipelines.yml"))) found.push("bitbucket-pipelines");
  if (existsSync(join(cwd, "azure-pipelines.yml"))) found.push("azure-pipelines");
  return found;
}

/** Look at the project and the machine. Reads only; never prints or returns secret values. */
export async function detectProject(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ProjectFacts> {
  const hostsInProject = AGENT_HOSTS.filter((host) =>
    HOST_MARKERS[host].some((marker) => existsSync(join(cwd, marker))),
  );
  const hostsOnPath = AGENT_HOSTS.filter((host) => findOnPath(HOST_COMMANDS[host], env));
  let hasPolicy = false;
  try {
    hasPolicy = readFileSync(join(cwd, ".github", "autoremediator.yml"), "utf8").length > 0;
  } catch {
    hasPolicy = false;
  }
  return {
    cwd,
    packageManager: detectPackageManager(cwd),
    gitHost: gitHostFromRemote(await readOriginRemote(cwd)),
    ci: detectCi(cwd),
    hostsInProject,
    hostsOnPath,
    modelEnv: MODEL_ENV_NAMES.filter((name) => Boolean(env[name])),
    hasTsconfig: existsSync(join(cwd, "tsconfig.json")),
    hasPolicy,
  };
}

/** Hosts to configure: the ones the project already uses, else the ones installed. */
export function chooseHosts(facts: ProjectFacts, requested?: AgentHost[]): AgentHost[] {
  if (requested && requested.length > 0) return [...new Set(requested)];
  if (facts.hostsInProject.length > 0) return facts.hostsInProject;
  return facts.hostsOnPath;
}
