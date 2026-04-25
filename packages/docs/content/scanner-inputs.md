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

| Format | Best for | Why |
|---|---|---|
| `npm-audit` | npm, pnpm, and bun JSON audit output | direct, common ecosystem path |
| `yarn-audit` | Yarn-specific audit output | aligns parser expectations with yarn shape |
| `sarif` | centralized security tooling and enterprise scanners | integrates with broad security pipelines |
| `auto` | mixed or unknown scan source in generic jobs | convenience when one adapter can be reliably inferred |

Use explicit formats in CI when possible. `auto` is convenient, but explicit parser selection is more deterministic.

## Input Behavior and Constraints

Scanner ingestion focuses on extracting remediable CVE identifiers and related package context.

Operational constraints:

- malformed or incomplete scanner payloads can reduce remediable findings
- missing CVE identifiers may produce skipped or unresolved items
- duplicated findings are deduplicated before remediation execution

For deterministic gate behavior, store scanner artifacts and rerun with explicit `--format`.

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
