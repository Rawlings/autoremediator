# API and SDK

The SDK is the programmatic surface for embedding remediation into internal platforms, bots, and security orchestration systems.

This page documents what each exported function does, why you would use it, and how to consume results safely.

Related references:

- [CLI Reference](cli.md)
- [Policy and Safety](policy-and-safety.md)
- [Integrations](integrations.md)
- [Agent Ecosystems](agent-ecosystems.md)

## Public APIs

- `remediate(cveId, options?)`
- `planRemediation(cveId, options?)`
- `remediateFromScan(inputPath, options?)`
- `listPatchArtifacts(options?)`
- `inspectPatchArtifact(patchFilePath, options?)`
- `validatePatchArtifact(patchFilePath, options?)`
- `toCiSummary(scanReport)`
- `ciExitCode(summary)`

New integrations should use `remediate`, `planRemediation`, and `remediateFromScan`.
Patch-heavy integrations should also use the patch lifecycle functions when they need to reuse or verify generated patch artifacts.

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

### `listPatchArtifacts(options?)`

What: lists stored patch artifacts in the configured patch directory.

Why: useful when downstream automation treats patches as durable assets.

### `inspectPatchArtifact(patchFilePath, options?)`

What: inspects a patch artifact and its optional manifest sidecar.

Why: useful for metadata-aware automation and diagnostics before applying or promoting a patch.

### `validatePatchArtifact(patchFilePath, options?)`

What: validates a stored patch against its manifest and current dependency inventory.

Why: useful for drift detection when lockfiles or installed versions change over time.

## Options Reference

Core options:

- `cwd`: repository root to operate on
- `packageManager`: explicit package manager selection (`npm`, `pnpm`, `yarn`)
- `dryRun`: simulation mode without mutation
- `preview`: non-mutating planning mode for orchestration/approval workflows
- `runTests`: enables post-apply test validation
- `llmProvider`: provider selection (`remote` or `local` deterministic primary path)
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
- `constraints.installMode`: install profile (`deterministic`, `prefer-offline`, `standard`) used for apply and rollback installs
- `constraints.installPreferOffline`: explicit override for `--prefer-offline` install flag behavior
- `constraints.enforceFrozenLockfile`: explicit override for frozen-lockfile behavior (`npm ci` / `--frozen-lockfile`)
- `constraints.workspace`: workspace/package selector used to scope monorepo install/list/test operations when supported by the package manager
- `modelPersonality`: prompt behavior profile (`analytical`, `pragmatic`, `balanced`)
- `providerSafetyProfile`: confidence/safety posture profile (`strict`, `relaxed`)
- `requireConsensusForHighRisk`: require consensus verification for high-risk generated patches
- `consensusProvider`: provider override (`remote`, `local`) for high-risk consensus verification
- `consensusModel`: model override for high-risk consensus verification
- `patchConfidenceThresholds`: per-risk acceptance thresholds (`low`, `medium`, `high` in range 0..1)
- `dynamicModelRouting`: enable dynamic model selection by input size
- `dynamicRoutingThresholdChars`: threshold for dynamic routing behavior

Scan and CI summary aggregates:

- `patchCount`: total patch-file remediation attempts in the scan run
- `strategyCounts`: aggregate counts by remediation strategy (`version-bump`, `override`, `patch-file`, `none`)
- `dependencyScopeCounts`: aggregate counts by dependency scope (`direct`, `transitive`)
- `unresolvedByReason`: aggregate counts by machine-readable unresolved reason

Patch lifecycle outputs:

- `patchArtifact`: structured metadata describing generated patch artifacts
- `validationPhases`: phased patch validation results for deterministic decisioning

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
import {
	ciExitCode,
	inspectPatchArtifact,
	listPatchArtifacts,
	planRemediation,
	remediate,
	remediateFromScan,
	toCiSummary,
	validatePatchArtifact,
} from "autoremediator";

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
		preferVersionBump: true,
		installMode: "deterministic",
		enforceFrozenLockfile: true
	}
});

const summary = toCiSummary(scanReport);
const exit = ciExitCode(summary);
process.exitCode = exit;

const patches = await listPatchArtifacts({ cwd: process.cwd() });
const inspection = await inspectPatchArtifact("./patches/lodash+4.17.0.patch", { cwd: process.cwd() });
const validation = await validatePatchArtifact("./patches/lodash+4.17.0.patch", { cwd: process.cwd() });
```

## Automation and Error Handling

Recommended handling pattern:

- treat unresolved outcomes as actionable backlog, not success
- persist summaries for security reporting
- use `llmProvider: "local"` for deterministic primary flow; if no safe version exists, patch fallback may still require remote model credentials
- use `llmProvider: "remote"` when remote model-backed patch generation is required
- for high-risk patch fallback, set `requireConsensusForHighRisk: true` with `consensusModel` to run verifier-model agreement checks
- use `patchConfidenceThresholds` to tighten acceptance per risk level, for example `{ high: 0.9 }`
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
