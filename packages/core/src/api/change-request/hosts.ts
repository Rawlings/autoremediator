import { trimChar } from "../../platform/trim.js";
import type { ChangeRequestOptions, ChangeRequestProvider } from "../../platform/types.js";

/**
 * Host-specific plumbing for change requests: token lookup, HTTPS push authentication, remote URL
 * parsing, and REST calls for hosts without a first-party CLI (GitLab API, Bitbucket Cloud, Azure
 * DevOps Services). GitHub keeps its own code path in `index.ts`.
 */

const TOKEN_ENV_FALLBACKS: Record<ChangeRequestProvider, string[]> = {
  github: ["GITHUB_TOKEN", "GH_TOKEN"],
  gitlab: ["GITLAB_TOKEN", "GITLAB_ACCESS_TOKEN"],
  bitbucket: ["BITBUCKET_TOKEN"],
  "azure-devops": ["AZURE_DEVOPS_EXT_PAT", "AZURE_DEVOPS_TOKEN", "SYSTEM_ACCESSTOKEN"],
};

/**
 * Resolve the API/push token. Never falls back to another host's token variables, so a GitHub
 * token cannot be sent to a GitLab, Bitbucket or Azure DevOps remote.
 */
export function resolveChangeRequestToken(
  provider: ChangeRequestProvider,
  options: Pick<ChangeRequestOptions, "token" | "tokenEnvVar">,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (options.token) return options.token;
  if (options.tokenEnvVar && env[options.tokenEnvVar]) return env[options.tokenEnvVar];
  for (const name of TOKEN_ENV_FALLBACKS[provider]) {
    const value = env[name];
    if (value) return value;
  }
  return undefined;
}

function isJwtLike(token: string): boolean {
  return /^eyJ[\w-]+\.[\w-]+\.[\w-]+$/.test(token);
}

/**
 * Value for git's `http.extraheader` (without the `-c` prefix) that authenticates an HTTPS push.
 *
 * - GitHub: basic `x-access-token:<token>`.
 * - GitLab: basic `oauth2:<token>` (personal, project and group access tokens).
 * - Bitbucket Cloud: basic `x-token-auth:<token>` (repository/workspace access tokens).
 * - Azure DevOps: bearer for build-service JWTs (`System.AccessToken`), otherwise basic with an
 *   empty user name for personal access tokens.
 */
export function buildPushAuthHeader(provider: ChangeRequestProvider, token: string): string {
  const basic = (user: string) =>
    `AUTHORIZATION: basic ${Buffer.from(`${user}:${token}`).toString("base64")}`;
  if (provider === "github") return basic("x-access-token");
  if (provider === "gitlab") return basic("oauth2");
  if (provider === "bitbucket") return basic("x-token-auth");
  return isJwtLike(token) ? `AUTHORIZATION: bearer ${token}` : basic("");
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

const PROVIDER_HOSTS: Record<ChangeRequestProvider, RegExp> = {
  github: /^(?:ssh\.)?github\.com$|\.ghe\.com$/,
  gitlab: /^gitlab\.com$/,
  bitbucket: /^bitbucket\.org$/,
  "azure-devops": /^(?:(?:vs-)?ssh\.)?dev\.azure\.com$|\.visualstudio\.com$/,
};

function hostnameOf(host: string): string {
  const withoutPort = host.startsWith("[")
    ? host.replace(/\]:\d+$/, "]")
    : host.replace(/:\d+$/, "");
  return withoutPort.toLowerCase();
}

