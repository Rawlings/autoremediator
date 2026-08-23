# Policy and Safety

Policy controls decide what is allowed.

Safety controls decide what is considered successful.

Use both together to run remediation automation without silent risk acceptance.

Related references:

- [CLI Reference](cli.md)
- [Getting Started](getting-started.md)
- [Integrations](integrations.md)

## Autonomous Operator Policies

The policy surface now includes controls for result disposition, containment, escalation routing, and non-mutating simulation output.

## Policy Configuration

Create `.github/autoremediator.yml`:

```yaml
# Permit major-version upgrades (false recommended for most teams)
allowMajorBumps: false

# Packages that must never be modified by automation
denyPackages:
  - lodash

# Optional: restrict automation to only these packages
allowPackages: []

# Dependency resolution constraints
constraints:
  directDependenciesOnly: false
  preferVersionBump: false
  installMode: deterministic
  installPreferOffline: true
  enforceFrozenLockfile: true
  workspace: "@apps/web"

# SecOps controls
skipUnreachable: false

dispositionPolicy:
  minConfidenceForAutoApply: 0.85
  holdForTransitive: true
  escalateOnKev: true

containmentMode: false

exploitSignalOverride:
  kev:
    mandatory: true # treat CISA KEV-listed CVEs as mandatory
  epss:
    mandatory: true
    threshold: 0.7 # promote CVEs with EPSS score >= 0.7

suppressions:
  - cveId: CVE-2021-99999
    justification: not_affected
    notes: Vulnerable code path is not reachable in this deployment
  - cveId: CVE-2022-11111
    justification: inline_mitigations_already_exist

sla:
  critical: 24 # hours
  high: 72
  medium: 168
  low: 720

escalationGraph:
  no-safe-version: open-issue
  source-fetch-failed: notify-channel
```

Field intent:

- `allowMajorBumps`:
  - what: permits major-version remediation changes
  - why: major upgrades can break runtime behavior
  - guidance: keep `false` by default unless your release governance explicitly supports major upgrades
- `denyPackages`:
  - what: packages the automation must not modify
  - why: protect sensitive dependencies with manual review requirements
- `allowPackages`:
  - what: optional allowlist boundary
  - why: limit automation scope during staged rollout
- `constraints.directDependenciesOnly`:
  - what: blocks outcomes for transitive dependencies
  - why: keeps automation within directly managed dependency scope
- `constraints.preferVersionBump`:
  - what: rejects patch-file outcomes
  - why: enforces bump-first remediation policy for change governance
- `constraints.installMode`:
  - what: selects install profile (`deterministic`, `prefer-offline`, or `standard`) for apply and rollback operations
  - why: allows balancing reproducibility and operational flexibility per environment
- `constraints.installPreferOffline`:
  - what: explicitly enables or disables `--prefer-offline` where supported
  - why: helps tune install reliability across cache-heavy and cache-cold runners
- `constraints.enforceFrozenLockfile`:
  - what: explicitly enables or disables lockfile-strict install behavior
  - why: allows teams to enforce deterministic lockfile safety or temporarily relax it during recovery workflows
- `constraints.workspace`:
  - what: scopes install/list/test operations to a specific workspace/package selector
  - why: reduces remediation blast radius in monorepos and improves run performance
- `skipUnreachable`:
  - what: skips packages not imported from project source files
  - why: reduces noise from packages that cannot be reached by the running application
- `dispositionPolicy`:
  - what: classifies each result as `auto-apply`, `simulate-only`, `hold-for-approval`, or `escalate`
  - why: lets teams control when successful technical remediations can still require operator review
- `containmentMode`:
  - what: prevents applied results with disposition `escalate` from mutating the repository
  - why: lets teams run approval-first security automation without losing machine-readable remediation intent
- `escalationGraph`:
  - what: maps unresolved reasons to intended escalation actions (`open-issue`, `notify-channel`, `create-draft-pr`, `hold-branch`, `none`)
  - why: gives teams deterministic follow-up routing for unresolved outcomes while keeping remediation execution side-effect free- `exploitSignalOverride.kev.mandatory`:
  - what: treats CVEs with active CISA KEV status as unconditionally mandatory
  - why: ensures actively-exploited CVEs bypass severity filtering
- `exploitSignalOverride.epss.mandatory` + `threshold`:
  - what: treats CVEs above the configured EPSS probability as mandatory
  - why: aligns automation priority with statistically likely exploitation
