import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildPushAuthHeader,
  commitIdentity,
  createAzureDevOpsPullRequest,
  createBitbucketPullRequest,
  createGitLabMergeRequestViaApi,
  isValidRepositoryForProvider,
  parseRemoteUrl,
  repositoryFromRemote,
  resolveChangeRequestToken,
} from "./hosts.js";

const b64 = (value: string) => Buffer.from(value).toString("base64");

describe("resolveChangeRequestToken", () => {
  it("prefers explicit token, then tokenEnvVar, then provider-specific variables", () => {
    const env = { GITLAB_TOKEN: "from-env", MY_TOKEN: "custom", GITHUB_TOKEN: "gh" };
    expect(resolveChangeRequestToken("gitlab", { token: "explicit" }, env)).toBe("explicit");
    expect(resolveChangeRequestToken("gitlab", { tokenEnvVar: "MY_TOKEN" }, env)).toBe("custom");
    expect(resolveChangeRequestToken("gitlab", {}, env)).toBe("from-env");
  });

  it("never sends a GitHub token to another host", () => {
    const env = { GITHUB_TOKEN: "gh", GH_TOKEN: "gh2" };
    expect(resolveChangeRequestToken("gitlab", {}, env)).toBeUndefined();
    expect(resolveChangeRequestToken("bitbucket", {}, env)).toBeUndefined();
    expect(resolveChangeRequestToken("azure-devops", {}, env)).toBeUndefined();
    expect(resolveChangeRequestToken("github", {}, env)).toBe("gh");
  });

  it("reads Bitbucket and Azure DevOps pipeline variables", () => {
    expect(resolveChangeRequestToken("bitbucket", {}, { BITBUCKET_TOKEN: "bb" })).toBe("bb");
    expect(resolveChangeRequestToken("azure-devops", {}, { SYSTEM_ACCESSTOKEN: "sys" })).toBe(
      "sys",
    );
  });
});

describe("buildPushAuthHeader", () => {
  it("keeps the GitHub x-access-token header unchanged", () => {
    expect(buildPushAuthHeader("github", "tok")).toBe(
      `AUTHORIZATION: basic ${b64("x-access-token:tok")}`,
    );
  });

  it("uses oauth2 basic auth for GitLab", () => {
    expect(buildPushAuthHeader("gitlab", "glpat-abc")).toBe(
      `AUTHORIZATION: basic ${b64("oauth2:glpat-abc")}`,
    );
  });

  it("uses x-token-auth basic auth for Bitbucket", () => {
    expect(buildPushAuthHeader("bitbucket", "bbtok")).toBe(
      `AUTHORIZATION: basic ${b64("x-token-auth:bbtok")}`,
    );
  });

  it("uses bearer for Azure DevOps build tokens and basic for PATs", () => {
    const jwt = "eyJhbGciOi.eyJzdWIi.c2ln-nature_";
    expect(buildPushAuthHeader("azure-devops", jwt)).toBe(`AUTHORIZATION: bearer ${jwt}`);
    expect(buildPushAuthHeader("azure-devops", "patvalue")).toBe(
      `AUTHORIZATION: basic ${b64(":patvalue")}`,
    );
  });
});

describe("commitIdentity", () => {
  it("keeps the GitHub identity and avoids it elsewhere", () => {
    expect(commitIdentity("github").email).toContain("github-actions[bot]");
    expect(commitIdentity("gitlab").email).not.toContain("github");
  });
});

describe("parseRemoteUrl", () => {
  it("parses https remotes with embedded credentials and ports", () => {
    expect(parseRemoteUrl("https://gitlab-ci-token:abc@gitlab.example.com:8443/g/s/p.git")).toEqual(
      { scheme: "https", host: "gitlab.example.com:8443", path: "g/s/p" },
    );
  });

  it("parses scp-style and ssh:// remotes", () => {
    expect(parseRemoteUrl("git@gitlab.com:group/proj.git")).toEqual({
      scheme: "https",
      host: "gitlab.com",
      path: "group/proj",
    });
    expect(parseRemoteUrl("ssh://git@host.example:2222/a/b.git")).toEqual({
      scheme: "https",
      host: "host.example",
      path: "a/b",
    });
  });

  it("returns undefined for local paths and file URLs", () => {
    expect(parseRemoteUrl("/tmp/remote.git")).toBeUndefined();
    expect(parseRemoteUrl("file:///tmp/remote.git")).toBeUndefined();
    expect(parseRemoteUrl("")).toBeUndefined();
  });
});