function hostFromUrlOrHost(value: string | undefined): string | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  try {
    return hostnameOf(
      new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`).host,
    );
  } catch {
    return undefined;
  }
}

/** Hosts the user has named for GitHub: the API URL option and the variables Actions and `gh` set. */
function namedGitHubHosts(githubApiUrl: string | undefined, env: NodeJS.ProcessEnv): Set<string> {
  const hosts = new Set<string>();
  for (const value of [githubApiUrl, env.GITHUB_API_URL, env.GITHUB_SERVER_URL, env.GH_HOST]) {
    const host = hostFromUrlOrHost(value);
    if (!host) continue;
    hosts.add(host);
    if (host.startsWith("api.")) hosts.add(host.slice(4));
  }
  return hosts;
}

export interface TokenDestinationCheck {
  provider: ChangeRequestProvider;
  /** The remote's URL as the repository has it configured. */
  remoteUrl: string | undefined;
  /** The caller passed the token (or the name of the variable that holds it) rather than leaving it to the environment. */
  explicitToken: boolean;
  githubApiUrl?: string;
  /** True for the push/fetch header, which only an http(s) remote ever sees. */
  forPush?: boolean;
  env?: NodeJS.ProcessEnv;
}

export interface TokenDestinationDecision {
  send: boolean;
  /** Why the token must not go there; set only when a remote that would receive it was rejected. */
  refusal?: string;
}

/**
 * Whether the change-request token may be sent to the host a remote points at. The provider
 * defaults to GitHub, so a GitLab or Bitbucket remote with `GITHUB_TOKEN` set would otherwise be
 * handed the GitHub token; an `http://` remote would receive it in cleartext. Loopback hosts are
 * always allowed (local test servers). A GitHub token goes only to github.com, `*.ghe.com`, or a
 * host the caller named (`githubApiUrl`, `GITHUB_SERVER_URL`, `GITHUB_API_URL`, `GH_HOST`), unless
 * the caller passed the token explicitly.
 */
export function checkTokenDestination(check: TokenDestinationCheck): TokenDestinationDecision {
  const url = check.remoteUrl?.trim() ?? "";
  if (check.forPush && !/^https?:\/\//i.test(url)) return { send: false };
  const remote = parseRemoteUrl(url);
  if (!remote) return { send: false };
  const host = hostnameOf(remote.host);
  if (LOOPBACK_HOSTS.has(host)) return { send: true };

  const label = `the ${check.provider} token`;
  if (remote.scheme === "http") {
    return {
      send: false,
      refusal: `Not sending ${label} to ${host}: the remote uses http://, which would send it in cleartext. Use an https remote.`,
    };
  }
  for (const [other, pattern] of Object.entries(PROVIDER_HOSTS)) {
    if (other !== check.provider && pattern.test(host)) {
      return {
        send: false,
        refusal: `Not sending ${label} to ${host}: that host belongs to ${other}. Set changeRequest.provider to ${other} (--change-request-provider ${other}).`,
      };
    }
  }
  if (check.provider === "github") {
    const env = check.env ?? process.env;
    if (
      PROVIDER_HOSTS.github.test(host) ||
      namedGitHubHosts(check.githubApiUrl, env).has(host) ||
      check.explicitToken
    ) {
      return { send: true };
    }
    return {
      send: false,
      refusal: `Not sending ${label} to ${host}: it is not github.com or a host you named. Set changeRequest.provider to match the host, name a GitHub Enterprise host with githubApiUrl or GITHUB_SERVER_URL, or pass the token explicitly.`,
    };
  }
  return { send: true };
}

/** Git identity used for the remediation commit. GitHub keeps its historical bot identity. */
export function commitIdentity(provider: ChangeRequestProvider): { name: string; email: string } {
  return provider === "github"
    ? {
        name: "autoremediator[bot]",
        email: "41898282+github-actions[bot]@users.noreply.github.com",
      }
    : { name: "autoremediator[bot]", email: "autoremediator[bot]@users.noreply.invalid" };
}

export interface ParsedRemote {
  scheme: "https" | "http";
  host: string;
  /** Repository path without leading slash or `.git` suffix. */
  path: string;
}

function cleanPath(raw: string): string {
  return trimChar(raw, "/").replace(/\.git$/, "");
}

/** Parse an https/http/ssh/scp-style git remote URL. Returns undefined for local paths. */
export function parseRemoteUrl(remoteUrl: string): ParsedRemote | undefined {
  const url = remoteUrl.trim();
  if (!url) return undefined;

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return undefined;
    }
    if (parsed.protocol === "file:") return undefined;
    const isHttp = parsed.protocol === "https:" || parsed.protocol === "http:";
    return {
      scheme: parsed.protocol === "http:" ? "http" : "https",
      host: isHttp ? parsed.host : parsed.hostname,
      path: cleanPath(parsed.pathname),
    };
  }

  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)(.+)$/.exec(url);
  if (scp) {
    return { scheme: "https", host: scp[1]!, path: cleanPath(scp[2]!) };
  }
  return undefined;
}

/**
 * Derive the repository identifier for a host from its remote URL.
 * GitLab: `group[/subgroup]/project`. Bitbucket: `workspace/repo`. Azure DevOps: `org/project/repo`.
 */
export function repositoryFromRemote(
  provider: Exclude<ChangeRequestProvider, "github">,
  remote: ParsedRemote,
): string | undefined {
  const segments = remote.path.split("/").filter(Boolean);
  if (provider === "gitlab") {
    return segments.length >= 2 ? segments.join("/") : undefined;
  }
  if (provider === "bitbucket") {
    return segments.length >= 2 ? `${segments[0]}/${segments[1]}` : undefined;
  }
  // Azure DevOps: https://dev.azure.com/org/project/_git/repo  or  ssh.dev.azure.com:v3/org/project/repo
  if (segments.indexOf("_git") === 2 && segments[3]) {
    return `${segments[0]}/${segments[1]}/${segments[3]}`;
  }
  if (segments[0] === "v3" && segments.length >= 4) {
    return `${segments[1]}/${segments[2]}/${segments[3]}`;
  }
  return undefined;
}