- `suppressions`:
  - what: inline VEX suppression entries matched by `cveId`
  - why: suppresses false positives without modifying installed packages or ignoring the CVE entirely
  - justification values: `not_affected`, `vulnerable_code_not_in_execute_path`, `inline_mitigations_already_exist`, `component_not_present`, `not_affected_vulnerable_code_unreachable`
- `sla`:
  - what: per-severity breach windows in hours
  - why: makes breach detection deterministic and auditable without requiring external tracking

## SecOps Controls

### VEX Suppression

Suppress a CVE before inventory analysis using VEX justification entries. Suppressed CVEs do not reach the remediation pipeline and appear as zero-result runs with the justification in the summary.

Options:

- `suppressionsFile` (CLI/SDK): path to an external YAML file containing additional suppression entries (merged with policy-inline suppressions)
- `suppressions` (policy): inline entries in `.github/autoremediator.yml`

### Exploit Signal Prioritization

`exploitSignalOverride` elevates CVEs above standard severity filtering when exploitation signals are active:

- CISA KEV: CVEs flagged in the Known Exploited Vulnerabilities catalog
- FIRST EPSS: CVEs with a probability score above the configured threshold

When a signal fires, `exploitSignalTriggered: true` appears in the report.

### SLA Breach Alerting

When `slaCheck: true` and `sla` windows are configured, CVE publication age is compared against window thresholds. Breached CVEs appear in `slaBreaches` on the report with `cveId`, `severity`, `publishedAt`, and `hoursOverdue`.

In addition, scan and portfolio reports include `slaBreachSummary` — a structured aggregate with `breachCount` and a `breaches` array of `SlaBreachEntry` records. Each entry includes the `cveId`, `severity`, `hoursOverdue`, `deadlineAt`, and a `recommendedAction` derived from the escalation graph for that CVE. This field is also propagated to `CiSummary` via `toCiSummary()` for pipeline-visible gating.

Enable with `--sla-check` (CLI) or `slaCheck: true` (SDK).

### AST Call-Graph Reachability Engine (Pillar 3.1)

When `skipUnreachable: true`, autoremediator executes a high-performance AST-level reachability analysis across project source files (`.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`) using the Rust-based `oxc-parser`:

- **Full Import Resolution**: Walks the abstract syntax tree for static ESM import declarations (`import ... from 'pkg'`), dynamic imports (`import('pkg')`), CommonJS calls (`require('pkg')`), and re-exports (`export ... from 'pkg'`).
- **Path-Alias Resolution**: Automatically parses `tsconfig.json` and `jsconfig.json` (`compilerOptions.paths` and `compilerOptions.baseUrl`), mapping custom path aliases (`@/components/*`, `~/lib/*`) to actual filesystem sources.
- **Function-Level Invocation Tracing**: Analyzes `CallExpression`, `NewExpression`, and `MemberExpression` nodes (e.g. `_.template()`, `template()`, `lodash.template()`).
- **Dead-Code Pruning & VEX Justification**: If a vulnerable package is imported but the vulnerable symbol is never invoked in any execution path, reachability resolves to:
  - `status: "not-reachable"`
  - `reachabilityBasis: "call-graph-uninvoked"`
  - `justification: "code_not_in_execute_path"`
- **CycloneDX 1.5 VEX Integration**: Automatically emits `state: "not_affected"` VEX statements with standard justification codes and audit trace details.

Enable with `--skip-unreachable` (CLI) or `skipUnreachable: true` (SDK).

### Subprocess Execution Sandboxing & Supply Chain Hardening

All child process executions (package manager installs, deduplications, and test runners) execute through an isolated subprocess runner (`safeExeca`):

- **Environment Sanitization**: Strips dangerous process-injection environment variables that could be exploited during supply chain installations: `NODE_OPTIONS`, `LD_PRELOAD`, `DYLD_INSERT_LIBRARIES`, `DYLD_LIBRARY_PATH`, `PERL5OPT`, and `RUBYOPT`.
- **Execution Timeouts**: Enforces deterministic timeouts to prevent rogue lifecycle hooks or tests from hanging CI pipelines.
- **Argument-Level Injection Defense**: Enforces strict argument separation to prevent subshell command chaining and flag injection.

### Universal Git-Aware Dynamic Atomic Rollback

All mutating operations run within an atomic rollback envelope (`withAtomicRollback`):

- **Git-Aware Transaction Revert**: Compares working tree status via `git status --porcelain=v1 -uall`. In the event of a test failure or interrupted run, untracked artifacts (`??`) are cleaned and modified tracked files (`M`) are reverted to their exact pre-remediation commit state.
- **Dynamic File-Touch Registry (`recordFileTouch`)**: For non-git environments or dynamically touched files (such as modified source files and patch files), every touched file is registered and snapshotted in-memory, guaranteeing byte-for-byte rollback if tests fail.

