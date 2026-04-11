# Policy and Safety

Policy controls decide what is allowed.

Safety controls decide what is considered successful.

Use both together to run remediation automation without silent risk acceptance.

Related references:

- [CLI Reference](cli.md)
- [Getting Started](getting-started.md)
- [Integrations](integrations.md)

## Policy Configuration

Create `.autoremediator.json`:

```json
{
  "allowMajorBumps": false,
  "denyPackages": ["lodash"],
  "allowPackages": [],
  "constraints": {
    "directDependenciesOnly": false,
    "preferVersionBump": false
  }
}
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
  - what: blocks outcomes for indirect dependencies
  - why: keeps automation within directly managed dependency scope
- `constraints.preferVersionBump`:
  - what: rejects patch-file outcomes
  - why: enforces bump-first remediation policy for change governance

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
- low-confidence patch output must not be applied
- validation failures must be unresolved outcomes
- unresolved results must remain visible for manual handling

## Summary Signals

Scan and CI runs expose aggregate summary fields in addition to per-CVE results:

- `strategyCounts`: counts for `version-bump`, `override`, `patch-file`, and `none`
- `dependencyScopeCounts`: counts for direct versus transitive remediation outcomes
- `unresolvedByReason`: counts by machine-readable unresolved reason such as `no-safe-version`, `constraint-blocked`, and `patch-validation-failed`

These fields make it easier to build CI gates, dashboards, and escalation rules without reparsing each nested remediation result.

## Validation Controls

- install/test validation uses the resolved package manager for the repository
- `--run-tests` enables post-apply test validation and should be used in mutation-enabled automation
- `--dry-run` is the onboarding and policy-tuning baseline for new projects
- `--preview` is the planning baseline for orchestration systems that need non-mutating intent before apply

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

## Related Docs

- [CLI Reference](cli.md)
- [Integrations](integrations.md)
- [Scanner Inputs](scanner-inputs.md)
