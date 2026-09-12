# Scanner Inputs

Scanner input mode converts vulnerability findings into a remediation queue.

This page explains what formats are supported, why to choose each one, and how parser behavior affects automation reliability.

Related references:

- [CLI Reference](cli.md)
- [Integrations](integrations.md)
- [Policy and Safety](policy-and-safety.md)

## Scan Output Summaries

Scanner-driven runs can emit orchestration-friendly aggregates in addition to per-CVE reports:

- `strategyCounts`
- `dependencyScopeCounts`
- `dispositionCounts`
- `unresolvedByReason`
- `escalationCounts`
- `simulationSummary` when `simulationMode` is enabled in dry-run or preview contexts

When `containmentMode` blocks an applied escalation outcome, the affected result is reported with `unresolvedReason: policy-blocked`.

## Supported Formats

- `npm-audit`
- `yarn-audit`
- `sarif`
- `auto`

## Format Selection (What and Why)

| Format       | Best for                                             | Why                                                   |
| ------------ | ---------------------------------------------------- | ----------------------------------------------------- |
| `npm-audit`  | npm, pnpm, and bun JSON audit output                 | direct, common ecosystem path                         |
| `yarn-audit` | Yarn-specific audit output                           | aligns parser expectations with yarn shape            |
| `sarif`      | centralized security tooling and enterprise scanners | integrates with broad security pipelines              |
| `auto`       | mixed or unknown scan source in generic jobs         | convenience when one adapter can be reliably inferred |

Use explicit formats in CI when possible. `auto` is convenient, but explicit parser selection is more deterministic.

## Input Behavior and Constraints

Scanner ingestion focuses on extracting remediable CVE and GHSA identifiers alongside affected package coordinates.

Operational characteristics:

- **GHSA Identifier Preservation**: `npm-audit` and `yarn-audit` scanner adapters extract and preserve GitHub Security Advisory IDs (`GHSA-...`) when vulnerability advisories do not have assigned CVE numbers, unlocking direct remediation for advisories lacking assigned CVEs.
- **Deduplication**: Duplicated advisory findings across packages are automatically deduplicated before remediation planning begins.
- **Identifier Validation**: Scanner payloads missing valid CVE or GHSA identifiers are reported as skipped or unresolved items.
- **Malformed Payloads**: Incomplete scanner payloads can reduce remediable findings; for deterministic CI gates, store scanner artifacts and specify `--format` explicitly.

## npm audit

Generate and remediate:

```bash
npm audit --json > audit.json
autoremediator audit.json --format npm-audit
```

Why use this path: default for npm-native projects and most CI templates.

## pnpm audit

Generate and remediate:

```bash
pnpm audit --json > pnpm-audit.json
autoremediator pnpm-audit.json --format npm-audit
```

Why `npm-audit` parser: pnpm audit JSON is compatible with that adapter path.

## yarn audit

Generate and remediate:

```bash
yarn npm audit --json > yarn-audit.json
autoremediator yarn-audit.json --format yarn-audit
```

If your Yarn workflow emits alternate JSON shape, lock parser with `--format yarn-audit` and retain artifacts for troubleshooting.

## bun audit

Generate and remediate:

```bash
bun audit --json > bun-audit.json
autoremediator bun-audit.json --format npm-audit
```

Why `npm-audit` parser: Bun audit JSON is compatible with the npm-audit adapter path. `--audit` mode with `--package-manager bun` is also supported.

## Deno

Deno does not provide a native audit command. Use a SARIF scan file or an npm-audit-format file from an external scanner:

```bash
autoremediator report.sarif --format sarif --package-manager deno
```

`--audit` is not supported with `--package-manager deno` and will exit with an error directing you to use `--input` instead.

## SARIF

Remediate from SARIF file:

```bash
autoremediator report.sarif --format sarif
```

Why use SARIF: unify scanner ingestion across heterogeneous security platforms.

## Git Delta and Lockfile Diff Scanning (`autoremediator diff`)

Unlike static scan files that snapshot the complete dependency tree, git delta scanning computes the vulnerability risk differential introduced by a specific pull request, commit, or branch:

```bash
# Compare working tree lockfiles against target branch
autoremediator diff --base origin/main

# Output JSON report and fail CI if new vulnerabilities are introduced
autoremediator diff --base origin/main --ci --output-format json
```

Key capabilities:

- **Multi-Package-Manager Lockfile Diffing**: Directly compares lockfile manifests across npm (`package-lock.json`), pnpm (`pnpm-lock.yaml`), and Yarn (`yarn.lock`).
- **Transitive Scope Tracking**: Identifies whether a version bump or addition occurred in direct dependencies or deep in the transitive tree.
- **Risk Delta Classification**: Determines whether net risk is `improved`, `neutral`, or `degraded`, allowing PR validation gates to catch newly introduced vulnerabilities before merging without blocking on pre-existing findings.

## Interactive Scanner Triage (`autoremediator triage`)

Instead of batch-remediating all findings unattended in CI, developers can triage scanner outputs interactively from the terminal:

```bash
# Interactively triage findings from an audit JSON export
autoremediator triage ./audit.json

# Interactively triage direct audit findings with post-apply test validation
autoremediator --audit -i --run-tests
```

During triage, each vulnerability finding is presented with severity, EPSS score, CISA KEV status, and safe version guidance, providing keyboard shortcuts to `[a]pply` the fix, `[s]kip`, `[x] suppress` (VEX), or `[q]uit`.

## Deduplication and Batch Semantics

In scan mode, CVEs are normalized and deduplicated before per-CVE remediation begins.

Why this matters:

- avoids repeated attempts against identical findings
- improves run time and summary clarity
- reduces noisy CI output

## Automation Guidance

- store raw scanner output as a build artifact
- run with explicit `--format` in production CI
- combine `--ci` and `--summary-file` for deterministic gate handling
- pair with policy controls for safe rollout boundaries

Example CI run:

```bash
autoremediator scan --input ./audit.json --format npm-audit --ci --summary-file ./summary.json
```

## Troubleshooting

- parser mismatch:
  - specify format explicitly
  - confirm file matches expected scanner output shape
- fewer CVEs than scanner UI:
  - verify CVE identifiers are present in exported JSON/SARIF
  - check deduplication behavior in summary output
- inconsistent runs:
  - pin scanner version and export flags
  - keep policy file and package manager lockfile stable

## Related Docs

- [CLI Reference](cli.md)
- [Integrations](integrations.md)
- [Policy and Safety](policy-and-safety.md)