/** Repository slug validation. GitLab allows nested groups; Azure DevOps uses org/project/repo. */
export function isValidRepositoryForProvider(
  provider: ChangeRequestProvider,
  repository: string,
): boolean {
  if (provider === "gitlab") {
    return /^[a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]+)+$/.test(repository);
  }
  if (provider === "azure-devops") {
    return /^[a-zA-Z0-9._%-]+\/[a-zA-Z0-9._%-]+\/[a-zA-Z0-9._%-]+$/.test(repository);
  }
  return /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/.test(repository);
}

function describeFailure(label: string, status: number, text: string): Error {
  return new Error(`${label} failed (${status}): ${text}`);
}

export interface RestChangeRequestParams {
  repository: string;
  head: string;
  base: string;
  title: string;
  body: string;
  draft?: boolean;
  token: string;
}

/** Create a GitLab merge request through the REST API (`POST /projects/:id/merge_requests`). */
export async function createGitLabMergeRequestViaApi(
  params: RestChangeRequestParams & { apiUrl: string },
): Promise<string | undefined> {
  const endpoint = `${trimChar(params.apiUrl, "/", "end")}/projects/${encodeURIComponent(
    params.repository,
  )}/merge_requests`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "private-token": params.token,
      accept: "application/json",
      "content-type": "application/json",
      "user-agent": "autoremediator",
    },
    body: JSON.stringify({
      source_branch: params.head,
      target_branch: params.base,
      title: params.draft ? `Draft: ${params.title}` : params.title,
      description: params.body,
    }),
  });
  if (!response.ok) {
    throw describeFailure(
      "GitLab API create merge request",
      response.status,
      await response.text().catch(() => ""),
    );
  }
  const data = (await response.json()) as { web_url?: string };
  return data.web_url || undefined;
}

/** Create a Bitbucket Cloud pull request (`POST /2.0/repositories/{workspace}/{repo}/pullrequests`). */
export async function createBitbucketPullRequest(
  params: RestChangeRequestParams & { apiUrl?: string },
): Promise<string | undefined> {
  const [workspace, repo] = params.repository.split("/");
  const baseUrl = trimChar(params.apiUrl ?? "https://api.bitbucket.org/2.0", "/", "end");
  const response = await fetch(`${baseUrl}/repositories/${workspace}/${repo}/pullrequests`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${params.token}`,
      accept: "application/json",
      "content-type": "application/json",
      "user-agent": "autoremediator",
    },
    body: JSON.stringify({
      title: params.title,
      description: params.body,
      source: { branch: { name: params.head } },
      destination: { branch: { name: params.base } },
      ...(params.draft ? { draft: true } : {}),
    }),
  });
  if (!response.ok) {
    throw describeFailure(
      "Bitbucket API create pull request",
      response.status,
      await response.text().catch(() => ""),
    );
  }
  const data = (await response.json()) as { links?: { html?: { href?: string } } };
  return data.links?.html?.href || undefined;
}

/** Create an Azure DevOps Services pull request (`POST .../_apis/git/repositories/{repo}/pullrequests`). */
export async function createAzureDevOpsPullRequest(
  params: RestChangeRequestParams & { baseUrl?: string },
): Promise<string | undefined> {
  const [org, project, repo] = params.repository.split("/");
  const baseUrl = trimChar(params.baseUrl ?? "https://dev.azure.com", "/", "end");
  const repoWebUrl = `${baseUrl}/${org}/${project}/_git/${repo}`;
  const authorization = isJwtLike(params.token)
    ? `Bearer ${params.token}`
    : `Basic ${Buffer.from(`:${params.token}`).toString("base64")}`;
  const response = await fetch(
    `${baseUrl}/${org}/${project}/_apis/git/repositories/${repo}/pullrequests?api-version=7.1`,
    {
      method: "POST",
      headers: {
        authorization,
        accept: "application/json",
        "content-type": "application/json",
        "user-agent": "autoremediator",
      },
      body: JSON.stringify({
        sourceRefName: `refs/heads/${params.head}`,
        targetRefName: `refs/heads/${params.base}`,
        title: params.title,
        // Azure DevOps rejects descriptions longer than 4000 characters.
        description: params.body.slice(0, 4000),
        isDraft: Boolean(params.draft),
      }),
    },
  );
  if (!response.ok) {
    throw describeFailure(
      "Azure DevOps API create pull request",
      response.status,
      await response.text().catch(() => ""),
    );
  }
  const data = (await response.json()) as {
    pullRequestId?: number;
    repository?: { webUrl?: string };
  };
  if (data.pullRequestId === undefined) return undefined;
  return `${data.repository?.webUrl ?? repoWebUrl}/pullrequest/${data.pullRequestId}`;
}
