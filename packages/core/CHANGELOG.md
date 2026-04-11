# Changelog

All notable changes to this project are documented in this file.

## Unreleased

### Added

- Added new high-risk consensus controls across SDK, CLI, MCP, and OpenAPI: `consensusProvider` and `consensusModel`.
- Added per-risk patch confidence override support through `patchConfidenceThresholds` (`low`, `medium`, `high`).

### Changed

- High-risk consensus verification now supports explicit verifier provider/model selection instead of a fixed provider fallback path.
- Patch confidence gating is now risk-aware (`low`/`medium`/`high`) while preserving existing relaxed/strict profile defaults.

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
