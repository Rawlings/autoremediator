# @autoremediator/github-app

## 0.6.0

### Minor Changes

- 54c0f23: Agentic remediation, a security hardening pass, and a reorganized source tree.
  
  **Positioning.** The package, CLI, OpenAPI, GitHub Action, VS Code extension and Claude Code plugin are now described around one loop: plan the fix, repair what an upgrade breaks, verify it independently, roll back on failure. The README is rewritten around it, and the CLI text output lists each package's outcome before the totals. JSON, SARIF and VEX output are unchanged.
  
  **Security hardening.** The tool now assumes the project it works on is not fully trusted.
  
  - Child processes no longer inherit credentials, and dependency install scripts are skipped by default (`installScripts: all` in the policy file restores them).
  - Remote callers (MCP, HTTP, A2A) pass file paths, not inline scripts or policies, and the operations that run a project's installs and tests need the `admin` role.
  - The repair agent can edit fewer files, and a verified change is checked again before it is applied; saved proof-of-fix scripts always run in the sandbox.
  - Recipes a dependency ships for itself are no longer read automatically, and the GitHub App keeps its installation token out of the clone URL.
  - The VS Code extension runs the release it was built with instead of downloading the newest one, and declares that it does not support untrusted workspaces.
  
  **Reorganized source.** The code now lives in feature folders with one dependency direction, and shared helpers (typed errors, schema-checked JSON reading) are in one place. Commands, SDK exports and the MCP, HTTP and A2A contracts are unchanged. The built files moved: the CLI, MCP server and HTTP server are now under `dist/surfaces/`, and the trace hook is under `dist/features/trace/`. The `autoremediator` and `autoremediator-mcp` commands and the `autoremediator/cli`, `/mcp`, `/openapi` and `/trace` subpaths still work.
  
  **Breaking.** Remote integrations that sent inline scripts or policies, or used an `operator` token for operations that now need `admin`, must change. Anything that started a server or hook by its old `dist/` file path must use the new path or the package subpath.

### Patch Changes

- Updated dependencies [54c0f23]
  - autoremediator@0.23.0

## 0.5.0

### Minor Changes

- 6bb2158: The app understands agents and alerts: `/autoremediator plan|fix|retry|rollback|help` comment commands for people with write access, runs started by Dependabot and code scanning alerts, a bot PR doctor for failing Dependabot and Renovate pull requests (opt in), and the `check_run` subscription that pull request healing needed. Existing registrations must update their events and permissions on GitHub.

### Patch Changes

- Updated dependencies [3ef25c7]
- Updated dependencies [fc66a87]
  - autoremediator@0.22.0

## 0.4.2

### Patch Changes

- Security hardening for CodeQL findings: the GitHub App install page only reflects numeric installation IDs (reflected XSS), branch-name and URL trimming no longer use backtracking regexes (ReDoS), the OpenAPI server returns a generic 500 body instead of internal error messages, and disposition evidence is built without writing attacker-controlled keys onto objects (prototype pollution).
- Build with plain `tsc` instead of tsup: the published package now ships the compiled source tree (`dist/cli/index.js`, `dist/api/index.js`, `dist/mcp/server.js`, `dist/openapi/server.js`) instead of bundled entry files. Package names, bin names, and export subpaths are unchanged; only the internal file layout under `dist/` differs.
- Updated dependencies
- Updated dependencies
  - autoremediator@0.21.2

## 0.4.1

### Patch Changes

- 77b43d9: Reorganize the documentation into a navigable tree under `docs/` (getting started, how it works, safety, guides, reference, integrations) and correct package READMEs, the security policy and workflow templates to match what the code does.
- Internal tooling only: all packages now extend a shared root `tsconfig.base.json` (TypeScript 7, ES2025 target, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, `erasableSyntaxOnly` and related strict flags), and the oxlint and oxfmt configs were tightened. No public API or behavior change.
- Updated dependencies [77b43d9]
- Updated dependencies [77b43d9]
- Updated dependencies
  - autoremediator@0.21.1

## 0.4.0

### Minor Changes

- 961d4e3: Make the deterministic remediation pipeline the only pipeline, fix what contradicted its documentation, and harden the boundaries. Details live in `docs/`.
  
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

### Patch Changes

- Updated dependencies [961d4e3]
  - autoremediator@0.21.0

## 0.3.0

### Minor Changes

- 5b4a2ee: Add CI failure auto-healing to parse check-run logs and commit repairs for build, lint, and test errors on remediation pull requests.

### Patch Changes

- Updated dependencies
- Updated dependencies [5b4a2ee]
- Updated dependencies [5b4a2ee]
  - autoremediator@0.20.0

## 0.1.3

### Patch Changes

- Updated dependencies [6fe871e]
- Updated dependencies [6fe871e]
- Updated dependencies [6fe871e]
- Updated dependencies [6fe871e]
- Updated dependencies [6fe871e]
- Updated dependencies [6fe871e]
- Updated dependencies [6fe871e]
- Updated dependencies [6fe871e]
- Updated dependencies [6fe871e]
- Updated dependencies [6fe871e]
  - autoremediator@0.18.0

## 0.1.2

### Patch Changes

- 4fece5d: - **Dependency Modernization & Consolidation (2026 Standards)**:
  - Removed dead/unused `chalk` runtime dependency from `autoremediator` core.
  - Removed redundant `@octokit/rest` monolithic SDK from `autoremediator` core in favor of native `httpClient` (`fetch`), eliminating significant bundle weight.
  - Replaced legacy `tocbot` in documentation app (`docs`) with a pure declarative React 19 TOC component using `IntersectionObserver`.
  - Adopted Pnpm 10 Catalogs (`catalog:`) across workspace packages for unified toolchain versioning (`typescript`, `@types/node`, `vitest`, `tsup`, `yaml`).
- Updated dependencies [4fece5d]
- Updated dependencies [4fece5d]
  - autoremediator@0.17.0

## 0.1.1

### Patch Changes

- 8904cda: Dependency updates.
- Updated dependencies [afef1de]
- Updated dependencies [8904cda]
  - autoremediator@0.16.0
