# Changelog

All notable changes to this project are documented in this file.

## Unreleased

### Added

- Added GitHub workflow packaging for audit-driven setup, including action-level `audit` mode, a reusable remediation workflow with optional PR creation, and copyable workflow templates for enforcement gates, nightly remediation PRs, and SARIF upload.
- Added workflow governance automation for GitHub delivery assets, including workflow linting, template metadata validation, stable reusable-workflow reference enforcement, and fixture-based smoke coverage for action and reusable-workflow paths.

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
