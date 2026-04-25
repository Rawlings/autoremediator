# Changelog

## 0.11.0

### Added

- Added VEX suppression support: `suppressionsFile` option accepts a path to a YAML file containing `{ suppressions: [] }` entries. Each suppression matches a `cveId` with a VEX `justification` (`not_affected`, `vulnerable_code_not_in_execute_path`, `inline_mitigations_already_exist`, `component_not_present`, `not_affected_vulnerable_code_unreachable`). Matched CVEs are skipped before inventory analysis, and the suppression justification appears in the report summary.
- Added exploit-signal prioritization via `exploitSignalOverride` option: `kev.mandatory: true` treats CVEs with active CISA KEV status as unconditionally mandatory; `epss.mandatory: true` with `epss.threshold` promotes CVEs above a given EPSS probability. When a signal fires, `exploitSignalTriggered: true` appears on the report. Both controls are configurable from `.github/autoremediator.yml`.
- Added SLA breach alerting via `slaCheck` option and `sla` policy field. When `slaCheck: true` and SLA windows are configured (`sla.critical`, `sla.high`, `sla.medium`, `sla.low` in hours), CVE publication age is compared against the window. Breaches appear in `slaBreaches` on the report, each including `cveId`, `severity`, `publishedAt`, and `hoursOverdue`.
- Added static reachability filtering via `skipUnreachable` option. When enabled, packages not imported from project source (`.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`) are skipped. Skip reason and `reachability` assessment are included on the result.
- Added SBOM generation: `RemediationReport.sbom` is an array of `SbomEntry` records (one per installed package) with `name`, `version`, `type`, `status` (`patched` | `unpatched` | `skipped` | `suppressed`), and optional `cveId`.
- Added patch integrity signing: every generated patch artifact now includes an `integrity` field containing a SHA-256 content hash (`sha256:<hex>`). `PatchArtifact.integrity` and `PatchArtifactSummary.integrity` are included in patch lifecycle results.
- Added regression detection via `regressionCheck` option. When enabled, the patched version is verified against the CVE's vulnerable semver range after apply. If the installed version still falls within the range, `regressionDetected: true` is set on the `PatchResult`.
- Added `SbomEntry`, `SbomStatus`, and related types to the public SDK exports.
- Added `--suppressions-file`, `--sla-check`, `--skip-unreachable`, and `--regression-check` CLI flags.
- Evidence output now includes per-result `suppressedBy` justification and `regressionDetected` flag, and per-run `exploitSignalTriggered`, `slaBreachCount`, `regressionDetectedCount`, and `sbomEntryCount` in the finish step.

## 0.10.0

### Added