describe("repositoryFromRemote", () => {
  it("keeps nested GitLab groups", () => {
    const remote = parseRemoteUrl("https://gitlab.com/org/team/sub/proj.git")!;
    expect(repositoryFromRemote("gitlab", remote)).toBe("org/team/sub/proj");
  });

  it("returns workspace/repo for Bitbucket", () => {
    const remote = parseRemoteUrl("https://x-token-auth:t@bitbucket.org/ws/repo.git")!;
    expect(repositoryFromRemote("bitbucket", remote)).toBe("ws/repo");
  });

  it("returns org/project/repo for Azure DevOps https and ssh remotes", () => {
    const https = parseRemoteUrl("https://org@dev.azure.com/org/proj/_git/repo")!;
    expect(repositoryFromRemote("azure-devops", https)).toBe("org/proj/repo");
    const ssh = parseRemoteUrl("git@ssh.dev.azure.com:v3/org/proj/repo")!;
    expect(repositoryFromRemote("azure-devops", ssh)).toBe("org/proj/repo");
  });

  it("returns undefined when the path does not match the host layout", () => {
    const remote = parseRemoteUrl("https://gitlab.com/onlyone")!;
    expect(repositoryFromRemote("gitlab", remote)).toBeUndefined();
    expect(repositoryFromRemote("azure-devops", remote)).toBeUndefined();
  });
});

describe("isValidRepositoryForProvider", () => {
  it("accepts per-host layouts and rejects injection attempts", () => {
    expect(isValidRepositoryForProvider("github", "o/r")).toBe(true);
    expect(isValidRepositoryForProvider("github", "a/b/c")).toBe(false);
    expect(isValidRepositoryForProvider("gitlab", "a/b/c")).toBe(true);
    expect(isValidRepositoryForProvider("gitlab", "a")).toBe(false);
    expect(isValidRepositoryForProvider("bitbucket", "ws/repo")).toBe(true);
    expect(isValidRepositoryForProvider("azure-devops", "org/My%20Project/repo")).toBe(true);
    expect(isValidRepositoryForProvider("azure-devops", "org/repo")).toBe(false);
    expect(isValidRepositoryForProvider("gitlab", "a/b;rm -rf")).toBe(false);
  });
});

