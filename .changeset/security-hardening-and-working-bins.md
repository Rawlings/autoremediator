---
"autoremediator": minor
---

Fix installed binaries and close several security holes.

**Fixes**

- `autoremediator`, `autoremediator-mcp` and the OpenAPI server now actually start when launched through an npm/pnpm bin symlink (`npx`, global install, GitHub Action). Previously the entry-point check compared the symlink path to the real path and the process exited silently without doing anything.
- Rollback no longer deletes or reverts files outside the project when the project is a subdirectory of a git repository (git status paths are repo-root relative), no longer treats any filename containing "lock" as a lockfile, and restores binary lockfiles such as `bun.lockb` byte-for-byte.
- Package-manager installs and test runs routed through `safeExeca` now use an explicit 10-minute limit instead of an implicit 60-second one.

**Security (breaking for some callers)**

- `safeExeca` now really sanitizes the child environment (`extendEnv: false`); every subprocess call goes through it. Previously `NODE_OPTIONS`, `LD_PRELOAD` and similar variables were re-merged from the parent.
- Source-file fetching for patch generation no longer builds a `bash -c "curl … | tar …"` pipeline from a registry URL, requires `https`, and refuses paths escaping the package root.
- Model-written reproduction tests are no longer written to disk and executed during patch fallback. Supply your own `proofOfFix` / `reproductionTest` instead.
- The orchestration prompt is no longer read from the target repository's working directory.
- `changeRequest` is rejected together with `dryRun`, `preview` and `planRemediation` on every surface (previously only the CLI blocked it), and change requests stage only tracked modifications plus generated patch files instead of `git add -A`.
- `changeRequest.tokenEnvVar` and `changeRequest.githubApiUrl` are stripped from MCP and HTTP input so a caller cannot send the server's GitHub token to a URL of their choosing.
- OpenAPI server is secure by default: authentication must be configured (or explicitly disabled with `AUTOREMEDIATOR_INSECURE_NO_AUTH=1`), `POST` requires `Content-Type: application/json`, bodies are capped at 1 MiB, the `Host` header is allow-listed, and path options are confined to allowed roots (`AUTOREMEDIATOR_ALLOWED_ROOTS`). See the integrations docs.

**Packaging**

- `exports` lists `types` before `import`, and the Docker image is now built from this checkout instead of installing a hard-coded old npm version.
