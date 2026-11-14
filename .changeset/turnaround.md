---
"autoremediator": minor
"@autoremediator/github-app": minor
"autoremediator-rawlings": minor
---

Make the deterministic remediation pipeline the only pipeline, fix what contradicted its documentation, and harden the boundaries. Details live in `docs/`.

**Breaking**

- Node.js 26 and pnpm 12 are required (`engines.node` is `>=26.0.0`). The GitHub Action and reusable workflow default to Node 26, and Docker images use `node:26-alpine`.
- Removed the LLM tool-calling pipeline and the options built around it: `llmProvider`, `modelPersonality`, `providerSafetyProfile`, `dynamicModelRouting`, `dynamicRoutingThresholdChars`, `requireConsensusForHighRisk`, `consensusProvider`, `consensusModel`, `regressionCheck` and `onProgress`. This covers the CLI, SDK, MCP, HTTP, policy file, GitHub App config and the matching `AUTOREMEDIATOR_*` variables.
- Removed `agentSteps`, `estimatedCostUsd` and `regressionDetected` from reports, along with enrichment sources that were never wired in and the SIEM audit logger.
- Removed the `docs` package and site. Documentation is markdown under `docs/`.
- Patch generation is configured with `model` (`provider:model-id`, loaded from `@ai-sdk/<provider>`) or an SDK `patchGenerator`. Output is schema-validated, syntax-checked and confidence-gated. Model-written tests are never run. With neither configured, patch fallback is reported as unavailable.
- Policy files are validated: unknown fields, bad values, invalid YAML and a missing explicit path are errors.
- `changeRequest` is rejected together with `dryRun`, `preview` and `planRemediation` on every surface. `changeRequest.tokenEnvVar` and `githubApiUrl` are stripped from MCP and HTTP input.
- The OpenAPI server requires authentication (or `AUTOREMEDIATOR_INSECURE_NO_AUTH=1`), `Content-Type: application/json`, bodies of at most 1 MiB, an allow-listed `Host` and confined paths (`AUTOREMEDIATOR_ALLOWED_ROOTS`). `POST /jobs/*` require the `admin` role.
- GitHub App repository config `cwd` must be a relative path inside the checkout.

**Fixes**

- Installed binaries (`npx`, global installs, the GitHub Action) now start. The entry-point check no longer compares a symlink to its real path.
- Installs after a manifest change are no longer frozen, which made every default version bump fail. Use `enforceFrozenLockfile` to freeze.
- KEV and EPSS enrichment now runs, so `exploitSignalOverride` and `escalateOnKev` can fire. OSV ranges with several intervals, `ECOSYSTEM` ranges or version lists are parsed correctly, and publication dates feed SLA checks.
- `containmentMode` rolls back only applied `hold-for-approval` results, never fixes for actively exploited or SLA-breached CVEs.
- VEX claims `resolved` only when every affected package was fixed, and `not_affected` only from explicit suppressions.
- Rollback stays inside the project, uses exact lockfile names and restores binary lockfiles byte-for-byte.
- `safeExeca` really sanitizes the child environment, and every subprocess goes through it. Installs and test runs get an explicit 10-minute limit. Source fetching no longer shells out to `curl | tar`.
- CLI: options typed after a subcommand reach it, unknown subcommand options are an error, and omitted boolean flags no longer override the policy file.
- VS Code extension: now calls the real CLI flags, types its parsing against core's exported report types, accepts GHSA ids and no longer marks advisory text as trusted.
- GitHub Action: `pull-request-branch` and `pull-request-title` are applied, `pull-request-url` is found, and `update-outdated` works on its own. The unused `pull-request-commit-message` input was removed.
- The Docker image is built from this checkout, and `exports` lists `types` first.

**Added**

- `breakingChangeRefactor`: built-in call-site codemods (`rimraf` and `uuid`) for breaking upgrades.
- `proofOfFix` and `requireProofOfFix`: verify that a reproduction test fails before the fix and passes after it. You supply the test.
- GitHub App: CI failure auto-healing for build, lint and test errors on remediation pull requests.