### Multi-Language Manifest & Patch Syntax Pre-Validation

Before applying any generated code patch or updating manifests, autoremediator performs an AST-level syntax verification gate:

- **JavaScript / TypeScript**: Syntax verified using the `oxc-parser` AST parser.
- **JSON (`package.json`, `tsconfig.json`)**: Validated via strict JSON parser.
- **YAML (`pnpm-lock.yaml`, workflow definitions)**: Validated via YAML parser.

Patches containing syntax errors or malformed structures are rejected prior to touching the disk.

### Simulation Mode

When `simulationMode: true`, autoremediator adds deterministic simulation metadata to dry-run and preview results without changing runtime remediation order or mutating repository state.

Simulation mode is only valid in effective non-mutating contexts:

- `dryRun: true`
- `preview: true`
- `planRemediation(...)`, which forces both

If `simulationMode` is requested on a mutating run, the public API and CLI fail fast with a deterministic validation error.

Simulation outputs add:

- `results[].simulation.plannedMutations`: deterministic mutation targets that would be touched by the selected strategy
- `results[].simulation.rebuttalFindings`: deterministic rebuttal codes derived from unresolved, validation, regression, risk, escalation, exploit-signal, SLA, and test-run signals
- `simulationSummary`: aggregate counts on remediation, scan, CI, and evidence summaries when simulation mode is enabled

Evidence remains additive only: existing evidence artifacts are reused, and simulation summary data is appended to finish/summary metadata rather than written as a separate artifact.

### Containment Mode

When `containmentMode: true`, results with disposition `escalate` are prevented from being applied.
If a result would otherwise be applied, containment rewrites it to `applied: false` with `unresolvedReason: policy-blocked`.

Enable with `--containment-mode` (CLI) or `containmentMode: true` (SDK).

Containment outcomes are included in evidence summaries as `containmentCount`, counting results that are blocked with `unresolvedReason=policy-blocked` and `disposition=escalate`.

### Disposition Policy

`dispositionPolicy` controls how individual results are classified:

- `minConfidenceForAutoApply`: below this threshold, technically successful results are downgraded to `hold-for-approval`
- `holdForTransitive`: classifies transitive remediations as `hold-for-approval`
- `escalateOnKev`: classifies KEV-triggered outcomes as `escalate`
- `escalateOnSlaBreachSeverities`: classifies selected SLA-breached severities as `escalate`

Reports aggregate these decisions in `dispositionCounts` so CI and orchestration layers can distinguish auto-apply-safe results from approval- or escalation-bound outcomes.

### Patch Integrity

Every generated patch artifact includes an `integrity` field with a SHA-256 content hash (`sha256:<hex>`). Integrity values are included in `PatchArtifact` and `PatchArtifactSummary` results.

### SBOM Output

`RemediationReport.sbom` is an array of `SbomEntry` records covering all installed packages with status tracking: `patched`, `unpatched`, `skipped` (reachability), or `suppressed` (VEX). Each entry includes `name`, `version`, `type`, and optional `cveId`.

### Regression Detection

When `regressionCheck: true`, the patched version is tested against the CVE's vulnerable semver range after apply. If it still satisfies the range, `regressionDetected: true` is set on the result.

Enable with `--regression-check` (CLI) or `regressionCheck: true` (SDK).

### Air-gap / Offline Mode

When `offlineIntelligence: true`, autoremediator skips all external CVE intelligence network calls — OSV, GitHub Advisory, NVD, CISA KEV, EPSS, and other enrichment sources. Package inventory scanning and version-bump selection from a local npm mirror still work normally; only CVE enrichment is bypassed.

For fully air-gapped environments, pair `offlineIntelligence` with `intelligenceSnapshotPath` pointing to a local JSON file of pre-fetched CVE data. The snapshot file must contain an array of `CveDetails`-shaped records keyed by CVE ID.

Evidence artifacts record `offlineMode: true` in the provenance section when this mode is active, providing an auditable signal that run outputs were produced without live intelligence source access.

Enable with:

- CLI: `--offline` and optionally `--intelligence-snapshot <path>`
- SDK: `offlineIntelligence: true` and optionally `intelligenceSnapshotPath: "/path/to/snapshot.json"`
- GitHub Action: `offline: true` input and optionally `intelligence-snapshot: <path>`

## GitHub App: Per-Repository Settings

When using the GitHub App runtime, per-repository remediation behavior is also controlled by `.github/autoremediator.yml`. These fields are read on each webhook delivery and do not require restarting the server.

