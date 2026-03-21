# Getting Started

Autoremediator is an automation-first remediation system for Node.js dependency CVEs.

It supports two primary entry paths:

- direct CVE remediation (for urgent, targeted fixes)
- scanner-driven remediation (for CI and recurring automation)

This page explains what to run, why you would run it, and how to interpret results safely.

Related references:

- [CLI Reference](cli.md)
- [Scanner Inputs](scanner-inputs.md)
- [Policy and Safety](policy-and-safety.md)
- [API and SDK](api-sdk.md)
- [Integrations](integrations.md)

## What You Need

- Node.js 20+
- one package manager in your target project (`pnpm`, `npm`, or `yarn`)
- a repository with lockfile and dependency manifest
- optional model credentials for patch generation fallback:
	- `OPENAI_API_KEY`
	- `ANTHROPIC_API_KEY`

If you use `--llm-provider local` (deterministic mode), API keys are not required.

## Install

Global install is useful for operator workstations:

```bash
pnpm add -g autoremediator
# or
npm install -g autoremediator
# or
yarn global add autoremediator
```

Project-local install is recommended for CI reproducibility:

```bash
pnpm add -D autoremediator
pnpm exec autoremediator --help
# or
npm install --save-dev autoremediator
npm exec autoremediator -- --help
# or
yarn add --dev autoremediator
yarn autoremediator --help
```

## Choose the Right Mode

| Use case | Recommended mode | Why |
|---|---|---|
| Urgent single CVE | direct CVE mode | Fast, focused remediation and clear operator feedback |
| Nightly scanner automation | scan mode (`--input`) | Batch handling with deterministic CI summary |
| CI gate without mutation | `--dry-run --ci` | Safety-first check for unresolved risk |
| Air-gapped or deterministic environments | `--llm-provider local` | No remote model dependency and predictable behavior |
| Platform service integration | SDK, MCP, or OpenAPI | Standardized orchestration across many repos |

For full mode semantics, see [CLI Reference](cli.md) and [Integrations](integrations.md).

## First Commands (What and Why)

Direct CVE remediation:

```bash
autoremediator CVE-2021-23337
```

What it does:

- looks up CVE intelligence
- checks installed package inventory
- matches vulnerable installed versions
- attempts safe version bump first
- uses patch fallback only when no safe bump is available

Why to use it: ideal for urgent vulnerability response.

Scanner-driven remediation:

```bash
autoremediator ./audit.json
```

What it does: parses scanner output, deduplicates CVEs, and runs remediation for each CVE.

Why to use it: ideal for regular automation from `npm audit`, `yarn audit`, or SARIF tools.

Safety preview:

```bash
autoremediator CVE-2021-23337 --dry-run
```

What it does: runs full decision logic without mutating project files.

Why to use it: validate policy impact and expected changes before applying.

Validation-enabled apply:

```bash
autoremediator CVE-2021-23337 --run-tests
```

What it does: runs post-apply validation (install/test workflow) before final success.

Why to use it: reduce regression risk in production automation.

## Interpreting Results

A remediation run usually ends in a mix of outcomes:

- applied: a safe bump or valid patch was applied
- unresolved: remediation was attempted but could not be safely completed
- skipped: package was out of scope or blocked by policy

In CI mode (`--ci`), use the summary output as your gate decision source. See [CLI Reference](cli.md) for exit behavior and [Policy and Safety](policy-and-safety.md) for unresolved semantics.

## Security Best Practices

- start with `--dry-run` in new repositories
- keep `allowMajorBumps` disabled by default unless your release process explicitly permits breaking upgrades
- use package allow/deny policy controls for governance boundaries
- enable validation (`--run-tests`) in remediation jobs that can mutate dependencies
- treat unresolved results as escalation signals, not silent pass conditions
- preserve evidence and summary artifacts for auditability

Detailed controls are documented in [Policy and Safety](policy-and-safety.md).

## Troubleshooting First Steps

- CVE did not apply:
	- verify the vulnerable version is actually installed
	- confirm policy did not deny the package
	- inspect unresolved reason in output/evidence
- Scan file not accepted:
	- explicitly set `--format`
	- validate scanner JSON shape against [Scanner Inputs](scanner-inputs.md)
- No patch fallback generated:
	- confirm non-local provider or configured local strategy supports patch generation for your environment
	- check safety thresholds and validation outcome

For CI and scheduling patterns, continue with [Integrations](integrations.md).