- Added `updateOutdated()` SDK function to bump all non-CVE outdated packages to their latest compatible versions. Respects `allowMajorBumps` policy (major bumps are skipped by default), supports `includeTransitive`, `dryRun`, `runTests`, `changeRequest`, and `evidence` options, and returns an `UpdateOutdatedReport` with updated/skipped/failed counts.
- Added `autoremediator update-outdated` CLI command with `--include-transitive` flag.
- Added `updateOutdated` MCP tool and `POST /update-outdated` OpenAPI route, maintaining full cross-surface parity.
- Added `OutdatedPackage`, `UpdateOutdatedOptions`, and `UpdateOutdatedReport` types to the public SDK.
- Added `CveSeverity` to the public SDK type exports.
- Added `action.yml` inputs: `token` (defaults to `${{ github.token }}`), `create-pull-request`, `pull-request-branch`, `pull-request-title`, and `pull-request-commit-message` for native pull request creation from the GitHub Action. Pull request creation is skipped when `dry-run` is `true`.
- Added `pull-request-url` output to `action.yml`.
- Added `update-outdated` and `include-transitive` inputs to `action.yml` and the reusable `reusable-remediate-from-audit.yml` workflow.
- Added GitHub App per-repository configuration via `.github/autoremediator.yml` fetched from each target repository on every webhook delivery. All remediation behavior (dryRun, runTests, minimumSeverity, pullRequest, policy constraints) is now dynamically resolved per-repo.
- Added `AutoremediatorRepoConfig`, `DEFAULT_REPO_CONFIG`, and `fetchRepoConfig()` to the GitHub App public exports.
- Added GitHub App status publishing: remediation job lifecycle (queued → in_progress → completed) is now reported as GitHub check runs when `AUTOREMEDIATOR_GITHUB_APP_ENABLE_STATUS_PUBLISHING=true`. Check name customizable via `AUTOREMEDIATOR_GITHUB_APP_STATUS_CHECK_NAME`.
- Added GitHub App manifest-based one-click registration flow: `GET /setup` renders a pre-filled GitHub App manifest form; `GET /setup/complete` exchanges the manifest code for credentials (CSRF protected via state cookie); `GET /install` confirms installation. Setup can be protected with `AUTOREMEDIATOR_GITHUB_APP_SETUP_SECRET`.
- Added push event support to the GitHub App: pushes to the default branch now trigger remediation (in addition to `check_suite.requested` and `workflow_dispatch`).
- Added `installation.new_permissions_accepted` as a handled activation action in the GitHub App event dispatcher.
- Added minimum severity filtering in the GitHub App default remediation handler. When `minimumSeverity` is set in `.github/autoremediator.yml`, audit findings below the threshold are filtered before remediation; filtered CVEs are written to a temp SARIF file and passed directly to `remediateFromScan`.
- Added GitHub Enterprise Server support via `AUTOREMEDIATOR_GITHUB_APP_GITHUB_URL` and `AUTOREMEDIATOR_GITHUB_APP_GITHUB_API_URL` environment variables.
- Added `AUTOREMEDIATOR_GITHUB_APP_BASE_URL` for explicit webhook URL override and `AUTOREMEDIATOR_GITHUB_APP_ENABLE_SETUP_ROUTES` to disable setup endpoints in production.

### Changed

- **Breaking:** Policy file format changed from `.autoremediator.json` (JSON) to `.github/autoremediator.yml` (YAML). Update any existing policy files accordingly.
- **Breaking (GitHub App):** `AUTOREMEDIATOR_GITHUB_APP_REMEDIATION_CWD` and `AUTOREMEDIATOR_GITHUB_APP_REMEDIATION_DRY_RUN` environment variables removed. Remediation behavior is now controlled per-repository via `.github/autoremediator.yml` fetched from each target repo.
- **Breaking (GitHub App):** `createDefaultRemediationHandler` no longer accepts `cwd`/`dryRun` options. It now requires an `octokitFactory` function and accepts an optional `repoConfigProvider` for testing. Per-repo config is fetched automatically via the GitHub API.
- `check_suite.completed` action is now explicitly ignored by the event dispatcher; only `requested` and `rerequested` actions trigger remediation (previously both actions were treated as equivalent).

### Fixed

- Scanner adapters: `moderate` severity from npm/yarn audit output is now correctly normalized to `MEDIUM` (was previously mapped to `UNKNOWN`).

## 0.9.0

### Added

- Added portfolio remediation public operation support across surfaces, including SDK `remediatePortfolio`, CLI `portfolio` command wiring, and MCP/OpenAPI parity.
- Added change-request enhancements for grouped scan execution and portfolio-level change-request aggregation. Pull request and merge request creation uses the `gh` (GitHub CLI) and `glab` (GitLab CLI) tools, so those CLIs must be available in the execution environment when change request creation is enabled.
- Added remediation report enrichments for reachability assessment and fix explanation fields.
- Added new high-risk consensus controls across SDK, CLI, MCP, and OpenAPI: `consensusProvider` and `consensusModel`.
- Added per-risk patch confidence override support through `patchConfidenceThresholds` (`low`, `medium`, `high`).
- Added install behavior constraints (`installMode`, `installPreferOffline`, `enforceFrozenLockfile`) to give consumers explicit control over remediation apply/rollback install commands.
- Added workspace-scoped remediation constraint support (`workspace`) for monorepo-targeted install/list/test execution.
- Added scan-mode native audit ingestion (`--audit`) so npm/pnpm/yarn audit output can be consumed directly without a pre-generated file.
- Added package-manager-native dependency path diagnostics command resolution (`npm explain`, `pnpm why`, `yarn why`) for remediation context.
- Added override selector support so override remediation can target manager-native selector keys (including nested/scoped selectors).

### Changed