```yaml
# Dry-run mode: plan and report without mutating files (safe default)
dryRun: true

# Run project tests after successful version bump or override
runTests: false

# Minimum CVE severity to process: LOW | MEDIUM | HIGH | CRITICAL | UNKNOWN
# UNKNOWN processes all findings regardless of severity score
minimumSeverity: HIGH

# Optional: scope remediation to a specific project subdirectory
# cwd: packages/api

# Pull request creation (GitHub App only)
pullRequest:
  enabled: false
  grouping: per-cve # all | per-cve | per-package
  # repository: owner/repo   # optional: target repository override
  # baseBranch: main
  branchPrefix: autoremediator/fix
  titlePrefix: "chore(security):"
  # bodyFooter: "Generated by autoremediator"
  draft: false
  # pushRemote: origin
  # tokenEnvVar: GITHUB_TOKEN
```

Field intent:

- `dryRun`: prevents file mutations; use `false` only when change review is in place
- `runTests`: adds post-apply test validation; recommended when `dryRun: false`
- `minimumSeverity`: filters findings before remediation; use `UNKNOWN` to process all severities including unscored CVEs
- `pullRequest.enabled`: enables native GitHub PR creation per remediation run
- `pullRequest.grouping`: `all` = one PR for the run, `per-cve` = one PR per CVE, `per-package` = one PR per affected package
- `pullRequest.draft`: keeps PRs in draft state for manual promotion to review

When `.github/autoremediator.yml` is absent in a repository, the GitHub App uses safe defaults (`dryRun: true`, `minimumSeverity: HIGH`, no pull request creation).

## Precedence Rules

When settings conflict, precedence is:

1. explicit CLI/API options
2. policy file values
3. runtime defaults

Why this matters:

- platform teams can enforce baseline safety in policy files
- pipeline owners can override only when explicitly intended
- defaults remain predictable when options are omitted

## Safety Guarantees

Core guardrails:

- dry-run must not mutate files
- preview mode must remain non-mutating (preview enforces dry-run behavior)
- package allow/deny policy must be enforced
- major bump policy must be enforced
- tool failures must surface in structured outputs
- failed patch validation must be marked unresolved (never success)

These guarantees are critical for trustable automation in CI.

## Remediation Scope and Escalation

- direct dependencies:
  - primary automatic upgrade target when safe fixed versions exist
- indirect dependencies:
  - can be remediated through package-manager-native overrides or resolutions when a safe transitive fix exists
  - remain unresolved when no safe override path or validated fallback exists
  - should route through team escalation when automation cannot produce a safe validated outcome

Why this distinction exists: direct dependency changes are typically auditable and reviewable in repository context, while indirect fixes can require broader dependency graph decisions even when the package manager supports an override-based remediation path.

## Fallback Safety Path

When a safe direct version bump cannot be applied, remediation may attempt:

1. package-manager-native override or resolution for transitive dependencies
2. source fetch
3. patch generation
4. patch apply (if confidence and validation gates pass)

Safety implications:

- override-based remediation must still pass install and optional test validation
- override targeting can use manager-native selector keys, including nested and scoped selectors, when supported by the active package manager
- low-confidence patch output must not be applied
- validation failures must be unresolved outcomes
- unresolved results must remain visible for manual handling

## Summary Signals

Scan and CI runs expose aggregate summary fields in addition to per-CVE results:

- `strategyCounts`: counts for `version-bump`, `override`, `patch-file`, and `none`
- `dependencyScopeCounts`: counts for direct versus transitive remediation outcomes
- `unresolvedByReason`: counts by machine-readable unresolved reason such as `no-safe-version`, `constraint-blocked`, and `patch-validation-failed`
- `escalationCounts`: counts by intended escalation action for unresolved outcomes
- `slaBreachSummary`: structured SLA breach aggregate on `ScanReport`, `CiSummary`, and `PortfolioReport` when `slaCheck: true`; contains `breachCount` and a `breaches` array of `SlaBreachEntry` records with per-CVE overdue details and `recommendedAction`

### Transitive Dependency Remediation

autoremediator can remediate transitive (indirect) dependencies without requiring an upstream publisher release. When `constraints.directDependenciesOnly` is not set:

- package-manager-native override or resolution (`pnpm.overrides`, `resolutions`, `overrides`) is attempted for transitive packages with a known safe version
- LLM-generated patch fallback is used for transitive packages when no safe version exists upstream

Transitive remediation attempts appear in `dependencyScopeCounts.transitive` and emit a notice line in text mode output. Use `constraints.preferVersionBump: true` or `constraints.directDependenciesOnly: true` to restrict automation scope when transitive changes require manual governance approval.

