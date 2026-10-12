import { spawn } from "node:child_process";
import type { Octokit } from "@octokit/rest";

export interface CreatePullRequestParams {
  octokit: Octokit;
  owner: string;
  repo: string;
  head: string;
  base: string;
  title: string;
  body: string;
  draft?: boolean;
}

/**
 * Creates a pull request via Octokit GitHub REST API.
 */
export async function createPullRequestWithOctokit(
  params: CreatePullRequestParams,
): Promise<{ url: string; number: number }> {
  const { octokit, owner, repo, head, base, title, body, draft } = params;

  const response = await octokit.rest.pulls.create({
    owner,
    repo,
    head,
    base,
    title,
    body,
    draft: Boolean(draft),
  });

  return {
    url: response.data.html_url,
    number: response.data.number,
  };
}

export interface PushBranchParams {
  cwd: string;
  branchName: string;
  token?: string;
  pushRemote?: string;
}

/**
 * Pushes a git branch with optional GitHub token authorization header.
 */
export async function pushBranchWithToken(params: PushBranchParams): Promise<void> {
  const { cwd, branchName, token, pushRemote = "origin" } = params;

  const args: string[] = [];
  if (token) {
    const authHeader = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
    args.push("-c", `http.extraheader=${authHeader}`);
  }
  args.push("push", "-u", pushRemote, branchName);

  await new Promise<void>((resolve, reject) => {
    const child = spawn("git", args, { cwd, stdio: "pipe" });
    let stderr = "";

    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`git push failed with code ${code}: ${stderr.trim()}`));
      }
    });
  });
}