- High-risk consensus verification now supports explicit verifier provider/model selection instead of a fixed provider fallback path.
- Patch confidence gating is now risk-aware (`low`/`medium`/`high`) while preserving existing relaxed/strict profile defaults.
- Remediation apply flows now use deterministic lockfile-respecting install commands (`npm ci`, `pnpm install --frozen-lockfile`, `yarn install --frozen-lockfile`) for apply and rollback validation steps.
- Native scan audit mode now honors workspace-scoped execution for npm/pnpm when `workspace` constraints are provided.
- Native scan audit mode parse failures now include command and exit-code context to improve debugging in CI and local runs.
- Version-bump and override remediation now run a best-effort package-manager dedupe pass after successful apply/validation.

## 0.8.0

### Added

- Added first-class patch lifecycle workflows across SDK, CLI, MCP, and OpenAPI with patch listing, inspection, and validation operations.
- Added patch manifest sidecars (`.patch.json`) so patch artifacts can be inspected and validated as durable outputs.
- Added `modelPersonality`, `providerSafetyProfile`, `requireConsensusForHighRisk`, `dynamicModelRouting`, and `dynamicRoutingThresholdChars` options for advanced model orchestration controls.
- Added `llmUsage` telemetry on remediation reports and aggregate LLM telemetry fields (`llmUsageCount`, `estimatedCostUsd`, `totalLlmLatencyMs`) on scan/CI summary surfaces.
- Added provider-aware orchestration prompt addendum support with non-mutating plan-first guidance.

### Changed

- Expanded patch-file remediation results with patch artifact metadata and phased validation details for better machine-readable automation.
- Added CLI patch lifecycle commands: `autoremediator patches list`, `autoremediator patches inspect`, and `autoremediator patches validate`.
- **Breaking:** public provider surface is now vendor-neutral: `llmProvider` uses `remote|local` instead of vendor-specific values.
- **Breaking:** remote model wiring now uses generic adapter environment variables: `AUTOREMEDIATOR_REMOTE_CLIENT_MODULE`, `AUTOREMEDIATOR_REMOTE_CLIENT_FACTORY`, and `AUTOREMEDIATOR_REMOTE_API_KEY`.

## 0.7.0

### Changed

- Improved consistency across SDK, CLI, MCP, and OpenAPI so shared options and report fields behave the same way across interfaces.
- Expanded local-mode remediation behavior with deterministic-first execution and controlled patch fallback handling when safe upgrades are unavailable.
- Improved single-CVE CLI parity with CI and SARIF workflows so `cve` mode aligns with scan-mode automation expectations.
- Enhanced remediation reporting and evidence outputs with clearer aggregate summaries for strategy, dependency scope, unresolved reasons, and patch activity.

## 0.6.0

### Changed

- This release turns autoremediator into a more complete remediation platform rather than a version-bump-only tool. It now handles direct upgrades, transitive dependency overrides or resolutions, and controlled patch fallback under one policy-driven workflow.
- Reporting and governance were tightened across every surface. SDK, CLI, MCP, OpenAPI, and evidence outputs now expose clearer rollups for remediation strategy, dependency scope, unresolved reasons, patch activity, and replay or provenance context.
- The public contract was cleaned up and aligned across touchpoints so the same concepts, option names, and summary fields behave consistently whether the tool is used in CI, through code, or from an agent or service integration.
- Operational readiness improved with stronger fallback validation, better constraint enforcement, richer documentation, and a cleaner release path for the VS Code extension and CI-facing packaging flows.

## 0.4.1

### Changed

- Updated project dependencies to latest compatible versions.
- Updated supported Node.js runtime version requirements.

## 0.4.0

### Added

- **Multi-source CVE intelligence enrichment**: Eight new vulnerability intelligence providers integrated with non-fatal degradation:
  - CISA Known Exploited Vulnerabilities (KEV) for real-world exploitation signal
  - FIRST Exploit Probability Scoring System (EPSS) for exploit probability quantification
  - CVE.org canonical record enrichment (CVE Services) for authoritative metadata
  - GitLab Security Advisory API for supplemental package range intelligence
  - CERT/CC vulnerability note sourcing
  - deps.dev package repository coverage
  - OpenSSF Security Scorecard for repository security posture
  - Pluggable vendor/commercial intelligence connector with bearer token support