## Validation Controls

- install/test validation uses the resolved package manager for the repository
- apply and rollback install validation is lockfile-respecting by default (`npm ci`, `pnpm install --frozen-lockfile`, `yarn install --frozen-lockfile`)
- successful version-bump and override remediation runs perform a best-effort package-manager dedupe pass after apply and validation
- `--run-tests` enables post-apply test validation and should be used in mutation-enabled automation
- `--dry-run` is the onboarding and policy-tuning baseline for new projects
- `--preview` is the planning baseline for orchestration systems that need non-mutating intent before apply
- GitHub App default remediation handlers gate scan-driven automation by severity using the `minimumSeverity` field in `.github/autoremediator.yml` (default `HIGH`)

Dependency-path diagnostics use package-manager-native commands where available (`npm explain`, `pnpm why`, `yarn why`) so remediation context reflects the active dependency graph tooling.

## Correlation and Traceability

Orchestration-facing fields:

- `requestId`: request-scoped trace identifier
- `sessionId`: multi-run session identifier
- `parentRunId`: parent-child linkage for hierarchical workflows

Additional provenance and replay controls:

- `actor`: identity of the automation principal
- `source`: calling surface (`cli`, `sdk`, `mcp`, `openapi`, `unknown`)
- `idempotencyKey` + `resume`: replay-safe execution pair for deterministic retries

Provider model controls:

- `llmProvider: "local"` keeps execution deterministic-first
- `llmProvider: "remote"` enables remote model-backed patch generation
- `requireConsensusForHighRisk: true` enforces verifier consensus for high-risk generated patches
- `consensusProvider` and `consensusModel` pin the verifier provider/model used for high-risk consensus
- `patchConfidenceThresholds` allows per-risk confidence gates, for example `{ "high": 0.9 }`

These fields are propagated through reports and evidence outputs to support deterministic run lineage in CI, MCP hosts, and service integrations.

## Intelligence Source Configuration

Source roles:

- primary package intelligence: OSV, GitHub Advisory Database
- severity/context enrichment: NVD, CVE Services
- exploitation prioritization: CISA KEV, FIRST EPSS
- supplemental context signals: GitLab Advisory, CERT/CC, deps.dev, OpenSSF Scorecard
- optional enterprise connectors: vendor/commercial feeds

Additional enrichment sources are best-effort and can be configured via environment variables:

- `AUTOREMEDIATOR_EPSS_API` (default: FIRST EPSS API)
- `AUTOREMEDIATOR_CVE_SERVICES_API` (default: CVE Services API)
- `AUTOREMEDIATOR_GITLAB_ADVISORY_API` (default: GitLab advisory API endpoint)
- `AUTOREMEDIATOR_CERTCC_SEARCH_URL` (default: CERT/CC vulnerability search URL)
- `AUTOREMEDIATOR_DEPSDEV_API` (default: deps.dev API)
- `AUTOREMEDIATOR_SCORECARD_API` (default: OpenSSF Scorecard API)
- `AUTOREMEDIATOR_VENDOR_ADVISORY_FEEDS` (comma-separated vendor feed URLs)
- `AUTOREMEDIATOR_COMMERCIAL_FEEDS` (comma-separated enterprise feed URLs)
- `AUTOREMEDIATOR_COMMERCIAL_FEED_TOKEN` (optional bearer token for enterprise feeds)

Operational behavior:

- these sources never replace primary package intelligence (OSV/GitHub Advisory)
- enrichment failures are non-fatal and remediation continues
- configured feed URLs are only used for enrichment and prioritization metadata

## Security Best-Practice Baseline

- start with dry-run in all new repositories
- enable CI summary artifacts and retain evidence data
- require review + branch protection for auto-generated remediation PRs
- keep major bumps blocked unless a team explicitly accepts that risk class
- treat unresolved findings as an escalation queue

## Troubleshooting Policy Outcomes

- package unexpectedly skipped:
  - verify allow/deny package rules
  - verify CLI overrides were not supplied in the job
- expected major bump did not happen:
  - check `allowMajorBumps`
  - confirm resolved version actually requires a major jump
- unresolved after fallback attempt:
  - inspect validation outcome
  - review confidence gating behavior and escalation process
- native audit parsing failed unexpectedly:
  - inspect the reported audit command and exit code
  - verify the selected workspace/package-manager combination is supported by the active runner

## Related Docs

- [CLI Reference](cli.md)
- [Integrations](integrations.md)
- [Scanner Inputs](scanner-inputs.md)