describe("REST change request creators", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function mockFetch(payload: unknown, ok = true, status = 200) {
    const fn = vi.fn().mockResolvedValue({
      ok,
      status,
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    });
    globalThis.fetch = fn as unknown as typeof fetch;
    return fn;
  }

  function lastCall(fn: ReturnType<typeof vi.fn>) {
    const [url, init] = fn.mock.calls.at(-1) as [
      string,
      { headers: Record<string, string>; body: string; method: string },
    ];
    return { url, init, body: JSON.parse(init.body) as Record<string, unknown> };
  }

  it("creates a GitLab merge request with PRIVATE-TOKEN auth and an encoded project path", async () => {
    const fn = mockFetch({ web_url: "https://gitlab.example.com/g/s/p/-/merge_requests/7" });
    const url = await createGitLabMergeRequestViaApi({
      apiUrl: "https://gitlab.example.com/api/v4/",
      repository: "g/s/p",
      head: "autoremediator/x",
      base: "main",
      title: "fix",
      body: "body",
      draft: true,
      token: "glpat-1",
    });
    expect(url).toBe("https://gitlab.example.com/g/s/p/-/merge_requests/7");
    const { url: endpoint, init, body } = lastCall(fn);
    expect(endpoint).toBe("https://gitlab.example.com/api/v4/projects/g%2Fs%2Fp/merge_requests");
    expect(init.method).toBe("POST");
    expect(init.headers["private-token"]).toBe("glpat-1");
    expect(body).toMatchObject({
      source_branch: "autoremediator/x",
      target_branch: "main",
      title: "Draft: fix",
      description: "body",
    });
  });

  it("surfaces GitLab API failures", async () => {
    mockFetch({ message: "403 Forbidden" }, false, 403);
    await expect(
      createGitLabMergeRequestViaApi({
        apiUrl: "https://gitlab.com/api/v4",
        repository: "g/p",
        head: "h",
        base: "main",
        title: "t",
        body: "b",
        token: "x",
      }),
    ).rejects.toThrow(/GitLab API create merge request failed \(403\)/);
  });

  it("creates a Bitbucket Cloud pull request with bearer auth", async () => {
    const fn = mockFetch({
      links: { html: { href: "https://bitbucket.org/ws/repo/pull-requests/3" } },
    });
    const url = await createBitbucketPullRequest({
      repository: "ws/repo",
      head: "autoremediator/x",
      base: "main",
      title: "fix",
      body: "body",
      draft: true,
      token: "bbtok",
    });
    expect(url).toBe("https://bitbucket.org/ws/repo/pull-requests/3");
    const { url: endpoint, init, body } = lastCall(fn);
    expect(endpoint).toBe("https://api.bitbucket.org/2.0/repositories/ws/repo/pullrequests");
    expect(init.headers.authorization).toBe("Bearer bbtok");
    expect(body).toEqual({
      title: "fix",
      description: "body",
      source: { branch: { name: "autoremediator/x" } },
      destination: { branch: { name: "main" } },
      draft: true,
    });
  });

  it("omits the Bitbucket draft flag for ready pull requests and reports failures", async () => {
    const fn = mockFetch({ links: {} });
    await createBitbucketPullRequest({
      repository: "ws/repo",
      head: "h",
      base: "main",
      title: "t",
      body: "b",
      token: "x",
    });
    expect(lastCall(fn).body).not.toHaveProperty("draft");

    mockFetch({ error: "nope" }, false, 401);
    await expect(
      createBitbucketPullRequest({
        repository: "ws/repo",
        head: "h",
        base: "main",
        title: "t",
        body: "b",
        token: "x",
      }),
    ).rejects.toThrow(/Bitbucket API create pull request failed \(401\)/);
  });

  it("creates an Azure DevOps pull request with PAT basic auth", async () => {
    const fn = mockFetch({
      pullRequestId: 12,
      repository: { webUrl: "https://dev.azure.com/org/proj/_git/repo" },
    });
    const url = await createAzureDevOpsPullRequest({
      repository: "org/proj/repo",
      head: "autoremediator/x",
      base: "main",
      title: "fix",
      body: "b".repeat(5000),
      token: "pat",
    });
    expect(url).toBe("https://dev.azure.com/org/proj/_git/repo/pullrequest/12");
    const { url: endpoint, init, body } = lastCall(fn);
    expect(endpoint).toBe(
      "https://dev.azure.com/org/proj/_apis/git/repositories/repo/pullrequests?api-version=7.1",
    );
    expect(init.headers.authorization).toBe(`Basic ${b64(":pat")}`);
    expect(body).toMatchObject({
      sourceRefName: "refs/heads/autoremediator/x",
      targetRefName: "refs/heads/main",
      title: "fix",
      isDraft: false,
    });
    expect(body.description as string).toHaveLength(4000);
  });

  it("uses bearer auth for Azure DevOps build service tokens and falls back to a built URL", async () => {
    const fn = mockFetch({ pullRequestId: 5 });
    const url = await createAzureDevOpsPullRequest({
      repository: "org/proj/repo",
      head: "h",
      base: "main",
      title: "t",
      body: "b",
      draft: true,
      token: "eyJhbGciOi.eyJzdWIi.c2ln",
    });
    expect(url).toBe("https://dev.azure.com/org/proj/_git/repo/pullrequest/5");
    const { init, body } = lastCall(fn);
    expect(init.headers.authorization).toBe("Bearer eyJhbGciOi.eyJzdWIi.c2ln");
    expect(body.isDraft).toBe(true);
  });

  it("surfaces Azure DevOps API failures", async () => {
    mockFetch({ message: "TF401027" }, false, 403);
    await expect(
      createAzureDevOpsPullRequest({
        repository: "org/proj/repo",
        head: "h",
        base: "main",
        title: "t",
        body: "b",
        token: "x",
      }),
    ).rejects.toThrow(/Azure DevOps API create pull request failed \(403\)/);
  });
});
