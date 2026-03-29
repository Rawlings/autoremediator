# API and SDK

The SDK is the programmatic surface for embedding remediation into internal platforms, bots, and security orchestration systems.

This page documents what each exported function does, why you would use it, and how to consume results safely.

Related references:

- [CLI Reference](cli.md)
- [Policy and Safety](policy-and-safety.md)
- [Integrations](integrations.md)

## Public APIs

- `remediate(cveId, options?)`
- `planRemediation(cveId, options?)`
- `remediateFromScan(inputPath, options?)`
- `toCiSummary(scanReport)`
- `ciExitCode(summary)`

New integrations should use `remediate`, `planRemediation`, and `remediateFromScan`.

## Function Reference

### `remediate(cveId, options?)`

What: runs single-CVE remediation pipeline for a target repository.

Why: best for targeted, urgent vulnerability response in automation.

How: performs CVE lookup, inventory/version matching, safe bump attempt, and fallback patch flow when configured and allowed.

### `remediateFromScan(inputPath, options?)`

What: parses scanner output and remediates each discovered CVE.

Why: best for scheduled CI and batch remediation operations.

How: normalizes scanner findings, deduplicates CVEs, and delegates each CVE to the remediation pipeline.

### `planRemediation(cveId, options?)`

What: runs a non-mutating remediation preview for a single CVE.

Why: best for agent orchestration systems that need to inspect intended actions before allowing write operations.

How: forces preview semantics and returns a standard remediation report shape with dry-run outcomes.

### `toCiSummary(scanReport)`

What: derives deterministic CI summary output from scan results.

Why: stable contract for pipeline gates and dashboards.

How: includes aggregate strategy counts, dependency-scope counts, and unresolved-reason counts so callers can distinguish direct bumps, transitive overrides, patch fallback, and blocked outcomes without re-walking nested reports.

### `ciExitCode(summary)`

What: translates summary results into CI-friendly exit behavior.

Why: supports policy-based gate enforcement in CI/CD.

## Options Reference

Core options:

- `cwd`: repository root to operate on
- `packageManager`: explicit package manager selection (`npm`, `pnpm`, `yarn`)
- `dryRun`: simulation mode without mutation
- `preview`: non-mutating planning mode for orchestration/approval workflows
- `runTests`: enables post-apply test validation
- `llmProvider`: provider selection (`openai`, `anthropic`, `local` deterministic primary path)
- `policy`: path to `.autoremediator.json`
- `evidence`: enable/disable evidence artifact writing for direct and scan workflows
- `patchesDir`: patch output/apply location when fallback patching is used
- `requestId`: request-level correlation identifier
- `sessionId`: session-level correlation identifier
- `parentRunId`: optional parent run linkage for hierarchical traces
- `idempotencyKey`: deterministic replay key for cached resume flows
- `resume`: reuse cached report for matching `idempotencyKey` + CVE when available
- `actor`: actor identity string written to evidence metadata
- `source`: provenance source (`cli`, `sdk`, `mcp`, `openapi`, `unknown`)
- `constraints.directDependenciesOnly`: block remediation outcomes for indirect dependencies
- `constraints.preferVersionBump`: reject patch-file outcomes in favor of bump-only policy

Scan and CI summary aggregates:

- `patchCount`: total patch-file remediation attempts in the scan run
- `strategyCounts`: aggregate counts by remediation strategy (`version-bump`, `override`, `patch-file`, `none`)
- `dependencyScopeCounts`: aggregate counts by dependency scope (`direct`, `transitive`)
- `unresolvedByReason`: aggregate counts by machine-readable unresolved reason

Scan-specific options:

- `format`: scanner adapter selection (`auto`, `npm-audit`, `yarn-audit`, `sarif`)

## Source Precedence

Lookup and enrichment follows this precedence model:

- Primary package intelligence: OSV, then GitHub Advisory Database
- Severity and CVE context enrichment: NVD, then CVE Services
- Exploitation prioritization enrichment: CISA KEV and FIRST EPSS
- Supplemental trust/context enrichment: GitLab Advisory, CERT/CC, deps.dev, OpenSSF Scorecard
- Optional enterprise enrichment: vendor and commercial feed connectors

Primary package intelligence determines affected npm packages and version windows. All other sources are best-effort enrichment and do not block remediation when unavailable.

## Basic TypeScript Usage

```ts
import { planRemediation, remediate, remediateFromScan, toCiSummary, ciExitCode } from "autoremediator";

const report = await remediate("CVE-2021-23337", {
	cwd: process.cwd(),
	llmProvider: "local",
	dryRun: true
});

const scanReport = await remediateFromScan("./audit.json", {
	format: "npm-audit",
	policy: "./.autoremediator.json"
});

const preview = await planRemediation("CVE-2021-23337", {
	cwd: process.cwd(),
	requestId: "req-42",
	sessionId: "nightly-security-job"
});

const resumable = await remediate("CVE-2021-23337", {
	cwd: process.cwd(),
	idempotencyKey: "nightly-cve-2021-23337",
	resume: true,
	source: "sdk",
	constraints: {
		directDependenciesOnly: true,
		preferVersionBump: true
	}
});

const summary = toCiSummary(scanReport);
const exit = ciExitCode(summary);
process.exitCode = exit;
```

## Automation and Error Handling

Recommended handling pattern:

- treat unresolved outcomes as actionable backlog, not success
- persist summaries for security reporting
- use `llmProvider: "local"` for deterministic primary flow; if no safe version exists, patch fallback may still require remote model credentials
- avoid retry loops that ignore policy and validation failures

Common failure classes to handle:

- scanner parse mismatch
- no vulnerable installed version match
- no safe fixed version available
- policy denial
- patch confidence/validation failure

Summary observability:

- use `strategyCounts` to distinguish direct bumps from override-based transitive remediation
- use `dependencyScopeCounts` to understand how much of a run was handled as direct dependency work versus transitive dependency remediation
- use `unresolvedByReason` to drive CI escalation, dashboards, or ticket routing without parsing freeform messages

Intelligence observability:

- `report.cveDetails.intelligence.sourceHealth` includes per-source enrichment status for each `lookup-cve` run
- each source entry exposes `attempted`, `changed`, and optional `error`

## Security Guidance for SDK Integrators

- default new integrations to dry-run until policy is validated
- require explicit allowlist process for any major-version policy change
- keep policy and summary artifacts versioned in CI systems
- integrate unresolved outcomes with ticketing/escalation systems

## Related Docs

- [Policy and Safety](policy-and-safety.md)
- [Scanner Inputs](scanner-inputs.md)
- [Integrations](integrations.md)