- **Source health observability**: `sourceHealth` field tracks per-source enrichment attempts, changes, and errors at runtime.
- **Environment variable configuration** for all intelligence sources:
  - `AUTOREMEDIATOR_EPSS_API`, `AUTOREMEDIATOR_CVE_SERVICES_API`, `AUTOREMEDIATOR_GITLAB_ADVISORY_API`
  - `AUTOREMEDIATOR_CERTCC_SEARCH_URL`, `AUTOREMEDIATOR_DEPSDEV_API`, `AUTOREMEDIATOR_SCORECARD_API`
  - `AUTOREMEDIATOR_VENDOR_ADVISORY_FEEDS`, `AUTOREMEDIATOR_COMMERCIAL_FEEDS`, `AUTOREMEDIATOR_COMMERCIAL_FEED_TOKEN`
- **Type extensions to CveDetails**: New metadata fields for enriched CVE context:
  - `epss`: FIRST score, percentile, date
  - `kev`: Known-exploited flag, due date, required action, ransomware campaign use
  - `intelligence.sourceHealth`: Per-source enrichment tracking with change detection
  - Additional fields: `cveServicesEnriched`, `gitlabAdvisoryMatched`, `certCcMatched`, `depsDevEnrichedPackages`, `scorecardProjects`, `vendorAdvisories[]`, `commercialFeeds[]`
- **Public API field naming normalization** across SDK/CLI/MCP/OpenAPI:
  - Unified terminology: `runTests`, `policy`, `evidence`, `patchCount`, `patchesDir`
  - Consistent cross-surface naming for all public API entry points
- **Documentation**: Source precedence hierarchy, configuration guidance, and trust/advisory source taxonomy.

### Changed

- **lookup-cve tool** now enriches CVE details with all configured intelligence sources in deterministic order.
- **CveDetails** type now includes sourceHealth observability and enriched metadata fields (epss, kev, additional intelligence).
- **Configuration layer** extended with IntelligenceSourceConfig for environment-based source endpoint customization.

### Technical Details

- **Non-fatal enrichment**: All supplemental sources gracefully degrade on error. Failures logged but never halt remediation.
- **Source order**: NVD → CISA KEV → EPSS → CVE Services → GitLab Advisory → CERT/CC → deps.dev → OpenSSF Scorecard → External Feeds
- **Primary intel unchanged**: OSV and GitHub Advisory Database remain authoritative for affected npm packages. All other sources are optional enrichment.
- **Backwards compatible**: New fields additive; existing code paths unaffected. Environment variables optional with defaults.

## 0.3.0

### Added

- New SDK entry point: `planRemediation(cveId, options?)` for non-mutating remediation preview flows.
- New preview option plumbing across interfaces:
  - SDK/API: `RemediateOptions.preview`
  - CLI: `--preview`
  - MCP: `preview` input field where applicable
  - OpenAPI: `POST /plan-remediation`
- Correlation context fields for run traceability:
  - `requestId`, `sessionId`, `parentRunId`
  - propagated through SDK/CLI/MCP/OpenAPI and evidence output.
- Repository mutation lock for concurrent safety in mutating remediation paths.
- Additional test coverage for API preview behavior, correlation propagation, OpenAPI route contracts, CLI option forwarding, and MCP tool contracts.
- Idempotency/resume support via `idempotencyKey` + `resume`, including cached report replay behavior.
- Idempotency state persistence under `.autoremediator/state/idempotency.json`.
- Constraint enforcement support via `constraints.directDependenciesOnly` and `constraints.preferVersionBump`.
- New CLI options for replay/provenance/constraints:
  - `--idempotency-key`, `--resume`
  - `--actor`, `--source`
  - `--direct-dependencies-only`, `--prefer-version-bump`
- Provenance metadata support via `actor` and `source`, propagated through reporting and evidence.
- Expanded API, MCP, and OpenAPI option schemas to include idempotency, provenance, and constraints fields.
- Additional test coverage for lock integration in mutating tools (`apply-version-bump`, `apply-patch-file`) and idempotency/constraint enforcement behavior.

### Changed

- OpenAPI server and CLI/MCP entrypoints were refactored for import-safe testability (no auto-start side effects on module import).
- MCP tool dispatch was extracted into a testable handler (`handleToolCall`) with structured unknown-tool error handling.
