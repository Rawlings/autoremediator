# API and SDK

The SDK is the programmatic surface for embedding remediation into internal platforms, bots, and security orchestration systems.

This page documents what each exported function does, why you would use it, and how to consume results safely.

Related references:

- [CLI Reference](cli.md)
- [Policy and Safety](policy-and-safety.md)
- [Integrations](integrations.md)

## Public APIs

- `remediate(cveId, options?)`
- `remediateFromScan(inputPath, options?)`
- `toCiSummary(scanReport)`
- `ciExitCode(summary)`

Legacy aliases (for compatibility only):

- `heal`
- `healFromScanFile`

New integrations should prefer `remediate` and `remediateFromScan`.

## Function Reference

### `remediate(cveId, options?)`

What: runs single-CVE remediation pipeline for a target repository.

Why: best for targeted, urgent vulnerability response in automation.

How: performs CVE lookup, inventory/version matching, safe bump attempt, and fallback patch flow when configured and allowed.

### `remediateFromScan(inputPath, options?)`

What: parses scanner output and remediates each discovered CVE.

Why: best for scheduled CI and batch remediation operations.

How: normalizes scanner findings, deduplicates CVEs, and delegates each CVE to the remediation pipeline.

### `toCiSummary(scanReport)`

What: derives deterministic CI summary output from scan results.

Why: stable contract for pipeline gates and dashboards.

### `ciExitCode(summary)`

What: translates summary results into CI-friendly exit behavior.

Why: supports policy-based gate enforcement in CI/CD.

## Options Reference

Core options:

- `cwd`: repository root to operate on
- `packageManager`: explicit package manager selection (`npm`, `pnpm`, `yarn`)
- `dryRun`: simulation mode without mutation
- `skipTests`: disables post-apply test validation
- `llmProvider`: provider selection (`openai`, `anthropic`, `local` deterministic mode)
- `policyPath`: path to `.autoremediator.json`
- `patchesDir`: patch output/apply location when fallback patching is used

Scan-specific options:

- `format`: scanner adapter selection (`auto`, `npm-audit`, `yarn-audit`, `sarif`)
- `writeEvidence`: enable/disable evidence artifact writing

## Basic TypeScript Usage

```ts
import { remediate, remediateFromScan, toCiSummary, ciExitCode } from "autoremediator";

const report = await remediate("CVE-2021-23337", {
	cwd: process.cwd(),
	llmProvider: "local",
	dryRun: true
});

const scanReport = await remediateFromScan("./audit.json", {
	format: "npm-audit",
	policyPath: "./.autoremediator.json"
});

const summary = toCiSummary(scanReport);
const exit = ciExitCode(summary);
process.exitCode = exit;
```

## Automation and Error Handling

Recommended handling pattern:

- treat unresolved outcomes as actionable backlog, not success
- persist summaries for security reporting
- use deterministic mode (`llmProvider: "local"`) where remote model access is restricted
- avoid retry loops that ignore policy and validation failures

Common failure classes to handle:

- scanner parse mismatch
- no vulnerable installed version match
- no safe fixed version available
- policy denial
- patch confidence/validation failure

## Security Guidance for SDK Integrators

- default new integrations to dry-run until policy is validated
- require explicit allowlist process for any major-version policy change
- keep policy and summary artifacts versioned in CI systems
- integrate unresolved outcomes with ticketing/escalation systems

## Related Docs

- [Policy and Safety](policy-and-safety.md)
- [Scanner Inputs](scanner-inputs.md)
- [Integrations](integrations.md)
