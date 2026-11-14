# autoremediator-rawlings

## 0.3.1

### Patch Changes

- 77b43d9: Reorganize the documentation into a navigable tree under `docs/` (getting started, how it works, safety, guides, reference, integrations) and correct package READMEs, the security policy and workflow templates to match what the code does.
- Internal tooling only: all packages now extend a shared root `tsconfig.base.json` (TypeScript 7, ES2025 target, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, `erasableSyntaxOnly` and related strict flags), and the oxlint and oxfmt configs were tightened. No public API or behavior change.

## 0.3.0

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

## 0.2.0

### Minor Changes

- 4fece5d: - **Interactive DevEx & Pre-Flight Package Vetting (`evaluatePackage`)**: Added pre-installation package security vetting querying OSV, CISA KEV active exploitation, FIRST EPSS score percentiles, and npm registry versions. Exposed via SDK `evaluatePackage`, MCP tool `evaluatePackage`, and CLI `autoremediator evaluate <pkg>`.
  - **AST Call-Graph Reachability Tool (`checkReachability`)**: Standalone AST call-graph reachability exploration via `oxc-parser`. Scans project source files for static imports, dynamic `import()`, `require()`, and re-exports to verify whether vulnerable symbols are actually invoked. Exposed via SDK `checkReachability`, MCP tool `checkReachability`, and CLI `autoremediator reachability --package <name> [--symbol <sym>]`.
  - **Git-Aware Delta Vulnerability Scanner (`scanDelta`)**: Analyzes git diffs (working tree vs `HEAD`, or branch vs base ref) to surface only newly introduced or resolved CVEs during in-flight development or PR code reviews. Exposed via SDK `scanDelta`, MCP tool `scanDelta`, and CLI `autoremediator diff [--base <ref>]`.
  - **Diff-First MCP Protocol & Unified Diffs**: Attached syntax-highlighted `unifiedDiff` strings to `SimulationMutation` and `ResultSimulation` to enable rich interactive code previews in MCP chat hosts (VS Code GitHub Copilot, Roo Code, Cline) before modifying disk.
  - **VS Code Extension Modernization**: Added rich HoverProvider with exploit telemetry cards, CodeLens summary annotations in `package.json`, virtual patch side-by-side diff previews (`autoremediator-patch://`), and debounced in-memory caching.

### Patch Changes

- 4fece5d: - **Dependency Modernization & Consolidation (2026 Standards)**:
  - Removed dead/unused `chalk` runtime dependency from `autoremediator` core.
  - Removed redundant `@octokit/rest` monolithic SDK from `autoremediator` core in favor of native `httpClient` (`fetch`), eliminating significant bundle weight.
  - Replaced legacy `tocbot` in documentation app (`docs`) with a pure declarative React 19 TOC component using `IntersectionObserver`.
  - Adopted Pnpm 10 Catalogs (`catalog:`) across workspace packages for unified toolchain versioning (`typescript`, `@types/node`, `vitest`, `tsup`, `yaml`).

## 0.1.1

### Patch Changes

- 8904cda: Dependency updates.
