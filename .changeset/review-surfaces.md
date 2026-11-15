---
"autoremediator": patch
---

Security fixes from a review of the HTTP, MCP and A2A surfaces and the git integrations.

- **Git refs from callers can no longer act as git options.** `scanDelta` (and `guardGitDiff`) resolve `baseRef` with `git rev-parse --verify --end-of-options` and use the commit id; a value starting with `-` is refused (`baseRef: "--output=<path>"` used to create a file outside the allowed roots). A caller-supplied change-request `baseBranch` gets the same check.
- **`compilePolicy` and `radar` need the `operator` role** (they were `reader`): they can send the policy or package text to a model provider the caller names, call GitHub and download up to a 256 MB tarball budget. Both stay `destructiveHint: false`.
- **`buildEvidencePack` no longer deletes unrelated files.** An earlier pack is recognised only by a manifest written by autoremediator (`schemaVersion` and `generator.name`); only the files it lists are removed, and only when their sha256 still matches; only directories the pack made are pruned; a non-empty directory that is not a pack, or a pack with edited files, is refused with nothing removed. The operation is now `destructiveHint: true`, so it needs the `admin` role and an MCP host asks before calling it.
- **Package names are validated** (`packageNameSchema`, `generateProofOfFix.package`, `readMaintainerVex.packageName`) and `packumentUrl` refuses a name that is not a plain or `@scope/` npm name, so `a/../../-/npm/v1/tokens` can no longer steer an authenticated registry request. Legacy upper-case names such as `JSONStream` are still accepted.
- **A2A task store**: a task keeps a 2 KB copy of the caller's message instead of the whole message, the store is bounded in total bytes (64 MB, 4 MB per result) as well as in count and age, and `GetTask` returns a task only to the caller that ran it (the JWT `sub`, else a digest of the bearer token); anyone else sees "Task not found".
- **yarn.lock aliases**: `foo@npm:bar@^1.0.0` is now the package `bar` (classic: from the descriptor; berry: from `resolution:`), so incident exposure, history and rollback see it.
- **Change-request tokens go only where they belong.** The push/fetch authorization header and the host API token are sent only to an `https` remote (or loopback) on a host that fits the provider: for GitHub, github.com, `*.ghe.com` or a host named by `githubApiUrl`, `GITHUB_SERVER_URL`, `GITHUB_API_URL` or `GH_HOST` (or a token passed explicitly); a host that belongs to another provider, or an `http` remote, is refused with an explanation before anything is committed.
